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
import type { CheckinStatus, ClaimOutcome, CreditBalance } from './credits.js'
import type {
  ProviderAccountEntry,
  RpcBuddyGrowthAccountResult,
  RpcCreditsBalanceExtra,
  RpcOnboardingClaimResponse,
  RpcOnboardingStatusResponse,
} from './types.js'

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
   *（`src/jet-hub-rpc.ts` 的 `createProviderCredits({ loomy, raccoon, zcode })`），
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

  /**
   * **一次性**新手任务 / 登录奖励（Loomy 新手任务、raccoon 桌面端登录奖励）。
   *
   * ⚠️ 与 `credits`（**每日**签到）语义独立：这里的每一项**每号只能领一次**
   *（Loomy 合计 10000 分、raccoon 3000 分），故是独立端点、也独立成域。
   * 把两者混在一个域里会诱导实现方拿「今天领过没」的判据去判「领过没」——
   * 那正是本仓库记录过的「一份语义两套判据」形态。
   *
   * ## ⚠️ 本域**当前只被测试读**（Task 4 复审 Finding 3）
   *
   * 与 {@link auth.refreshAccount} / {@link credits} 同款，**如实登记**，
   * 免得下一个读者满仓找消费方：
   * - 生产路径**零读者** —— `onboarding.status` / `onboarding.claim` 的表由
   *   `registerJetHubEndpoints` **从已解构的 `auths` 现造**
   *  （`src/jet-hub-rpc.ts` 的 `createProviderOnboarding({ loomy, raccoon })`），
   *   **不查本表**（理由与 `credits` 域同：位置参数错位是本仓库自陈复发 6 次的形态）；
   * - 它的**唯一**消费者是 `tests/unit/claim-runtime-parity.spec.ts` 的两条断言
   *  （「`credits.onboardingTasks === true` 的渠道，runtime 必须有
   *   `onboarding.claim` / `onboarding.status`」）—— 那是「能力声明与实现不许漂移」
   *   的守卫，需要一张可读的表才能成立。
   *
   * ⇒ 与 `credits` 同因，它是给**拿不到 `auths` 形参**的跨模块场景
   *（Task 5 的 `aggregate-expiry.ts`、Task 8 的 `account-probe.ts`）留的**前瞻接线**。
   * ⚠️ **要接生产消费点，先改这段注释。**
   */
  readonly onboarding?: ProviderOnboarding
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

  /**
   * 执行**每日**签到领取。
   *
   * ## ⚠️ 为什么必须收 `entry`（不能只有 credential + call）
   *
   * TRAE 的签到设备指纹代次存在**账号池**里，按 `entry.id` 读写：
   * `claimTraeDailyCheckin(…, pool.traeCheckinDeviceGenerationFor(entry.id),
   * next => pool.updateTraeCheckinDeviceGeneration(entry.id, next))`。
   * 把 `entry` 去掉会让这个功能**静默消失**（指纹永不自愈 ⇒ 反复撞 9074）。
   *
   * ⚠️ `entry` 是 `collectClaimResults` **本来就持有**的实参（它的循环变量），
   * 不是内部派生参数 —— 故收进本接口不构成「泄漏内部状态」。
   * （对比 {@link afterClaim} 的 `roundDeadlineAt`：那个才是骨架内部算出来的。）
   */
  claim?(
    credential: unknown,
    entry: ProviderAccountEntry,
    call: ProviderCallContext,
  ): Promise<ClaimOutcome>

  /**
   * **该产品没有签到端点**时给用户看的原因（`claim` 缺席时才有意义）。
   *
   * ⚠️ 为什么不能由端点用一句泛化模板拼（那是 brief Step 4 的写法）：
   * 三条文案是**实测报障修来的**，且各自信息量不同 —— 把它们压成
   * 「`${displayName} 不支持每日签到（其后端没有签到接口）`」会
   * ① 让 workbuddy 的文案变成「WorkBuddy (国际版) 不支持…」（`displayName`
   * 带括号后缀，与实测文案逐字不同）；
   * ② **整个丢掉** raccoon 那条可操作指引「登录奖励请在『新手任务』中领取」
   *（用户看完才知道下一步该点哪里）。⇒ 文案由**知道该产品形态的那一层**给。
   *
   * ⚠️ 缺席且 `claim` 也缺席时，端点回**旧的** `unsupported provider: X`
   *（gemini / opencode / aggregate 现状即此）—— 那是**刻意不动**的行为，
   * 改成「不支持每日签到」是一处需批准的 G3 例外（见 Task 4 报告）。
   */
  claimUnavailableReason?: string

  /**
   * 领取前是否先查 status。
   *
   * ⚠️ **两侧方向都不能"统一"，各有实测依据**：
   * - **必须 `false`**（流程自带预检，外部再查一次是**重复请求**，
   *   而且对 codearts 是**发错端点**——用 buddy 式的状态查询打华为端点必然失败）：
   *   `codearts`、`lobsterai`；
   * - **必须 `true`**：`trae` —— 它的 claim 对「今天已签到」是**幂等**的，
   *   重复领取同样返回 `{code:0, message:"success"}` 与真领取**无法区分**。
   *   早期照抄 LobsterAI 传了 false，于是已签到的账号被报成「领取成功」
   *  （真实报障：**显示成功但 +0 积分**）。判据只能是 status 的 `checked_in`。
   * - 省略（`undefined`）等价于 `true`（骨架的默认值）。
   *
   * ⚠️ **`qoder` / `qodercn` 也必须是 false，但它们与本字段无关**
   *（Task 4 复审 Finding Minor 4 更正：本文原先把它们列在上面那份名单里，
   * 而它们**根本不在这张表里** —— 两家是 `credits.claimAll` 的**端点特例分支**，
   * 理由见 `jet-hub-rpc.ts` 的 `isQoderFamily` 短路与
   * `src/provider-credits.ts` 的模块头）。那处特例分支**直接写死**
   * `precheckStatus: false`（`claimQoderDailyCheckin` 自带活动列表查询），
   * **不经过**本字段。⇒ 读到这份名单时别去 credits 表里找它们。
   *
   * ⚠️ **`loomy` 也必须显式 `false`，且理由与上面两家不同**（这是最容易漏的一格）：
   * 它**没有** {@link fetchStatus}，而骨架的默认 `precheck = deps.precheckStatus !== false`
   * 会拿 **buddy 式**的 `fetchCheckinStatus` 去打 Loomy 端点 —— 一次**必然失败的
   * 真实上游请求**。它自带幂等判据（响应体的 `alreadyProcessed`），不需要外部预检。
   * 由 `tests/unit/claim-runtime-parity.spec.ts` 的「loomy 必须 false」锁死。
   */
  precheckStatus?: boolean

  /**
   * **领取预检专用**的状态查询（`precheckStatus === true` 时用它）。
   *
   * ## ⚠️ 为什么不能复用 {@link fetchStatus}（这是两个消费者，不是一个）
   *
   * 同一个「查签到状态」的动作有两个**作用域不同**的消费者：
   * - `credits.status` 端点（面板读数）—— 由 {@link fetchStatus} 提供；
   * - `credits.claimAll` 的领取预检 —— 由本字段提供。
   *
   * `trae` 恰好证明二者**必须能分开**：它有可用的状态端点（`checked_in`，
   * 领取预检的唯一可靠判据），但 `credits.status` 对它**刻意仍回 `null`**
   *（Task 3 的决定，由 `credits-runtime-parity.spec.ts` 的
   *「fetchStatus 只登记在真有同构状态端点的渠道上」锁死 —— trae 的状态响应
   * 与 `CheckinStatus` 语义不同构）。
   *
   * ⇒ 把 trae 塞进 `fetchStatus` 会**同时**改掉 `credits.status` 的行为
   *（一处未获批准的 G3 例外），故单列本字段。
   *
   * ⚠️ 未提供时端点**回落到** {@link fetchStatus}（buddy / minimax 就是这种：
   * 它们的预检与面板读数是同一个端点，只声明一次即可，避免两处重复声明漂移）。
   */
  claimStatus?(credential: unknown, call: ProviderCallContext): Promise<CheckinStatus | null>

  /**
   * 领取之后的**下钻钩子**（成长中心任务），返回值原样进
   * `RpcCreditsClaimAllResponse.growth`。
   *
   * ## ⚠️ 为什么它是独立字段而不是并进 `claim`
   *
   * 成长中心任务与签到**共用同一趟逐账号循环**才能避免把凭据解析做两遍
   *（凭据可能被外部删除，解析两次会得到两次不同的失败路径）。而它又
   * **不能**混进 `claim` 本身 —— `claim` 的返回类型是 `ClaimOutcome`，
   * 装不下 22 项任务的逐项判据（既有注释明确写了这一点）。
   *
   * ## ⚠️ 参数形状：只收「实现真正需要的」，不收骨架的内部派生量
   *
   * `growthProduct` 是 `collectClaimResults` 拿到的 `product`，**刻意不收**：
   * 各家的产品配置由各家注册时闭包捕获（buddy 闭包自己的 `CODEBUDDY`），
   * 让调用侧转发它只会多一个「传错产品」的失败面 —— 而
   * `credits.claimAll` 的通用分支**本来就传 `undefined`**（它没有 product），
   * 转发过去就是 `collectBuddyGrowth(credential, undefined, …)`，成长中心当场打坏。
   *
   * `run` 里两个字段**都是请求/骨架的真实输入**，不是派生量：
   * - `budgetMs` 来自**请求体**（`RpcCreditsClaimAllRequest.budgetMs`，
   *   `types.ts` 明文「原样透传给 `runGrowthTaskCompletions`」）；
   * - `roundDeadlineAt` 是骨架算出的**整轮**截止时刻。它确实来自骨架内部，
   *   但**必须外露**：它是「账号很多时如实停住并报出哪些账号没跑」的唯一判据，
   *   实现侧要拿它决定「本轮还轮不轮得到这个账号」（见 `collectBuddyGrowth` 首段）。
   *   不给它，实现方就只能自己再算一个 —— 那正是「一份语义两套判据」。
   *
   * ⚠️ **只有 buddy 提供**（`GROWTH_CAPABLE_PROVIDERS` 那张平行手抄集合已删除，
   * 改由本字段是否存在说了算 —— 与 Task 1b 同因：消除平行副本）。
   * ⚠️ 触发条件是 `runTasks === true`（默认 false）—— 成长一轮单账号实测
   * 90~270s、任务间 1.5s 节流，默认开启等于每次启动打几十个上游请求。
   */
  afterClaim?(
    credential: unknown,
    entry: ProviderAccountEntry,
    run: GrowthRunOptions,
    call: ProviderCallContext,
  ): Promise<RpcBuddyGrowthAccountResult | undefined>
}

