/**
 * **从 `PROVIDER_REGISTRY` 派生的「期望集合」唯一真源**（Task 11-F 引入）。
 *
 * ## ⚠️ 它解决什么
 *
 * 本次重构实测：同一批「谁是 X 类 provider」的判据在**多个测试文件里各写了一遍**，
 * 形态还分两种（硬编码 id 字面量 / 读带理由的豁免表）。实测两组的分布：
 *
 * | 语义 | 出现处 | 硬编码副本 |
 * |---|---|---|
 * | 「谁该占 auth 键位 / 该注册进能力表 / 该进批量续期表」 | 4 处（3 个文件） | 3 份 `d.id !== 'opencode'` |
 * | 「谁该进生产积分表」 | 3 处（2 个文件） | 3 份 `new Set(['opencode','qoder','qodercn'])` |
 *
 * ⚠️ 两组的**集合并不相同**（13 vs 11），故**不能合并成一个**：
 *
 * - 第一组判据是 `channel`（有没有账号/凭据/积分）减去 {@link AUTH_EXEMPT}；
 * - 第二组判据是 `credits.balance === true`（声明了余额能力）减去
 *   {@link CREDITS_TABLE_EXEMPT} —— **形态不匹配**、没法套共享骨架的那几家。
 *
 * ⚠️ 两者的豁免名单**恰好重合于 opencode**，但**理由毫无关系**：前者是
 * 「RPC 走 `handleOpencodeRpc`、没有 XxxAuth 服务」，后者是「余额是本地派生的
 * 通道可用性、零网络」。把它们当成一张表会**掩盖理由的差异**（本仓库反复记录的
 * 「同一份名单承载两种语义」缺陷形态），故**刻意分成两张表**。
 *
 * ## ⚠️ 为什么是函数而不是模块级常量
 *
 * 与 `src/provider-runtime.ts` 的派生表同因：调用方的期望集合要**现算**。
 * 本仓库的反向验证会**临时改写 `PROVIDER_REGISTRY`**（删一个字段、改一个布尔
 * 再跑用例），模块级常量会读到改写前的陈旧值 ⇒ 反向验证失效而无人察觉。
 * 另外调用方都要 `.sort()` 后的副本，缓存也省不下什么。
 *
 * ## ⚠️ 为什么这些判据不该由 `src/` 导出
 *
 * 它们是**测试的期望**（「我认为谁该有 auth」），不是生产契约。放进 `src/`
 * 会让「生产代码自己声明该接受什么」—— 那等于把守卫换成同义反复
 * （`AUTH_SERVICE` 与它比对就恒真了，这正是本仓库 2026-10-08 复审 Finding 1
 * 记录过的形态）。故留在 `tests/helpers/`。
 */

import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'

/**
 * 不占 auth 键位的两个 registry provider —— **理由不同，故必须分别被验证**。
 *
 * ⚠️ 这是一张**硬编码的豁免表**，不是「顺手写的名单」：registry 里**没有**
 * 「有没有 auth 服务」这个字段（`channel` 只表示「有没有账号/凭据/积分」），
 * 而唯一形似的字段 `settingsNamespace` 是**巧合而非语义**（它表示老契约
 * settings namespace；opencode 恰好是唯一没有它的 `channel`）—— 本仓库
 * AGENTS.md 明确反对用巧合字段推断语义（「用布尔而不是『有没有 accountExtras』
 * 来推断：那是巧合而非语义」）。故豁免只能显式列出，并由用例**验证理由**。
 *
 * ⚠️ 2026-10-08（Task 11-F）：本表原先定义在 `jet-hub-rpc-auth-wiring.spec.ts`，
 * 而 `channel` + 本表的判据在**四个文件里各写了一遍**—— 实测四处**集合完全相同**
 * （都是 13 家）。现集中到本文件，四处同读这一份，去掉三份硬编码副本。
 * ⚠️ 理由的**验证**仍留在 `jet-hub-rpc-auth-wiring.spec.ts`（它会调 `AUTH_SERVICE`，
 * 而 `AUTH_SERVICE` 在 apply 的作用域里，helper 拿不到）。
 */
export const AUTH_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['opencode', '它的 RPC 由 handleMethod 统一分派到 handleOpencodeRpc，没有 XxxAuth 服务'],
  ['aggregate', '它没有账号 / 凭据 / 续期（registry 的 channel: false）'],
])

