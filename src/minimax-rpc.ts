/**
 * MiniMax **国际站**的账号出口代理端点。
 *
 * ## 缺陷背景
 *
 * `agent.minimax.io` 按**出口 IP 所在国家**分流：中国大陆来源会被 307 到中国站
 * `agent.minimaxi.com`，而中国站不认国际站 token ⇒ 与「凭据失效」**逐字同形**
 * 的 401（issue IKMEVG）。既有的 `X-Forwarded-For` 只**声明**一个海外 IP
 * （上游不信任该头即失效），真正换出口要靠代理。
 *
 * ## 为什么单独成文件（而不是塞进 `jet-hub-rpc.ts` 的 `switch`）
 *
 * ① **前缀分流**：`minimaxintl.*` 需要与 `opencode.*` / `gemini.*` 一样在主
 *    switch **之前**被试一次（理由见 `opencode-rpc.ts` 模块头：Jet Hub 只有
 *    一条 RPC 通道，主 switch 的 `default` 会把不认识的方法报成
 *    `unknown method`，**不让路**）；
 * ② **形状同构**：setProxy / testProxy 与 opencode / gemini 的同名端点
 *    **逐字段同构**，抄第三份会漂移（AGENTS.md 的第一条红线）。
 *
 * ⚠️ 但**实现不复用它们的分派表**：那两份绑的是各自的池字段与 provider id，
 * 本家要写 `setMinimaxIntlProxy` / `minimaxintl`。复用的是**判据与措辞**
 * （`normalizeProxy` / `describeFetchError`），不是那份表。
 *
 * ## ⚠️⚠️ 「测试连接」的判据：必须能区分「通」与「通了但仍在大陆」
 *
 * 这里**不**照抄 opencode 打出口 IP 服务（那只能证明代理本身可用），也**不**
 * 照抄 gemini 只判「拿到 HTTP 状态码」（那对本家是不够的）：
 *
 * - 本家的失败模式不是「连不上」，而是**连得上却被 307 到中国站**；
 * - 若只报「HTTP 307 = 通」，用户看到绿色以为配好了，实际照样 401 ——
 *   这正是 gemini 模块头记的那种**假阳性**。
 *
 * ⇒ 探测打**国际站自己的目录端点**（公开，无 token 也回 200），并且用
 * `redirect: 'manual'` **不跟随**，以便观测 `Location`：
 *
 * | 观测 | 结论 |
 * |---|---|
 * | 非 3xx 的 HTTP 响应 | ✅ 出口已在海外（未被分流） |
 * | 3xx 且 `Location` 指向 `*.minimaxi.com`（中国站） | ⚠️ 代理能通，但出口**仍被判为大陆** |
 * | 拿不到任何 HTTP 响应 | ❌ 代理不通 |
 *
 * ⚠️ 为什么用目录端点：它无需凭据即可回 200（本机实测），所以「测试」按钮
 * 不消耗任何凭据、也不会烧掉用户的 refresh_token —— 本仓库在 MiniMax 上
 * 有过「诊断脚本对真实凭据发起 refresh 而烧掉账号」的事故，此后凡是探测
 * 一律不得碰凭据。
 */

import type { Context } from '@deepseek-ai/cordis'
import { MINIMAX_INTL, MINIMAX_MODELS_PATH } from './minimax-product.js'
import { normalizeProxy } from './minimax-proxy.js'
import { proxyFetch } from './opencode-proxy.js'
import { describeFetchError } from './opencode-rpc.js'

export interface RpcMinimaxIntlProxyRequest {
  accountId: string
  proxy: string
}
export interface RpcMinimaxIntlProxyResponse {
  proxy: string
  label: string
}
export interface RpcMinimaxIntlTestProxyRequest {
  proxy: string
}
export interface RpcMinimaxIntlTestProxyResponse {
  /** 目标端点回的 HTTP 状态码（任何状态码都证明链路通）。 */
  status: number
  latencyMs: number
  /**
   * 出口**是否仍被判定为中国大陆**（上游把请求 307 到了中国站）。
   *
   * ⚠️ `true` 时本端点**仍然返回成功**（连接是通的）—— 但 UI 必须把它
   * 显示成警告而不是绿色：这是用户真正想问的那个问题的答案。
   */
  geoRouted: boolean
}

/** 账号池的最小依赖面（结构化类型，避免绑定具体类）。 */
export interface MinimaxIntlPoolLike {
  setMinimaxIntlProxy(accountId: string, proxy: string): Promise<void>
}

/** 探测连接用的超时（测试按钮不能无限等）。 */
const TEST_TIMEOUT_MS = 15_000

