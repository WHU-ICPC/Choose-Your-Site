import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, readUtf8, parseInputs, atomicWrite, acquireLock, digest } from './lib.mjs';

let unlock;
try {
  if (process.argv.length > 2) throw new Error('初始化不接收参数，固定读取 options.txt 和 people.txt。');
  unlock = acquireLock(ROOT);
  const dataFile = path.join(ROOT, 'data.json');
  const tokensFile = path.join(ROOT, 'tokens.txt');
  if (fs.existsSync(dataFile) || fs.existsSync(tokensFile)) {
    throw new Error('已有 data.json 或 tokens.txt。为防止丢失记录，拒绝覆盖；重置前请停止服务并备份、移走这两个文件。');
  }
  const data = parseInputs(readUtf8(path.join(ROOT, 'options.txt')), readUtf8(path.join(ROOT, 'people.txt')));
  const issued = data.people.map(person => {
    const token = crypto.randomBytes(32).toString('base64url');
    person.tokenHash = digest(token);
    return { name: person.name, number: person.number, token };
  });
  const collator = new Intl.Collator('zh-CN');
  issued.sort((a, b) => collator.compare(a.name, b.name) || a.number - b.number);
  atomicWrite(tokensFile, '\uFEFF姓名\t编号\tToken\r\n' + issued.map(person => `${person.name}\t${person.number}\t${person.token}`).join('\r\n') + '\r\n');
  atomicWrite(dataFile, JSON.stringify({ version: 1, ...data }, null, 2) + '\n');
  console.log(`初始化完成：${data.options.length} 个选项，${data.people.length} 个 token。\n请从 tokens.txt 单独发放 token，勿公开整个文件。`);
} catch (error) {
  console.error(`初始化失败：${error.message}`);
  process.exitCode = 1;
} finally {
  unlock?.();
}
