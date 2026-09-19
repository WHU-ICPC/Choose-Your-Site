import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SOURCE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(SOURCE);
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function readUtf8(filename) {
  return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filename)).replace(/^\uFEFF/, '');
}

function lines(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map((text, index) => ({ text: text.trim(), line: index + 1 })).filter(row => row.text);
}

export function parseInputs(optionsText, peopleText) {
  const names = new Set();
  const rows = lines(optionsText);
  let title = '顺序选择';
  let timeLimitSeconds = null;
  const headers = new Set();
  while (rows[0]?.text.startsWith('@')) {
    const { text, line } = rows.shift();
    const match = /^@(title|timeout)\s+(.+)$/.exec(text);
    if (!match || headers.has(match[1])) throw new Error(`options.txt 第 ${line} 行：标题或限时配置无效或重复。`);
    headers.add(match[1]);
    if (match[1] === 'title') title = match[2].trim();
    else if (match[2] !== '无限') {
      const seconds = Number(match[2]);
      if (!/^\d+$/.test(match[2]) || !Number.isSafeInteger(seconds) || seconds > 2147483647) throw new Error('限时必须为 0 至 2147483647 的整数秒，0 或“无限”表示不限时。');
      timeLimitSeconds = seconds || null;
    }
  }
  const options = rows.map(({ text, line }, index) => {
    if (text.startsWith('@')) throw new Error(`options.txt 第 ${line} 行：配置必须放在所有选项之前。`);
    const match = /^(\S+)\s+([1-9]\d*)$/.exec(text);
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error(`options.txt 第 ${line} 行：应为“选项名称 正整数”，名称不能含空白。`);
    if (names.has(match[1])) throw new Error(`options.txt 第 ${line} 行：选项名称重复。`);
    names.add(match[1]);
    return { id: index + 1, name: match[1], capacity: Number(match[2]) };
  });
  if (!options.length) throw new Error('options.txt 不能为空。');
  const people = lines(peopleText).map(({ text, line }, index) => {
    const [name, ...rules] = text.split(/\s+/);
    let allowed = options.map(option => option.id);
    if (rules.length) {
      const mode = rules[0][0];
      if (!['+', '-'].includes(mode) || rules.some(rule => rule[0] !== mode || !names.has(rule.slice(1)))) {
        throw new Error(`people.txt 第 ${line} 行：请使用同一种 +选项名 或 -选项名，且选项必须存在。`);
      }
      const selected = new Set(rules.map(rule => rule.slice(1)));
      allowed = options.filter(option => mode === '+' ? selected.has(option.name) : !selected.has(option.name)).map(option => option.id);
    }
    if (!allowed.length) throw new Error(`people.txt 第 ${line} 行：没有任何允许的选项。`);
    return { number: index + 1, name, allowed, choice: null, chosenAt: null, preferences: [], turnStartedAt: null };
  });
  if (!people.length) throw new Error('people.txt 不能为空。');
  if (options.reduce((sum, option) => sum + option.capacity, 0) < people.length) {
    throw new Error('选项总容量小于选择机会数，请增加容量。');
  }
  return { title, timeLimitSeconds, options, people };
}

export function atomicWrite(filename, content) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx');
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

// One process owns the data, including initialization. Recover only provably stale locks.
export function acquireLock(directory) {
  const filename = path.join(directory, 'app.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(filename, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.unlinkSync(filename);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(filename, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('锁文件异常，请确认服务已停止后删除 app.lock。');
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if (probe.code === 'ESRCH') {
          fs.unlinkSync(filename);
          continue;
        }
      }
      throw new Error('数据正在使用，请先停止服务或其他初始化进程。');
    }
  }
  throw new Error('无法取得数据锁。');
}

export function publicState(data) {
  const used = new Map(data.options.map(option => [option.id, 0]));
  for (const person of data.people) {
    if (person.choice !== null) used.set(person.choice, used.get(person.choice) + 1);
  }
  const current = data.people.find(person => person.choice === null);
  return {
    title: data.title ?? '顺序选择',
    timeLimitSeconds: data.timeLimitSeconds ?? null,
    serverNow: Date.now(),
    deadline: current?.turnStartedAt != null && data.timeLimitSeconds ? current.turnStartedAt + data.timeLimitSeconds * 1000 : null,
    options: data.options.map(option => ({ ...option, remaining: option.capacity - used.get(option.id) })),
    completed: data.people.filter(person => person.choice !== null).map(person => ({
      number: person.number, name: person.name,
      option: data.options.find(option => option.id === person.choice).name
    })),
    current: current ? { number: current.number, name: current.name } : null,
    total: data.people.length
  };
}

// Advance all immediately resolvable turns, including deadlines elapsed while offline.
export function advanceTurns(data, now = Date.now(), randomIndex = crypto.randomInt) {
  let changed = false;
  let start = now;
  for (const person of data.people) {
    if (person.choice !== null) continue;
    if (person.turnStartedAt == null) {
      person.turnStartedAt = start;
      changed = true;
    }
    const available = publicState(data).options.filter(option => person.allowed.includes(option.id) && option.remaining > 0);
    if (!available.length) break;
    let choice = (person.preferences ?? []).find(id => available.some(option => option.id === id));
    let chosenAt = person.turnStartedAt;
    let source = 'preference';
    if (choice === undefined) {
      const deadline = data.timeLimitSeconds ? person.turnStartedAt + data.timeLimitSeconds * 1000 : null;
      if (deadline === null || now < deadline) break;
      choice = available[randomIndex(available.length)].id;
      chosenAt = deadline;
      source = 'timeout';
    }
    person.choice = choice;
    person.chosenAt = new Date(chosenAt).toISOString();
    person.choiceSource = source;
    start = chosenAt;
    changed = true;
  }
  return changed;
}
