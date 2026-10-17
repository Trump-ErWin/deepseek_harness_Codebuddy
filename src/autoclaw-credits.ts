/**
 * AutoClaw（智谱清言桌面端）积分钱包余额查询与每日签到领额度。
 *
 * ## 协议端点
 *
 * 1. 积分钱包余额查询（只读）：
 *    `GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`
 *    响应包含 total_balance 与各钱包明细（reward, daily, subscription, fuel_pack, other）
 *
 * 2. 每日签到领额度（写，幂等判据）：
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
export const AUTOCLAW_DAILY_CLAIM_PATH = '/userapi/v1/user-info'
export const AUTOCLAW_CREDITS_TIMEOUT_MS = 15_000
export const AUTOCLAW_CREDIT_UNIT = '积分'

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

  items.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))

  return items.map((item) => {
    const type = item.public_wallet_type ?? 'other'
    const defaultLabel = AUTOCLAW_WALLET_TYPE_LABELS[type] ?? (type ? `${type}积分` : '其他积分')
    const name = (item.display_name && item.display_name.trim()) || defaultLabel
    const remaining = item.balance ?? 0
    return makePackage(name, remaining, item.display ?? true)
  })
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

    const packages = parseAutoclawWallets(data?.wallets)
    if (packages.length === 0) {
      packages.push(makePackage('奖励积分', total, true))
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
