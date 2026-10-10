/**
 * 各 provider 的**积分能力实现表** —— `ProviderRuntime.credits` 域的唯一真源。
 *
 * ## 它解决什么
 *
 * 重构前，`credits.balances` 是一个 **441 行**的 `case`，里面 11 段
 * `if (req.provider === X.id)` 各自重复同一套编排（逐账号 resolve 凭据 →
 * 调用本家的余额原语 → 拼 `{accountId, nickname, balance, error}`）。
 * 那些分支里**没有一行是协议逻辑** —— 协议早已封装在各家 `fetch*Balance` 内，
 * RPC 层看到的只是「选哪个函数」（设计文档 §3.5 的边界）。
 *
 * 本文件把「选哪个函数」抽成数据；编排仍留在既有的共享骨架
 *（`collectCreditBalances` / `collectCreditsStatus`）里，**一行不重写**。
 *
 * ## ⚠️ 哪些渠道**不在这里**（形态与骨架根本不匹配，刻意保留特例）
 *
 * | 渠道 | 为什么不进表 |
 * |---|---|
 * | `opencode` | 它的「余额」是**本地派生的通道可用性**（读账号池的 `modelRateLimits`），**零网络请求**。套进 `fetchBalance(credential, …)` 形状会逼它去发一个不存在的上游请求。 |
 * | `qoder` / `qodercn` | `fetchQoderCreditBalance` 只吃 `QoderCredential`、且 product 来自同族注册表；旧实现因此**没有**走 `collectCreditBalances` 的 `(credential, product)` 泛型。 |
 *
 * 这两段留在 `jet-hub-rpc.ts` 的 `credits.balances` 里、**先于查表短路**，
 * 并有各自的行为用例锁死（见 `credits-runtime-parity.spec.ts` 的
 * 「特例的优先级」）。强行套骨架会丢语义 —— 那是本仓库反复记录的缺陷形态。
 *
 * ## ⚠️ 为什么有些渠道用 `fetchBalanceDetailed` 而不是 `fetchBalance`
 *
 * `fetchBalance` 的 `null` 由共享骨架统一翻译成「余额查询失败」。但有几家的
 * 失败原因**必须区分**（用户会按原因决定去重新登录、还是去充值、还是什么
 * 都不用做）：
 *
 * - `codearts`：三态 —— 「Token 计费账户」/「非积分计费账户」/「未返回积分数据」；
 * - `gemini`：「尚未授权 Google 账号」与「查询失败」是两回事；
 * - `zcode`：「企业版不下发额度数字」不是故障；
 * - `cline` / `loomy` / `raccoon`：协议原语自己带**具体**原因
 *  （含 HTTP 状态码与错误体摘要），压成笼统一句会丢掉唯一有用的线索。
 *
 * 故这些渠道给 `fetchBalanceDetailed`，文案由实现自己负责。
 * **绝不允许把「查不到」写成 0**（0 是「已用光」的语义）。
 *
 * ## ⚠️ 为什么是**工厂**而不是常量表
 *
 * `loomy` / `raccoon` / `zcode` 的余额查询走**各自 auth 实例上的方法**
 *（`fetchCreditBalance` / `fetchBalanceFor`），因为那些实例可能带注入的
 * `fetchImpl`（测试替身 / 代理）。重构前 RPC 就是这么调的，这里原样保留。
 * 未传实例时回退到自由函数 + 全局 `fetch` —— 与 `index.ts` 的实际构造
 *（三者都没传 `fetchImpl`）逐字等价，故生产行为不变。
 */

import { CODEBUDDY, WORKBUDDY } from './product.js'
import type { BuddyCredential } from './buddy.js'
import { CLINE } from './cline-product.js'
import { GEMINI } from './gemini.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { LOOMY } from './loomy-product.js'
import { MINIMAX } from './minimax-product.js'
import { RACCOON } from './raccoon-product.js'
import { TRAE } from './trae-product.js'
import { fetchClineCreditBalance } from './cline-credits.js'
import { fetchCodeArtsAccountInfoDetailed } from './codearts-credits.js'
import { fetchGeminiCreditBalance } from './gemini-credits.js'
import { fetchLobsteraiCreditBalance } from './lobsterai-credits.js'
import { fetchLoomyCreditBalance } from './loomy-credits.js'
import {
  fetchMinimaxCreditBalance,
  fetchMinimaxSigninStatus,
} from './minimax-credits.js'
import { fetchRaccoonCreditBalance } from './raccoon-credits.js'
import { fetchTraeCreditBalance } from './trae-credits.js'
import { fetchZcodeBalance, type ZcodeBalanceResult } from './zcode-upstream.js'
import {
  fetchCheckinStatus,
  fetchCreditBalance,
  type CreditBalance,
  type CreditPackage,
} from './credits.js'
import type { ProviderCredits } from './provider-runtime.js'
import type { CodeArtsCredential, RpcCreditsBalanceExtra } from './types.js'
import type { ClineCredential } from './cline.js'
import type { GeminiCredential } from './gemini.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { LoomyCredential } from './loomy.js'
import type { MinimaxCredential } from './minimax.js'
import type { RaccoonCredential } from './raccoon.js'
import type { TraeCredential } from './trae.js'
import type { ZcodeCredential } from './zcode.js'

