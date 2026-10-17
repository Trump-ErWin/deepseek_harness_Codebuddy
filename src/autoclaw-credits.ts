/**
 * AutoClaw（智谱清言桌面端）积分钱包余额查询与每日签到领额度。
 *
 * ## 协议端点
 *
 * 1. 积分钱包余额查询（只读）：
 *    `GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`
 *    响应包含 total_balance 与各钱包明细（reward, daily, subscription, fuel_pack, other）。
 *    ⚠️ **无任何到期字段**（桌面端 Zod schema `.strict()` 五字段）——
 *    且服务端用 `display` 标记哪些池可展示（官方客户端据此过滤）。
 *
 * 2. 积分流水（只读，**临期桶的数据源**）：
 *    `GET /agent-assetmgr/api/v1/ledgers_std?asset_type=point&wallet_type=all`
 *    每笔发放（`mutation_type === "credit"`）带 `wallet_expires_at`（unix 秒）
 *    —— 该渠道**唯一**的每批次到期数据源。实测 28/28 全带值，且未过期批次
 *    之和 == `total_balance`（守恒，2026-10-17 取证）⇒ 批次包可**替换**钱包包，
 *    客户端按 `deductionEndTime` 分「永久 / 长期 / 临期」三档（buddy / officeace 同构）。
 *
 * 3. 每日签到领额度（写，幂等判据）：
 *    `POST /userapi/v1/user-info`
 *    Body: `{ source_id: 'autoclaw', device_id }`
 *    响应体中 `daily_check_in_completed_on_request`:
 *    - true: 签到成功（`kind: 'claimed'`）
 *    - false: 今日已完成签到（`kind: 'already-claimed'`）
 */

import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'
import type { ProviderBalanceDetail } from './provider-runtime.js'
import { randomUUID } from 'node:crypto'
import {
  AUTOCLAW,
  AUTOCLAW_SOURCE_ID,
  type AutoclawProduct,
} from './autoclaw-product.js'
import {
  calculateAutoclawSign,
  type AutoclawCredential,
} from './autoclaw.js'

export const AUTOCLAW_WALLETS_PATH = '/agent-assetmgr/api/v2/wallets'
export const AUTOCLAW_LEDGERS_PATH = '/agent-assetmgr/api/v1/ledgers_std'
export const AUTOCLAW_DAILY_CLAIM_PATH = '/userapi/v1/user-info'
export const AUTOCLAW_CREDITS_TIMEOUT_MS = 15_000
export const AUTOCLAW_CREDIT_UNIT = '积分'

/**
 * 流水翻页上限（页 × 100 条）。
 *
 * ⚠️ **必须有界**：余额徽标每 60 秒轮询一次，无界翻页会把徽标变成无限循环请求。
 * 实测该账号全部发放历史 = 28 条（1 页）。到达上限仍没对平时，走守恒回退
 *（见 `fetchAutoclawBalanceDetailed`）—— 宁可没有临期桶，也不给错数。
 */
export const AUTOCLAW_LEDGER_MAX_PAGES = 5

/** 钱包类型与默认展示名映射。 */
export const AUTOCLAW_WALLET_TYPE_LABELS: Readonly<Record<string, string>> = {
  reward: '奖励积分',
  daily: '每日积分',
  subscription: '签约积分',
  fuel_pack: '加油包积分',
  other: '其他积分',
}

export interface AutoclawWalletItem {
  readonly public_wallet_type?: string
  readonly display_name?: string
  readonly balance?: number
  readonly balance_view?: string
  readonly display?: boolean
  readonly priority?: number
}

export interface AutoclawWalletsResponseData {
  readonly schema_version?: string
  readonly total_balance?: number
  readonly wallets?: readonly AutoclawWalletItem[]
}

export interface AutoclawDailyClaimResponseData {
  readonly uid?: string
  readonly daily_check_in_completed_on_request?: boolean
}

export interface AutoclawCreditsOptions {
  readonly product?: AutoclawProduct
  readonly fetcher?: typeof fetch
  readonly deviceId?: string
}

function cleanToken(token?: string): string {
  if (!token) return ''
  return token.replace(/^Bearer\s+/i, '').trim()
}

/**
 * 构造 AutoClaw API 认证请求头。
 */
