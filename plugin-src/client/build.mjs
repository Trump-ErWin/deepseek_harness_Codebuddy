import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/client/jet-hub.js');

// 加载器 id 必须与 package.json 的 `name` 逐字一致：DSH 以包名认领客户端注册，
// 两者不一致时报 `loaded without registering "<包名>"` 并中止加载。
// 从 package.json 派生而非硬编码，使改名时的两处（包名 / 此处）不可能再漂移。
const packageName = JSON.parse(
  await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
).name;
if (typeof packageName !== 'string' || packageName.length === 0) {
  throw new Error('package.json 缺少合法的 name 字段');
}
const loaderId = packageName;

const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  // 默认 charset 为 'ascii'，会把所有中文转义成 \uXXXX：产物可读性差，
  // 且使「用 includes 校验产物文案」的做法天然失效。改用 utf8 后产物保留原文，
  // 加载器按 utf8 读取 bundle（dsh-client-modules 用 "utf8" 解码），故安全。
  charset: 'utf8',
  external: ['react', 'react-dom'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`Wrote ${outputPath}`);
