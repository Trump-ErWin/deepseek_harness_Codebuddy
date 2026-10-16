/**
 * AutoClaw LLM 适配器。
 *
 * 把 DSH 的 `LlmAdapter` 调用转发到智谱 AutoClaw 桌面端代理网关。
 * 遵循 OpenAI Chat Completions 协议，并实施必要的 406 绕过前缀校验与动态签名。
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import {
  AUTOCLAW,
  type AutoclawProduct,
} from './autoclaw-product.js'
import {
  AUTOCLAW_CHAT_PATH,
  AUTOCLAW_MODEL_CONFIG_PATH,
  calculateAutoclawSign,
  cleanBearerToken,
  normalizeAutoclawModel,
  prepareAutoclawMessages,
  buildAutoclawHeaders,
  type AutoclawCredential,
  type ChatMessage,
} from './autoclaw.js'
import {
  serializeMessages,
  collectImages,
  consumeOpenAiSse,
} from './openai-compat.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

export interface AutoclawAdapterOptions {
  /** 凭据获取函数。支持按模型选号。 */
  resolveCredential?: (modelId?: string) => Promise<AutoclawCredential | undefined>
  /** 凭据获取函数（旧兼容）。 */
  credentialProvider?: () => Promise<AutoclawCredential | undefined>
  /** 探测凭据函数。 */
  probeCredential?: () => Promise<AutoclawCredential | undefined>
  /** 覆盖默认的 fetch（测试注入）。 */
  fetchImpl?: typeof fetch
  /** 凭据刷新回调。 */
  refresh?: () => Promise<void>
  /** 黑名单模型过滤。 */
  disabledModels?: () => ReadonlySet<string>
  /** 目录加载完成通知。 */
  onCatalogLoaded?: () => void
  /** 产品配置。 */
  product?: AutoclawProduct
}

export class AutoclawAdapter extends LlmAdapter {
  private readonly product: AutoclawProduct
  private announced = false

  constructor(private readonly options: AutoclawAdapterOptions = {}) {
    super()
    this.product = options.product ?? AUTOCLAW
  }

  private async resolveCredential(modelId?: string): Promise<AutoclawCredential | undefined> {
    if (this.options.resolveCredential) {
      return this.options.resolveCredential(modelId)
    }
    if (this.options.credentialProvider) {
      return this.options.credentialProvider()
    }
    return undefined
  }

  private async probeCredential(): Promise<AutoclawCredential | undefined> {
    if (this.options.probeCredential) {
      return this.options.probeCredential()
    }
    return this.resolveCredential()
  }

  get provider(): string {
    return this.product.id
  }

  async getProviderInfo(id: string): Promise<{ id: string; name: string }> {
    return { id, name: this.product.displayName }
  }

  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[] {
    return this.product.fallbackModels.map((m) => ({
      id: m.id,
      name: m.name,
      isFree: m.isFree === true,
    }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const disabled = this.options.disabledModels?.() ?? new Set<string>()
    const credential = await this.probeCredential()
    if (!credential) return []

    // 尝试探测连通性（即使探活端点异常也不阻断兜底模型目录）
    try {
      await this.probe(credential)
    } catch {
      // ignore
    }

    this.announceLater()

    return this.product.fallbackModels
      .filter((m) => !disabled.has(m.id))
      .map((m) => ({
        provider: this.product.id,
        id: m.id,
        name: m.name,
        inputModalities: ['text'] as const,
        isFree: m.isFree === true,
      }))
  }

  private announceLater(): void {
    if (this.announced) return
    this.announced = true
    setTimeout(() => {
      try {
        this.options.onCatalogLoaded?.()
      } catch {
        // ignore
      }
    }, 0)
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const norm = normalizeAutoclawModel(model)
    const known = this.product.fallbackModels.find((m) => m.id === norm || m.id === model)
    const baseName = known?.name ?? model
    return {
      provider,
      id: model,
      name: baseName,
      inputModalities: known?.supportsImage ? (['text', 'image'] as const) : (['text'] as const),
      ...(known === undefined ? {} : {
        context: {
          contextWindow: known.contextWindow,
          ...(known.maxOutputTokens !== undefined ? { maxOutputTokens: known.maxOutputTokens } : {}),
        },
      }),
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: '快速思考 (Low)' },
          { id: ReasoningEffortId('high'), name: '深度思考 (High)' },
          { id: ReasoningEffortId('max'), name: '极限推理 (Max)' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }
  }

  private async probe(credential: AutoclawCredential): Promise<boolean> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8_000)
    try {
      const f = this.options.fetchImpl ?? fetch
      const ts = Math.floor(Date.now() / 1000).toString()
      const sign = calculateAutoclawSign(this.product.appId, ts, this.product.appKey)
      const cleanAccess = cleanBearerToken(credential.access_token)

      const r = await f(`${this.product.apiBase}${AUTOCLAW_MODEL_CONFIG_PATH}`, {
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Appid': this.product.appId,
          'X-Auth-TimeStamp': ts,
          'X-Auth-Sign': sign,
          'X-Authorization': `Bearer ${cleanAccess}`,
          Authorization: `Bearer ${cleanAccess}`,
          'X-Client-Type': 'pc',
          x_trace_id: 'autoclaw-desktop',
        },
        signal: ctrl.signal,
      })
      return r.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const model = options.model
    let credential = await this.resolveCredential(model)
    if (!credential) {
      throw new Error(
        '未找到 AutoClaw 凭据：请先在 AutoClaw 桌面端完成登录，或在 Jet Hub 账号管理中添加 AutoClaw 账号',
      )
    }

    const f = this.options.fetchImpl ?? fetch
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort)

