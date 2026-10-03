/**
 * 本机网关的 **OpenAI Responses API** 出口（`POST /v1/responses`）。
 *
 * ## 为什么要有它
 *
 * 网关最初只有 `/v1/chat/completions`。而新一代客户端（Codex CLI、以及各家
 * 「只认 Responses」的 agent）**不发** `messages` / `max_tokens`，而是发
 * `input` / `instructions` / `max_output_tokens`，并且只解析 Responses 的
 * SSE 事件（`response.output_text.delta` / `response.output_item.done` /
 * `response.completed`）。协议外壳不同，往里塞 Chat Completions 是塞不进的。
 *
 * ⚠️ **两个端点同时可用，不做「格式开关」**（用户 2026-10-03 明确要求）：
 * 客户端用哪套协议由它自己请求的 URL 决定。做成互斥开关只会让「另一个协议的
 * 客户端在切换后突然失效」，而网关这边本来就没有任何互斥的理由 ——
 * 两者共用同一份 provider 路由、账号池与图片入站。
 *
 * ## 与 `/v1/chat/completions` 的**有意差异**（改这个文件前先读）
 *
 * 1. **文本以 `block-end` 的组装块为权威**（见 {@link applyItemChunk}）。
 *    DSH 的 `block-end` 是**权威覆盖**（`openai-compat.ts` / `buddy-adapter.ts`
 *    的注释与 `scripts/verify-blockend-override.ts` 都写明这一点：死循环截断、
 *    泄漏清洗都只在 block-end 上生效），而 delta 累积只是「过程量」。
 *    Chat 路径忽略 block-end、只累加 delta，于是在上游触发正文死循环截断时
 *    会把重复正文一并交给客户端；本模块按协议本意取 block-end。
 *    ⚠️ 代价：同一个上游响应，两个端点在「正文死循环被截断」这种少数情况下
 *    会给出不同的文本。**这是本端点更正确**，不是缺陷；Chat 路径保持原样是
 *    因为「不顺手改既有端点的行为」。
 * 2. **`usage` 的字段口径与 Chat 路径一致**（`input_tokens` 是**未命中缓存**
 *    的输入，缓存命中单列在 `input_tokens_details.cached_tokens`）。OpenAI 官方
 *    的 `input_tokens` 含缓存命中，这里刻意不跟随：同一请求在两个端点上的
 *    数字必须能直接对比，否则「换了个 URL 用量就变了」会被当成计费缺陷。
 *
 * ## 明确**接受但不生效**的字段
 *
 * `store` / `include` / `prompt_cache_key` / `metadata` / `user` /
 * `truncation` / `service_tier` / `safety_identifier` / `parallel_tool_calls`：
 * 网关是**无状态转发**，既没有可存储的响应（`GET /v1/responses/{id}` 一律 404），
 * 也没有跨请求缓存通道，故这些字段接受并忽略。
 *
 * ⚠️ 但**语义会变**的字段绝不静默忽略 —— 那种「用户以为设置生效了」的失败在
 * 本仓库是被明令禁止的（见 `messages.ts` 的 `normalizeReasoningEffort` 同款
 * 教训）。故 `previous_response_id` / `background` / `text.format`（结构化输出）/
 * `top_p`（非 1 时）一律**明确报 400**。
 */

import { randomUUID } from 'node:crypto'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_IMAGE_LIMITS, type AttachmentBridge, type ImageLimits } from './images.js'
import {
  OpenAiGatewayError,
  convertTools,
  createGatewayMessage,
  parseModelRoute,
  partsFromContent,
  textFromContent,
  tokenValue,
} from './messages.js'
import { normalizeUpstreamFailure } from './model-errors.js'
import { failureToOpenAiError, withSuggestion, type SuggestionHook } from './stream.js'

/** 请求体形状（只声明我们用到的字段；其余原样忽略）。 */
export interface OpenAiResponsesRequest {
  model?: unknown
  input?: unknown
  instructions?: unknown
  stream?: unknown
  temperature?: unknown
  top_p?: unknown
  max_output_tokens?: unknown
  tools?: unknown
  tool_choice?: unknown
  reasoning?: unknown
  text?: unknown
  previous_response_id?: unknown
  background?: unknown
  parallel_tool_calls?: unknown
  metadata?: unknown
  truncation?: unknown
  user?: unknown
  store?: unknown
  [key: string]: unknown
}

const UNSUPPORTED = 'unsupported_parameter' as const

