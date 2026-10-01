/**
 * ZCode 本地 Anthropic 透明桥。
 *
 * ## 为什么需要它
 *
 * DSH 官方只认两个 settings 命名空间（`llm-deepseek` / `llm-pi-ai`），
 * 其余 `settingsNs` 在「设置 → 模型 → 模型卡片 → 编辑」里只会渲染一行
 * 「其余字段在 cordis.patch.yml 中…」。想让 ZCode 的免费额度通道**走官方
 * 模型卡片**（可编辑 contextWindow / maxTokens、三档思考强度自动进 composer），
 * 唯一的路子是把 ZCode 伪装成一个 pi-ai 的 `anthropic-messages` provider。
 *
 * 但 pi-ai 只会原样把请求 POST 到 `baseURL + /v1/messages`，而 ZCode 上游
 * 硬性要求两件 pi-ai 做不到的事：
 *
 * 1. **请求体必须带官方身份块**（`buildZcodeSystemBlocks`）。缺了回
 *    `3012 unusual activity`，且**有账号冷却惩罚**（30 分钟 → 24 小时 → 停用）。
 * 2. **每个请求必须现产一个阿里云 captcha**（一次性，复用必 `3007`），
 *    并在响应头上带 `x-aliyun-captcha-verify-param`。
 *
 * 这个桥就干这两件事，外加账号池切换与错误翻译，其余**逐字透传**。
 *
 * ## 为什么是「透明」的
 *
 * ZCode 上游就是 Anthropic Messages 协议的 SSE（`event: message_start` /
 * `content_block_delta` / …），与 pi-ai 期待的形状**完全一致** ⇒ 桥不需要
 * 做任何协议转换，直接把上游的 SSE 帧转写出去即可。唯一的加工是：
 *
 * - **扣住 `message_stop`**：上游返回 200 但一个内容块都没有时（实测
 *   「无权益」指纹是 150-200ms 秒回空），pi-ai 会把它读成
 *   `EMPTY_RESPONSE`，而该码在 harness 的 `DEFAULT_RETRYABLE_CODES` 里
 *   ⇒ 白退避重试 5 次（约 15.5 秒）。桥改成发一个 `event: error` 帧，
 *   pi-ai 的 `iterateAnthropicEvents` 会当场 `throw`，错误文案里带
 *   `insufficient quota` ⇒ 被 `classifyPiAiError` 归成**不可重试**的
 *   `QUOTA_EXCEEDED`。
 *
 * ## 错误码翻译（决定 harness 会不会白重试）
 *
 * | 上游 | 桥回给 pi-ai | 分类结果 |
 * |---|---|---|
 * | `3009` 并发限流 | HTTP 429（文案不含 quota） | `RATE_LIMIT`（可重试） |
 * | `1005`/`1113`/秒回空 | HTTP 429 + 文案含 `insufficient quota` | `QUOTA_EXCEEDED`（**不**重试） |
 * | `3012` 风控 | HTTP 403 + `x-should-retry: false` | `AUTH`（**不**重试） |
 * | `3007` captcha | HTTP 502 | `SERVER`（可重试） |
 * | `401`/`1002` | HTTP 401 | `AUTH` |
 *
 * 依据：`dsh-llm-pi-ai` 的 `classifyPiAiError` 分类序是
 * `401|403` → `isQuotaExceededError` → `429|rate limit` → `413` → `400`
 * → `5xx` → timeout → transport；**quota 判断在 429 之前**，
 * 所以「429 + insufficient quota」是 QUOTA_EXCEEDED 而不是 RATE_LIMIT。
 *
 * @module zcode-bridge
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AccountPool } from './account-pool.js'
import { GateAbortedError, ModelGate } from './model-gate.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import { ZCODE, type ZcodeProduct, type ZcodeRemoteModelLike } from './zcode-product.js'
import type { ZcodeCredential } from './zcode.js'
import { ZCODE_PLAN_MESSAGES_URL, buildZcodeHeaders } from './zcode-upstream.js'
import { buildZcodeSystemBlocks, withContextPrefix } from './zcode-identity.js'
import { iterateSseFrames, type SseFrame } from './zcode-anthropic.js'

/** 上游「无权益」的错误指纹用的英文短语（刻意让 `isQuotaExceededError` 命中）。 */
const QUOTA_FINGERPRINT = 'insufficient quota'

