/**
 * auto 选型：**额度已尽的 provider 必须退出候选**。
 *
 * ## 缺陷（真实，用户报障 2026-10-07）
 *
 * auto 选中了额度已尽的 zcode，请求直接以
 * `QUOTA_EXCEEDED: 账号在模型 "GLM-5.3" 上的额度已用尽或没有可用权益` 失败 ——
 * 而 auto 的价值主张恰恰是「挑有额度、且快作废的那个」。折算错了就挑中一个**根本
 * 不能用**的 provider，比不做 auto 更糟（用户看到的是「auto 坏了」）。
 *
 * 根因在两个 `*Expiry` 把「余额为 0」折算成了**可用**的语义：
 * - `codeArtsExpiry`：`credit.total`（= **剩余额度**，见 issue IKJQ3M 核验）
 *   为 0 时返回 `NEVER`（= 永久，排最后但**不被剔除**）；
 * - `zcodeExpiry`：无有效桶时返回 `nextUtc8DayStartMs()`（= 当日，**排最前**），
 *   「有可领的每日活动」也被当作有额度。
 *
 * ## 为什么这类缺陷编译期抓不到
 *
 * `pickSoonestProvider` 只认 `UNUSABLE`（剔除）与其它一切（按时刻升序参与排序），
 * 折算错成 `NEVER` / 当日都是**合法返回值** —— 只能靠断言守住。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADAPTER = readFileSync(resolve(HERE, '../../src/auto-adapter.ts'), 'utf8')

/** 取某个 `private async <name>` 函数的函数体片段。 */
const bodyOf = (name: string): string =>
  new RegExp(`private async ${name}\\([\\s\\S]*?\\n  \\}`).exec(ADAPTER)?.[0] ?? ''

describe('auto：额度已尽的 provider 退出候选', () => {
  it('codeArtsExpiry：total 是剩余额度，为 0 即不可用（不是「永久」）', () => {
    const fn = bodyOf('codeArtsExpiry')
    expect(fn.length, '应能取到 codeArtsExpiry').toBeGreaterThan(0)
    // ⚠️ 关键：`0` 必须折算 UNUSABLE。写成 NEVER 时它排在最后但**仍会被选中** ——
    // 当池里只有它有额度时就必然选中它，然后 QUOTA_EXCEEDED。
    expect(fn).toMatch(/total > 0 \? nextUtc8DayStartMs\(\) : UNUSABLE/)
    expect(fn).not.toMatch(/total > 0 \? nextUtc8DayStartMs\(\) : NEVER/)
  })

  it('zcodeExpiry：没有有效桶即不可用（「可领活动」不等于有额度）', () => {
    const fn = bodyOf('zcodeExpiry')
    expect(fn.length, '应能取到 zcodeExpiry').toBeGreaterThan(0)
    // 桶里有余额才按其 expiresAt 排序；否则一律 UNUSABLE。
    expect(fn).toMatch(/if \(earliest !== NEVER\) return earliest/)
    expect(fn).toMatch(/return UNUSABLE\s*\}\s*$/)
    // 「有可领的每日活动」曾被折算成当日额度 —— 那是「预测将有额度」，不是「有额度」。
    // ⚠️ 判据只查**代码**：函数体注释里说明这条历史教训的 `claimablePlans` 一词
    // 不参与匹配（先剥掉行注释再断言）。
    const code = fn.replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/claimablePlans/)
  })

  it('loomy 是正例口径：只有真永久积分才折算 NEVER（勿把三处改成一刀切）', () => {
    const fn = bodyOf('loomyExpiry')
    expect(fn.length, '应能取到 loomyExpiry').toBeGreaterThan(0)
    expect(fn).toMatch(/permanent > 0 \? NEVER : UNUSABLE/)
    // loomy 的 `daily > 0`（**实测已下发**的当日赠送）才按当日额度算 —— 与
    // zcode 的 `claimablePlans`（尚未领取）语义不同，不可混同。（上游用 if 语句。）
    expect(fn).toMatch(/if \(detail\.daily > 0\) return nextUtc8DayStartMs\(\)/)
  })

  it('注释说清「额度要先领才存在」，避免后人把 claimablePlans 加回来', () => {
    const fn = bodyOf('zcodeExpiry')
    // 判据的**理由**必须留在代码里：这个折算被改错过一次，就会有人「顺手修回去」。
    expect(fn).toMatch(/额度要先领才存在|没领\s*\n?\s*\*\s*就是当前不可用|要先领才存在/)
  })
})