function unsupported(message: string): OpenAiGatewayError {
  return new OpenAiGatewayError(message, 400, UNSUPPORTED, UNSUPPORTED)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 取出 `reasoning.effort` 的**原始请求值**，交给
 * {@link import('./messages.js').normalizeReasoningEffort} 归一化。
 *
 * ⚠️ 这里只做**形状**校验，不做档位判定：档位是否被该模型支持要看
 * `resolveModelInfo()` 的结果，那是 server 层的事（与 Chat 路径同一分工）。
 * 返回 `undefined` 表示「用户没给」—— `normalizeReasoningEffort` 的三态契约
 * 依赖这个区分。
 */
export function responsesReasoningEffort(body: OpenAiResponsesRequest): unknown {
  const reasoning = body.reasoning
  if (reasoning === undefined || reasoning === null) return undefined
  if (!isObject(reasoning)) throw new OpenAiGatewayError('reasoning must be an object')
  return reasoning.effort
}

/**
 * 取出并校验 `max_output_tokens`（Responses 版的 `max_tokens`）。
 *
 * ⚠️ `null` 按「没给」处理：SDK 把「未设置」序列化成 `null` 是常见形态，
 * 为此回 400 只会让用户莫名其妙。
 */
export function responsesMaxOutputTokens(body: OpenAiResponsesRequest): number | undefined {
  const value = body.max_output_tokens
  if (value === undefined || value === null) return undefined
  return tokenValue(value, 'max_output_tokens')
}

/**
 * Responses 的内容块 → Chat 形状的内容块。
 *
 * ## 为什么要先转成 Chat 形状
 *
 * 图片入站（`partsFromContent` → 附件服务）、纯文本提取（`textFromContent`）
 * 在 Chat 路径上已被实测与单测覆盖。「两套协议各写一份」必然漂移，而漂移的
 * 症状是「图片在 Chat 端能收、在 Responses 端报错」这类极难归因的差异。
 * 故这里只做**外壳改写**，真正的转换逻辑全部复用。
 *
 * 对应关系（官方文档的字段名差异，语义相同）：
 * - `input_text` / `output_text` / `text` → `text`
 * - `input_image.image_url` → `image_url.url`
 * - `refusal` → `text`（拒答文本对 DSH 就是一段 assistant 文本，丢弃才是错的）
 */
function chatPartsFromResponses(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return content
  if (!Array.isArray(content)) {
    throw new OpenAiGatewayError('content must be a string or an array of content parts')
  }
  return content.map((raw) => {
    if (!isObject(raw)) throw new OpenAiGatewayError('content contains an invalid part')
    if (raw.type === 'input_text' || raw.type === 'output_text' || raw.type === 'text') {
      if (typeof raw.text !== 'string') {
        throw new OpenAiGatewayError(`${String(raw.type)} part requires a string text`)
      }
      return { type: 'text', text: raw.text }
    }
    if (raw.type === 'refusal') {
      return { type: 'text', text: typeof raw.refusal === 'string' ? raw.refusal : '' }
    }
    if (raw.type === 'input_image') {
      // ⚠️ `file_id` 形态无法支持：那是 OpenAI 侧的文件资源，网关拿不到它的字节。
      // 明确报错而不是当成空图片 —— 静默丢图会让用户以为模型看到了图。
      if (typeof raw.image_url !== 'string') {
        throw unsupported('input_image 只支持内联的 image_url（base64 data URL）；file_id 形态拿不到图片字节')
      }
      return { type: 'image_url', image_url: { url: raw.image_url } }
    }
    throw new OpenAiGatewayError(`content part type ${String(raw.type)} is not supported`)
  })
}

/**
 * Responses 的工具定义 → Chat 形状。
 *
 * Responses 的工具是**扁平**的（`{type:'function', name, description, parameters}`），
 * Chat 的是**嵌套**的（`{type:'function', function:{…}}`）。同时容忍嵌套形态：
 * 有些客户端会把 Chat 的 tools 原样发过来，为此报 400 毫无收益。
 *
 * 非 function 类工具（`web_search` / `file_search` / `computer_use` / `mcp` …）
 * 一律明确报错：网关没有这些执行体，静默丢弃会让模型永远等不到那个工具的结果。
 */
function toChatTools(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new OpenAiGatewayError('tools must be an array')
  return raw.map((value) => {
    if (!isObject(value)) throw new OpenAiGatewayError('tool must be an object')
    if (value.type !== 'function') {
      throw unsupported(`tool type ${String(value.type)} is not supported（网关只提供 function 工具）`)
    }
    const flat = isObject(value.function) ? value.function : value
    if (typeof flat.name !== 'string' || flat.name.length === 0) {
      throw new OpenAiGatewayError('function tool requires a non-empty name')
    }
    return {
      type: 'function',
      function: {
        name: flat.name,
        description: flat.description,
        parameters: flat.parameters,
      },
    }
  })
}

/** `function_call_output.output` 可能是字符串，也可能是内容块数组。 */
function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  if (!Array.isArray(value)) {
    throw new OpenAiGatewayError('function_call_output.output must be a string or an array of content parts')
  }
  // 走 `textFromContent`：它对图片块有明确文案（工具结果不能带图），
  // 不会出现「静默只取到文本」的失真。
  return textFromContent(chatPartsFromResponses(value))
}