/**
 * 成长中心任务的**两个独立时间闸门**（见 {@link ProviderCredits.afterClaim}）。
 *
 * ⚠️ 它们是两个不同的问题，别合并：`budgetMs` 管「单个账号卡住」，
 * `roundDeadlineAt` 管「账号很多」。
 */
export interface GrowthRunOptions {
  /**
   * 单账号时间预算（毫秒），来自请求体。
   *
   * `undefined` 由实现取缺省 10 分钟；传 0 或负数表示不限时（本地排障用）。
   */
  readonly budgetMs: number | undefined
  /**
   * 整轮的截止时刻（`Date.now()` 口径），`undefined` 表示不限时。
   *
   * ⚠️ 逐账号预算是**每账号**上限，N 个账号会线性累加；宿主 RPC 的超时上界
   * 由 dsh 侧决定，本插件不可见也不可控。故另给一个整轮预算，让「账号很多」
   * 时也能**如实停住并报出哪些账号没跑**，而不是撞上宿主超时后前端只看到一个
   * 无来由的失败。
   */
  readonly roundDeadlineAt: number | undefined
}

/**
 * 一个 provider 的**一次性**奖励能力（见 {@link ProviderRuntime.onboarding}）。
 *
 * ⚠️ 返回类型直接复用 RPC 响应的形状（`RpcOnboardingStatusResponse` /
 * `RpcOnboardingClaimResponse`），与 `ProviderBalanceDetail` 同款理由：
 * 本域的值要直接喂给端点，多一层翻译就多一处漂移。
 *
 * ⚠️ 这**不是**把 RPC 契约当内部接口：这两个形状本就与 provider 数量无关
 *（`tasks` / `earned` / `total` / `titles` / `points` 是**所有**一次性奖励的
 * 公共字段），而 `raccoon` 的「已领时 `earned` 报满分」这条语义**只有在
 * 这个形状上**才表达得出来 —— 压成 `ClaimOutcome` 会丢掉它（见下）。
 */
export interface ProviderOnboarding {
  /**
   * 领取全部一次性奖励。
   *
   * ⚠️ **`raccoon` 的「已领时 `earned` 必须报满分、不是 0」是实测报障修来的**
   *（UI 曾显示「✅ 1 个此前已完成 / 累计已领 0 / 3000」这种自相矛盾的数字）：
   * `earned` 回答的是「该项目**累计**领到多少」，与「本次请求是否新增」无关。
   * ⚠️ 且已领时的金额必须从**账单反查**取得（与 {@link status} 同一数据源），
   * 否则两处会显示不同的数字。
   */
  claim?(credential: unknown, call: ProviderCallContext): Promise<RpcOnboardingClaimResponse>
  /**
   * 查询一次性奖励的进度（**只读**）。
   *
   * ⚠️ **只读：不得**在此触发任何 `complete` / `claim`（面板挂载时会调用它）。
   */
  status?(credential: unknown, call: ProviderCallContext): Promise<RpcOnboardingStatusResponse>
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
