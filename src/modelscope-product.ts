/**
 * ModelScope（魔搭，阿里达摩院）产品配置与错误分类。
 *
 * ## 这个 provider 从哪来（与上游其余 provider 的关系）
 *
 * 本仓库是 gitee `iJetLi/deepseek-harness-codearts` 的 fork。上游 0.2.0-rc.3
 * **没有** modelscope / chatanywhere 两个 provider —— 它们是**本地 fork 独有的
 * 反代上游**（旧实现见 `dsh-codearts-auth@0.1.0` 的 `src/proxy/remote-upstream.ts`，
 * 由一个端口 8787 的 OpenAI 兼容反代按 priority 轮换）。2026-10-09 切到上游后
 * 这两个能力整体消失，本文件把 modelscope 一路按上游的**标准 provider 模式**
 * 补回来（而不是把旧 fork 的整套反代搬回来）。
 *
 * ## 数据来源（逐条可追溯）
 *
 * | 事实 | 取值 | 出处 |
 * |---|---|---|
 * | base URL | `https://api-inference.modelscope.cn/v1` | 旧 fork `src/proxy/upstream-config.ts:51` |
 * | chat 路径 | `/chat/completions` | 旧 fork `src/proxy/remote-upstream.ts:429` |
 * | models 路径 | `/models` | 旧 fork `src/proxy/remote-upstream.ts:268` |
 * | 鉴权头 | `Authorization: Bearer <apiKey>` | 旧 fork `src/proxy/remote-upstream.ts:238` |
 * | 请求内容类型 | `Content-Type: application/json` | 同上 L236 |
 * | 流式 | `stream: true` 恒开，SSE | 旧 fork `src/proxy/remote-upstream.ts:376` |
 * | 模型名 | 带命名空间前缀，如 `deepseek-ai/DeepSeek-V4.1-Flash` | 旧 fork `src/domain/models/catalog.ts:277` |
 * | 关思考参数 | `reasoning_effort: "none"` / `enable_thinking: false` / `thinking: {type:"disabled"}` | 旧 fork `src/proxy/remote-upstream.ts:77` |
 * | 视觉能力 | `deepseek-v4.1-flash` 实测可收图 | 旧 fork `src/proxy/remote-upstream.ts:87-91` |
 * | 额度 | 平台**无余额 API**，余额只在登录后的网页上 | 旧 fork `src/overview.ts:70-76` |
 *
 * ## ⚠️ 一个已实测的 400（本 provider 最容易踩的坑）
 *
 * 旧 fork 曾把 DSH 的扁平工具 schema `{name, description, parameters}` **原样**
 * 转发给 modelscope，结果**每次请求都被 400 拒绝**：
 *
 * ```
 * upstream: modelscope  status: 400
 * {"error":{"code":"invalid_parameter_error",
 *           "message":"'type' is a required property - 'tools.0'"}}
 * ```
 *
 * 后果极隐蔽：反代把它当「上游不可用」静默跳过，魔搭积分**一次都没消耗**，
 * 用户完全看不出来（见旧 fork `src/proxy/remote-upstream.ts:386-395` 与
 * `src/proxy/openai-map.ts:242`）。
 * ⇒ 本实现必须走 `{type:'function', function:{…}}` 包装（见
 * `src/modelscope-messages.ts`），与仓库其余 OpenAI 兼容 provider 同口径。
 *
 * @module src/modelscope-product.ts
 */

import { retryAfterMsFromRecord } from './retry-after.js'