function assistantItemSource(provider: string, model: string): Message['source'] {
  return { kind: 'model', provider, model }
}

/**
 * 把 Responses 的 `input` 转成 DSH 的消息数组。
 *
 * ## 连续 assistant 项**必须合并**（与 Chat 路径的形态对齐）
 *
 * Responses 把「助手说了一句话」和「助手发起工具调用」拆成**两个 item**
 * （`message` 与 `function_call`），而 Chat 把它们放在**同一条** assistant 消息里
 * （`content` + `tool_calls`）。若照 item 一一映射，**每一个用过工具的会话**都会
 * 给上游留下「连续两条 assistant 消息」的历史 —— 而 Anthropic 系适配器要求
 * user/assistant 交替，这类历史会被上游拒绝或行为异常。
 * 故这里把连续的 assistant 内容块合并进同一条消息（文本 + 工具调用）。
 */
async function toMessages(
  input: unknown,
  provider: string,
  model: string,
  bridge: AttachmentBridge | undefined,
  limits: ImageLimits,
): Promise<Message[]> {
  const messages: Message[] = []
  const pushAssistant = (blocks: ContentBlock[]): void => {
    if (blocks.length === 0) return
    const last = messages[messages.length - 1]
    if (last !== undefined && last.role === 'assistant') {
      last.content.push(...blocks)
      return
    }
    messages.push(createGatewayMessage('assistant', blocks, assistantItemSource(provider, model)))
  }

  const list = typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: input }]
    : input
  if (typeof input !== 'string' && (!Array.isArray(input) || input.length === 0)) {
    throw new OpenAiGatewayError('input must be a non-empty string or array of items')
  }

  for (const raw of list as unknown[]) {
    if (!isObject(raw)) throw new OpenAiGatewayError('input entries must be objects')
    const type = raw.type
    // `type` 缺省时按 EasyInputMessage 处理（`{role, content}`），官方允许这种简写。
    if (type === undefined || type === 'message') {
      const content = chatPartsFromResponses(raw.content)
      if (raw.role === 'user') {
        messages.push(createGatewayMessage('user', await partsFromContent(content, bridge, limits), { kind: 'user' }))
        continue
      }
      if (raw.role === 'assistant') {
        const text = textFromContent(content)
        pushAssistant(text.length > 0 ? [{ type: 'text', text }] : [])
        continue
      }
      if (raw.role === 'system' || raw.role === 'developer') {
        messages.push(createGatewayMessage('system', [{ type: 'text', text: textFromContent(content) }], {
          kind: 'plugin', plugin: 'dsh-openai-gateway',
        }))
        continue
      }
      throw new OpenAiGatewayError(`unsupported message role: ${String(raw.role)}`)
    }
    if (type === 'function_call') {
      // `call_id` 才是与 `function_call_output` 配对的那个 id；`id`（fc_…）
      // 只是 item 身份。两者都可能出现，优先 `call_id`，缺了才退回 `id`。
      const callId = nonEmptyString(raw.call_id) ?? nonEmptyString(raw.id)
      const name = nonEmptyString(raw.name)
      if (callId === undefined || name === undefined || typeof raw.arguments !== 'string') {
        throw new OpenAiGatewayError('function_call requires call_id, name and string arguments')
      }
      pushAssistant([{ type: 'tool-call', id: callId as never, name, arguments: raw.arguments }])
      continue
    }
    if (type === 'function_call_output') {
      const callId = nonEmptyString(raw.call_id)
      if (callId === undefined) throw new OpenAiGatewayError('function_call_output requires call_id')
      messages.push(createGatewayMessage('user', [{
        type: 'tool-result',
        toolCallId: callId as never,
        content: [{ type: 'text', text: outputText(raw.output) }],
      }], { kind: 'tool', callId: callId as never }))
      continue
    }
    if (type === 'reasoning') {
      // 历史里的推理项**刻意丢弃**：它承载的是上游自家加密的思考内容
      // （`encrypted_content`），网关既没有解密通道，也没有可回放的等价物。
      // 与 Chat 路径一致 —— 那里的 `reasoning_content` 同样不回传上游。
      continue
    }
    if (type === 'item_reference') {
      throw unsupported('item_reference 需要服务端保存过该 item；本网关无状态，无法解析引用')
    }
    throw unsupported(`input item type ${String(type)} is not supported`)
  }
  if (messages.length === 0) throw new OpenAiGatewayError('input contains no usable message')
  return messages
}

