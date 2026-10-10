/**
 * provider 的**行为能力注册表** —— 「按 provider id 找到它那套能力实现」的唯一入口。
 *
 * ## 它解决什么
 *
 * 重构前，RPC 层用 `switch (provider)` / 一长串 `else if` 分派到各家实现。
 * 实测（设计文档 §1.3）三类形态：
 *
 * | 形态 | 例子 | 分派点数 |
 * |---|---|---|
 * | **纯重复**：各分支做同一件事 | `account.refresh` 13 个 case **逐字同构** | 13 |
 * | **同构骨架 + 参数差异** | `credits.balances`（441 行）/ `credits.claimAll`（267 行） | 14 / 15 |
 * | **真协议差异** | qoder WASM 签名、codearts HMAC、trae 身份头 | 已封装在各家模块内 |
 *
 * 前两类里 RPC 层看到的**全是「选哪个函数」而不是「做什么逻辑」** ——
 * 那正是本注册表要消除的。第三类**不动**：协议实现留在各家模块内。
 *
 * ## ⚠️ 边界（别把这里做成「一套配置驱动所有 provider」）
 *
 * 抽象的是**编排**（选哪个原语、按什么顺序），**不是协议**（原语内部怎么实现）。
 * 故各家的 `*Expiry` / `fetch*Balance` / `claim*` 等原语函数**原样保留**，
 * 本文件只是把它们挂到一张可查的表上。
 *
 * ## ⚠️ 能力域全部可选，「不支持」用 `undefined` 表达
 *
 * RPC 层据此返回**既有的可读错误文案**（例如 cline 的「Cline 不支持每日签到
 * （其后端没有签到接口）」），**不得**退化成泛化的 `unsupported provider`
 * —— 后者会让排查者以为「provider 没注册」，而真相是「该产品无此能力」。
 * 这是本仓库反复记录过的缺陷形态。
 *
 * ## ⚠️ 本表与 `account.refresh` 的分派**无关**（2026-10-08 调序后修正）
 *
 * 初稿计划让 `account.refresh` 经本表分派，但 Task 9 已把 13 个 auth 实例变成
 * `registerJetHubRpc` 的**命名对象形参** `auths`，而 `account.refresh` 的 switch
 * 就在同一个闭包内 ⇒ 那里直接查 `authOf(auths, entry.provider)` 即可
 *（零全局状态、测试零改动，见 `jet-hub-rpc.ts`）。
 *
 * 本表的消费点是**拿不到 `auths` 形参**的跨模块场景（Task 5 的
 * `aggregate-expiry.ts`、Task 8 的 `account-probe.ts`）—— 即本文件是**前瞻接线**。
 */

import type { ProviderDescriptor } from './provider-registry.js'
import type { AccountPool } from './account-pool.js'
import type { CheckinStatus, CreditBalance } from './credits.js'
import type { RpcCreditsBalanceExtra } from './types.js'

/**
 * 调用上下文：把共享设施注入给各家实现，避免它们各自持有 ctx。
 *
 * ⚠️ 只放**跨 provider 通用**的东西。各家私有的依赖（product 配置、fetch 包装）
 * 由各家在注册时闭包捕获。
 */
export interface ProviderCallContext {
  /** 按 ref 名解析凭据（返回**原始字符串**，由各家自己 parse + 形状校验）。 */
  readonly resolveCredential: (refName: string) => Promise<{ value: string } | undefined>
  /** 日志出口（两级可选链语义：logger 缺席时静默）。 */
  readonly warn: (message: string) => void
  /** 账号池（少数实现需要，如 TRAE 的设备指纹代次读写）。 */
  readonly accountPool: AccountPool
}

/**
 * 一个 provider 的能力实现。
 *
 * ⚠️ **每个域都可选**：provider 只实现自己有的能力，`undefined` 即「不支持」。
 * 这样 cline 不必假装实现 `credits.claim`，aggregate 不必假装有 `auth`。
 */
