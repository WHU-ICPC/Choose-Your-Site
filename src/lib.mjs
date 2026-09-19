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
  const headers = new Set();
  while (rows[0]?.text.startsWith('@')) {
    const { text, line } = rows.shift();
    const match = /^@(title)\s+(.+)$/.exec(text);
    if (!match || headers.has(match[1])) throw new Error(`options.txt 第 ${line} 行：标题配置无效或重复。`);
    headers.add(match[1]);
    if (match[1] === 'title') title = match[2].trim();
  }
  const options = rows.map(({ text, line }, index) => {
    if (text.startsWith('@')) throw new Error(`options.txt 第 ${line} 行：配置必须放在所有选项之前。`);
    const match = /^(\S+)\s+([1-9]\d*)(?:\s+([^\s+#-][^\s]*))?$/.exec(text);
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error(`options.txt 第 ${line} 行：应为“选项名称 正整数容量 [组别]”，组名不能含空白或以 +、-、# 开头。`);
    if (names.has(match[1])) throw new Error(`options.txt 第 ${line} 行：选项名称重复。`);
    names.add(match[1]);
    return { id: index + 1, name: match[1], capacity: Number(match[2]), group: match[3] ?? '0' };
  });
  if (!options.length) throw new Error('options.txt 不能为空。');
  const people = lines(peopleText).map(({ text, line }, index) => {
    const fields = text.split(/\s+/);
    if (fields.length !== 2 || /^[+#-]/.test(fields[1])) throw new Error(`people.txt 第 ${line} 行：必须为“姓名 组别”，每行指定一个组别。`);
    const [name, group] = fields;
    const allowed = options.filter(option => option.group === group).map(option => option.id);
    if (!allowed.length) throw new Error(`people.txt 第 ${line} 行：组别“${group}”不存在。`);
    return { number: index + 1, name, group, allowed, choice: null, lockedAt: null, preferences: [...allowed], confirmedChoice: null, confirmedAt: null };
  });
  if (!people.length) throw new Error('people.txt 不能为空。');
  if (options.reduce((sum, option) => sum + option.capacity, 0) < people.length) {
    throw new Error('选项总容量小于选择机会数，请增加容量。');
  }
  return { title, settings: { startAt: null, intervalSeconds: null }, options, people };
}

export function issueTokens(data) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const hashes = new Set([data.adminTokenHash, ...data.people.map(person => person.tokenHash)]);
  function generate() {
    let token;
    do {
      token = Array.from({ length: 10 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
    } while (hashes.has(digest(token)));
    hashes.add(digest(token));
    return token;
  }
  const adminToken = generate();
  data.adminTokenHash = digest(adminToken);
  const accounts = new Map();
  for (const person of data.people) {
    if (!accounts.has(person.name)) accounts.set(person.name, generate());
    const token = accounts.get(person.name);
    person.tokenHash = digest(token);
  }
  const collator = new Intl.Collator('zh-CN');
  const issued = [...accounts].sort(([first], [second]) => collator.compare(first, second));
  return '\uFEFF姓名\tToken\r\n' + `【管理员】\t${adminToken}\r\n` + issued.map(([name, token]) => `${name}\t${token}`).join('\r\n') + '\r\n';
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

export function publicState(data, now = Date.now()) {
  const used = new Map(data.options.map(option => [option.id, 0]));
  for (const person of data.people) {
    if (person.choice !== null) used.set(person.choice, used.get(person.choice) + 1);
  }
  const current = data.people.find(person => person.lockedAt === null);
  return {
    title: data.title ?? '顺序选择',
    settings: data.settings,
    serverNow: now,
    deadline: current && data.settings.startAt !== null ? data.settings.startAt + (current.number - 1) * data.settings.intervalSeconds * 1000 : null,
    options: data.options.map(option => ({ ...option, remaining: option.capacity - used.get(option.id) })),
    completedCount: data.people.filter(person => person.lockedAt !== null).length,
    people: data.people.map(person => ({
      number: person.number, name: person.name, group: person.group, lockedAt: person.lockedAt,
      option: data.options.find(option => option.id === person.confirmedChoice)?.name ?? '尚未选择'
    })),
    current: current ? { number: current.number, name: current.name } : null,
    total: data.people.length
  };
}

export function advanceTurns(data, now = Date.now()) {
  if (data.settings.startAt === null) return false;
  let changed = false;
  const remaining = new Map(publicState(data, now).options.map(option => [option.id, option.remaining]));
  for (const person of data.people) {
    if (person.lockedAt !== null) continue;
    const deadline = data.settings.startAt + (person.number - 1) * data.settings.intervalSeconds * 1000;
    if (now < deadline) break;
    const selected = new Set(data.people.filter(other => other.number !== person.number && other.name === person.name && other.group === person.group && other.lockedAt !== null).map(other => other.choice));
    person.choice = person.preferences.find(id => person.allowed.includes(id) && remaining.get(id) > 0 && !selected.has(id)) ?? null;
    person.lockedAt = deadline;
    if (person.choice !== null) remaining.set(person.choice, remaining.get(person.choice) - 1);
    changed = true;
  }
  return changed;
}