/**
 * **期望**占 auth 键位 / 该注册进能力表 / 该进批量续期表的 provider id 集合
 * —— 唯一判据：`channel: true` 减去 {@link AUTH_EXEMPT}。
 *
 * ## ⚠️ 为什么四处共用一个函数，而不是各写一遍 `.filter((d) => d.channel && …)`
 *
 * 本次重构（Task 11-F）实测：同一判据在四个文件里出现，形态有**两种**——
 * 三处写 `d.id !== 'opencode'`（硬编码字面量），一处写 `!AUTH_EXEMPT.has(d.id)`
 * （带理由表）。两种形态**实测集合相同**（都是 13 家），但失效行为不同：
 *
 * - 硬编码那三处**没有理由**，新增一个「有账号但没有 auth 服务」的 provider 时，
 *   后人只能靠猜「为什么偏偏是 opencode」；
 * - 更糟的是它们**各自独立**：改一处漏另两处 ⇒ 三处断言对「13」的期望分叉，
 *   而症状是三条看起来无关的用例一起红。
 *
 * ⚠️ 被测对象各不相同（`AUTH_SERVICE` / `wiredRefreshTargets()` /
 * `registeredRuntimeIds()` / `REFRESH_PROVIDERS`），故**不构成**红线 #1
 *（一个语义两套判据）—— 语义（「谁该有 auth」）只有这一份，
 * 被测对象有四份，那正是用例该有的样子。⚠️ 注意它与
 * {@link expectedProviderIdsInCreditsTable} 是**两个不同的语义**（13 vs 11），
 * 别因为「都排除了 opencode」就把两者当成一份。
 */
export function expectedProviderIdsWithAuth(): string[] {
  return PROVIDER_REGISTRY
    .filter((d) => d.channel && !AUTH_EXEMPT.has(d.id))
    .map((d) => d.id)
}

/**
 * 声明了余额能力（`credits.balance === true`）却**刻意不进**生产积分表的渠道。
 *
 * 判据见 `src/provider-credits.ts` 的模块头（「哪些渠道不在这里」一节）：
 *
 * - `opencode`：它的「余额」是**本地派生的通道可用性**（读账号池的
 *   `modelRateLimits`），**零网络请求**。套进 `fetchBalance(credential, …)`
 *   形状会逼它去发一个不存在的上游请求。
 * - `qoder` / `qodercn`：余额原语只吃 `QoderCredential`、且 product 来自同族
 *   注册表，**与共享骨架的 `(credential, product)` 泛型不兼容**。
 *
 * ⚠️ 与 {@link AUTH_EXEMPT} **不是同一张表**（虽然都含 `opencode`）：
 * 那张是「没有 auth 服务」，这张是「余额形态套不进骨架」。两者各自有
 * 独立的验证用例，别合并。
 */
export const CREDITS_TABLE_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['opencode', '余额是本地派生的通道可用性（零网络），套 fetchBalance 形状会发不存在的请求'],
  ['qoder', 'fetchQoderCreditBalance 只吃 QoderCredential，与共享骨架的泛型不兼容'],
  ['qodercn', '同 qoder（两者复用同一个 QoderAuth，余额原语同形）'],
])

/**
 * **期望**进生产积分表（`createProviderCredits()`）的 provider id 集合
 * —— 唯一判据：`credits.balance === true` 减去 {@link CREDITS_TABLE_EXEMPT}。
 *
 * ⚠️ 判据是 `credits.balance === true`（**声明了余额能力**）而不是 `channel`
 * —— 两者实测不等价：`aggregate` 的 `balance` 是 `false` 而它同时也不是
 * `channel`；用错判据会把「声明了余额却没进表」的真漏接掩盖过去。
 *
 * ⚠️ 2026-10-08（Task 11-F）：本判据原先在 `credits-runtime-parity.spec.ts`
 * （**同一文件里两处**）与 `provider-runtime-wiring.spec.ts` 里各写了一遍
 * （三份 `new Set([...])` 硬编码），现收敛到这里。
 */
export function expectedProviderIdsInCreditsTable(): string[] {
  return PROVIDER_REGISTRY
    .filter((d) => d.credits.balance === true && !CREDITS_TABLE_EXEMPT.has(d.id))
    .map((d) => d.id)
}