/** 校验那些「语义会变、故不能静默忽略」的字段。 */
function assertSupported(body: OpenAiResponsesRequest): void {
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw unsupported(
      'previous_response_id 不被支持：本网关无状态，不保存历史响应。'
      + '请把完整 input 一起发过来（会话状态由客户端自己维护）。',
    )
  }
  if (body.background === true) {
    throw unsupported('background 不被支持：本网关只做同步转发')
  }
  const text = body.text
  if (text !== undefined && text !== null) {
    if (!isObject(text)) throw new OpenAiGatewayError('text must be an object')
    const format = text.format
    if (format !== undefined && format !== null) {
      if (!isObject(format)) throw new OpenAiGatewayError('text.format must be an object')
      const kind = format.type
      if (kind !== undefined && kind !== 'text') {
        throw unsupported(
          `text.format ${JSON.stringify(String(kind))} 不被支持：DSH 的模型请求没有结构化输出`
          + '（response_format）通道。网关不假装按 schema 约束 —— 那会让客户端以为拿到的是合规 JSON。',
        )
      }
    }
  }
  // DSH 的 `GenerateOptions` 没有 topP（见 `@deepseek-ai/dsh-llm` 的 types）。
  // `top_p: 1` 是默认值、等价于不设置，故放行；其余值明确报错而不是静默丢弃。
  if (body.top_p !== undefined && body.top_p !== null && body.top_p !== 1) {
    throw unsupported('top_p 不被支持：DSH 的模型请求只暴露 temperature')
  }
}

/**
 * Responses 请求 → DSH `GenerateOptions`。
 *
 * @param reasoningEffortOverride 网关归一化后的档位（三态，见
 *   `messages.ts` 的 `normalizeReasoningEffort`）。
 * @param maxTokensOverride 已归一化的输出预算（`normalizeMaxTokens` 的结果）。
 */
export async function toResponsesGenerateOptions(
  body: OpenAiResponsesRequest,
  signal: AbortSignal,
  reasoningEffortOverride?: string | null,
  maxTokensOverride?: number,
  images: { bridge?: AttachmentBridge; limits?: ImageLimits } = {},
): Promise<GenerateOptions> {
  assertSupported(body)
  const { provider, model } = parseModelRoute(body.model)
  const limits = images.limits ?? DEFAULT_IMAGE_LIMITS

  // 工具选择：与 Chat 路径同一口径 —— DSH 只能表达 auto / none。
  const toolChoice = body.tool_choice
  if (toolChoice !== undefined && toolChoice !== 'auto' && toolChoice !== 'none') {
    throw new OpenAiGatewayError('only tool_choice auto and none are supported')
  }
  const tools = convertTools(toChatTools(body.tools))
  if (toolChoice === 'none' && tools !== undefined && tools.length > 0) {
    throw unsupported('tool_choice none with tools cannot be represented by DSH')
  }
  const temperature = body.temperature === undefined ? undefined
    : typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature
      : (() => { throw new OpenAiGatewayError('temperature must be a finite number') })()

  const messages: Message[] = []
  if (body.instructions !== undefined && body.instructions !== null) {
    if (typeof body.instructions !== 'string') {
      throw new OpenAiGatewayError('instructions must be a string')
    }
    // 与 Chat 路径的 `system` 消息**同一种构造**（同样的 plugin source），
    // 否则同一份提示词在两个端点上的来源标记不同，排查时会误导。
    messages.push(createGatewayMessage('system', [{ type: 'text', text: body.instructions }], {
      kind: 'plugin', plugin: 'dsh-openai-gateway',
    }))
  }
  messages.push(...await toMessages(body.input, provider, model, images.bridge, limits))

  // ⚠️ 判据是 `== null`（同时排除 undefined 与 null）：`null` = 明确不下发。
  const reasoningEffort = reasoningEffortOverride
  const maxTokens = maxTokensOverride ?? responsesMaxOutputTokens(body)
  return {
    provider,
    model,
    messages,
    ...tools === undefined ? {} : { tools },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...temperature === undefined ? {} : { temperature },
    ...reasoningEffort == null ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
    signal,
  }
}

// ───────────────────────── 响应侧 ─────────────────────────

type ResponsesItemKind = 'message' | 'reasoning' | 'function_call'
type ResponsesStatus = 'in_progress' | 'completed' | 'incomplete' | 'failed'

/**
 * 一个输出项（Responses 的 `output[]` 元素）在流式过程中的状态。
 *
 * ⚠️ `override` / `argumentOverride` 是 `block-end` 的**权威覆盖**（见文件头
 * 第 1 条差异）：最终的 `output_text.done` / `output_item.done` /
 * `response.completed` 都必须用它，只有 delta 事件用过程量。
 */
