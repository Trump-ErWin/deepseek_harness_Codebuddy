/**
 * Gemini（Cloud Code Assist）模型适配器。
 *
 * 协议实现（信封构造、SSE 消费）在 `gemini-messages.ts`，
 * 认证在 `gemini-auth.ts`，配额在 `gemini-credits.ts`。
 *
 * ## ⚠️ 本适配器独有的四件事（照 `docs/GEMINI-PORT-PLAN.md` §3.1/§3.2）
 *
 * 1. **两层救场**：先换端点（廉价兜底），再换账号（主救场）。
 *    ⚠️ 端点差异**未获实验支持**（404 / project 两类错误两端点行为完全一致），
 *    换端点零成本无害，但**不能当 quota 的有效解法**。
 * 2. **签名回填 + 去签重试**：`functionCall` 上的 `thoughtSignature` 由
 *    `gemini-sigstore.ts` 落盘缓存，下一轮按「工具名 + 规范化参数」回填；
 *    上游仍拒签名时**去签重试一次**。
 * 3. **图片两跳**：先 `projectRequestImage`（插件侧缩放，640,000 px），
 *    拿不到才 `readImage`（原图）。两者都拿不到**抛错**，绝不静默丢图。
 * 4. **`toolChoice` 恒 AUTO**：`@deepseek-ai/dsh-llm` 的 `GenerateOptions`
 *    **没有** `toolChoice` 字段（实测 `lib/types/types.d.ts:380-416`），
 *    故不传；`translateGeminiRequest` 内部默认走 `AUTO`。
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { providerCatalogVisible, type AccountPool } from './account-pool.js'
import { collectImages, httpErrorCode } from './openai-compat.js'
import { projectRequestImage } from './image-budget.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import {
  GEMINI,
  GEMINI_ENDPOINTS,
  GEMINI_IDLE_TIMEOUT_MS,
  GEMINI_MAX_IMAGE_BYTES_INLINE,
  GEMINI_SESSION_ID_INFER,
  GEMINI_STREAM_PATH,
  GEMINI_UPSTREAM_FLASH,
  geminiCanonicalModelId,
  geminiFallbackEntries,
  geminiHeaders,
  geminiModelSpec,
  geminiReasoningInfo,
  isGeminiExpired,
  marshalAlphabetical,
  newGeminiRequestId,
  normalizeBase64,
  type GeminiCredential,
  type GeminiModelEntry,
  type GeminiProduct,
} from './gemini.js'
import { consumeGeminiSse, translateGeminiRequest } from './gemini-messages.js'
import type { GeminiSigStore } from './gemini-sigstore.js'

/** 最多换几个账号（含起始账号）。 */
const GEMINI_MAX_ROTATE = 3
/** 429 命中后原账号的冷却时长（计划 §3.1）。 */
const GEMINI_RATE_LIMIT_COOLDOWN_MS = 60_000
/** 401 命中后原账号的冷却时长（计划 §3.1）。 */
const GEMINI_AUTH_COOLDOWN_MS = 300_000

/**
 * 判定「签名被上游拒绝」（原版 `IsSignatureError` 的口径）。
 *
 * ⚠️ 必须**宽**：上游对签名问题的报错文案不统一（`thought_signature`、
 * `Invalid signature`、`signature is required`…），而漏判的后果是
 * 用户看到一次莫名其妙的 400；误判的后果只是多发一次不带签名的请求
 * （那条路径本来就要试）。
 */
export function isGeminiSignatureError(text: string): boolean {
  const lower = text.toLowerCase()
  if (lower.includes('signature')) return true
  return lower.includes('thought') && lower.includes('invalid')
}

/** 400 的正文是否指向配额/权限类问题（决定「先换端点再换账号」）。 */
function isGeminiSwitchableText(text: string): boolean {
  const lower = text.toLowerCase()
  return ['quota', 'permission', 'unsupported', 'project'].some((word) => lower.includes(word))
}

/** 400 的正文是否明确是配额耗尽（归类 `QUOTA_EXCEEDED`）。 */
function isGeminiQuotaText(text: string): boolean {
  const lower = text.toLowerCase()
  return ['quota', 'resource_exhausted', 'resource exhausted', 'rate limit', 'exceeded']
    .some((word) => lower.includes(word))
}

