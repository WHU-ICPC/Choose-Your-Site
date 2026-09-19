import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { ROOT, parseInputs, digest, publicState, atomicWrite, acquireLock, advanceTurns } from '../lib.mjs';
import { createApp } from '../server.mjs';

test('UTF-8, BOM, CRLF, repeated names and permission rules', () => {
  const data = parseInputs('\uFEFF靠窗 2\r\n安静 3\r\n讨论 1', '张三\r\n李四 +靠窗 +安静\r\n王五 -讨论\r\n张三');
  assert.deepEqual(data.people.map(person => person.number), [1, 2, 3, 4]);
  assert.deepEqual(data.people.map(person => person.allowed), [[1, 2, 3], [1, 2], [1, 2], [1, 2, 3]]);
  assert.equal(data.people[3].name, '张三');
});

test('invalid configuration is rejected', () => {
  for (const [options, people] of [
    ['A 0', '张三'], ['A 1\nA 2', '张三'], ['A 2', '张三 +B'],
    ['A 2\nB 2', '张三 +A -B'], ['A 2', '张三 -A'],
    ['A 1', '甲\n乙'], ['', '甲'], ['A 1', ''], ['A 9007199254740992', '甲']
  ]) assert.throws(() => parseInputs(options, people));
});

test('public view exposes neither tokens nor unselected participant list', () => {
  const data = parseInputs('A 2', '甲\n乙');
  data.people[0].tokenHash = 'secret';
  const text = JSON.stringify(publicState(data));
  assert.ok(!text.includes('secret') && !text.includes('tokenHash') && !text.includes('allowed') && !text.includes('乙'));
});