interface ResponsesItemState {
  readonly index: number
  readonly outputIndex: number
  readonly kind: ResponsesItemKind
  readonly id: string
  text: string
  override?: string
  name?: string
  callId?: string
  arguments: string
  argumentOverride?: string
}

interface Accumulated {
  usage?: TokenUsage
  finishReason?: string
  failure?: { code: string; message: string }
}

function hexId(): string {
  return randomUUID().replaceAll('-', '')
}

function itemId(kind: ResponsesItemKind): string {
  if (kind === 'reasoning') return `rs_${hexId()}`
  if (kind === 'function_call') return `fc_${hexId()}`
  return `msg_${hexId()}`
}

function newItem(index: number, outputIndex: number, kind: ResponsesItemKind): ResponsesItemState {
  return { index, outputIndex, kind, id: itemId(kind), text: '', arguments: '' }
}

/** 文本的权威值：有 block-end 覆盖就用它，否则用 delta 累积值。 */
function finalText(item: ResponsesItemState): string {
  return item.override ?? item.text
}

function finalArguments(item: ResponsesItemState): string {
  return item.argumentOverride ?? item.arguments
}

function kindOfBlock(type: ContentBlock['type']): ResponsesItemKind {
  if (type === 'reasoning') return 'reasoning'
  if (type === 'tool-call') return 'function_call'
  return 'message'
}

function finishReasonOf(reason: FinishReason): string {
  switch (reason.kind) {
    case 'stop': return 'stop'
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    // aborted / error 不走这里（两者都会先落到 failure 分支）。
    default: return 'error'
  }
}

/** 内容类帧（delta / block-end）写进**输出项**。 */
function applyItemChunk(item: ResponsesItemState, chunk: StreamChunk): void {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      item.text += chunk.text
      return
    case 'tool-call-delta':
      // `id` / `name` 只允许**非空**覆盖：分片里偶发空值，覆盖会把已识别的调用打坏。
      if (String(chunk.id).length > 0) item.callId = String(chunk.id)
      if (chunk.name !== undefined) item.name = chunk.name
      item.arguments += chunk.argumentsDelta
      return
    case 'block-end': {
      const block = chunk.block
      if (block.type === 'text' || block.type === 'reasoning') {
        item.override = block.text
        return
      }
      if (block.type === 'tool-call') {
        if (String(block.id).length > 0) item.callId = String(block.id)
        item.name = block.name
        item.argumentOverride = block.arguments
      }
      return
    }
    default:
      return
  }
}

/** 状态类帧（usage / finish）写进**累积状态**。 */
function applyStateChunk(state: Accumulated, chunk: StreamChunk): void {
  if (chunk.type === 'usage') {
    state.usage = chunk.usage
    return
  }
  if (chunk.type !== 'finish') return
  if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
    state.failure = {
      code: chunk.reason.failure.code,
      message: chunk.reason.failure.message || `DSH model request ${chunk.reason.kind}`,
    }
    return
  }
  state.finishReason = finishReasonOf(chunk.reason)
}

function usageJson(usage: TokenUsage): Record<string, unknown> {
  return {
    // ⚠️ 与 /v1/chat/completions 的口径一致（见文件头第 2 条差异）。
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
    total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
  }
}

function outputItemJson(item: ResponsesItemState): Record<string, unknown> {
  if (item.kind === 'reasoning') {
    const text = finalText(item)
    return {
      id: item.id,
      type: 'reasoning',
      summary: text.length > 0 ? [{ type: 'summary_text', text }] : [],
    }
  }
  if (item.kind === 'function_call') {
    return {
      id: item.id,
      type: 'function_call',
      status: 'completed',
      call_id: item.callId ?? '',
      name: item.name ?? '',
      arguments: finalArguments(item),
    }
  }
  return {
    id: item.id,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: finalText(item), annotations: [], logprobs: [] }],
  }
}

/** 只有真正有产出的项才进 `output[]`（空项会污染客户端的会话历史）。 */
function hasContent(item: ResponsesItemState): boolean {
  if (item.kind === 'function_call') return true
  return finalText(item).length > 0
}

interface ResponseShapeOptions {
  id: string
  model: string
  request: OpenAiResponsesRequest
  status: ResponsesStatus
  output: readonly Record<string, unknown>[]
  usage: Record<string, unknown> | null
  error?: Record<string, unknown> | null
}

/**
 * 组装 Responses 对象。
 *
 * ⚠️ **可空字段一个都不能少**：官方 SDK（openai-node / openai-python）用 schema
 * 解析这个对象，缺字段会直接抛「反序列化失败」，用户看到的是客户端崩了，而根因
 * 只是网关少发了一个 `null`。故这里把所有可空字段显式写成 `null`。
 */