/** 请求体上限（图片内联后 base64 会很大；两张 2560×1600 截图约 10MB）。 */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024

/** 上游默认发车闸门参数（与 `zcode-adapter.ts` 同源）。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000
/** 流式阶段的**空闲**超时（两帧之间的最大间隔）。 */
const DEFAULT_STREAM_IDLE_MS = 180_000

/** 桥的构造选项。 */
export interface ZcodeBridgeOptions {
  /** 产品配置；默认 {@link ZCODE}。 */
  product?: ZcodeProduct
  /**
   * 解析当前可用凭据。
   *
   * 由 `index.ts` 注入（它持有账号池与 `ZcodeAuth`），实现应当把
   * 「池里实际返回的那个账号 id」记录下来供 {@link currentAccountId} 查询 ——
   * 否则额度受限时会反复标记同一个账号而在两个账号之间空转。
   */
  resolveCredential: (modelId?: string) => Promise<ZcodeCredential | undefined>
  /** 产出一个**新鲜**的 captcha param（一次性，不可复用）。 */
  mintCaptcha: (options?: { signal?: AbortSignal }) => Promise<string>
  /** captcha 区域（进 `x-aliyun-captcha-verify-region`）。 */
  captchaRegion?: string
  /** 远端模型目录（供 `GET /v1/models`）；缺省用兜底表。 */
  fetchRemoteModels?: () => Promise<ZcodeRemoteModelLike[]>
  /** 账号池（额度用尽时切换账号）。 */
  accountPool?: AccountPool
  /** 本次请求实际使用的账号 id（额度受限时标记它）。 */
  currentAccountId?: () => string | undefined
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 上游发车闸门；缺省自建。 */
  gate?: ModelGate
  /** 建立连接的超时（毫秒）。 */
  requestTimeoutMs?: number
  /** 流式阶段的空闲超时（毫秒）。 */
  streamIdleMs?: number
  /** 日志出口。 */
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
}

/** 桥启动后的句柄。 */
export interface ZcodeBridgeHandle {
  /** `http://127.0.0.1:<port>`（**不含** `/v1`，SDK 自己会拼 `/v1/messages`）。 */
  readonly baseUrl: string
  readonly port: number
  /** 当前声明的模型 id（写镜像 route 时用）。 */
  modelIds(): Promise<readonly string[]>
  /** 取模型目录（含 contextWindow / maxTokens / 档位）。 */
  models(): Promise<readonly ZcodeRemoteModelLike[]>
  /** 关闭服务。 */
  close(): Promise<void>
}

/** 上游错误的桥内表示。 */
interface BridgeFailure {
  /** 回给 pi-ai 的 HTTP 状态码。 */
  status: number
  message: string
  /** 是否强制 pi-ai 不重试。 */
  noRetry: boolean
}

/** 构造一条带 `insufficient quota` 指纹的错误（会被归成 QUOTA_EXCEEDED）。 */
function quotaFailure(model: string, detail: string, attemptedAccounts: number): BridgeFailure {
  const tried = attemptedAccounts > 1 ? `；已尝试 ${attemptedAccounts} 个账号` : ''
  return {
    status: 429,
    noRetry: true,
    message:
      `${QUOTA_FINGERPRINT}: zcode 账号在模型 "${model}" 上的额度已用尽` +
      `或没有可用权益${tried}。请等待免费额度重置（按自然日结算）、改用其它模型，` +
      `或在 Jet Hub 的 ZCode 面板添加账号。${detail}`,
  }
}

/** 截断响应体，供错误文案使用。 */
function snippet(body: string): string {
  const trimmed = body.trim()
  return trimmed.length === 0 ? '' : ` 上游响应：${trimmed.slice(0, 300)}`
}

/** 从上游响应体里取业务码（`{code, msg}` 形态）。 */
function upstreamCode(body: string): unknown {
  try {
    const parsed = JSON.parse(body.trim()) as { code?: unknown }
    return parsed.code
  } catch {
    return undefined
  }
}

/** 上游并发限流（`3009`）。 */
function isConcurrencyLimited(status: number, body: string): boolean {
  if (status !== 429 && !body.includes('3009')) return false
  return body.includes('3009') || /concurrency\s+limit/i.test(body)
}