export function buildAutoclawCreditsHeaders(
  product: AutoclawProduct,
  accessToken?: string,
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString()
  const sign = calculateAutoclawSign(product.appId, ts, product.appKey)
  const clean = cleanToken(accessToken)
  const authVal = clean ? `Bearer ${clean}` : ''

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Auth-Appid': product.appId,
    'X-Auth-TimeStamp': ts,
    'X-Auth-Sign': sign,
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
    'User-Agent': 'AutoClaw/2.1.0 (win)',
  }
  if (authVal) {
    headers['X-Authorization'] = authVal
    headers.Authorization = authVal
  }
  return headers
}

/** 构造单个资源包。 */
function makePackage(
  name: string,
  remaining: number,
  active = true,
): CreditPackage {
  return {
    name,
    unit: AUTOCLAW_CREDIT_UNIT,
    remaining,
    total: remaining,
    used: 0,
    active,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
}

/**
 * 解析并转换钱包明细列表为 CreditPackage 数组。
 * 按照 priority 排序（小者优先），若 display_name 存在则使用，否则回退映射类型名。
 *
 * ⚠️ **`display === false` 的钱包必须丢弃**（2026-10-17 用户报障「每日 0」红字）。
 * 官方桌面端同款过滤（main.cjs `readWallets`：`wallet.display === true`）——
 * 服务端用这个标记表达「该池不该展示」（实测 `daily/subscription/fuel_pack/other`
 * 四池全为 `display:false` 且余额 0）。此前本解析器**忽略**了该标记，
 * 把 4 个隐藏的 0 余额池也发了出去 ⇒ 客户端按池名匹配「每日积分」命中
 * `DAILY_POOL_NAMES`，渲染出红色的「每日 0」——而「每日红 + 刷新倒计时」
 * 是 Loomy 那种**当日重置池**的语义（未用完随重置作废），AutoClaw 的
 * 每日签到积分是发放进余额、按**批次到期**作废的，两码事。
 */
export function parseAutoclawWallets(walletsRaw: unknown): CreditPackage[] {
  if (!Array.isArray(walletsRaw)) return []

  const items: AutoclawWalletItem[] = []
  for (const raw of walletsRaw) {
    if (!raw || typeof raw !== 'object') continue
    const cast = raw as Record<string, unknown>
    items.push({
      public_wallet_type: typeof cast.public_wallet_type === 'string' ? cast.public_wallet_type : undefined,
      display_name: typeof cast.display_name === 'string' ? cast.display_name : undefined,
      balance: typeof cast.balance === 'number' && Number.isFinite(cast.balance) ? cast.balance : 0,
      balance_view: typeof cast.balance_view === 'string' ? cast.balance_view : undefined,
      display: typeof cast.display === 'boolean' ? cast.display : true,
      priority: typeof cast.priority === 'number' && Number.isFinite(cast.priority) ? cast.priority : 100,
    })
  }

  // ⚠️ 服务端 `display === false` = 「不该展示」（官方客户端同款过滤），
  //    不是「余额为 0」——两者都为假时才回退为 true。
  const visible = items.filter((item) => item.display !== false)
  visible.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))

  return visible.map((item) => {
    const type = item.public_wallet_type ?? 'other'
    const defaultLabel = AUTOCLAW_WALLET_TYPE_LABELS[type] ?? (type ? `${type}积分` : '其他积分')
    const name = (item.display_name && item.display_name.trim()) || defaultLabel
    const remaining = item.balance ?? 0
    return makePackage(name, remaining, true)
  })
}

/** 流水条目里与本功能相关的原始字段（`toLedgerEntry` 的输入侧，见模块头）。 */
export interface AutoclawLedgerEntry {
  readonly amount?: unknown
  readonly mutation_type?: unknown
  readonly wallet_expires_at?: unknown
  readonly description?: unknown
  readonly source?: unknown
  readonly metadata?: unknown
}