function responseJson(options: ResponseShapeOptions): Record<string, unknown> {
  const request = options.request
  const effort = isObject(request.reasoning) ? request.reasoning.effort ?? null : null
  return {
    id: options.id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: options.status,
    background: false,
    error: options.error ?? null,
    incomplete_details: options.status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: typeof request.instructions === 'string' ? request.instructions : null,
    max_output_tokens: typeof request.max_output_tokens === 'number' ? request.max_output_tokens : null,
    model: options.model,
    output: options.output,
    parallel_tool_calls: request.parallel_tool_calls === false ? false : true,
    previous_response_id: null,
    reasoning: { effort, summary: null },
    store: false,
    temperature: typeof request.temperature === 'number' ? request.temperature : null,
    text: { format: { type: 'text' } },
    tool_choice: request.tool_choice ?? 'auto',
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: typeof request.top_p === 'number' ? request.top_p : null,
    truncation: typeof request.truncation === 'string' ? request.truncation : 'disabled',
    usage: options.usage,
    user: typeof request.user === 'string' ? request.user : null,
    metadata: isObject(request.metadata) ? request.metadata : {},
  }
}

function statusOf(state: Accumulated): 'completed' | 'incomplete' {
  return state.finishReason === 'length' ? 'incomplete' : 'completed'
}

function outputOf(items: readonly ResponsesItemState[]): Record<string, unknown>[] {
  const output = items.filter(hasContent).map(outputItemJson)
  // 空回复：保留一个空 message 项 —— 客户端不认空的 `output[]`。
  if (output.length === 0) output.push(outputItemJson(newItem(-1, 0, 'message')))
  return output
}

/** 上游失败 → 可识别的错误（404 翻译 + 纠错建议），与 Chat 路径同源。 */
async function toUpstreamError(error: unknown, suggest?: SuggestionHook): Promise<OpenAiGatewayError> {
  const converted = failureToOpenAiError(error)
  const message = String(converted.body.error.message)
  const normalized = normalizeUpstreamFailure({
    status: converted.status,
    type: String(converted.body.error.type),
    code: String(converted.body.error.code ?? 'upstream_error'),
    message,
  })
  return new OpenAiGatewayError(await withSuggestion(message, suggest), normalized.status, normalized.type, normalized.code)
}

/**
 * Responses 的 `error.code` 是**枚举**（`server_error` / `rate_limit_exceeded` / …），
 * 官方 SDK 按 Literal 校验。把 DSH 的内部码（`SERVER` / `QUOTA_EXCEEDED` /
 * `incomplete_stream` …）直接塞进去，客户端会在**解析失败事件**时抛校验错误 ——
 * 用户看到的是「客户端崩了」，而真实原因是上游错误。
 *
 * 故 `code` 只放**安全枚举值**，另外三个字段承担诊断信息：
 * - `message`：可读原因（含「你是不是想用 X」的纠错建议）；
 * - `status`：本该返回的 HTTP 状态（流已发 200，状态码改不了；Chat 路径的 SSE
 *   错误帧里也有同名字段，两处口径一致）；
 * - `dsh_code`：DSH 的内部错误码（`model_not_found` / `incomplete_stream` …）。
 *   没有它，流式失败就只剩一句人话，排障时无法与日志对上。
 */
function responsesError(
  converted: { status: number; type: string; code: string; message: string },
): Record<string, unknown> {
  const code = converted.type === 'rate_limit_exceeded' || converted.type === 'rate_limit_error'
    ? 'rate_limit_exceeded'
    : 'server_error'
  return { code, message: converted.message, status: converted.status, dsh_code: converted.code }
}

/**
 * 非流式：把整条流收成一个 Responses 对象。
 *
 * ⚠️ 逐帧判定必须与 {@link toResponsesSse} 保持一致（项的类型由**帧类型**决定、
 * `block-end` 是权威覆盖、`block-start` 负责收尾）。两者共用
 * {@link applyItemChunk} / {@link applyStateChunk}，只有「怎么把项交给调用方」
 * 不同 —— 这里是攒进数组，那里是发 SSE。
 */