/** 上游额度用尽（`1005` / `1113`）。 */
function isQuotaExhausted(status: number, body: string): boolean {
  if (isConcurrencyLimited(status, body)) return false
  if (body.includes('1113') || body.includes('余额不足')) return true
  if (body.includes('1005')) return true
  return /exceed\s+quota\s+limit|quota\s+(?:has\s+been\s+)?exhausted/i.test(body)
}

/** 把上游的非 2xx 响应翻成桥错误。 */
function classifyUpstreamFailure(model: string, status: number, body: string, attempted: number): BridgeFailure {
  const code = upstreamCode(body)
  if (isQuotaExhausted(status, body)) return quotaFailure(model, snippet(body), attempted)
  if (isConcurrencyLimited(status, body)) {
    return {
      status: 429,
      // ⚠ 文案里**不要**出现 quota / usage limit / rate limit 之外的额度词：
      //   `isQuotaExceededError` 只看英文正则，中文「额度」不命中。
      noRetry: false,
      message: `zcode 上游并发限流（HTTP ${status}，code 3009 model concurrency limit exceeded）——已按退避重试仍未通过，请稍后重试。${snippet(body)}`,
    }
  }
  if (code === 3012 || body.includes('3012')) {
    return {
      status: 403,
      noRetry: true,
      message:
        'zcode 上游风控拦截（code 3012 unusual activity）。⚠ 该错误有账号冷却惩罚' +
        `（30 分钟，反复触发会升级到 24 小时乃至停用），请勿连续重试。${snippet(body)}`,
    }
  }
  if (code === 3007 || body.includes('3007')) {
    return {
      status: 502,
      noRetry: false,
      message: `zcode 阿里云 captcha 校验失败（code 3007）——已换新 captcha 重试仍未通过。${snippet(body)}`,
    }
  }
  if (status === 401 || code === 1002) {
    return {
      status: 401,
      noRetry: true,
      message: `zcode 凭据失效（HTTP ${status}）——请在 Jet Hub 的 ZCode 面板重新登录，或打开官方 ZCode 客户端登录一次。${snippet(body)}`,
    }
  }
  return {
    status: status >= 500 ? status : status === 400 ? 400 : 502,
    noRetry: false,
    message: `zcode 上游返回 HTTP ${status}。${snippet(body)}`,
  }
}

/** 退避等待（线性递增，与适配器同源：900ms 实测仍撞 429，故起点 1500ms）。 */
function concurrencyDelayMs(attempt: number, baseMs: number): number {
  return (baseMs > 0 ? baseMs : 1_500) * (Math.max(0, Math.floor(attempt)) + 1)
}

