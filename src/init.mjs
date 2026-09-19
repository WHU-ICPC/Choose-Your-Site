import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readUtf8, parseInputs, atomicWrite, acquireLock } from './lib.mjs';

let unlock;
try {
  if (process.argv.length > 2) throw new Error('初始化不接收参数，固定读取 options.txt 和 people.txt。');
  unlock = acquireLock(ROOT);
  const dataFile = path.join(ROOT, 'data.json');
  const tokensFile = path.join(ROOT, 'token.txt');
  if (fs.existsSync(dataFile) || fs.existsSync(tokensFile)) {
    throw new Error('已有 data.json 或 token.txt。重置前请停止服务并备份、移走这两个文件。');
  }
  const data = parseInputs(readUtf8(path.join(ROOT, 'options.txt')), readUtf8(path.join(ROOT, 'people.txt')));
  atomicWrite(dataFile, JSON.stringify({ version: 2, ...data }, null, 2) + '\n');
  console.log(`初始化完成：${data.options.length} 个选项，${data.people.length} 个位置。\n启动服务后从 token.txt 发放 Token。`);
} catch (error) {
  console.error(`初始化失败：${error.message}`);
  process.exitCode = 1;
} finally {
  unlock?.();
}