export async function collectResponsesResult(
  chunks: AsyncIterable<StreamChunk>,
  responseId: string,
  model: string,
  request: OpenAiResponsesRequest,
  suggest?: SuggestionHook,
): Promise<Record<string, unknown>> {
  const state: Accumulated = {}
  const items: ResponsesItemState[] = []
  const open = new Map<number, ResponsesItemState>()
  let outputIndex = 0
  try {
    for await (const chunk of chunks) {
      if (chunk.type === 'block-start') {
        // 块切换 ⇒ 先收尾，保证 output 的顺序与真实产出顺序一致。
        for (const [index, item] of open) { items.push(item); open.delete(index) }
        continue
      }
      if (chunk.type === 'block-end') {
        let item = open.get(chunk.index)
        if (item === undefined) {
          item = newItem(chunk.index, outputIndex++, kindOfBlock(chunk.block.type))
        } else {
          open.delete(chunk.index)
        }
        applyItemChunk(item, chunk)
        items.push(item)
        continue
      }
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
        let item = open.get(chunk.index)
        if (item === undefined) {
          item = newItem(chunk.index, outputIndex++, chunk.type === 'text-delta' ? 'message' : chunk.type === 'reasoning-delta' ? 'reasoning' : 'function_call')
          open.set(chunk.index, item)
        }
        applyItemChunk(item, chunk)
        continue
      }
      applyStateChunk(state, chunk)
    }
  } catch (error) {
    throw await toUpstreamError(error, suggest)
  }
  for (const item of open.values()) items.push(item)
  if (state.failure !== undefined) {
    // 上游在流里报错：与 Chat 路径同样翻成可识别的错误（含 404 翻译与纠错建议）。
    throw await toUpstreamError(
      new OpenAiGatewayError(state.failure.message, 502, 'server_error', state.failure.code || 'upstream_error'),
      suggest,
    )
  }
  if (state.finishReason === undefined) {
    throw new OpenAiGatewayError('upstream stream ended before finish', 502, 'server_error', 'incomplete_stream')
  }
  return responseJson({
    id: responseId,
    model,
    request,
    status: statusOf(state),
    output: outputOf(items),
    usage: state.usage === undefined ? null : usageJson(state.usage),
  })
}

/**
 * 流式：按 Responses 的事件序列产出 SSE 文本。
 *
 * 事件顺序（与官方一致，客户端按 `output_index` 归位）：
 * `response.created` → `response.in_progress` → 每个输出项的
 * `output_item.added` + 各自的 part/delta/done → `response.completed`
 * （截断时是 `response.incomplete`，失败时是 `response.failed`）。
 *
 * ⚠️ **不发 `data: [DONE]`**：那是 Chat Completions 的收尾约定；Responses 的流
 * 以 `response.completed` / `response.failed` 结束（官方 SDK 依此判定结束）。
 */
