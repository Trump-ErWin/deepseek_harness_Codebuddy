/**
 * 渠道原生搜索的**共享契约**。
 *
 * ## 为什么单独成文件（2026-10-14）
 *
 * 这些类型/常量被**两层**同时使用：
 *
 * | 层 | 文件 | 用它做什么 |
 * |---|---|---|
 * | **工具层** | `web-native.ts` | 拦截 `tools/execute`、合并多 query、校验官方入参 |
 * | **渠道层** | `buddy-adapter.ts` / `qoder-adapter.ts` | 调上游取数、投影字段 |
 *
 * ⚠️ 若放在 `web-native.ts` 里，渠道层就要 `import` 工具层 —— 依赖方向反了
 * （渠道是更底层的实现，不该知道「谁在拦截工具执行」）。放在这里后两边
 * **对等依赖**，各自可独立演进。
 *
 * ## 什么该放这里
 *
 * **只放两层都要用的东西**：错误类型、错误码、投影后的结果形状。
 * 工具层专有的（多 query 合并、官方入参校验、waterfall 拦截）留在
 * `web-native.ts`；渠道专有的（端点、鉴权、原始响应解析）留在各适配器。
 *
 * @module
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * 原生搜索链路的失败。
 *
 * ⚠️ **刻意不复用官方的 `WEB_*` 码**：那套码描述的是 `ctx.web` 的
 * **provider 选择**语义（`WEB_PROVIDER_*` / `WEB_DUPLICATE_PROVIDER` …），
 * 而本链路**绕过了 `ctx.web`**，直接调上游。借用会让后续排查误判归属。
 *
 * 形态对齐官方：官方工具层**不做任何包装**（零 try/catch），异常一路抛到
 * `dispatchToolBody` 的 catch，由 `toolErrorResult()` 统一转成
 * `{ isError: true, content: [{text: 'Error: …'}], error: { message, info } }`。
 * 故这里也**只抛不包**，让宿主产出与官方逐字同形的错误结果。
 */
export class WebNativeError extends HarnessError {}

/**
 * 原生搜索链路的错误码（**两层共用同一套**）。
 *
 * ⚠️ 取数虽在各适配器里，但「同一种失败在任何渠道报同一个码」这条不能破 ——
 * 否则排查时会把「无账号」误判成「上游故障」。
 */
export const NativeSearchCodes = {
  /** 无可用账号。 */
  noAccount: 'WEB_NATIVE_NO_ACCOUNT',
  /** 上游非 2xx。 */
  upstream: 'WEB_NATIVE_UPSTREAM',
  /** 响应无法解析（上游返回了非预期形状）。 */
  badResponse: 'WEB_NATIVE_BAD_RESPONSE',
  /**
   * 入参不合法。
   *
   * ⚠️ 与 `badResponse` **必须分开**（对抗性审查 m1）：后者描述的是
   * **上游响应**解析失败，而这里描述的是**模型给的入参**不合法。官方对应路径是
   * `defineTool` 的 `validate()` → `ToolArgsError`，其 code 是 **`INVALID_ARGS`**。
   * 复用「响应」码会让排查误判归属（本是模型传错参数，却去查上游）。
   */
  invalidArgs: 'WEB_NATIVE_INVALID_ARGS',
  /**
   * 上游请求超时。
   *
   * ⚠️ 与 `upstream` 分开（对抗性审查 m2）：超时是一条独立的失败归因。
   * 且要知悉：各适配器的 20s 预算**小于**官方 `web_search` 的 `timeoutMs`（30s），
   * 故本超时**总是先于**宿主 `tool-call-timeout-policy` 的 `TOOL_TIMEOUT` 触发
   * —— 模型看到的是本链路的文案，而不是「tool call timed out」。
   * 这是刻意的：原生链路的预算由各适配器自己兜，不依赖外层包装器。
   */
  timeout: 'WEB_NATIVE_TIMEOUT',
  /** 调用方取消（正常终止，不是失败）。 */
  aborted: 'WEB_NATIVE_ABORTED',
} as const

/**
 * 一条已投影成官方 `sources[]` 形态的结果。
 *
 * ⚠️ 形状**必须**贴合官方 output schema（`url` 必填、`additionalProperties: false`）：
 * 各渠道的原始字段名不同（腾讯 `results[].url`、Qoder `pageItems[].link`），
 * **投影在各适配器里做掉**，工具层的合并算法才能与渠道无关地逐字节共用。
 */
export interface NativeSource {
  url: string
  title?: string
  snippet?: string
}

/**
 * 渠道原生搜索的适配器面。
 *
 * ⚠️ **刻意用结构化接口**（而不是引入 `BuddyAdapter` / `QoderAdapter` 类型）：
 * 工具层不该知道任何渠道的具体类型；两个方法都由各适配器自己实现，
 * 单测也能注入替身。
 */
export interface NativeSearchAdapter {
  /**
   * 用聊天链路**同一套**编排解析凭据。
   *
   * ⚠️ 返回 `unknown` 而不是具体凭据类型：腾讯是 `BuddyCredential`、Qoder 是
   * `QoderCredential`，形状完全不同。**由各适配器自己收窄**（见 `searchOnce`），
   * 工具层只负责「透传」。
   *
   * @param modelId - 当前会话路由的模型 id。
   */
  resolveCredentialFor(modelId: string | undefined): Promise<unknown>

  /**
   * 执行**一次单 query 搜索**，返回已投影的 `sources[]`。
   *
   * ⚠️ 实现里**必须自己校验凭据可用性**（缺账号 / 令牌为空）并在失败时抛
   * `WebNativeError`（用 `NativeSearchCodes.noAccount`）—— 因为各渠道的凭据形状
   * 不同，只有适配器自己知道「什么样的凭据算可用」。
   *
   * ⚠️ **不要在这里做多 query 合并**：工具层统一按官方 `mergeSearchResults`
   * 的规则（rank 轮转 + url 去重 + cap）做，适配器只管单次取数。
   *
   * @param query - 单个查询串（已由工具层 trim + 去重）。
   * @param credential - `resolveCredentialFor` 的返回值（适配器自己收窄）。
   * @param signal - 取消信号（工具层会把多 query 的 batch signal 传进来）。
   */
  searchOnce(query: string, credential: unknown, signal: AbortSignal): Promise<NativeSource[]>
}
