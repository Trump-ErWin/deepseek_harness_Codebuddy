/**
 * AutoClaw（智谱清言桌面端）产品配置 —— 唯一真相源。
 *
 * ## 数据与协议来源
 *
 * - API 基址：`https://autoglm-acceleration-api.zhipuai.cn`
 * - 认证静态参数：`appId = '100003'`, `appKey = '38d2391985e2369a5fb8227d8e6cd5e5'`
 * - 核心模型：`zai_glm-5.3-flash`（实测免费畅通可用）、`zaicoding_glm-5.3`、`zai_auto`
 * - 协议：OpenAI Chat Completions 兼容，SSE text/event-stream 响应
 * - 406 绕过硬性约束：首条 message 必须为 system 且包含前缀
 *   `You are AutoClaw. Answer the user directly and concisely`
 */

export interface AutoclawFallbackModel {
  /** 模型 ID（传给上游的 model 标识，例如 zai_glm-5.3-flash）。 */
  readonly id: string
  /** UI 显示名称。 */
  readonly name: string
  /** 真实上下文窗口大小（Token 数）。通过智谱官方模型配置端点实测探测为 1M (1,048,576)。 */
  readonly contextWindow: number
  /** 最大输出 Token 数。 */
  readonly maxOutputTokens?: number
  /** 是否支持图片输入。 */
  readonly supportsImage?: boolean
  /** 是否归类为免费额度模型。 */
  readonly isFree?: boolean
}

export const AUTOCLAW_FALLBACK_MODELS: readonly AutoclawFallbackModel[] = [
  {
    id: 'zai_glm-5.3-flash',
    name: 'GLM-5.3 Flash (AutoClaw)',
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'zaicoding_glm-5.3',
    name: 'GLM-5.3 Coding (AutoClaw)',
    contextWindow: 1048576,
    maxOutputTokens: 307200,
    supportsImage: false,
    isFree: false,
  },
  {
    id: 'zai_auto',
    name: 'AutoClaw Auto',
    contextWindow: 1048576,
    maxOutputTokens: 393216,
    supportsImage: false,
    isFree: false,
  },
  {
    id: 'zai_auto-fast',
    name: 'AutoClaw Auto Fast',
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    supportsImage: true,
    isFree: false,
  },
]

export const AUTOCLAW_API_BASE = 'https://autoglm-acceleration-api.zhipuai.cn'
export const AUTOCLAW_APP_ID = '100003'
export const AUTOCLAW_APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5'
export const AUTOCLAW_SOURCE_ID = 'autoclaw'
export const AUTOCLAW_PRODUCT_NAME = 'autoclaw'

export const AUTOCLAW_DEFAULT_CREDENTIAL_REF = 'AUTOCLAW_ACCOUNT_DEFAULT'

export interface AutoclawProduct {
  readonly id: 'autoclaw'
  readonly displayName: string
  readonly apiBase: string
  readonly appId: string
  readonly appKey: string
  readonly product: string
  readonly defaultCredentialRef: string
  readonly fallbackModels: readonly AutoclawFallbackModel[]
}

export const AUTOCLAW: AutoclawProduct = {
  id: 'autoclaw',
  displayName: 'AutoClaw (智谱)',
  apiBase: AUTOCLAW_API_BASE,
  appId: AUTOCLAW_APP_ID,
  appKey: AUTOCLAW_APP_KEY,
  product: AUTOCLAW_PRODUCT_NAME,
  defaultCredentialRef: AUTOCLAW_DEFAULT_CREDENTIAL_REF,
  fallbackModels: AUTOCLAW_FALLBACK_MODELS,
}