/** 读完整请求体。 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error(`request body exceeds ${MAX_REQUEST_BYTES} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 写一个 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    ...headers,
  })
  response.end(body)
}

/** 把一帧 SSE 转写成字节。 */
function serializeFrame(frame: SseFrame): string {
  const lines: string[] = []
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`)
  for (const line of frame.data.split('\n')) lines.push(`data: ${line}`)
  return `${lines.join('\n')}\n\n`
}

/** 发一个 `event: error` 帧（pi-ai 会当场抛错）。 */
function errorFrame(type: string, message: string): string {
  return serializeFrame({ event: 'error', data: JSON.stringify({ type: 'error', error: { type, message } }) })
}

/**
 * 启动本地桥。
 *
 * ⚠ 只监听 `127.0.0.1`：桥不需要鉴权（上游凭据留在宿主进程里），
 * 但也绝不对外暴露。
 */
export async function startZcodeBridge(options: ZcodeBridgeOptions): Promise<ZcodeBridgeHandle> {
  const product = options.product ?? ZCODE
  const fetchImpl = options.fetchImpl ?? fetch
  const gate = options.gate ?? new ModelGate({ serialize: product.serializeUpstream, gaps: product.modelGapMs })
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const streamIdleMs = options.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS
  const logger = options.logger

  let remoteModels: readonly ZcodeRemoteModelLike[] | undefined

  /** 模型目录：远端优先，失败/为空回退兜底表。 */
  const loadModels = async (): Promise<readonly ZcodeRemoteModelLike[]> => {
    if (remoteModels !== undefined) return remoteModels
    let fetched: readonly ZcodeRemoteModelLike[] = []
    try {
      fetched = (await options.fetchRemoteModels?.()) ?? []
    } catch (error) {
      logger?.warn?.(`[zcode-bridge] 远端模型目录拉取失败，回退兜底表：${String(error)}`)
    }
    remoteModels = fetched.length > 0 ? fetched : product.fallbackModels
    return remoteModels
  }

  /** 额度用尽时换账号（与 `zcode-adapter.ts` 的 `switchAccountOnQuota` 同语义）。 */
  const switchAccount = async (
    model: string,
    tried: Set<string>,
    activeAccountId: string | undefined,
  ): Promise<{ credential: ZcodeCredential; accountId: string } | undefined> => {
    const pool = options.accountPool
    if (pool === undefined) return undefined
    if (activeAccountId !== undefined) {
      await pool.updateModelRateLimit(activeAccountId, model, nextUtc8DayStartMs())
      tried.add(activeAccountId)
    }
    const next = await pool.getAvailableAccount(product.id, model, tried)
    if (next === null || next === undefined || tried.has(next.entry.id)) return undefined
    tried.add(next.entry.id)
    return { credential: next.credential as unknown as ZcodeCredential, accountId: next.entry.id }
  }

  /** 处理 `POST /v1/messages`。 */
  const handleMessages = async (
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
    signal: AbortSignal,
  ): Promise<void> => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(body) as Record<string, unknown>
    } catch {
      sendJson(response, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'zcode-bridge: 请求体不是合法 JSON' } })
      return
    }

    const model = typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : ''
    if (model.length === 0) {
      sendJson(response, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'zcode-bridge: 缺少 model' } })
      return
    }

    /**
     * ⚠ 必须**追加**到官方身份块之后，而不是替换：pi-ai 发来的单块 system
     * 是 DSH 自己的规范，zcode 上游要的是「官方身份块 + 调用方规范」。
     */
    const callerSystem = Array.isArray(parsed.system)
      ? (parsed.system as { type?: unknown; text?: unknown }[])
          .filter(block => block?.type === 'text' && typeof block.text === 'string')
          .map(block => String(block.text))
          .join('\n\n')
      : typeof parsed.system === 'string'
        ? parsed.system
        : ''

    const incomingMessages = Array.isArray(parsed.messages) ? (parsed.messages as { role?: unknown; content?: unknown }[]) : []
    const messages = withContextPrefix(incomingMessages as { role: string; content: unknown }[])

    /** 上游请求体：pi-ai 的形状已经与 zcode 同构，只换 system / messages。 */
    const outgoing: Record<string, unknown> = {
      ...parsed,
      model,
      max_tokens: typeof parsed.max_tokens === 'number' && parsed.max_tokens > 0 ? parsed.max_tokens : 8192,
      system: buildZcodeSystemBlocks(callerSystem, {
        cwd: process.cwd(),
        provider: product.id,
        model,
      }),
      messages,
      stream: true,
    }
    /**
     * 三个 pi-ai / Anthropic 专有字段要摘掉：
     * - `betas` 是 Anthropic 的 header 化参数，zcode 网关不认；
     * - `thinking`（`{type:'adaptive'}`）—— 实测**必须不发**：zcode 的思考开关
     *   就是 `output_config.effort`（上游 `client/configs` 里
     *   `reasoning.levels[level].anthropic.set = {path:["output_config","effort"]}`
     *   是权威依据），多发一个 `thinking` 只会引入 400 风险；
     * - `metadata` / `fallbacks` 同理。
     */
    delete outgoing.betas
    delete outgoing.thinking
    delete outgoing.metadata
    delete outgoing.fallbacks

    const tried = new Set<string>()
    let activeAccountId = options.currentAccountId?.()
    if (activeAccountId !== undefined) tried.add(activeAccountId)

    let switchedAccount = false
    let credential: ZcodeCredential | undefined
    let upstream: Response | undefined

    for (let quotaRound = 0; ; quotaRound += 1) {
      credential = await options.resolveCredential(model)
      if (credential === undefined) {
        sendJson(response, 401, {
          type: 'error',
          error: {
            type: 'authentication_error',
            message:
              'zcode-bridge: 没有可用的凭据 —— 请在 Jet Hub 的 ZCode 面板点「添加账号」完成登录' +
              '（若已装官方 ZCode 客户端并登录过，本插件也会自动读取它的凭据）',
          },
        })
        return
      }

      for (let attempt = 0; ; attempt += 1) {
        if (signal.aborted) return
        // captcha 是一次性的：每轮、每次尝试都必须现产一个新的。
        let captchaParam: string
        try {
          captchaParam = await options.mintCaptcha({ signal })
        } catch (error) {
          const failure =
            error instanceof GateAbortedError || signal.aborted
              ? undefined
              : { status: 502, noRetry: false, message: `zcode-bridge: captcha 产出失败：${String(error)}` }
          if (failure === undefined) return
          sendJson(response, failure.status, { type: 'error', error: { type: 'api_error', message: failure.message } })
          return
        }

        const headers = buildZcodeHeaders(credential, {
          authorization: `Bearer ${credential.zcode_jwt}`,
          captcha: { param: captchaParam, region: options.captchaRegion ?? 'cn' },
        })

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
        timer.unref?.()
        const onAbort = (): void => controller.abort()
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          upstream = await gate.run(
            model,
            async () =>
              await fetchImpl(ZCODE_PLAN_MESSAGES_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify(outgoing),
                signal: controller.signal,
              }),
            { signal },
          )
        } catch (error) {
          if (error instanceof GateAbortedError || signal.aborted) return
          const timedOut = controller.signal.aborted
          sendJson(response, timedOut ? 504 : 502, {
            type: 'error',
            error: {
              type: 'api_error',
              message: timedOut
                ? `zcode-bridge: 请求超时（${requestTimeoutMs}ms 内未建立上游连接）—— 上游可能长时间不返回数据`
                : `zcode-bridge: 请求失败：${error instanceof Error ? error.message : String(error)}`,
            },
          })
          return
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
        }

        /**
         * 闸门只该包住这一下 fetch —— 上面的 `finally` 释放的是本次尝试的
         * 超时与中断监听，流式阶段另有空闲看门狗（见 `relay`）。
         */
        if (upstream.ok && upstream.body !== null) break

        const text = upstream.ok ? '' : await upstream.text().catch(() => '')
        if (upstream.ok && upstream.body === null) {
          // HTTP 200 + 空 body：实测同样是「额度/权益」形态（跳过了整个 SSE 消费）。
          if (quotaRound < product.quotaSwitchMax) {
            const switched = await switchAccount(model, tried, activeAccountId)
            if (switched !== undefined) {
              credential = switched.credential
              activeAccountId = switched.accountId
              switchedAccount = true
              break
            }
          }
          sendJson(response, 429, {
            type: 'error',
            error: { type: 'quota_exceeded_error', message: quotaFailure(model, '', tried.size).message },
          }, { 'x-should-retry': 'false' })
          return
        }

        if (isQuotaExhausted(upstream.status, text)) {
          if (quotaRound < product.quotaSwitchMax) {
            const switched = await switchAccount(model, tried, activeAccountId)
            if (switched !== undefined) {
              credential = switched.credential
              activeAccountId = switched.accountId
              switchedAccount = true
              break
            }
          }
        } else if (isConcurrencyLimited(upstream.status, text) && attempt < product.concurrencyRetryMax) {
          await new Promise<void>(resolve => {
            const delay = setTimeout(resolve, concurrencyDelayMs(attempt, product.concurrencyRetryBaseMs))
            delay.unref?.()
          })
          continue
        }

        const failure = classifyUpstreamFailure(model, upstream.status, text, tried.size)
        sendJson(
          response,
          failure.status,
          { type: 'error', error: { type: failure.noRetry ? 'quota_exceeded_error' : 'api_error', message: failure.message } },
          failure.noRetry ? { 'x-should-retry': 'false' } : {},
        )
        return
      }

      if (switchedAccount) {
        switchedAccount = false
        continue
      }
      break
    }

    if (upstream === undefined || upstream.body === null) {
      sendJson(response, 502, { type: 'error', error: { type: 'api_error', message: 'zcode-bridge: 上游请求未发出（内部状态异常）' } })
      return
    }

    await relay(upstream.body, response, model, tried.size, signal)
  }

  /**
   * 把上游 SSE 逐帧转写出去。
   *
   * 唯一的加工：**扣住 `message_stop`**。整条流一帧内容都没有时改发
   * `event: error`（见文件头「为什么是透明」一节）。
   */
  const relay = async (
    upstreamBody: ReadableStream<Uint8Array>,
    response: ServerResponse,
    model: string,
    attemptedAccounts: number,
    signal: AbortSignal,
  ): Promise<void> => {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.flushHeaders?.()

    const idle = new AbortController()
    let sawContent = false
    let pendingStop: string | undefined
    let idleTimer: NodeJS.Timeout | undefined
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => idle.abort(), streamIdleMs)
      idleTimer.unref?.()
    }
    const onAbort = (): void => idle.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const combined = AbortSignal.any([signal, idle.signal])

    const write = async (chunk: string): Promise<void> => {
      if (response.writableEnded) return
      await new Promise<void>(resolve => {
        response.write(chunk, () => resolve())
      })
    }

    try {
      armIdle()
      for await (const frame of iterateSseFrames(upstreamBody, { signal: combined })) {
        armIdle()
        if (frame.event === 'error') {
          await write(serializeFrame(frame))
          return
        }
        if (frame.event === 'message_stop') {
          pendingStop = serializeFrame(frame)
          continue
        }
        if (frame.event === 'content_block_start') sawContent = true
        await write(serializeFrame(frame))
      }
    } catch (error) {
      if (idle.signal.aborted && !signal.aborted) {
        await write(errorFrame('api_error', `zcode-bridge: 上游流式响应空闲超时（${streamIdleMs}ms 内没有新数据）`))
        return
      }
      if (!signal.aborted) {
        await write(errorFrame('api_error', `zcode-bridge: 读取上游流失败：${error instanceof Error ? error.message : String(error)}`))
      }
      return
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      signal.removeEventListener('abort', onAbort)
    }

    if (pendingStop !== undefined) {
      await write(pendingStop)
      return
    }
    if (sawContent) {
      // 上游没给收尾帧（极少见）：补一个，避免 pi-ai 报
      // 「Anthropic stream ended before message_stop」。
      await write(serializeFrame({ event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) }))
      return
    }
    // 200 + 无任何内容块 = 「无权益」指纹（实测 150-200ms 秒回空）。
    await write(errorFrame('quota_exceeded_error', quotaFailure(model, '', attemptedAccounts).message))
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    void (async (): Promise<void> => {
      try {
        if (request.method === 'GET' && (path === '/health' || path === '/healthz')) {
          const models = await loadModels()
          sendJson(response, 200, { ok: true, provider: product.id, models: models.length })
          return
        }
        if (request.method === 'GET' && (path === '/v1/models' || path === '/models')) {
          const models = await loadModels()
          sendJson(response, 200, {
            data: models.map(entry => ({
              id: entry.id,
              display_name: entry.name,
              contextWindow: entry.contextWindow,
              maxTokens: entry.maxTokens,
              input_modalities: entry.supportsImage ? ['text', 'image'] : ['text'],
            })),
          })
          return
        }
        if (request.method === 'POST' && (path === '/v1/messages' || path === '/v1/v1/messages')) {
          const body = await readBody(request)
          const controller = new AbortController()
          response.on('close', () => controller.abort())
          await handleMessages(request, response, body, controller.signal)
          if (!response.writableEnded) response.end()
          return
        }
        sendJson(response, 404, { type: 'error', error: { type: 'not_found_error', message: `zcode-bridge: 未知路径 ${path}` } })
      } catch (error) {
        logger?.warn?.(`[zcode-bridge] 处理 ${request.method ?? '?'} ${path} 失败：${String(error)}`)
        if (!response.headersSent) {
          sendJson(response, 500, { type: 'error', error: { type: 'api_error', message: `zcode-bridge: ${String(error)}` } })
        } else if (!response.writableEnded) {
          response.end()
        }
      }
    })()
  })

  /**
   * ⚠ Node 的 `server.listen()` 失败（最典型 `EADDRINUSE`）**`await` 一个内部
   * 调用 `listen()` 的 Promise 捕获不到** —— 必须在 `listen()` **之前**注册
   * `'error'`（`trae-oauth.ts` 记过这条）。
   */
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const baseUrl = `http://127.0.0.1:${port}`
  logger?.info?.(`[zcode-bridge] 本地 Anthropic 桥已监听 ${baseUrl}`)

  return {
    baseUrl,
    port,
    modelIds: async () => (await loadModels()).map(entry => entry.id),
    models: async () => await loadModels(),
    close: async () => {
      await new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