/** {@link GeminiAdapter} 的构造选项。 */
export interface GeminiAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<GeminiCredential | undefined>
  /** 凭据失效时的处理（续期或换号，由接线侧决定）。 */
  refresh: () => Promise<void>
  /** 账号池（目录门控、黑名单、限流切号）。 */
  accountPool?: AccountPool
  /**
   * 内联一张图片为**原始字节**（由调用方桥接 `ctx.attachments.readImage`）。
   *
   * ⚠️ 契约与 `buddy-adapter.ts:195` 一致：**读不到必须抛错**，不得返回空。
   * 静默丢图会让用户以为图片被模型看到了（与 cline / lobsterai 同口径）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string }>
  /**
   * 取**请求版本**图片（附件服务按目标尺寸缩放）。
   *
   * ⚠️ 契约与 `readImage` **相反**：不可用时返回 `undefined`（不是抛错）——
   * 缩放是优化，拿不到就发原图（见 `image-budget.ts:151`）。
   */
  readImageRequest?: (
    attachment: unknown,
    target: { width: number; height: number; maxBytes: number },
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** `thoughtSignature` 缓存（未提供则每轮都不带签名）。 */
  sigStore?: GeminiSigStore
  /** 上行会话 id；缺省 {@link GEMINI_SESSION_ID_INFER}。 */
  sessionId?: string
  /** 产品配置；默认 {@link GEMINI}。 */
  product?: GeminiProduct
}

/** Gemini（Cloud Code Assist）模型适配器。 */
export class GeminiAdapter extends LlmAdapter {
  private readonly product: GeminiProduct