/**
 * 三家「余额查询挂在 auth 实例上」的渠道所需的最小接口。
 *
 * ⚠️ **结构化类型而不是 `LoomyAuth` / `RaccoonAuth` / `ZcodeAuth`**：
 * 本模块只需这三个方法，导入三个 auth 类会把 `@deepseek-ai/cordis` 与
 * 一整套登录流程拖进依赖图 —— 而它只被 `index.ts`（已经持有实例）与
 * 单测使用。结构化类型同时让单测可以传**只带一个方法的替身**。
 */
export interface ProviderCreditsDeps {
  /** Loomy auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
  readonly loomy?: { fetchCreditBalance(credential: LoomyCredential): Promise<CreditBalance | null> }
  /** Raccoon auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
  readonly raccoon?: { fetchCreditBalance(credential: RaccoonCredential): Promise<CreditBalance | null> }
  /** ZCode auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
  readonly zcode?: { fetchBalanceFor(credential: ZcodeCredential): Promise<ZcodeBalanceResult | undefined> }
}

/**
 * 把 ZCode 的额度桶映射成 `CreditBalance`。
 *
 * ⚠️ **逐桶映射，不是只取第一个桶**（真实缺陷）：旧实现只取
 * `result.planName`（= `buckets[0]?.showName`）拼**一个**包 —— 多桶账号的
 * 其余额度被**静默丢掉**，而 `result.remaining` / `total` 却是**全桶汇总**，
 * 于是那一个包的数字比它自己的 `totalUnits` 还大，自相矛盾。
 * 实测本机账号只回一个桶，但**不能按「只有一个桶」来写** —— 那正是把缺陷
 * 固化成契约。
 *
 * ## 空桶的兜底
 *
 * 上游可能一个桶都不给。此时**不能**返回空 `packages`（前端会显示成
 * 「没有额度」而不是「查不到」），故给一个具名占位包，让 UI 至少能显示
 * 「0 / 0」并带上 `result.planName`。
 */
export function buildZcodeBalance(result: ZcodeBalanceResult): CreditBalance {
  const packages: CreditPackage[] = result.buckets.map((bucket) => {
    const remaining = bucket.availableUnits ?? bucket.remainingUnits ?? 0
    const total = bucket.totalUnits ?? 0
    return {
      name: bucket.showName ?? result.planName ?? 'ZCode 免费额度',
      // ⚠ 单位是 **token**（不是 credit）—— 如实标注，
      // 避免用户以为 ZCode 有 1 亿积分。
      unit: 'token',
      remaining,
      total,
      used: Math.max(0, total - remaining),
      active: true,
      // ZCode 的额度按日刷新（`period: 'one_time'` 的活动包到点失效），
      // 故周期起止都留空，只用 `expiredTime` 给到期时刻。
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: bucket.expiresAt !== undefined
        ? new Date(bucket.expiresAt * 1000).toISOString()
        : (result.expiresAt !== undefined ? new Date(result.expiresAt * 1000).toISOString() : ''),
    }
  })
  if (packages.length === 0) {
    packages.push({
      name: result.planName ?? 'ZCode 免费额度',
      unit: 'token',
      remaining: result.remaining,
      total: result.total,
      used: Math.max(0, result.total - result.remaining),
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: result.expiresAt !== undefined
        ? new Date(result.expiresAt * 1000).toISOString()
        : '',
    })
  }
  return {
    // 仍是**全桶汇总**，与 `packages` 逐项之和一致（`fetchZcodeBalance` 就是这么累加的）。
    total: result.remaining,
    // ZCode 不在同一响应里区分「已失效包」，故为 0。
    expiredTotal: 0,
    packages,
  }
}

/** 组装一条「有余额」的带原因结果。 */
function ok(balance: CreditBalance): { balance: CreditBalance } {
  return { balance }
}

/** 组装一条「查不到」的带原因结果（`error` 必须是可读原因，不是 0）。 */
function fail(error: string): { balance: null; error: string } {
  return { balance: null, error }
}

/**
 * 构造「id → 积分能力」的表。
 *
 * ⚠️ **只覆盖余额查得到资源包的渠道**。`opencode` 与 `qoder` 系刻意缺席
 *（见文件头），`aggregate` 没有自己的账号与余额。
 */
export function createProviderCredits(
  deps: ProviderCreditsDeps = {},
): Readonly<Record<string, ProviderCredits>> {
  return {
    /**
     * CodeArts（华为云）：余额搭 `statistics/plugin` 的账户类型检测回来，
     * 故必须用带原因的形态 —— 非积分账户要显示「Token 计费账户」而不是
     * 误导性的「余额查询失败」。
     *
     * ⚠️ 这三条文案是用户报障修来的，**逐字保留**。
     */
    codearts: {
      fetchBalanceDetailed: async (credential) => {
        // 用带原因的版本：`fetchCodeArtsAccountInfo` 只回 null，会把
        // 「AK 限流」「签名失败」「凭据过期」压成同一句笼统文案，
        // 用户与排查者都拿不到线索（本端点就因此把一次 401 显示成了
        // 无信息量的「账户信息查询失败」）。
        const result = await fetchCodeArtsAccountInfoDetailed(credential as CodeArtsCredential)
        if (!result.ok) return fail(`账户信息查询失败：${result.message}`)
        const info = result.info
        if (!info.isCreditPackage) {
          return fail(
            info.isTokenPackage
              ? 'Token 计费账户，无积分余额'
              : '非积分计费账户，无积分余额',
          )
        }
        // 积分账户但没有 credit metric：如实报「无积分数据」，
        // 不显示成 0 —— 0 会让用户以为自己把积分用光了。
        if (info.credit === undefined) return fail('未返回积分数据')
        return ok(info.credit)
      },
    },

    lobsterai: {
      fetchBalance: (credential) =>
        fetchLobsteraiCreditBalance(credential as LobsteraiCredential, LOBSTERAI),
    },

    trae: {
      fetchBalance: (credential) =>
        fetchTraeCreditBalance(credential as TraeCredential, TRAE),
    },

    /**
     * Cline：协议原语自带**具体**原因（含 HTTP 状态码与错误体摘要），
     * 压成「余额查询失败」会丢掉唯一有用的线索。
     */
    cline: {
      fetchBalanceDetailed: async (credential) => {
        const result = await fetchClineCreditBalance(credential as ClineCredential, CLINE)
        // 查不到时带上具体原因，而不是笼统一句「查询失败」—— 卡片显示原因而非 0
        //（0 是「已用光」的语义，会误导用户）。
        return result.balance === null
          ? fail(result.error ?? '积分查询失败（凭据失效或响应异常）')
          : ok(result.balance)
      },
    },

    /** Loomy：`/points/records`（**只读**，无副作用；`first-login` 是写端点）。 */
    loomy: {
      fetchBalanceDetailed: async (credential) => {
        // ⚠️ 判**方法存在**而不是 `deps.loomy !== undefined`：调用方常常只持有
        //   一个部分替身（单测的 `{}` 桩），用 `!== undefined` 会走进
        //   `undefined is not a function` 并被骨架吞成一条笼统错误 —— 那正是
        //   「静默降级」的形态。判方法则如实回退到自由函数。
        const viaInstance = deps.loomy?.fetchCreditBalance
        const balance = typeof viaInstance === 'function'
          ? await viaInstance.call(deps.loomy, credential as LoomyCredential)
          : await fetchLoomyCreditBalance(credential as LoomyCredential, LOOMY)
        // 查不到时带原因（不显示成 0，0 是「已用光」的语义）。
        return balance === null ? fail('积分查询失败（凭据失效或响应异常）') : ok(balance)
      },
    },

    /** Raccoon：`/points/v1/balance`（**只读**，无副作用）。 */
    raccoon: {
      fetchBalanceDetailed: async (credential) => {
        const viaInstance = deps.raccoon?.fetchCreditBalance
        const balance = typeof viaInstance === 'function'
          ? await viaInstance.call(deps.raccoon, credential as RaccoonCredential)
          : await fetchRaccoonCreditBalance(RACCOON, credential as RaccoonCredential)
        // ⚠️ 查不到时带原因（**不显示成 0** —— 0 是「已用光」的语义，
        // 把「查询失败」显示成 0 会让用户以为自己积分没了）。
        return balance === null ? fail('积分查询失败（凭据失效或响应异常）') : ok(balance)
      },
    },

    /**
     * ZCode：额度单位是 **token**（不是积分）。`balance: null` 表示**查不到**
     * （不显示成 0，0 是「已用光」的语义）。
     */
    zcode: {
      fetchBalanceDetailed: async (credential) => {
        const viaInstance = deps.zcode?.fetchBalanceFor
        const result = typeof viaInstance === 'function'
          ? await viaInstance.call(deps.zcode, credential as ZcodeCredential)
          : await fetchZcodeBalance(credential as ZcodeCredential)
        if (result === undefined) return fail('额度查询失败（凭据失效或网络异常）')
        // 企业版不下发额度数字、只给外部链接 —— 如实说明，不显示 0。
        if (result.enterprise === true) {
          return fail('企业版账号不下发额度数字，请在 ZCode 内查看')
        }
        return ok(buildZcodeBalance(result))
      },
    },

    /**
     * MiniMax：`GET /minimax-cloud/api/v1/credit/details`。
     *
     * ⚠️ 该端点是**平铺响应**（`total_count` 与 `base_resp` 同级、没有 `data` 键），
     * `fetchMinimaxCreditBalance` 内部已兼容两种形状。
     * ⚠️ 查不到时（null）由共享骨架统一补「余额查询失败」—— 卡片显示原因而非 0
     *（本机实测 `total_count: 0` 且 `details` 缺失正是「真的为 0」）。
     */
    minimax: {
      fetchBalance: (credential) =>
        fetchMinimaxCreditBalance(credential as MinimaxCredential),
      // ⚠️ **有**独立的签到状态端点，与「如实返回 null」的那几家不同。
      // 判据是 `is_today && status===3`（见 `minimaxPanelToCheckinStatus`），
      // 不是「没有 Claimable」。`active` 恒 true（拿到响应即 true）。
      fetchStatus: (credential) =>
        fetchMinimaxSigninStatus(credential as MinimaxCredential),
    },

    /**
     * Gemini：余额 = **配额窗口**（不是充值积分），两个桶的剩余比例。
     * 「未授权」与「查询失败」是两回事，故用带原因的形态。
     *
     * ⚠️ 账号规格（Pro / Free / Ultra）搭这趟车回来：`loadCodeAssist` 与配额
     * 是同一函数里**并行**发的两个端点，档位挂在 `result.tier` 上。这里翻译成
     * 面板要的 `extra.accountTier` —— `label` 是短标签（面板只放得下一个词），
     * `title` 是上游原文（hover 才看得到）。取不到时 `extra` 缺席，
     * 面板不渲染那一行（**不是错误**）。
     */
    gemini: {
      fetchBalanceDetailed: async (credential) => {
        const { balance, error, tier } = await fetchGeminiCreditBalance(
          credential as GeminiCredential, GEMINI,
        )
        const extra: RpcCreditsBalanceExtra | undefined = tier === undefined
          ? undefined
          : { accountTier: { label: tier.label, title: `${tier.name}（${tier.id}）` } }
        return {
          balance,
          ...error === undefined ? {} : { error },
          ...extra === undefined ? {} : { extra },
        }
      },
    },

    buddy: {
      fetchBalance: (credential) =>
        fetchCreditBalance(credential as BuddyCredential, CODEBUDDY),
      fetchStatus: (credential) =>
        fetchCheckinStatus(credential as BuddyCredential, CODEBUDDY),
    },

    workbuddy: {
      fetchBalance: (credential) =>
        fetchCreditBalance(credential as BuddyCredential, WORKBUDDY),
      // ⚠️ 国际版**没有签到接口**，但**状态端点**与余额一样存在（两个产品通用），
      // 故这里注册 fetchStatus。真正禁止的是 `claimAll`（那由能力表与
      // `credits.claimAll` 的显式守卫成对拦住）。
      fetchStatus: (credential) =>
        fetchCheckinStatus(credential as BuddyCredential, WORKBUDDY),
    },
  }
}

/**
 * 按 provider id 从表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `constructor`），
 * 把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `jet-hub-rpc.ts` 的 `authOf` 同因。
 */
export function creditsOf(
  table: Readonly<Record<string, ProviderCredits>>,
  provider: string,
): ProviderCredits | undefined {
  if (!Object.hasOwn(table, provider)) return undefined
  return table[provider]
}
