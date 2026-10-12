/**
 * DSML 工具调用协议 —— 共享定义与提示构造。
 *
 * ## DSML 是什么
 *
 * 华为 CodeArts / MaaS 系模型（deepseek-v4 等）支持一种**流式**工具调用
 * 语法：工具调用以文本形式写入 `delta.content`（而非标准 `tool_calls`
 * 字段），形如：
 *
 * ```
 * <｜DSML｜tool_calls><｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>
 * ```
 *
 * 竖线是 **U+FF5C 全角竖线**。开闭标签必须是 **`tool_calls`** —— 这是
 * `parseDsmlToolCalls` 唯一认的写法（见 llm-adapter.ts 的
 * `DSML_TOOL_CALLS_OPEN` / `DSML_TOOL_CALLS_CLOSE` 常量）。
 *
 * ## 为什么需要（2026-10-13 实测事故）
 *
 * OfficeAce 通道下的 `deepseek-v4.1-flash` 输出的是 `<｜DSML｜ calls>`
 * （**少了 `tool_` 前缀**）⇒ 解析器完全不认 ⇒ 整段当正文显示、工具
 * **从未执行**。根因是适配器**既没有**发送 `tools` 字段、**也没有**
 * 注入本文件的 DSML system 提示，模型在零协议指引下凭训练印象臆造了
 * `calls` 这种不存在的语法。
 *
 * 即：**不是模型把标记写坏了，是没人告诉它正确的写法**。
 * 归一化（sse.ts `fixDsmlMarkers`）只能修「双竖线」这类笔误，修不了
 * 「协议本身没下发」—— 必须先有正确的 schema 与语法说明。
 *
 * ## 抽到共享层的原因
 *
 * 最初 `buildDsmlSystemPrompt` 只在 `llm-adapter.ts`（codearts）里，
 * OfficeAce 复用不到 ⇒ 于是漏注入。协议定义**只有一份**才不会再漏。
 */

/** DSML 工具调用块的开标签（**必须**是 `tool_calls`，不是 `calls`）。 */
export const DSML_TOOL_CALLS_OPEN = '<｜DSML｜tool_calls>'
/** DSML 工具调用块的闭标签。 */
export const DSML_TOOL_CALLS_CLOSE = '</｜DSML｜tool_calls>'
/** 单个 invoke 块的开标签前缀（后面跟 ` name="..."`）。 */
export const DSML_INVOKE_OPEN_PREFIX = '<｜DSML｜invoke'
/** 单个 invoke 块的闭标签。 */
export const DSML_INVOKE_CLOSE = '</｜DSML｜invoke>'

/** OpenAI function 形态的工具定义（构造提示用）。 */
export interface DsmlToolSpec {
  type: string
  function: { name: string; description?: string; parameters?: unknown }
}

/**
 * 判断模型是否应使用 DSML 原生工具调用语法输出。
 *
 * ## 为什么 deepseek-v4 必须走 DSML
 *
 * 标准 `tool_calls` 模式要求参数**一次性打包**生成，SSE 流在生成参数期间
 * 长时间无数据 —— APIG 网关 ~60s 空闲超时必然掐断（`terminated`），且后端
 * 不对任何请求头发心跳保活。实测（2026-08-22 e2e）：标准模式 100 行也要
 * 17.7s 静默后一次性到达、300 行即 60s 断连；而 DSML 模式使调用经
 * `delta.content` 流式输出（全程有数据流），1000 行 write content 全程
 * 最大静默仅 204ms、146s 完整结束。
 *
 * 非 deepseek-v4 模型无此网关问题，继续保持标准 `tool_calls`。
 */
export function isDeepseekV4Model(model: string): boolean {
  return /^deepseek-v4-(flash|pro)$/.test(model)
}

/**
 * 判断模型是否应使用 DSML 工具调用模式。
 *
 * ⚠️ OfficeAce 通道的模型 id 带 `-flash` 变体（如 `deepseek-v4.1-flash`），
 * 需一并纳入 —— 该通道同样经网关，断连风险一致（2026-10-13）。
 */
export function needsDsmlToolMode(model: string, _toolNames: readonly string[]): boolean {
  return isDeepseekV4Model(model) || /^deepseek-v4\.\d+-(flash|pro)$/.test(model)
}

/**
 * 构造让模型以原生 DSML 格式调用工具的 system 提示。
 *
 * 用法：适配器**不**发送 `tools` 字段（否则模型走标准 tool_calls 一次性
 * 打包路径），而是把 OpenAI function schema 以文本注入 system 消息，并明确
 * 要求模型使用 {@link DSML_TOOL_CALLS_OPEN} 语法。
 *
 * ⚠️ **注入位置有讲究**（实测 2026-08-22）：应置于 system 之后、user 之前
 *    （与 CodeArts Agent IDE 实际请求体一致）。push 到 messages 末尾时，
 *    deepseek-v4 倾向把思考写入正文而非 `reasoning_content`；unshift 到
 *    user 之前后恢复走 reasoning 通道，思考不再泄漏到正文。
 */
export function buildDsmlSystemPrompt(tools: DsmlToolSpec[]): string {
  const toolJson = JSON.stringify(tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  })), null, 2)
  return [
    '以下是你可用的工具及其 JSON Schema。当需要调用工具完成任务时，',
    '必须使用原生 DSML 工具调用语法输出，格式如下：',
    `${DSML_TOOL_CALLS_OPEN}<｜DSML｜invoke name="工具名"><｜DSML｜parameter name="参数名" string="true">参数值</｜DSML｜parameter></｜DSML｜invoke>${DSML_TOOL_CALLS_CLOSE}`,
    '',
    '规则：',
    '- 工具名必须是下面列表中的 name。',
    '- 每个参数用一个 <｜DSML｜parameter> 标签包裹，参数值放在标签之间。',
    '- 字符串参数加 string="true" 属性；对象/数组/数字/布尔参数不要加该属性。',
    '- 一次可以输出多个 <｜DSML｜invoke> 调用（工具可以并行）。',
    '- 文件内容请一次性完整写入单个 write 调用的 content 参数，不要拆分或省略。',
    '',
    '工具列表（JSON Schema）：',
    toolJson,
  ].join('\n')
}