/** ModelScope 的产品配置（字段全部围绕它的 OpenAI 兼容协议）。 */
export interface ModelscopeProduct {
  readonly id: 'modelscope'
  /**
   * 展示名。
   *
   * ⚠️ 必须与客户端 `plugin-src/client/jet-hub.js` 的 `PROVIDERS` 里
   * `modelscope` 那条的 `label` **逐字一致** —— 跨文件一致性由
   * `tests/unit/modelscope-client-panel.spec.ts` 锁死（与 raccoon / opencode /
   * gemini 同款约定）。
   */
  readonly displayName: string
  /** OpenAI 兼容 base URL，**含 `/v1`**，且**不带**尾斜杠。 */
  readonly baseUrl: string
  /** 对话端点（拼在 baseUrl 之后）。 */
  readonly chatPath: string
  /** 模型目录端点（拼在 baseUrl 之后）。 */
  readonly modelsPath: string
  /** 等首个 token 的空闲超时（毫秒）。 */
  readonly chatHeaderTimeoutMs: number
  /** 两次 chunk 之间的空闲超时（毫秒）。 */
  readonly chunkTimeoutMs: number
  /** 模型目录请求超时（毫秒）。 */
  readonly catalogTimeoutMs: number
  /**
   * 单凭据回退 ref。
   *
   * ⚠️ **不再是旧 fork 的 `PROXY_UPSTREAM_MODELSCOPE`**。那个前缀属于旧 fork 的
   * 「反代上游」命名空间（`credentialRefForUpstream()` 的机械推导），在上游
   * 0.2.0-rc.3 里**整套反代都不存在**（`git grep PROXY_UPSTREAM upstream/master`
   * 零命中），保留它只会凭空造出一个『同时支持两种模式』的假象。
   * 取 `MODELSCOPE_ACCESS_TOKEN` 的理由见 `tests/unit/modelscope-credential-ref.spec.ts`。
   */
  readonly defaultCredentialRef: string
}

export const MODELSCOPE: ModelscopeProduct = {
  id: 'modelscope',
  // ⚠️ 与客户端 PROVIDERS 的 label 逐字一致；长度也刻意控制在不撑破 rail 的
  // 范围内（该 label 是本表新增里较长的，但仍短于既有最长的
  // 'WorkBuddy (国际版)' 与 'Gemini Code Assist'）。
  displayName: 'ModelScope (魔搭)',
  baseUrl: 'https://api-inference.modelscope.cn/v1',
  chatPath: '/chat/completions',
  modelsPath: '/models',
  // 与本仓库其余 provider 的流式超时常量同档（保守值）。
  chatHeaderTimeoutMs: 60_000,
  chunkTimeoutMs: 120_000,
  catalogTimeoutMs: 15_000,
  defaultCredentialRef: 'MODELSCOPE_ACCESS_TOKEN',
}

/** 兜底模型目录条目。 */
export interface ModelscopeFallbackModel {
  /** 上游真实模型 id（**带命名空间前缀**，如 `deepseek-ai/…`）。 */
  id: string
  /** 展示名（缺省时用 id）。 */
  name: string
  /**
   * 上下文窗口（DSH 以它 × 0.8 作压缩阈值）。
   *
   * ⚠️ `0` 是「**不知道**」哨兵，**不是**合法窗口 —— `resolveModel` 判
   * `> 0` 才下发 `context`，因为 DSH 的自动压缩会拿它算阈值，0 会抛
   * `TargetPressureConfigError`（与 opencode 的同款缺陷同因）。
   */
  contextWindow: number
  /** 是否支持图片输入（**声明支持就必须真支持**，本仓库硬约定）。 */
  supportsImage: boolean
  /** 支持的思考档位（上游 wire 值）；**为空时不声明 `reasoning`**。 */
  efforts?: readonly string[]
}

/**
 * 兜底模型表。
 *
 * ## ⚠️ 这张表**只放已在旧 fork 上实测跑通过的模型**（2026-10-08 前）
 *
 * 出处：旧 fork `src/domain/models/catalog.ts:277,287` 的
 * `DEFAULT_MODEL_ALIASES`，注释写明「已实测：GET /v1/models 返回该 ID，
 * 且 POST 能正常对话」。
 *
 * 远端目录不可用时用它 —— 否则「拉不到目录」会让整个 provider 凭空消失
 * （用户看到的是「配好的账号突然没有模型」，比看一份可能略旧的表糟得多）。
 * 远端可用时**完全采信远端**（不做 Buddy 那样的「以兜底表为准」裁剪），
 * 因为魔搭的模型池由平台侧随时增删，本地表必然滞后。
 */