/** 中国站主机后缀（观测到 3xx 指向它 ⇒ 出口被判为大陆）。 */
const CN_HOST_SUFFIX = '.minimaxi.com'

/**
 * 探测目标：国际站**目录端点**（公开，无需凭据）。
 *
 * ⚠️ 与推理端点的取舍：打推理端点需要一个真凭据（会烧 token），而目录端点
 * 无 token 也回 200（实测）⇒ 用它做探测**零副作用**。
 */
const PROBE_URL = `${MINIMAX_INTL.apiHost}${MINIMAX_MODELS_PATH}?region=${MINIMAX_INTL.region}`

/** 从 `Location` 判「是不是被分流到中国站」（相对 Location 也认）。 */
function pointsToChinaStation(location: string | null): boolean {
  if (location === null || location.length === 0) return false
  const raw = location.trim().toLowerCase()
  // ⚠️ 相对 Location（`/xxx`）也可能是同主机跳转，但它**不含中国站主机**
  // ⇒ 按「认不出来就不判分流」处理（宁可少报，也不谎报）。
  if (raw.startsWith('/')) return false
  try {
    return new URL(raw).hostname.endsWith(CN_HOST_SUFFIX)
  } catch {
    return raw.includes(CN_HOST_SUFFIX)
  }
}

/**
 * 处理一个 `minimaxintl.*` RPC 方法。
 *
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（同 `opencode-rpc.ts` 的契约：
 *          对未知方法回信封会把别的 provider 的方法名误判成「格式错误」）。
 */
export async function handleMinimaxIntlRpc(
  _ctx: Context,
  pool: MinimaxIntlPoolLike,
  method: string,
  payload: unknown,
): Promise<unknown> {
  const fail = (message: string) => ({ ok: false as const, error: { code: 'bad-request', message } })
  const done = <T>(value: T) => ({ ok: true as const, value })
  try {
    switch (method) {
      case 'minimaxintl.setProxy': {
        const req = payload as RpcMinimaxIntlProxyRequest
        if (typeof req?.accountId !== 'string' || req.accountId.length === 0) {
          return fail('缺少 accountId')
        }
        const raw = typeof req.proxy === 'string' ? req.proxy : ''
        if (raw.trim().length === 0) {
          // 空串 = 清除：账号回到直连。
          await pool.setMinimaxIntlProxy(req.accountId, '')
          return done({ proxy: '', label: '直连（本机出口）' } satisfies RpcMinimaxIntlProxyResponse)
        }
        const normalized = normalizeProxy(raw)
        if (!normalized.ok) return fail(normalized.reason)
        await pool.setMinimaxIntlProxy(req.accountId, normalized.proxy.url)
        return done({
          proxy: normalized.proxy.url,
          label: normalized.proxy.label,
        } satisfies RpcMinimaxIntlProxyResponse)
      }

      case 'minimaxintl.testProxy': {
        const req = payload as RpcMinimaxIntlTestProxyRequest
        const normalized = normalizeProxy(typeof req?.proxy === 'string' ? req.proxy : '')
        if (!normalized.ok) return fail(normalized.reason)
        const startedAt = Date.now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
        try {
          // ⚠️ 必须走 `proxyFetch`（与 dispatcher 同源的 fetch）：用全局 fetch
          // 会在 Node 22/24 上恒抛 `UND_ERR_INVALID_ARG`（缺陷 IKK4BY）。
          //
          // ⚠️ `redirect: 'manual'`：跟随会让我们**看不到** 307 这一跳，而
          // 「有没有被分流」恰恰只能在这一跳上判（跟到中国站之后 401 与
          // 「凭据失效」逐字同形，事后无法区分）。
          const response = await proxyFetch(PROBE_URL, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
          }, normalized.proxy)
          // ⚠️ **不判 `response.ok`**：401 / 403 / 307 同样证明链路通，
          // 把它当失败会让「测试连接」在正确配置下报红。
          return done({
            status: response.status,
            latencyMs: Date.now() - startedAt,
            geoRouted: pointsToChinaStation(response.headers.get('location')),
          } satisfies RpcMinimaxIntlTestProxyResponse)
        } catch (error) {
          // ⚠️ **必须把 `cause` 带出来**（同 IKK4BY 第 2 点）：`error.message`
          // 恒为 `fetch failed`，真因只在 `cause` 上。
          return fail(
            `测试失败：${controller.signal.aborted ? '连接超时' : describeFetchError(error)}`,
          )
        } finally {
          clearTimeout(timer)
        }
      }

      default:
        // ⚠️ **必须返回 undefined**（见函数注释）。
        return undefined
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