/**
 * 解析流水 → **按到期批次分组的积分包**。
 *
 * ## 为什么不用钱包、改用流水
 *
 * v2 钱包接口**没有任何到期字段**（桌面端 Zod schema `CreditsWalletSchema`
 * `.strict()` 只认 `key/type/displayName/balance/balanceView` 五个字段）；
 * 而流水（`/agent-assetmgr/api/v1/ledgers_std`）的每笔发放都带
 * `wallet_expires_at`（unix 秒）—— 这是该渠道**唯一**的每批次到期数据源。
 * 真机取证（2026-10-17，本账号 28 笔发放）：**28/28 全带到期值**，且
 * 未过期批次之和 == `total_balance`（20700，分毫不差）⇒ 用批次包**替换**
 * 钱包包后，三档分桶（永久 / 长期 / 临期）与 buddy / officeace 同构。
 *
 * ## 分组与字段映射
 *
 * - 只取 `mutation_type === 'credit'`（发放；消费行没有到期语义）；
 * - `wallet_expires_at` 为**秒**级 unix 时间戳 ⇒ 乘 1000 归一成毫秒
 *   （`deductionEndTime` 与 officeace / buddy 同单位）；
 * - **无到期字段的发放**（活动赠送的永久分）⇒ 不带 `deductionEndTime`
 *   （= 永久桶，客户端判据对 `undefined` 的约定是「到期未知」）；
 * - **已过期**（`wallet_expires_at <= now`）的批次**直接丢弃**：那批积分
 *   已经不在钱包余额里了（守恒核对实测成立），发出去会凭空多出一笔死数；
 * - 包名取服务端的人话描述（「每日签到」「AutoClaw 用户登录奖励积分，7天有效」）。
 *
 * @param entries - 流水原始条目（一页或多页拼接）。
 * @param nowMs - 当前时刻（毫秒）；测试注入用。
 */
export function parseAutoclawLedgerBatches(
  entriesRaw: unknown,
  nowMs: number = Date.now(),
): CreditPackage[] {
  if (!Array.isArray(entriesRaw)) return []
  const nowSec = nowMs / 1000

  // 按到期时刻分组（同刻并列 = 同一批）；无到期的单独走永久桶。
  const byExpiry = new Map<number, { amount: number; label: string }>()
  let permanent = 0
  let permanentLabel = '其他积分'
  for (const raw of entriesRaw) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as AutoclawLedgerEntry
    if (entry.mutation_type !== 'credit') continue
    const amount = typeof entry.amount === 'number' && Number.isFinite(entry.amount) ? entry.amount : 0
    if (amount === 0) continue
    const label = (typeof entry.metadata === 'object' && entry.metadata !== null
      ? (entry.metadata as { description?: unknown }).description
      : undefined) ?? entry.description ?? entry.source ?? '积分发放'
    const name = typeof label === 'string' && label.trim().length > 0 ? label.trim() : '积分发放'
    const exp = typeof entry.wallet_expires_at === 'number' && Number.isFinite(entry.wallet_expires_at)
      ? entry.wallet_expires_at
      : undefined
    if (exp === undefined || exp <= 0) {
      permanent += amount
      if (permanentLabel === '其他积分') permanentLabel = name
      continue
    }
    if (exp <= nowSec) continue // 已过期：余额里已经没有这批了，丢弃。
    const bucket = byExpiry.get(exp) ?? { amount: 0, label: name }
    bucket.amount += amount
    byExpiry.set(exp, bucket)
  }

  const packages: CreditPackage[] = [...byExpiry.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([expSec, batch]) => ({
      ...makePackage(batch.label, batch.amount, true),
      deductionEndTime: expSec * 1000,
    }))
  if (permanent > 0) packages.push(makePackage(permanentLabel, permanent, true))
  return packages
}

/**
 * 查询 AutoClaw 积分钱包余额（带详细原因）。
 * 遵循只读规范，调用 GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw
 */
