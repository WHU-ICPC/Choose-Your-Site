import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, SOURCE, acquireLock, atomicWrite, digest, publicState, readUtf8, advanceTurns, parseInputs, issueTokens } from './lib.mjs';

export function createApp(directory = ROOT, now = Date.now) {
  const filename = path.join(directory, 'data.json');
  let data = { version: 2, ...parseInputs(readUtf8(path.join(directory, 'options.txt')), readUtf8(path.join(directory, 'people.txt'))) };
  const tokens = new Map();
  function commit(next) {
    atomicWrite(filename, JSON.stringify(next, null, 2) + '\n');
    data = next;
  }
  function advance() {
    const next = structuredClone(data);
    if (advanceTurns(next, now())) commit(next);
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
      if (request.method === 'GET' && pathname === '/api/state') return json(response, 200, publicState(data, now()));
      if (!['/api/me', '/api/settings', '/api/preferences'].includes(pathname)) return json(response, 404, { error: '未找到此页面。' });
      const token = /^Bearer ([A-Za-z0-9]{10})$/.exec(request.headers.authorization || '')?.[1];
      const name = token && tokens.get(digest(token));
      const admin = token && digest(token) === data.adminTokenHash;
      if (name === undefined && !admin) return json(response, 401, { error: 'Token 无效，请检查后重试。' });
      if (request.method === 'GET' && pathname === '/api/me') {
        if (admin) return json(response, 200, { role: 'admin', name: '组织者' });
        const positions = data.people.filter(person => person.name === name).map(({ number, group, allowed, choice, lockedAt, preferences, confirmedChoice, confirmedAt }) => ({ number, group, allowed, choice, lockedAt, preferences, confirmedChoice, confirmedAt }));
        return json(response, 200, { role: 'participant', name, positions });
      }
      if (request.method !== 'POST' || !['/api/settings', '/api/preferences'].includes(pathname)) return json(response, 405, { error: '不支持此请求方式。' });
      if ((pathname === '/api/settings' && !admin) || (pathname === '/api/preferences' && admin)) return json(response, 403, { error: '此账户没有操作权限。' });
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') return json(response, 415, { error: '请求必须为 JSON。' });
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > Math.max(2048, data.options.length * 16)) return json(response, 413, { error: '请求过大。' });
      }
      let input;
      try { input = JSON.parse(body); } catch { return json(response, 400, { error: '请求格式不正确。' }); }
      advance();
      if (pathname === '/api/settings') {
        const timestamp = now();
        if (data.settings.startAt !== null && timestamp >= data.settings.startAt) return json(response, 409, { error: '活动已开始，设置已锁定。' });
        const { startAt, intervalSeconds } = input ?? {};
        if ((startAt !== null && (!Number.isSafeInteger(startAt) || startAt <= timestamp)) || !Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 86400 || (startAt !== null && startAt + (data.people.length - 1) * intervalSeconds * 1000 > 8640000000000000)) {
          return json(response, 400, { error: '开始时刻需晚于当前时间，间隔需为 1 至 86400 的整数秒。' });
        }
        const next = structuredClone(data);
        next.settings = { startAt, intervalSeconds };
        commit(next);
        return json(response, 200, { ok: true });
      }
      const person = data.people.find(person => person.number === input?.number && person.name === name);
      if (!person) return json(response, 403, { error: '只能修改本人名下位置的排列。' });
      if (person.lockedAt !== null) return json(response, 409, { error: '选择已锁定。' });
      const preferences = input?.preferences;
      if (!Array.isArray(preferences) || preferences.length !== person.allowed.length || new Set(preferences).size !== preferences.length || preferences.some(id => !Number.isInteger(id) || !person.allowed.includes(id))) {
        return json(response, 400, { error: '倾向排列需包含全部允许项目，每项出现一次。' });
      }
      const confirmedChoice = preferences[0];
      const conflict = data.people.find(other => other.number !== person.number && other.name === person.name && other.group === person.group && (other.confirmedChoice === confirmedChoice || other.choice === confirmedChoice));
      if (conflict) return json(response, 409, { error: `此首选项已被你在同组的第 ${conflict.number} 位确认或锁定，请调整首选项。` });
      const confirmedAt = now();
      const next = structuredClone(data);
      next.people[person.number - 1].preferences = preferences;
      next.people[person.number - 1].confirmedChoice = confirmedChoice;
      next.people[person.number - 1].confirmedAt = confirmedAt;
      commit(next);
      return json(response, 200, { ok: true, preferences, confirmedChoice, confirmedAt });
    } catch (error) {
      console.error(error);
      if (!response.headersSent) json(response, 500, { error: '服务暂时无法保存或读取数据，请稍后重试。' });
      else response.end();
    }
  });
  let timer;
  server.on('listening', () => {
    try {
      const next = structuredClone(data);
      const issued = issueTokens(next);
      atomicWrite(path.join(directory, 'token.txt'), issued);
      commit(next);
      for (const person of data.people) tokens.set(person.tokenHash, person.name);
    } catch (error) {
      server.close();
      server.emit('error', error);
      return;
    }
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
    server.listen(port, '0.0.0.0', () => { if (server.listening) console.log(`顺序选择已启动：http://localhost:${port}\n请从 token.txt 发放本次启动生成的 10 位 Token。\n局域网请使用本机 IP 和同一端口。按 Ctrl+C 停止。`); });
  } catch (error) {
    unlock?.();
    console.error(`启动失败：${error.code === 'ENOENT' ? '请准备 options.txt 和 people.txt。' : error.message}`);
    process.exitCode = 1;
  }
}