test('server enforces auth, ordering, permissions, capacity, single use and durable commits', async t => {
  const directory = fs.mkdtempSync(path.join(ROOT, '.test-'));
  const data = parseInputs('A 1\nB 2\nC 1', '甲\n乙 +A +B\n丙 -C');
  const tokens = ['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43)];
  data.people.forEach((person, i) => { person.tokenHash = digest(tokens[i]); });
  const filename = path.join(directory, 'data.json');
  atomicWrite(filename, JSON.stringify({ version: 1, ...data }));
  let server = createApp(directory);
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, index, optionId) => {
    const response = await fetch(base + route, {
      method: optionId === undefined ? 'GET' : 'POST',
      headers: { ...(index === undefined ? {} : { Authorization: `Bearer ${tokens[index]}` }), 'Content-Type': 'application/json' },
      ...(optionId === undefined ? {} : { body: JSON.stringify({ optionId }) })
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/api/me')).status, 401);
  assert.equal((await request('/api/me', 0)).body.name, '甲');
  assert.equal((await request('/api/choose', 1, 2)).status, 409);
  assert.equal((await request('/api/choose', 0, 99)).status, 400);
  assert.equal((await request('/api/choose', 0, '1')).status, 400);
  const simultaneous = await Promise.all([request('/api/choose', 0, 1), request('/api/choose', 0, 1)]);
  assert.deepEqual(simultaneous.map(result => result.status).sort(), [200, 409]);
  assert.equal((await request('/api/choose', 1, 3)).status, 400);
  assert.equal((await request('/api/choose', 1, 1)).status, 409);
  assert.equal((await request('/api/choose', 1, 2)).status, 200);
  await new Promise(resolve => server.close(resolve));
  server = createApp(directory);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await request('/api/me', 0)).body.choice, 1);
  assert.equal((await request('/api/state')).body.current.number, 3);
  assert.equal((await request('/api/choose', 2, 2)).status, 200);
  const final = (await request('/api/state')).body;
  assert.equal(final.current, null);
  assert.deepEqual(final.completed.map(person => person.number), [1, 2, 3]);
  assert.deepEqual(final.options.map(option => option.remaining), [0, 0, 1]);
  for (const route of ['/data.json', '/tokens.txt', '/people.txt', '/options.txt', '/../data.json']) {
    assert.equal((await fetch(base + route)).status, 404);
  }
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.ok(html.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.ok((await html.text()).includes('顺序选择'));
});

test('a second process cannot acquire an active data lock', () => {
  const directory = fs.mkdtempSync(path.join(ROOT, '.test-'));
  const release = acquireLock(directory);
  try { assert.throws(() => acquireLock(directory), /数据正在使用/); }
  finally { release(); fs.rmSync(directory, { recursive: true }); }
});

test('optional headers default to unlimited and validate configuration', () => {
  const plain = parseInputs('A 2', '甲');
  assert.equal(plain.timeLimitSeconds, null);
  assert.equal(plain.title, '顺序选择');
  const configured = parseInputs('@title 第一轮 座位选择\n@timeout 30\nA 2', '甲');
  assert.equal(configured.title, '第一轮 座位选择');
  assert.equal(configured.timeLimitSeconds, 30);
  for (const timeout of ['0', '无限']) assert.equal(parseInputs(`@timeout ${timeout}\nA 2`, '甲').timeLimitSeconds, null);
  for (const input of ['@timeout -1\nA 2', '@timeout 1.5\nA 2', '@title \nA 2', '@timeout 3\n@timeout 4\nA 2', 'A 2\n@timeout 3']) {
    assert.throws(() => parseInputs(input, '甲'));
  }
});

test('deadline boundaries, offline catch-up, preferences, full fallback and blocked turns', () => {
  const data = parseInputs('@timeout 2\nA 1\nB 2\nC 1', '甲 +A\n乙 +A +B\n丙 +B');
  data.people[1].preferences = [1, 2];
  advanceTurns(data, 1000, () => 0);
  advanceTurns(data, 2999, () => 0);
  assert.equal(data.people[0].choice, null);
  advanceTurns(data, 3000, () => 0);
  assert.deepEqual(data.people.map(person => person.choice), [1, 2, null]);
  assert.equal(data.people[2].turnStartedAt, 3000);
  advanceTurns(data, 10000, () => 0);
  assert.equal(data.people[2].choice, 2);
  assert.equal(data.people[2].chosenAt, new Date(5000).toISOString());
  const unlimited = parseInputs('A 2', '甲\n乙');
  advanceTurns(unlimited, 0);
  advanceTurns(unlimited, 999999);
  assert.equal(unlimited.people[0].choice, null);
  const blocked = parseInputs('@timeout 1\nA 1\nB 1', '甲 +A\n乙 +A');
  advanceTurns(blocked, 0, () => 0);
  advanceTurns(blocked, 5000, () => 0);
  assert.equal(blocked.people[1].choice, null);
});

test('private editable preferences persist, validate and execute in order', async t => {
  const directory = fs.mkdtempSync(path.join(ROOT, '.test-'));
  const data = parseInputs('A 1\nB 2\nC 1', '甲\n乙 -C\n丙');
  const tokens = ['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43)];
  data.people.forEach((person, i) => { person.tokenHash = digest(tokens[i]); });
  const filename = path.join(directory, 'data.json');
  atomicWrite(filename, JSON.stringify({ version: 1, ...data }));
  let server = createApp(directory);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true });
  });
  async function listen() {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  await listen();
  async function request(route, index, body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(index === undefined ? {} : { Authorization: `Bearer ${tokens[index]}` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('/api/preferences', undefined, { preferences: [1] })).status, 401);
  assert.equal((await request('/api/preferences', 0, { preferences: [1] })).status, 409);
  for (const preferences of [[3], [1, 1], ['1'], null, [99]]) {
    assert.equal((await request('/api/preferences', 1, { preferences })).status, 400);
  }
  for (const preferences of [[2, 1], [], [1, 2]]) {
    assert.equal((await request('/api/preferences', 1, { preferences })).status, 200);
    assert.deepEqual((await request('/api/me', 1)).body.preferences, preferences);
  }
  assert.ok(!JSON.stringify((await request('/api/state')).body).includes('preferences'));
  assert.deepEqual((await request('/api/me', 2)).body.preferences, []);
  const startedAt = JSON.parse(fs.readFileSync(filename)).people[0].turnStartedAt;
  await new Promise(resolve => server.close(resolve));
  server = createApp(directory);
  await listen();
  assert.equal(JSON.parse(fs.readFileSync(filename)).people[0].turnStartedAt, startedAt);
  assert.deepEqual((await request('/api/me', 1)).body.preferences, [1, 2]);
  await request('/api/preferences', 2, { preferences: [2] });
  assert.equal((await request('/api/choose', 0, { optionId: 1 })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename)).people.map(person => person.choice), [1, 2, 2]);
  assert.equal((await request('/api/preferences', 1, { preferences: [] })).status, 409);
});

test('timer selects without any browser requests', async t => {
  const directory = fs.mkdtempSync(path.join(ROOT, '.test-'));
  const data = parseInputs('@timeout 1\nA 1\nB 1', '甲 +B');
  data.people[0].tokenHash = digest('a'.repeat(43));
  const filename = path.join(directory, 'data.json');
  atomicWrite(filename, JSON.stringify({ version: 1, ...data }));
  const server = createApp(directory);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const until = Date.now() + 5000;
  while (JSON.parse(fs.readFileSync(filename)).people[0].choice === null && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(JSON.parse(fs.readFileSync(filename)).people[0].choice, 2);
});