export async function fetchAutoclawBalanceDetailed(
  credential: AutoclawCredential,
  options?: AutoclawCreditsOptions,
): Promise<ProviderBalanceDetail> {
  const token = cleanToken(credential.access_token)
  if (!token) {
    return { balance: null, error: '未登录或凭据缺失，请先登录 AutoClaw' }
  }

  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetcher ?? fetch
  const url = `${product.apiBase}${AUTOCLAW_WALLETS_PATH}?biz_app_id=${AUTOCLAW_SOURCE_ID}`

  try {
    const headers = buildAutoclawCreditsHeaders(product, token)
    const resp = await fetcher(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(AUTOCLAW_CREDITS_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return {
        balance: null,
        error: `AutoClaw 钱包查询失败（HTTP ${resp.status}${text ? `: ${text.slice(0, 100)}` : ''}）`,
      }
    }

    const json = (await resp.json()) as {
      code?: number
      msg?: string
      data?: AutoclawWalletsResponseData
    }

    if (json.code !== 0) {
      if (json.code === 410000) {
        return {
          balance: null,
          error: `AutoClaw 登录凭据失效，请重新登录（${json.msg ?? '用户未登录'}）`,
        }
      }
      return {
        balance: null,
        error: `AutoClaw 钱包查询失败（code: ${json.code}，msg: ${json.msg ?? '未知错误'}）`,
      }
    }

    const data = json.data
    const total =
      typeof data?.total_balance === 'number' && Number.isFinite(data.total_balance)
        ? data.total_balance
        : 0

    // ⚠️ display=false 的隐藏池在这里已被滤掉（见 parseAutoclawWallets）——
    //    官方客户端同款行为，红色「每日 0」由此消失。
    const walletPackages = parseAutoclawWallets(data?.wallets)

    // ── 临期桶的数据源：流水批次 ──
    // 钱包接口没有到期字段；流水的每笔发放带 wallet_expires_at（unix 秒）。
    // 守恒校验通过才采用批次包（未过期批次之和 == total_balance，实测 20700）；
    // 不守恒（翻页到顶 / 接口变化）⇒ 回退钱包包 —— 宁可没有临期桶，不给错数。
    let packages = walletPackages
    if (total > 0) {
      try {
        const entries = await fetchAutoclawLedgerEntries(credential, options)
        const batches = parseAutoclawLedgerBatches(entries)
        const batchSum = batches.reduce((sum, pkg) => sum + pkg.remaining, 0)
        if (batches.length > 0 && batchSum === total) {
          packages = batches
        }
      } catch {
        // 流水不可达：静默回退钱包包（临期桶缺失，但总额与长期数仍正确）。
      }
    }

    if (packages.length === 0) {
      packages = [makePackage('奖励积分', total, true)]
    }

    const balance: CreditBalance = {
      total,
      packages,
      expiredTotal: 0,
    }
    return { balance }
  } catch (error) {
    return {
      balance: null,
      error: `AutoClaw 钱包网络请求异常：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 拉取积分流水的**全部发放条目**（有界翻页）。
 *
 * ⚠️ 只发 GET、只翻到 {@link AUTOCLAW_LEDGER_MAX_PAGES} 页；中途任何一页失败
 * 都把**已拿到的**条目返回（上游守恒校验会兜住不完整的页序列 —— 不完整 ⇒
 * 批次之和不等于钱包总额 ⇒ 回退钱包包，绝不给错数）。
 */
export async function fetchAutoclawLedgerEntries(
  credential: AutoclawCredential,
  options?: AutoclawCreditsOptions,
): Promise<AutoclawLedgerEntry[]> {
  const token = cleanToken(credential.access_token)
  if (!token) return []

  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetcher ?? fetch
  const all: AutoclawLedgerEntry[] = []
  let cursor: string | undefined

  for (let page = 0; page < AUTOCLAW_LEDGER_MAX_PAGES; page++) {
    const query = new URLSearchParams({
      asset_type: 'point',
      wallet_type: 'all',
      page_size: '100',
      flow_direction: 'income',
    })
    if (cursor !== undefined) query.set('cursor', cursor)
    const resp = await fetcher(`${product.apiBase}${AUTOCLAW_LEDGERS_PATH}?${query.toString()}`, {
      method: 'GET',
      headers: buildAutoclawCreditsHeaders(product, token),
      signal: AbortSignal.timeout(AUTOCLAW_CREDITS_TIMEOUT_MS),
    })
    if (!resp.ok) return all
    const json = (await resp.json()) as {
      code?: number
      data?: { entries?: unknown; next_cursor?: unknown; nextCursor?: unknown }
    }
    if (json.code !== 0 || !Array.isArray(json.data?.entries)) return all
    all.push(...(json.data.entries as AutoclawLedgerEntry[]))
    const next = json.data.next_cursor ?? json.data.nextCursor
    cursor = typeof next === 'string' && next.length > 0 ? next : undefined
    if (cursor === undefined) break
  }
  return all
}

/**
 * 查询 AutoClaw 积分余额（返回 CreditBalance 或 null）。
 */
export async function fetchAutoclawCreditBalance(
  credential: AutoclawCredential,
  options?: AutoclawCreditsOptions,
): Promise<CreditBalance | null> {
  const result = await fetchAutoclawBalanceDetailed(credential, options)
  return result.balance
}

/**
 * 执行 AutoClaw 每日签到领额度。
 * 遵循 POST /userapi/v1/user-info 规范，不抛出异常。
 */
export async function claimAutoclawDailyQuota(
  credential: AutoclawCredential,
  options?: AutoclawCreditsOptions,
): Promise<ClaimOutcome> {
  const token = cleanToken(credential.access_token)
  if (!token) {
    return { kind: 'failed', code: -1, message: '未登录或凭据缺失，请先登录 AutoClaw' }
  }

  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetcher ?? fetch
  // ⚠️⚠️ **`device_id` 绝不能回落到写死的常量**（2026-10-17 真机取证修复）。
  //   原写法回落到 `'dsh-autoclaw-device-001'` —— 那意味着**所有**没带
  //   `device_id` 的调用方共用同一个假设备号。上游把 `device_id` 当设备身份，
  //   共用它会让风控把「不同用户的请求」识别成同一台设备刷接口。
  //   ⇒ 与 `resolveDeviceId` 同口径：凭据里有就用凭据的，没有就**随机造一个**
  //   （桌面端自己的 DeviceIdentityStore 就是 `crypto.randomUUID`，不含指纹）。
  //   ⚠️ 随机而非固定：固定常量正是本缺陷的形态。
  const deviceId =
    options?.deviceId
    ?? credential.device_id
    ?? randomUUID()

  const url = `${product.apiBase}${AUTOCLAW_DAILY_CLAIM_PATH}`
  const body = {
    source_id: AUTOCLAW_SOURCE_ID,
    device_id: deviceId,
  }
  try {
    const headers = buildAutoclawCreditsHeaders(product, token)
    const resp = await fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTOCLAW_CREDITS_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return {
        kind: 'failed',
        code: resp.status,
        message: `AutoClaw 签到请求失败（HTTP ${resp.status}${text ? `: ${text.slice(0, 100)}` : ''}）`,
      }
    }

    const json = (await resp.json()) as {
      code?: number
      msg?: string
      data?: AutoclawDailyClaimResponseData
    }

    if (json.code !== 0) {
      return {
        kind: 'failed',
        code: json.code ?? -1,
        message: json.msg ?? 'AutoClaw 签到失败',
      }
    }

    const completedOnRequest = json.data?.daily_check_in_completed_on_request === true
    if (completedOnRequest) {
      // ⚠️⚠️ **上游不返回「领到多少」**（2026-10-17 真机取证）：
      //   `user-info` 的 data 只有 `{ uid, daily_check_in_completed_on_request }`
      //   —— 没有 credit / 积分数量字段。
      //   ⇒ 原写法 `credit: 0` 会让界面显示「签到成功，+0 积分」，
      //     用户读作「白签了一次」。
      //
      //   ⚠️ 而**在 claim 内部量余额差是不可行的**：要知道差值必须在领取
      //   **之前**读一次，但那样 `already-claimed` 这条（最常见的日常路径）
      //   也会白白多打一次钱包请求。两个诉求冲突。
      //   ✅ 取舍：**不在 claim 里读**，改为如实返回 0 + 说明文案，
      //     并让**调用方**（`credits.claimAll` 的 `afterClaim` / 客户端刷新）
      //     在领取成功后刷新余额 —— 那是既有机制，用户本来就能看到最新余额。
      //   ⚠️ 这条取舍的代价已如实记录：`credit` 字段为 0 时**不代表没领到**。
      return {
        kind: 'claimed',
        credit: 0,
        // ⚠️ 用契约里**专为此存在**的 `delayedMessage`（不是 `message` ——
        //   `claimed` 分支的 `message` 字段并不存在，写了会编译期报错，
        //   这正是类型系统的价值：它挡住了「随便加个字段」）。
        delayedMessage: '签到成功（上游不返回积分数量，请查看刷新后的余额）',
        streakDays: 0,
        isStreakDay: false,
      }
    }

    return {
      kind: 'already-claimed',
      message: '今日已完成签到',
    }
  } catch (error) {
    return {
      kind: 'failed',
      code: -1,
      message: `AutoClaw 签到网络请求异常：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