export async function* toResponsesSse(
  chunks: AsyncIterable<StreamChunk>,
  responseId: string,
  model: string,
  request: OpenAiResponsesRequest,
  suggest?: SuggestionHook,
): AsyncIterable<string> {
  const state: Accumulated = {}
  const items: ResponsesItemState[] = []
  const open = new Map<number, ResponsesItemState>()
  let outputIndex = 0
  let sequence = 0

  const emit = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`
  const snapshot = (status: ResponsesStatus, usage: Record<string, unknown> | null, error?: Record<string, unknown> | null): Record<string, unknown> =>
    responseJson({ id: responseId, model, request, status, output: status === 'in_progress' ? [] : outputOf(items), usage, error })
  const emitStatus = (status: ResponsesStatus, usage: Record<string, unknown> | null, error?: Record<string, unknown> | null): string =>
    emit(`response.${status}`, { response: snapshot(status, usage, error) })

  /** 打开一个输出项，并补齐 `output_item.added` 与相应 part 的 `added`。 */
  const openItem = (index: number, kind: ResponsesItemKind, seed?: { callId?: string; name?: string }): string[] => {
    const item = newItem(index, outputIndex++, kind)
    if (seed?.callId !== undefined) item.callId = seed.callId
    if (seed?.name !== undefined) item.name = seed.name
    open.set(index, item)
    if (kind === 'message') {
      return [
        emit('response.output_item.added', {
          output_index: item.outputIndex,
          item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        }),
        emit('response.content_part.added', {
          item_id: item.id,
          output_index: item.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }),
      ]
    }
    if (kind === 'reasoning') {
      return [
        emit('response.output_item.added', {
          output_index: item.outputIndex,
          item: { id: item.id, type: 'reasoning', summary: [] },
        }),
        emit('response.reasoning_summary_part.added', {
          item_id: item.id,
          output_index: item.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        }),
      ]
    }
    return [emit('response.output_item.added', {
      output_index: item.outputIndex,
      item: {
        id: item.id,
        type: 'function_call',
        status: 'in_progress',
        call_id: item.callId ?? '',
        name: item.name ?? '',
        arguments: '',
      },
    })]
  }

  /** 收尾一个输出项：发完它的 `done` 事件。 */
  const closeItem = (item: ResponsesItemState): string[] => {
    const events: string[] = []
    if (item.kind === 'message') {
      const text = finalText(item)
      events.push(
        emit('response.output_text.done', {
          item_id: item.id, output_index: item.outputIndex, content_index: 0, text, logprobs: [],
        }),
        emit('response.content_part.done', {
          item_id: item.id,
          output_index: item.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text, annotations: [] },
        }),
      )
    } else if (item.kind === 'reasoning') {
      const text = finalText(item)
      events.push(
        emit('response.reasoning_summary_text.done', {
          item_id: item.id, output_index: item.outputIndex, summary_index: 0, text,
        }),
        emit('response.reasoning_summary_part.done', {
          item_id: item.id,
          output_index: item.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text },
        }),
      )
    } else {
      events.push(emit('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: item.outputIndex,
        name: item.name ?? '',
        arguments: finalArguments(item),
      }))
    }
    // `added` 与 `done` 必须成对：客户端按 added 建行、按 done 定稿，
    // 只发 added 会留下一个永远「进行中」的空项。空内容的项由 `outputOf`
    // 挡在 `response.completed` 之外，不必在这里另做一套判据。
    events.push(emit('response.output_item.done', { output_index: item.outputIndex, item: outputItemJson(item) }))
    items.push(item)
    return events
  }

  const closeAll = (): string[] => {
    const events: string[] = []
    for (const [index, item] of [...open.entries()].sort(([a], [b]) => a - b)) {
      events.push(...closeItem(item))
      open.delete(index)
    }
    return events
  }

  yield emit('response.created', { response: snapshot('in_progress', null) })
  yield emit('response.in_progress', { response: snapshot('in_progress', null) })

  try {
    for await (const chunk of chunks) {
      if (chunk.type === 'block-start') {
        // 新块开始 ⇒ 先收尾已开着的项：协议要求项按 `output_index` 顺序闭合，
        // 而新块的 delta 必然排在旧块之后（各适配器都是顺序产出块）。
        for (const event of closeAll()) yield event
        continue
      }
      if (chunk.type === 'block-end') {
        const existing = open.get(chunk.index)
        if (existing !== undefined) {
          applyItemChunk(existing, chunk)
          for (const event of closeItem(existing)) yield event
          open.delete(chunk.index)
          continue
        }
        // 只发了 block-end、没有 delta 的块：直接按块内容补齐一个完整项，
        // 否则这段内容会**整个消失**（Chat 路径就是这么丢的）。
        const block = chunk.block
        const seed = block.type === 'tool-call' ? { callId: String(block.id), name: block.name } : undefined
        for (const event of openItem(chunk.index, kindOfBlock(block.type), seed)) yield event
        const created = open.get(chunk.index)!
        applyItemChunk(created, chunk)
        for (const event of closeItem(created)) yield event
        open.delete(chunk.index)
        continue
      }
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        if (!open.has(chunk.index)) {
          for (const event of openItem(chunk.index, chunk.type === 'text-delta' ? 'message' : 'reasoning')) yield event
        }
        const item = open.get(chunk.index)!
        applyItemChunk(item, chunk)
        yield chunk.type === 'text-delta'
          ? emit('response.output_text.delta', {
            item_id: item.id, output_index: item.outputIndex, content_index: 0, delta: chunk.text, logprobs: [],
          })
          : emit('response.reasoning_summary_text.delta', {
            item_id: item.id, output_index: item.outputIndex, summary_index: 0, delta: chunk.text,
          })
        continue
      }
      if (chunk.type === 'tool-call-delta') {
        if (!open.has(chunk.index)) {
          // `call_id` / `name` 只在这一帧里出现，故 function_call 项**延迟到这时**
          // 才打开 —— `output_item.added` 必须带上它们，否则客户端配不上 call_id。
          for (const event of openItem(chunk.index, 'function_call', {
            callId: String(chunk.id), name: chunk.name,
          })) yield event
        }
        const item = open.get(chunk.index)!
        applyItemChunk(item, chunk)
        yield emit('response.function_call_arguments.delta', {
          item_id: item.id, output_index: item.outputIndex, delta: chunk.argumentsDelta,
        })
        continue
      }
      applyStateChunk(state, chunk)
    }
  } catch (error) {
    const converted = await toUpstreamError(error, suggest)
    for (const event of closeAll()) yield event
    yield emitStatus('failed', null, responsesError(converted))
    return
  }

  if (state.failure !== undefined) {
    const converted = await toUpstreamError(
      new OpenAiGatewayError(state.failure.message, 502, 'server_error', state.failure.code || 'upstream_error'),
      suggest,
    )
    for (const event of closeAll()) yield event
    yield emitStatus('failed', null, responsesError(converted))
    return
  }
  if (state.finishReason === undefined) {
    // 上游没给 finish 就断了：必须让客户端看见失败，而不是「干净地停在半句话上」。
    for (const event of closeAll()) yield event
    yield emitStatus('failed', null, responsesError({
      status: 502, type: 'server_error', code: 'incomplete_stream', message: 'upstream stream ended before finish',
    }))
    return
  }
  for (const event of closeAll()) yield event
  yield emitStatus(statusOf(state), state.usage === undefined ? null : usageJson(state.usage))
}