    // 收集图片引用
    const imageRefs = new Map<string, unknown>()
    for (const msg of options.messages ?? []) {
      if (Array.isArray(msg.content)) {
        collectImages(msg.content, imageRefs)
      }
    }
    if (imageRefs.size > 0) {
      throw new Error('AutoClaw 目前仅支持文本输入，暂不支持直接传输多模态图片')
    }

    // 序列化消息：带入 options.system（若有）并通过 prepareAutoclawMessages 注入 406 绕过前缀与人设隔离标记
    const rawSerialized = serializeMessages(options.messages)
    if (options.system !== undefined && options.system.trim().length > 0) {
      rawSerialized.unshift({ role: 'system', content: options.system.trim() })
    }
    const wireMessages = prepareAutoclawMessages(rawSerialized as unknown as ChatMessage[])

    const upstreamModel = normalizeAutoclawModel(model)

    // 转换 tools 为 OpenAI function calling 标准格式
    const tools = options.tools && options.tools.length > 0
      ? options.tools.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            ...(tool.description && tool.description.length > 0 ? { description: tool.description } : {}),
            ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
          },
        }))
      : undefined

    const bodyObj: Record<string, unknown> = {
      model: upstreamModel,
      messages: wireMessages,
      stream: true,
      // 智谱 AutoClaw 网关限制：若传递 max_tokens < 10000 会触发 406 Not Acceptable，
      // 故对小于 16384 的 maxTokens 做安全下限防护（与 AutoClaw 桌面端 32768/16384 规范对齐）。
      ...(options.maxTokens !== undefined ? { max_tokens: Math.max(16384, options.maxTokens) } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.reasoningEffort !== undefined ? {
        reasoning_effort: String(options.reasoningEffort),
        thinking_level: String(options.reasoningEffort),
      } : {}),
      ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
    }
    if (tools !== undefined && tools.length > 0) {
      bodyObj.tools = tools
    }

    const payload = JSON.stringify(bodyObj)

    const headers = buildAutoclawHeaders({
      product: this.product,
      accessToken: credential.access_token,
      modelId: upstreamModel,
      stream: true,
      deviceId: credential.device_id,
    })

    let response: Response
    try {
      response = await f(`${this.product.apiBase}${AUTOCLAW_CHAT_PATH}`, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      })
    } catch (err) {
      options.signal?.removeEventListener('abort', onAbort)
      throw err
    }

    if (!response.ok && (response.status === 401 || response.status === 403) && this.options.refresh) {
      try {
        await this.options.refresh()
        const refreshed = await this.resolveCredential(model)
        if (refreshed && refreshed.access_token.length > 0) {
          credential = refreshed
          const retryHeaders = buildAutoclawHeaders({
            product: this.product,
            accessToken: credential.access_token,
            modelId: upstreamModel,
            stream: true,
            deviceId: credential.device_id,
          })
          response = await f(`${this.product.apiBase}${AUTOCLAW_CHAT_PATH}`, {
            method: 'POST',
            headers: retryHeaders,
            body: payload,
            signal: controller.signal,
          })
        }
      } catch {
        // 忽略重试失败，交由下方错误检测
      }
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      options.signal?.removeEventListener('abort', onAbort)
      throw new Error(
        `AutoClaw 请求失败 [${response.status} ${response.statusText}]: ${errText.slice(0, 300)}`,
      )
    }

    try {
      yield* consumeOpenAiSse(
        response,
        { ...options.signal === undefined ? {} : { signal: options.signal } },
        {
          label: 'autoclaw',
          firstTokenTimeoutMs: 120_000,
          chunkTimeoutMs: 60_000,
          ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        },
      )
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * 在 `ctx.llm` 上注册 AutoClaw provider 路由与适配器。
 */
export function registerAutoclawLlm(
  ctx: Context,
  options: AutoclawAdapterOptions,
): AutoclawAdapter {
  const product = options.product ?? AUTOCLAW
  const adapter = new AutoclawAdapter({
    ...options,
    onCatalogLoaded: () => broadcastCatalogChanged(ctx),
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