  constructor(private readonly options: GeminiAdapterOptions) {
    super()
    this.product = options.product ?? GEMINI
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 静态模型表（用户拍板：不拉远端目录）。
   *
   * ⚠️ 静态表**每次现算**（纯本地、零成本），不做任何缓存 —— 缓存只会带来
   * 「表被改过但进程还拿着旧值」这一种故障。
   */
  private loadModels(): readonly GeminiModelEntry[] {
    return geminiFallbackEntries()
  }

  /**
   * 完整目录（**不套黑名单**），供 Jet Hub「显示列表」用。
   *
   * ⚠️ **必须同步返回数组，不能是 `async`**（`minimax-adapter.ts:218-242`
   * 记录的同类缺陷：写成 async 会让 `jet-hub-rpc.ts:2041 [...all]` 与
   * `:2125 all.map` 抛 `TypeError: all is not iterable`）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.loadModels().map((model) => ({ id: model.id, name: model.name }))
  }

  private inputModalitiesFor(
    entry: GeminiModelEntry | undefined,
  ): readonly ('text' | 'image')[] {
    return entry?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 把整个 provider 分组隐藏。
    // **必须返回空数组而不能抛错**（抛错会多一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const all = this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entry = this.loadModels().find((item) => item.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: this.inputModalitiesFor(entry),
    }
    // ⚠️ 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）
    if (entry !== undefined && entry.contextWindow > 0) {
      resolved.context = { contextWindow: entry.contextWindow }
    }
    // ⚠️ 远端/静态非法值必须过滤：0/负数/NaN 会让 DSH 抛
    // `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）。
    // ⚠️ 先取局部变量再判：`entry.maxTokens` 是可选属性，
    // `Number.isSafeInteger` 不做类型收窄，直接连写会报 TS18048。
    const maxTokens = entry?.maxTokens
    if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
      resolved.defaultMaxTokens = maxTokens
    }
    // ⚠️ 无档位的模型（例如用户手填的未知 id）⇒ `undefined` ⇒ **不声明**
    //（空数组会让面板显示一个点不开的空下拉框）。
    if (entry !== undefined) {
      const reasoning = geminiReasoningInfo(entry)
      if (reasoning !== undefined) resolved.reasoning = reasoning
    }
    return resolved
  }

  /** 兼容 0.1.1-rc.2 的 `prepareCall` shim（与其余适配器同款）。 */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /** 图片两跳的第一跳（缩放版）；返回 `undefined` 表示「该发原图」。 */
  private async projectImage(
    ref: unknown,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> {
    return await projectRequestImage(ref, {
      readImageRequest: this.options.readImageRequest,
      pixelBudget: this.product.imagePixelBudget,
    })
  }

  /**
   * 收集并内联本次请求涉及的全部图片。
   *
   * ⚠️ 两跳都失败时**必须抛错**（`buddy-adapter.ts:1239-1285` 的权威写法）：
   * 静默丢弃会表现为「图片凭空消失、模型答非所问」，是最难排查的一类问题。
   */
  private async collectInlineImages(
    messages: GenerateOptions['messages'],
    entry: GeminiModelEntry | undefined,
    model: string,
  ): Promise<Map<string, { mediaType: string; data: string }> | undefined> {
    const imageRefs = new Map<string, unknown>()
    for (const message of messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    if (imageRefs.size === 0) return undefined

    // ⚠️ 先判定模型能力：DSH 按适配器播报的 `inputModalities` 决定要不要把
    // 图片投影成文本占位符。声明支持就必须真支持。
    if (entry?.supportsImage !== true) {
      throw new LlmError(
        `gemini: 模型 "${model}" 不支持图片输入`,
        'UNSUPPORTED_CONTENT',
      )
    }

    const images = new Map<string, { mediaType: string; data: string }>()
    for (const [id, ref] of imageRefs) {
      const projected = await this.projectImage(ref)
      let inline = projected
      if (inline === undefined) {
        const readImage = this.options.readImage
        if (readImage === undefined) {
          throw new LlmError(
            'gemini: 图片输入需要附件服务（readImage / readImageRequest 均未提供）',
            'UNSUPPORTED_CONTENT',
          )
        }
        try {
          inline = await readImage(ref)
        } catch (error) {
          throw new LlmError(
            'gemini: 图片附件读取失败；附件服务可能未就绪，或该对象已不存在。',
            'UNSUPPORTED_CONTENT',
            { cause: error },
          )
        }
      }
      if (inline === undefined) {
        throw new LlmError(
          'gemini: 图片附件读取不到内容；附件服务可能未就绪，或该对象已不存在。',
          'UNSUPPORTED_CONTENT',
        )
      }
      if (inline.data.byteLength > GEMINI_MAX_IMAGE_BYTES_INLINE) {
        throw new LlmError(
          `gemini: 图片体积 ${inline.data.byteLength} 字节超过上游内联上限`
          + ` ${GEMINI_MAX_IMAGE_BYTES_INLINE} 字节`,
          'UNSUPPORTED_CONTENT',
        )
      }
      const data = normalizeBase64(Buffer.from(inline.data).toString('base64'))
      if (data === undefined) {
        throw new LlmError('gemini: 图片编码不是合法 base64', 'UNSUPPORTED_CONTENT')
      }
      images.set(id, { mediaType: inline.mediaType === '' ? 'image/png' : inline.mediaType, data })
    }
    return images
  }

  /**
   * 走 **Cloud Code 流式推理** 发一次请求。
   *
   * 控制流（计划 §3.1 的完整实现）：
   * 1. 签名被拒 → 去签重试一次（同账号同端点）；
   * 2. 403/404、400(quota|permission|unsupported|project) → 先换端点一次；
   * 3. 429 第一次 → 先换端点（廉价尝试），第二次 → 换账号（主救场）；
   * 4. 401 → 先续期一次，续不动 → 换账号；
   * 5. 换账号用**局部可变**的 `currentAccountId`，`tried` 集合跨轮保留；
   * 6. 全部试完 → 抛 `QUOTA_EXCEEDED`（不无限切）。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // ⚠️ 模型名**先查表再取凭据**：未知 id 立即拒绝（纯本地判定，零网络、
    // 零凭据成本）。放行的后果是上游对未知模型名**静默接受并落回
    // gemini-3.8-flash**（实测假名 200、正常作答 —— 名字根本不参与上游
    // 路由），用户选错模型时拿到的是错误模型的答案且无任何征兆，比报错
    // 难查得多。错误码用 INVALID_REQUEST：不在 harness 可重试集合（不白
    // 退避），也不是 AUTH/QUOTA（不触发换号/续期）。
    // ⚠️ 限流标记 / `account.test` 探测链路传来的是**带档位的名字**
    // （写标记用请求原始 id），先归一化再查表 —— 否则「测一下被限流的
    // 档位」会被误拒（探测功能回归）。
    const entry = this.loadModels().find((item) => item.id === geminiCanonicalModelId(options.model))
    if (entry === undefined) {
      throw new LlmError(
        `gemini: 模型 "${options.model}" 不在本 provider 目录中（仅支持 ${GEMINI_UPSTREAM_FLASH}）`,
        'INVALID_REQUEST',
      )
    }

    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isGeminiExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token === '') {
      throw new LlmError('gemini: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    const requested = options.reasoningEffort === undefined
      ? undefined
      : String(options.reasoningEffort)
    // ⚠️ 档位合法性：与 `geminiReasoningInfo` 的产出**保持一致**
    //（否则 UI 给了选项、请求却把它丢掉 —— 用户选了「高」而模型按「中」跑）。
    const declared = entry === undefined ? undefined : geminiReasoningInfo(entry)
    const effort = requested !== undefined
      && declared?.efforts.some((item) => String(item.id) === requested) === true
      ? requested
      : undefined
    const spec = geminiModelSpec(options.model, effort)

    const images = await this.collectInlineImages(options.messages, entry, options.model)

    const sessionId = this.options.sessionId ?? GEMINI_SESSION_ID_INFER
    const sigStore = this.options.sigStore
    const pool = this.options.accountPool

    // ⚠️ 起点账号：**局部可变**。不能每次问回调 —— 回调返回的是池的当前
    // 默认账号，换号后不跟着变，会让「换号」变成在两个账号间无限来回。
    let currentAccountId = ''
    if (pool !== undefined && credential.access_token !== '') {
      currentAccountId = await pool
        .findAccountIdByCredential(this.product.id, credential.access_token)
        .catch(() => '')
    }
    const tried = new Set<string>()
    if (currentAccountId !== '') tried.add(currentAccountId)

    let endpointIdx = 0
    let endpointSwitched = false
    let droppedSignatures = false
    let refreshedOnce = false
    let rotations = 0
    let lastFailure: { status: number; text: string } | undefined

    try {
      while (true) {
        // ⚠️ 每轮重新构造信封：`requestId` 每请求随机（原版口径），
        // 且去签重试时 `lookupSignature` 必须换成「返回 undefined」。
        const envelope = translateGeminiRequest({
          modelId: options.model,
          spec,
          messages: options.messages,
          ...options.system === undefined ? {} : { system: options.system },
          ...options.tools === undefined ? {} : { tools: options.tools },
          ...options.temperature === undefined ? {} : { temperature: options.temperature },
          ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
          sessionId,
          requestId: newGeminiRequestId(),
          ...images === undefined ? {} : { images },
          ...droppedSignatures || sigStore === undefined
            ? {}
            : { lookupSignature: (name: string, argsJson: string) => sigStore.get(name, argsJson) },
        })

        const url = `${GEMINI_ENDPOINTS[endpointIdx] ?? GEMINI_ENDPOINTS[0]}${GEMINI_STREAM_PATH}`
        let response: Response
        try {
          response = await fetch(url, {
            method: 'POST',
            // ⚠️ 流式**刻意不带 `Accept`**（抓包一致，见 `geminiHeaders`）。
            headers: geminiHeaders(credential),
            body: marshalAlphabetical(envelope),
            signal: options.signal,
          })
        } catch (error) {
          // 网络层失败：**如实抛 TRANSPORT**，让 harness 的退避去处理
          // （本适配器不自己重试网络错误 —— 那会与 harness 的退避叠加）。
          if (error instanceof LlmError) throw error
          throw new LlmError(
            `gemini: 请求发送失败 — ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error },
          )
        }

        if (response.ok) {
          if (response.body === null) {
            throw new LlmError('gemini: 响应缺少 body', 'EMPTY_RESPONSE')
          }
          const body = response.body
          try {
            yield* consumeGeminiSse({
              body,
              ...options.signal === undefined ? {} : { signal: options.signal },
              idleTimeoutMs: GEMINI_IDLE_TIMEOUT_MS,
              ...sigStore === undefined ? {} : { onSignature: (name, argsJson, sig) => sigStore.put(name, argsJson, sig) },
            })
          } finally {
            // ⚠️ 纯缓存，写失败只记日志（`flush` 内部已兜底）。
            await sigStore?.flush().catch(() => {})
          }
          return
        }

        const text = await response.text().catch(() => '')
        lastFailure = { status: response.status, text }
        const status = response.status

        // 1. 签名被拒 → 去签重试一次（同账号同端点）。
        if (isGeminiSignatureError(text) && !droppedSignatures) {
          droppedSignatures = true
          continue
        }

        const endpointFirst = status === 403
          || status === 404
          || (status === 400 && isGeminiSwitchableText(text))
        const quotaLike = status === 429 || (status === 400 && isGeminiQuotaText(text))

        // 2. 先换端点（廉价兜底，一次）。
        if ((endpointFirst || status === 429) && !endpointSwitched) {
          endpointSwitched = true
          endpointIdx = endpointIdx === 0 ? 1 : 0
          continue
        }

        // 3. 401 → 先续期一次，再考虑换账号。
        if (status === 401 && !refreshedOnce) {
          refreshedOnce = true
          await this.options.refresh().catch(() => {})
          const refreshed = await this.options.resolveCredential(options.model).catch(() => undefined)
          if (refreshed !== undefined && refreshed.access_token !== '') {
            credential = refreshed
            continue
          }
        }

        const rotatable = quotaLike || status === 401 || endpointFirst
        if (rotatable && pool !== undefined) {
          // 记限流/失效冷却：`getAvailableAccount` 会据此跳过该账号。
          if (currentAccountId !== '') {
            const cooldown = status === 401
              ? GEMINI_AUTH_COOLDOWN_MS
              : GEMINI_RATE_LIMIT_COOLDOWN_MS
            await pool
              .updateModelRateLimit(currentAccountId, options.model, Date.now() + cooldown)
              .catch(() => {})
          }
          if (rotations < GEMINI_MAX_ROTATE - 1) {
            const next = await pool.getAvailableAccount(this.product.id, options.model, tried)
            if (next !== null && next !== undefined && !tried.has(next.entry.id)) {
              rotations++
              tried.add(next.entry.id)
              currentAccountId = next.entry.id
              credential = next.credential as unknown as GeminiCredential
              // 换号后重置端点与去签状态：新账号值得从默认端点、带签名再试一次。
              endpointIdx = 0
              endpointSwitched = false
              droppedSignatures = false
              refreshedOnce = false
              continue
            }
          }
          throw new LlmError(
            `gemini: 模型 ${options.model} 的所有账号均不可用（限流或额度耗尽），请稍后再试`,
            'QUOTA_EXCEEDED',
            { status },
          )
        }

        // 4. 切完（或没有池）仍失败 → 透传原错误，归类见下。
        throw this.classifyFailure(status, text)
      }
    } finally {
      // 中途异常也要落盘：签名缓存是「下次能命中」的唯一来源。
      await sigStore?.flush().catch(() => {})
      void lastFailure
    }
  }

  /**
   * HTTP 失败 → {@link LlmError}。
   *
   * ⚠️ 归类必须拆细（计划 §3.1）：把 quota 归成 `SERVER` 会让 harness
   * 白重试 5 次（500/1000/2000/4000/8000 ≈ 15.5 秒），而 `QUOTA_EXCEEDED`
   * **不在** `DEFAULT_RETRYABLE_CODES` 里，会立刻把控制权交还用户。
   */
  private classifyFailure(status: number, text: string): LlmError {
    const detail = text === '' ? '' : ` — ${text.slice(0, 500)}`
    const message = `gemini: HTTP ${status}${detail}`
    if (status === 400 && isGeminiQuotaText(text)) {
      return new LlmError(message, 'QUOTA_EXCEEDED', { status })
    }
    if (status === 429) return new LlmError(message, 'RATE_LIMIT', { status })
    // ⚠️ 403/404 归 `SERVER`（计划 §3.1 明确），**不**用 `httpErrorCode` 的
    // `AUTH`：这两个码在 Cloud Code 上更多是「入口/模型注册表不认」，
    // 归成 AUTH 会把用户引向「去重新登录」这个无效动作。
    if (status === 403 || status === 404) return new LlmError(message, 'SERVER', { status })
    if (status === 401) return new LlmError(message, 'AUTH', { status })
    return new LlmError(message, httpErrorCode(status), { status })
  }
}

/** 在 `ctx.llm` 上注册 gemini provider 路由与适配器。 */
export function registerGeminiLlm(
  ctx: Context,
  options: GeminiAdapterOptions,
): GeminiAdapter {
  const product = options.product ?? GEMINI
  const adapter = new GeminiAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}

/** 供接线侧构造档位 id（避免各处重复 `as ReasoningEffortId`）。 */
export function geminiEffortId(id: string): ReasoningEffortId {
  return ReasoningEffortId(id)
}