export interface ProviderRuntime {
  /** 元数据（与 `PROVIDER_REGISTRY` 里那条同源，带上省一次查表）。 */
  readonly descriptor: ProviderDescriptor

  /**
   * 账号续期。
   *
   * ⚠️ 重构前 `account.refresh` 的 13 个 case 是**同一行调用**
   *（`auth.refreshAccountCredential(entry.credentialRef, pool, entry.id)`），
   * 只有实例名不同。
   *
   * ⚠️ **opencode 刻意没有本域**：它不参与续期（凭据是静态 API key）。
   * 它的 `account.refresh` 应返回可读错误，而不是被交给自己去刷一个不存在的端点。
   */
  readonly auth?: {
    /**
     * 续期**指定账号**。
     *
     * ⚠️ `pool` 与 `accountId` **必须都传**（issue !IKIRTT）：续期成功后要把新的
     * `expiresAt` 写回账号池，UI 才不再显示「已过期」。早先只有 raccoon 传了、
     * 其余七个分支漏传 —— 凭据续好了、界面纹丝不动，用户没有任何自救手段。
     *
     * ## ⚠️ 本字段**当前只被测试读**，生产路径**永远不会**消费它（Task 2 复审 Finding 6）
     *
     * 如实登记，免得下一个读者满仓找消费方：
     * - `account.refresh` 走 `registerJetHubRpc` 的 **`auths` 形参**
     *  （`authOf(auths, entry.provider)`），**不查本表**（见本文件模块头）；
     * - Task 5 的 `aggregate-expiry.ts` 只用 `expiry`；
     * - Task 8 的 `account-probe.ts` 用 `probe`；
     * - Task 10 读的是 `auth.refreshAll` —— ⚠️ 该字段**由 Task 10 自己加进来**
     *  （见计划 Task 10 的「auth 域补 `refreshAll?`」），不是本 Task 的产物。
     *
     * ⚠️ **Task 3 曾计划由本字段提供 `usesExpiryWindow`，执行时改为直接读
     * `descriptorOf(provider)`**（见 `jet-hub-rpc.ts` 的 `credits.balances`）——
     * 本表与 `credits` 表是**两条独立的接线**，让 `credits.balances` 同时依赖
     * 两者只会多一个「哪份没接上」的失败面。`descriptorOf` 是纯数据查表，
     * 零状态，与全局注册表无关。故本字段**仍未**有生产消费者。
     *
     * ⇒ 它的**唯一**消费者是 `tests/unit/provider-runtime-wiring.spec.ts`
     * （真跑 `apply()` 后调 `runtimeOf(id).auth.refreshAccount`，据此证明
     * 「`src/index.ts` 的注册清单把每个 id 接到了**自己的**实例上」——
     * 那是「中国版账号用国际版凭据续期」这个历史复发 6 次形态的防线）。
     *
     * ⚠️ **保留它是 plan 明确要求的前瞻接线**（本文件模块头），且那条守卫**真的需要**
     * 一个可调用的入口 —— 删掉本字段等于删掉那组行为用例。
     * 但别把它当成「生产会用到」的接口来依赖：**要接生产消费点，先改这段注释。**
     */
    refreshAccount(refName: string, pool: AccountPool, accountId: string): Promise<void>
  }

