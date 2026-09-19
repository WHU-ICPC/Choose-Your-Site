import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, SOURCE, acquireLock, atomicWrite, digest, publicState, readUtf8, advanceTurns } from './lib.mjs';

export function createApp(directory = ROOT) {
  const filename = path.join(directory, 'data.json');
  let data = JSON.parse(readUtf8(filename));
  if (data.version !== 1 || !Array.isArray(data.people) || !Array.isArray(data.options)) throw new Error('数据文件格式不正确。');
  const tokens = new Map(data.people.map(person => [person.tokenHash, person.number]));
  function commit(next) {
    atomicWrite(filename, JSON.stringify(next, null, 2) + '\n');
    data = next;
  }
  function advance() {
    const next = structuredClone(data);
    if (advanceTurns(next)) commit(next);
  }
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
  ]);
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      advance();
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && assets.has(pathname)) {
        const [file, type] = assets.get(pathname);
        response.writeHead(200, { 'Content-Type': type });
        response.end(fs.readFileSync(path.join(SOURCE, 'public', file)));
        return;
      }
      if (request.method === 'GET' && pathname === '/api/state') return json(response, 200, publicState(data));
      if (!['/api/me', '/api/choose', '/api/preferences'].includes(pathname)) return json(response, 404, { error: '未找到此页面。' });
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '')?.[1];
      const number = token && tokens.get(digest(token));
      if (!number) return json(response, 401, { error: 'Token 无效，请检查后重试。' });
      if (request.method === 'GET' && pathname === '/api/me') {
        const person = data.people[number - 1];
        return json(response, 200, { number, name: person.name, allowed: person.allowed, choice: person.choice, preferences: person.preferences ?? [] });
      }
      if (request.method !== 'POST' || !['/api/choose', '/api/preferences'].includes(pathname)) return json(response, 405, { error: '不支持此请求方式。' });
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') return json(response, 415, { error: '请求必须为 JSON。' });
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > Math.max(2048, data.options.length * 16)) return json(response, 413, { error: '请求过大。' });
      }
      let input;
      try { input = JSON.parse(body); } catch { return json(response, 400, { error: '请求格式不正确。' }); }
      // No await between validation and persistence: every choice sees the last committed state.
      advance();
      const person = data.people[number - 1];
      if (person.choice !== null) return json(response, 409, { error: '此 Token 已使用，不能再次选择。' });
      const state = publicState(data);
      if (pathname === '/api/preferences') {
        if (state.current?.number === number) return json(response, 409, { error: '已经轮到你，请直接选择；预选择只能在轮到之前修改。' });
        const preferences = input?.preferences;
        if (!Array.isArray(preferences) || preferences.length > person.allowed.length || new Set(preferences).size !== preferences.length || preferences.some(id => !Number.isInteger(id) || !person.allowed.includes(id))) {
          return json(response, 400, { error: '预选择必须是允许项目的不重复排列。' });
        }
        const next = structuredClone(data);
        next.people[number - 1].preferences = preferences;
        commit(next);
        return json(response, 200, { ok: true, preferences });
      }
      if (state.current?.number !== number) return json(response, 409, { error: '还未轮到你，请等待前面的人完成选择。' });
      const option = state.options.find(item => item.id === input?.optionId);
      if (!option || !person.allowed.includes(option.id)) return json(response, 400, { error: '你不能选择此选项。' });
      if (option.remaining < 1) return json(response, 409, { error: '此选项已满。' });
      const next = structuredClone(data);
      next.people[number - 1].choice = option.id;
      next.people[number - 1].chosenAt = new Date().toISOString();
      next.people[number - 1].choiceSource = 'manual';
      advanceTurns(next);
      commit(next);
      return json(response, 200, { ok: true });
    } catch (error) {
      console.error(error);
      if (!response.headersSent) json(response, 500, { error: '服务暂时无法保存或读取数据，请稍后重试。' });
      else response.end();
    }
  });
  let timer;
  server.on('listening', () => {
    const tick = () => { try { advance(); } catch (error) { console.error('自动选择保存失败，将重试：', error); } };
    tick();
    timer = setInterval(tick, 250);
    timer.unref();
  });
  server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let unlock;
  try {
    const value = process.argv[2] ?? '7999';
    const port = Number(value);
    if (process.argv.length > 3 || !/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1 至 65535 的整数。');
    unlock = acquireLock(ROOT);
    const server = createApp();
    let stopped = false;
    const release = () => { if (!stopped) { stopped = true; unlock(); } };
    process.on('exit', release);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
    server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; release(); });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.listen(port, '0.0.0.0', () => console.log(`顺序选择已启动：http://localhost:${port}\n局域网请使用本机 IP 和同一端口。按 Ctrl+C 停止。`));
  } catch (error) {
    unlock?.();
    console.error(`启动失败：${error.code === 'ENOENT' ? '缺少 data.json，请先运行 init.cmd。' : error.message}`);
    process.exitCode = 1;
  }
}
