/**
 * 只读探针：查 harness 侧与「排队 / 重试延迟」相关的处理。
 *
 * 目的：确认 `QUEUE` 错误码是否属于可重试集合，以及 harness 是否认识
 * `retryAfterSeconds` 这类「服务端指定延迟」字段 —— 这决定我们的修法应该
 * 是「在适配器内部自己等待重试」还是「把延迟信息交给 harness」。
 *
 * 用法：node scripts/probe-dsh-retry-policy.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const BASE = process.env.DSH_ROOT
  ?? join(process.env.USERPROFILE ?? '', 'scoop', 'persist', 'nvm', 'nodejs', 'v26.10.0', 'node_modules', '@deepseek-ai', 'dsh')
/** ⚠️ 包在 `<dsh>/node_modules/@deepseek-ai/<pkg>` 下，**不是** `<dsh>/../<pkg>`。 */
const PKG_ROOT = join(BASE, 'node_modules', '@deepseek-ai')
const PKGS = ['dsh-llm', 'dsh-llm-retry']

const KEYWORDS = ['"QUEUE"', 'retryAfterMs', 'retryDelayMs', 'retryAfterSeconds', 'retryAfter']

function walk(dir, out = [], depth = 0) {
  if (depth > 4) return out
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { walk(p, out, depth + 1); continue }
    if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

for (const pkg of PKGS) {
  const dir = join(PKG_ROOT, pkg)
  if (!existsSync(dir)) { console.log(`  [${pkg}] 不存在`); continue }
  for (const f of walk(dir)) {
    const text = readFileSync(f, 'utf8')
    const hits = KEYWORDS.filter((kw) => text.includes(kw))
    if (hits.length === 0) continue
    console.log(`  [${pkg}] ${relative(dir, f)}`)
    console.log(`      命中: ${hits.join(', ')}`)
    // 打印 QUEUE 附近的上下文，看它是否被列入可重试
    for (const kw of hits) {
      const at = text.indexOf(kw)
      if (at < 0) continue
      const ctx = text.slice(Math.max(0, at - 200), at + 200).replace(/\s+/g, ' ')
      console.log(`      ${kw} @ …${ctx}…`)
    }
  }
}

console.log('\n=== 结论判据 ===')
console.log('  DEFAULT_RETRYABLE_CODES 含 AUTH → 则「把排队判成 AUTH」能重试（但延迟不受控）')
console.log('  含 QUEUE → 则让适配器抛 QUEUE 即可交给 harness 重试')
console.log('  两者都不含 → 重试必须由适配器内部完成（自己 delay）')