  /**
   * 积分能力：余额与签到状态。
   *
   * ## ⚠️ 这两个方法只作**既有共享骨架的入参**，骨架本身**不重写**
   *
   * - `collectCreditBalances` 的「**顺序**查询避免并发触发风控」是实测结论
   *  （见该函数的注释），改成 `Promise.all` 会让上游按账号数并发打过来；
   * - 单账号失败**不抛错**而是返回 `{ ok: false }` 条目 —— 让一个号查不到
   *   不至于让整个选号失败；
   * - `collectCreditsStatus` 的逐账号 try/catch 同义。
   *
   * 故本域只是「**选哪个函数**」，各家 `fetch*Balance` 原语一行不动
   * （设计文档 §3.5 的边界：抽象编排，不抽象协议）。
   *
   * ## ⚠️ 本域**不是** `credits.balances` / `credits.status` 的分派来源
   *
   * 那两个端点的表由 `registerJetHubEndpoints` **从已解构的 `auths` 现造**
   *（`src/jet-hub-rpc.ts:1308` 的 `createProviderCredits({ loomy, raccoon, zcode })`），
   * **不是**本表。
   *
   * ⚠️ **历史上这里一度是第 5 个命名对象形参**（与 Task 9 的 `auths` 同法），
   * 2026-10-08 的 C1 修正把它删掉了 —— 理由是它在**生产路径纯冗余**
   *（`src/index.ts` 与端点侧传的是**同一批实例**），却重新打开了
   * 「位置参数错位」那个本仓库自陈**复发 6 次**的门。⇒ 现在两侧各自从
   * `auths` 派生，**没有形参、也没有全局状态**。
   *
   * ⇒ 生产路径上本域**当前只被测试读**：
   *   `credits-runtime-parity.spec.ts`（「credits 域注册在 ProviderRuntime 上」）
   *   与 `provider-runtime-wiring.spec.ts`（「每个有余额能力的渠道都挂上了 credits 域」）。
   *   与 `auth.refreshAccount` 同款，**如实登记**，免得下一个读者满仓找消费方。
   *   它是给**拿不到 `auths` 形参**的跨模块场景（Task 5 / 8）留的接口 ——
   *   **要接生产消费点，先改这段注释。**
   *
   * ## ⚠️ 为什么 `fetchBalance` 与 `fetchBalanceDetailed` 二选一
   *
   * `fetchBalance` 用 `null` 表达「查不到」，调用侧统一补一句「余额查询失败」。
   * 但有些渠道的失败**必须区分**（codearts 的「Token 计费账户」/
   * 「非积分计费账户」/「未返回积分数据」三态，gemini 的「尚未授权」）——
   * 把它们压成同一句会让用户按错误方向排查（本仓库反复记录过该缺陷）。
   * 此时用 `fetchBalanceDetailed`，原因由实现自己给。
   */
  readonly credits?: ProviderCredits
}

/** 一个 provider 的积分能力实现（见 {@link ProviderRuntime.credits}）。 */
export interface ProviderCredits {
  /**
   * 查该账号的积分余额。
   *
   * @returns `null` 表示「查不到」（**不是 0** —— 把失败画成 0 会让用户以为
   *   额度被清空）；调用侧据此显示原因。
   */
  fetchBalance?(credential: unknown, call: ProviderCallContext): Promise<CreditBalance | null>
  /**
   * 查余额（**带原因**）。与 {@link fetchBalance} 二选一，本方法优先。
   *
   * 回 `error` 时 `balance` 必须是 `null`（**不要编造 0**）。
   */
  fetchBalanceDetailed?(credential: unknown, call: ProviderCallContext): Promise<ProviderBalanceDetail>
  /**
   * 查签到状态（部分渠道的 claim 需要它做幂等判据，见 `precheckStatus`）。
   *
   * ⚠️ **未实现 = 该渠道没有与 `CheckinStatus` 同构的状态端点**，
   * 调用侧据此**如实回 `null`**，不要臆造 `{ streakDays: 0 }`
   *（那会让面板显示「连续 0 天」这种看起来像真实读数的假数据）。
   */
  fetchStatus?(credential: unknown, call: ProviderCallContext): Promise<CheckinStatus | null>
}