export const MODELSCOPE_FALLBACK_MODELS: readonly ModelscopeFallbackModel[] = [
  {
    id: 'deepseek-ai/DeepSeek-V4.1-Flash',
    name: 'DeepSeek-V4.1-Flash (魔搭)',
    contextWindow: 128_000,
    // ⚠️ 视觉能力有实测出处（旧 fork remote-upstream.ts:87-91：
    // 「modelscope / chatanywhere / deepseek 官方的 deepseek-v4.1-flash
    //   都有视觉能力（1×1 纯色 PNG 红/蓝/绿全答对）」）。
    supportsImage: true,
    // ⚠️ 只有「关闭思考」有实测出处（remote-upstream.ts:77）；
    // 其余档位的 wire 值**未实测** ⇒ 不声明（宁可没有档位选择器，
    // 也不要给一个发出去会被 400 或静默忽略的档位）。
    efforts: ['none'],
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Pro',
    name: 'DeepSeek-V4-Pro (魔搭)',
    contextWindow: 128_000,
    supportsImage: false,
  },
]

/** 该模型是否为本地兜底表里登记过的（远端目录爆炸时的收敛依据）。 */
export function isKnownModelscopeModel(id: string): boolean {
  return MODELSCOPE_FALLBACK_MODELS.some((m) => m.id === id)
}

export type ModelscopeErrorKind =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'server'
  | 'transport'
  | 'invalid_request'

export interface ModelscopeErrorInfo {
  kind: ModelscopeErrorKind
  /** 服务端要求的等待时长（毫秒）；仅在限流类错误上产出。 */
  retryAfterMs?: number
  /** 面向用户的可读描述（**禁止**裸 JSON）。 */
  detail: string
}

/** 从错误体里抽出人可读片段（禁止把整坨 JSON 抛给用户）。 */
function readableDetail(body: string): string {
  const text = body.trim()
  if (text === '') return '（上游未返回错误详情）'
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown; msg?: unknown }
    const nested = typeof data.error === 'object' && data.error !== null
      ? (data.error as { message?: unknown }).message
      : data.error
    const parts = [data.message, nested, data.msg]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON：直接截断原文
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

/**
 * 把一次失败的 HTTP 响应归类为语义化错误。
 *
 * ## ⚠️ 顺序即优先级（三条都来自本项目真实缺陷）
 *
 * 1. **限流/额度必须排在 auth 之前**：魔搭与同源的 chatanywhere 在额度耗尽时
 *    可能回 401/403 而不是 429（旧 fork `src/proxy/upstream.ts` 的
 *    `NON_RETRYABLE_CODES` 与 key-pool 的 `isQuotaLikeError` 就是为这个形态写的）。
 *    若先判状态码，用户看到的会是「API key 失效」——而他的唯一有效动作
 *    （等窗口恢复 / 换一个 key）被完全掩盖。
 * 2. **400 单独归 `invalid_request`**：魔搭对请求体形状极严格（见模块头的
 *    工具包装事故），把它归成 server/可重试会让 harness 白重试 5 次、
 *    每次都拿到同一个 400。
 * 3. `retry-after` 由**响应头**给出，解析实现收敛在 `src/retry-after.ts`
 *    （0 是合法值，判空必须用 `=== undefined`）。
 *
 * @param status  HTTP 状态码；传输层失败传 0。
 * @param body    响应体原文（调用方**必须先读一次体**再调本函数）。
 * @param headers 响应头。
 */
export function classifyModelscopeError(
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>,
): ModelscopeErrorInfo {
  const retryAfterMs = retryAfterMsFromRecord(headers)
  const detail = readableDetail(body)
  const lower = body.toLowerCase()

  if (
    status === 429
    || lower.includes('too many requests')
    || lower.includes('rate limit')
    || lower.includes('throttl')
  ) {
    return { kind: 'rate_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail }
  }
  if (
    status === 402
    || lower.includes('insufficient')
    || lower.includes('quota')
    || lower.includes('exceed')
    || lower.includes('balance')
    || lower.includes('魔粒')
  ) {
    return { kind: 'quota', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail }
  }
  if (
    status === 0
    || lower.includes('fetch failed')
    || lower.includes('terminated')
    || lower.includes('econnreset')
    || lower.includes('socket hang up')
    || lower.includes('getaddrinfo')
    || lower.includes('econnrefused')
  ) {
    return { kind: 'transport', detail }
  }
  if (status === 400 || status === 422) return { kind: 'invalid_request', detail }
  if (status === 401 || status === 403) return { kind: 'auth', detail }
  if (status >= 500) return { kind: 'server', detail }
  return { kind: 'server', detail }
}