/**
 * 带原因的余额查询结果。
 *
 * ⚠️ 形状与 `CreditsEndpointDeps.fetchBalanceDetailed` **刻意同构**：
 * 本域的值要直接喂给 `collectCreditBalances`，多一层翻译就多一处漂移。
 *
 * ⚠️ 用**一个**宽松形状而不是 `{balance} | {balance: null, error}` 联合：
 * 共享骨架自己会在 `balance === null && error === undefined` 时补
 * 「余额查询失败」，故「有 balance 同时带 error」不是需要类型排除的语义
 *（骨架本就按 `error` 优先读），而联合会让实现侧被迫写多余的收窄。
 */
export interface ProviderBalanceDetail {
  balance: CreditBalance | null
  error?: string
  extra?: RpcCreditsBalanceExtra
}

/** id → runtime。用 Map 而非普通对象：id 来自外部输入，避免原型链污染。 */
const runtimes = new Map<string, ProviderRuntime>()

/**
 * 注册一个 provider 的能力实现。
 *
 * ## ⚠️ 重复注册**不抛错** —— 保留现有 + 跳过本次
 *
 * 初稿写的是「重复注册抛错」，那是**错的**（本 Task 起草时实测纠正）：
 * 本仓库已有**实测的 fiber 重启竞态事故**（见 `src/llm-register-compat.ts` 的模块头）——
 * 宿主在启动过程中重启插件 fiber 时，**新 fiber 的同步 `apply()` 与旧 fiber 的
 * 异步 `dispose()` 交错执行**，于是 `apply()` 会在上一轮尚未清理完时再次注册。
 * 那时**抛错会让整个插件加载失败**（`plugin tree failed to load`），
 * 而这恰恰是 `llm-register-compat.ts` 记录过的同型事故。
 *
 * ⇒ 采用与 `llm-register-compat.ts` **同一个**语义（`isDuplicateRegistrationError`
 * 分支）：**保留现有条目、跳过本次注册**。理由是重启场景下「已存在的那条」
 * 是**上一轮同一个插件的注册**（同一代码），路由同样指向等价实现 ⇒ 语义等价。
 *
 * ⚠️ **这不等于静默覆盖**：保留的是**先注册者**（不会被后来者替换），
 * 故「先注册者静默失效」这个初稿担心的情形**不会发生**。
 * ⚠️ 也**不是吞错误**：非重复类的失败（如 descriptor 缺字段）照常抛。
 *
 * ⚠️ **返回值必须被调用方判**：`false` 在**生产**里是 fiber 重启竞态的正常现象
 *（应记 info，不是 error）；在**测试**里它更可能是「用例写错了」——
 * 故 `tests/helpers/rpc-refresh.ts` 之类若复用本函数，应把 false 当失败抛。
 *
 * @returns `true` = 本次真的注册了；`false` = 已存在、跳过了本次
 *   （调用方据此记日志，而不是靠猜）。
 */
export function registerProviderRuntime(runtime: ProviderRuntime): boolean {
  const id = runtime.descriptor.id
  if (runtimes.has(id)) {
    // ⚠️ 保留现有（先注册者），不覆盖 —— 与 llm-register-compat 的
    //    「保留现有路由并跳过本次注册」同义。
    return false
  }
  runtimes.set(id, runtime)
  return true
}

/** 按 id 取（未注册返回 `undefined`，由调用方决定报错措辞）。 */
export function runtimeOf(provider: string): ProviderRuntime | undefined {
  return runtimes.get(provider)
}

/**
 * 清空注册表。
 *
 * ⚠️ 只给**单测**与热重载用。生产路径不应调用 —— 清空后所有 provider 的能力
 * 一起消失，而 `apply()` 不会重新注册（它只在启动时跑一次）。
 */
export function clearProviderRuntimes(): void {
  runtimes.clear()
}

/**
 * 已注册的 id 列表（诊断与单测用）。
 *
 * ⚠️ 保持**注册顺序**（`Map` 的插入序），不要排序、不要 Set 化 ——
 * 排障时「哪个 provider 先注册上」是有用信息。
 */
export function registeredRuntimeIds(): string[] {
  return [...runtimes.keys()]
}
