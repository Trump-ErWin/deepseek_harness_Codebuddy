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
  // ⚠️ **大小写不敏感**（2026-10-13 二次事故）：OfficeAce 的模型在 UI 与
  //    部分调用链里以**显示名**形态流转（`DeepSeek-V4.1-Flash` /
  //    `DeepSeek-V4-Flash`，见 OFFICEACE_MODELS 的 `name` 字段）。此前正则
  //    全小写且大小写敏感 ⇒ 显示名一律不匹配 ⇒ dsmlMode=false ⇒ 既不注入
  //    DSML 提示也不建提取器 ⇒ 模型凭训练印象臆造 `<｜DSML｜ calls>`，
  //    整段当正文、工具从不执行（用户截图实证）。
  return /^deepseek-v4-(flash|pro)$/i.test(model)
}

/**
 * 判断模型是否应使用 DSML 工具调用模式。
 *
 * ⚠️ OfficeAce 通道的模型 id 带 `-flash` 变体（如 `deepseek-v4.1-flash`），
 * 需一并纳入 —— 该通道同样经网关，断连风险一致（2026-10-13）。
 */
export function needsDsmlToolMode(model: string, _toolNames: readonly string[]): boolean {
  return isDeepseekV4Model(model) || /^deepseek-v4\.\d+-(flash|pro)$/i.test(model)
}

// ══════════════════════════ 解析侧 ══════════════════════════
//
// ⚠️ **2026-10-13 迁移**：整套解析器原先只在 `llm-adapter.ts`（codearts）
//    里。OfficeAce 走 `openai-compat.ts` 的 `consumeOpenAiSse`，**没有**
//    这套解析 ⇒ 即便注入了 DSML 提示（上一版只做了「教模型写」），
//    模型写出的 DSML 文本**无人解析**，照样整段当正文 —— 用户报「还是不行」。
//
//    故解析器必须与提示词**同处一个共享层**：教得会、也解得开。
//
// ⚠️ **解析侧与提示词（`buildDsmlSystemPrompt`）刻意同处本文件**：协议的
//    「写法」与「读法」只有一份定义，才不会出现「提示教 A、解析认 B」而
//    静默失效（这正是本通道连续三次事故的共同病根）。

export const DSML_PARAM_OPEN_PREFIX = '<｜DSML｜parameter'
export const DSML_PARAM_CLOSE = '</｜DSML｜parameter>'
export const THOUGHT_OPEN = '<thought>'
export const THOUGHT_CLOSE = '</thought>'

/**
 * 对标记 string="true" 的参数值做宽松解析：若值恰好是 number/boolean
 * /null 字面量（如 "1304"、"true"、"null"），返回原始类型；若值是合法
 * JSON 数组或对象（如 todo_write 的 todos 被写成 `[{"content":...}]`），
 * 还原为原始类型；否则保持字符串。用于纠正模型对数字/数组/对象参数误标
 * string 的 DSML 输出（如 read 的 offset 被写成 offset="1304"、
 * todo_write 的 todos 被写成 string="true" 的 JSON 数组字符串），使工具
 * schema 校验通过。
 */
function tryParseScalar(value: string): unknown {
  if (value === '') return ''
  const trimmed = value.trim()
  if (trimmed === '') return value
  if (trimmed === 'null') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  // 带引号的 JSON 字符串字面量：deepseek-v4-pro 常把数字/布尔参数值用
  // JSON 字符串编码（如 "840"），即便标记了 string="true" 也只输出引号
  // 包裹的字面量。先 JSON.parse 解码去掉外层引号，再递归尝试标量转换。
  // 仅当整体是合法 JSON 字符串字面量（"..." 配对）时才解码，避免误伤
  // 含引号的普通文本（如路径中的引号片段）。
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed) as unknown
      if (typeof decoded === 'string') return tryParseScalar(decoded)
      return decoded
    } catch { /* 非合法 JSON 字符串字面量，按原样处理 */ }
  }
  // 整数 / 浮点数 / 负数：仅当整体匹配数字语法时才转换，避免误伤路径
  // 中的数字片段（如 "v1.2" 不含；"123abc" 不含）。
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed)
  // 数组 / 对象：模型常对数组/对象参数误标 string="true"，把 JSON 编码的
  // 数组/对象当作字符串输出。若值是合法 JSON 数组或对象，还原为原始类型。
  // 仅对 `[` / `{` 开头尝试 JSON.parse，避免误伤普通字符串。
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) } catch { /* 非合法 JSON，保持字符串 */ }
  }
  return value
}

/** 解析单个 DSML invoke 块为 { name, arguments }。 */
function parseDsmlInvoke(block: string): { name: string; arguments: string } | undefined {
  const nameMatch = /name\s*=\s*"([^"]*)"/.exec(block)
  if (nameMatch === null) return undefined
  const name = nameMatch[1]
  const params: Record<string, unknown> = {}
  let cursor = 0
  for (;;) {
    const openStart = block.indexOf(DSML_PARAM_OPEN_PREFIX, cursor)
    if (openStart === -1) break
    const openEnd = block.indexOf('>', openStart)
    if (openEnd === -1) break
    const openTag = block.slice(openStart, openEnd + 1)
    const paramNameMatch = /name\s*=\s*"([^"]*)"/.exec(openTag)
    if (paramNameMatch === null) { cursor = openEnd + 1; continue }
    const paramName = paramNameMatch[1]
    const closeStart = block.indexOf(DSML_PARAM_CLOSE, openEnd + 1)
    if (closeStart === -1) break
    const value = block.slice(openEnd + 1, closeStart)
    // string="true" 标记字符串类型。但模型常对数字参数（read 的 offset 等）
    // 误标 string="true"，把 "1304" 当字符串输出 ⇒ schema 报
    // `"offset" must be a number`。故即便标记 string 也尝试标量还原。
    const isString = /string\s*=\s*"true"/.test(openTag)
    if (isString) {
      params[paramName] = tryParseScalar(value)
    } else {
      // 非 string 参数：deepseek-v4-pro 有时把数字用 JSON 字符串引号包裹
      // （如 "840"）且不加 string="true"，JSON.parse 得字符串仍过不了校验，
      // 故对字符串结果再走一次 tryParseScalar 还原为 number。
      try {
        const parsed = JSON.parse(value)
        params[paramName] = typeof parsed === 'string' ? tryParseScalar(parsed) : parsed
      } catch { params[paramName] = value }
    }
    cursor = closeStart + DSML_PARAM_CLOSE.length
  }
  return { name, arguments: JSON.stringify(params) }
}

/**
 * 从一段已闭合的 DSML tool_calls 块中解析所有 invoke，返回结构化
 * tool-call 列表。返回 undefined 表示解析失败（调用方应回退为纯文本）。
 */
export function parseDsmlToolCalls(block: string): Array<{ name: string; arguments: string }> | undefined {
  let inner = block
  if (inner.startsWith(DSML_TOOL_CALLS_OPEN)) inner = inner.slice(DSML_TOOL_CALLS_OPEN.length)
  if (inner.endsWith(DSML_TOOL_CALLS_CLOSE)) inner = inner.slice(0, inner.length - DSML_TOOL_CALLS_CLOSE.length)
  const calls: Array<{ name: string; arguments: string }> = []
  let cursor = 0
  for (;;) {
    const openStart = inner.indexOf(DSML_INVOKE_OPEN_PREFIX, cursor)
    if (openStart === -1) break
    const openEnd = inner.indexOf('>', openStart)
    if (openEnd === -1) break
    const closeStart = inner.indexOf(DSML_INVOKE_CLOSE, openEnd + 1)
    if (closeStart === -1) break
    const invokeBlock = inner.slice(openStart, closeStart + DSML_INVOKE_CLOSE.length)
    const parsed = parseDsmlInvoke(invokeBlock)
    if (parsed === undefined) return undefined
    calls.push(parsed)
    cursor = closeStart + DSML_INVOKE_CLOSE.length
  }
  return calls
}

/**
 * `｜DSML｜` 之后允许**任意空白**（归一正则用 `\s*`），因此「别名候选」
 * **不能用有限字符串枚举** —— 枚举必然漏掉多空格 / `\t` / U+3000 等形态。
 *
 * 实测（2026-10-13 对抗性审计）：`<｜DSML｜  calls>`（**两个空格**）逐字符
 * 拆帧时，归一正则当帧还匹配不上（`calls>` 尚未到齐），而保留候选只有
 * **单空格**的枚举项 ⇒ 标签被**提前放行** ⇒ 整段当正文、工具永不执行；
 * `\t` / U+3000 同型。**整帧到达时一概不复现**，故只测整块的用例挡不住。
 *
 * ⚠️ **只认「开标签」前缀，绝不能把前导 `/` 也算进来**（2026-10-13 回归）：
 * 判据一旦接受 `</…`，正文/推理里**已写完的闭标签**（如模型在解释协议时
 * 引用 `</｜DSML｜tool_calls>`）就会被当成「未完成的标签前缀」扣进缓冲，
 * 收尾再以 `text` 放行 ⇒ **闭标签从 reasoning 泄漏进正文**
 * （`llm-adapter.spec.ts` 的「does not leak DSML tags from reasoning to
 * text via visible fallback」实测变红）。闭标签的空白形态由 `feed()` 开头
 * 的 `replace` 负责归一，**不需要**靠保留候选兜。
 */
function isDsmlLabelPrefix(tail: string): boolean {
  return /^<｜DSML｜\s*(?:t(?:o(?:o(?:l_?)?)?)?)?(?:c(?:a(?:l(?:l(?:s)?)?)?)?)?>?$/.test(tail)
}

/**
 * 计算缓冲区末尾与任一开标签的最长公共前缀长度。流式提取器据此决定保留
 * 多少缓冲区等待下次 feed：末尾若是某开标签的不完整前缀（`<tho` 跨 chunk），
 * 保留该前缀；否则全部放行，避免短文本被过度缓冲。
 *
 * 判据 = 字符串前缀枚举 **并上** {@link isDsmlLabelPrefix}（覆盖 `\s*` 形态）。
 *
 * ⚠️ **别名那一路必须从「最后一个 `<`」起判，不能按固定长度窗口扫**
 * （2026-10-13 自审修正）：`｜DSML｜` 之后的空白是 `\s*`，**长度无上限**，
 * 任何固定 `maxCheck` 都会被「空白够多」绕过 —— 例如
 * `<｜DSML｜` + 20 个空格 + `calls>` 总长 33 字符，窗口只回看 32 字符时
 * 连开头的 `<` 都够不着 ⇒ 判据不命中 ⇒ 标签被**提前放行**。
 * 从最后一个 `<` 起判则与空白长度无关（`lastIndexOf` 是 O(n)，无额外成本）。
 */
function longestOpenPrefixTail(buffer: string, prefixes: readonly string[]): number {
  let keepLen = 0
  const maxCheck = Math.min(buffer.length, Math.max(...prefixes.map(p => p.length)))
  for (let i = 1; i <= maxCheck; i++) {
    const tail = buffer.slice(buffer.length - i)
    if (prefixes.some(p => p.startsWith(tail))) keepLen = i
  }
  const lastLt = buffer.lastIndexOf('<')
  if (lastLt !== -1) {
    const tail = buffer.slice(lastLt)
    if (isDsmlLabelPrefix(tail) && tail.length > keepLen) keepLen = tail.length
  }
  return keepLen
}

/**
 * 开标签的**别名形态**（2026-10-13 二次事故）。
 *
 * 实测 OfficeAce / `deepseek-v4.1-flash` 会把 `<｜DSML｜tool_calls>` 漏写成
 * `<｜DSML｜ calls>`（**少 `tool_` 前缀**），或插入多余空白
 * （`<｜DSML｜ tool_calls>`）。宿主 `indexOf(DSML_TOOL_CALLS_OPEN)` 一律
 * 不匹配 ⇒ 整段当正文、工具从不执行。
 *
 * 这三个串同时用于两处：① `feed()` 的别名归一（拼齐后改写为规范形）；
 * ② `longestOpenPrefixTail` 的保留候选（**拆帧到达**时不漏放行）。
 */
const DSML_OPEN_ALIASES = [
  '<｜DSML｜ calls>',
  '<｜DSML｜calls>',
  '<｜DSML｜ tool_calls>',
] as const

/**
 * 流式 DSML 提取器。feed() 接收 content delta，返回：
 * - `text`：应作为 text-delta 输出的纯文本（可能为空串）
 * - `reasoning`：应作为 reasoning-delta 输出的推理增量（可能为空串）
 * - `toolCalls`：已完整解析的 DSML tool-call 列表（可能为空数组）
 * flush() 在流结束时把残留缓冲区按状态放行。
 *
 * 状态机三态：
 * - normal：寻找 `<thought>` 或 `<｜DSML｜tool_calls>` 开标签
 * - in-thought：寻找 `</thought>`，期间内容作为 reasoning 流式输出
 * - in-dsml：寻找 `</｜DSML｜tool_calls>`，完整后解析为 tool-call
 */
export class DsmlContentExtractor {
  private buffer = ''
  private state: 'normal' | 'in-thought' | 'in-dsml' = 'normal'

  feed(chunk: string): { text: string; reasoning: string; toolCalls: Array<{ name: string; arguments: string }> } {
    let text = ''
    let reasoning = ''
    const toolCalls: Array<{ name: string; arguments: string }> = []
    this.buffer += chunk
    // ── 开标签别名归一（2026-10-13）──
    // `<｜DSML｜ calls>` / `<｜DSML｜calls>` / `<｜DSML｜ tool_calls>`
    // 一律改写为规范形 `<｜DSML｜tool_calls>`，后续 indexOf 才认。
    // ⚠️ 必须放在 buffer 累积**之后**：别名可能被拆成多帧到达，只有等
    //    buffer 拼齐才改得动（这也是不能用 sse.ts 逐帧归一化器的原因）。
    // 幂等：规范形再过一遍，`(?:tool_)?calls` 命中后重建出同一字符串。
    this.buffer = this.buffer.replace(/(<\/?)｜DSML｜\s*(?:tool_)?calls>/g, '$1｜DSML｜tool_calls>')
    for (;;) {
      if (this.state === 'normal') {
        const thoughtIdx = this.buffer.indexOf(THOUGHT_OPEN)
        const dsmlIdx = this.buffer.indexOf(DSML_TOOL_CALLS_OPEN)
        let openIdx = -1
        let nextState: 'in-thought' | 'in-dsml' = 'in-thought'
        if (thoughtIdx !== -1 && (dsmlIdx === -1 || thoughtIdx < dsmlIdx)) {
          openIdx = thoughtIdx
          nextState = 'in-thought'
        } else if (dsmlIdx !== -1) {
          openIdx = dsmlIdx
          nextState = 'in-dsml'
        }
        if (openIdx === -1) {
          const keepLen = longestOpenPrefixTail(this.buffer, [THOUGHT_OPEN, DSML_TOOL_CALLS_OPEN, ...DSML_OPEN_ALIASES])
          if (keepLen === 0) {
            text += this.buffer
            this.buffer = ''
          } else if (this.buffer.length > keepLen) {
            text += this.buffer.slice(0, this.buffer.length - keepLen)
            this.buffer = this.buffer.slice(this.buffer.length - keepLen)
          }
          break
        }
        if (openIdx > 0) text += this.buffer.slice(0, openIdx)
        this.buffer = this.buffer.slice(openIdx)
        const openLen = nextState === 'in-thought' ? THOUGHT_OPEN.length : DSML_TOOL_CALLS_OPEN.length
        this.buffer = this.buffer.slice(openLen)
        this.state = nextState
        continue
      }
      if (this.state === 'in-thought') {
        const closeIdx = this.buffer.indexOf(THOUGHT_CLOSE)
        if (closeIdx === -1) {
          const keepLen = longestOpenPrefixTail(this.buffer, [THOUGHT_CLOSE])
          if (keepLen === 0) {
            reasoning += this.buffer
            this.buffer = ''
          } else if (this.buffer.length > keepLen) {
            reasoning += this.buffer.slice(0, this.buffer.length - keepLen)
            this.buffer = this.buffer.slice(this.buffer.length - keepLen)
          }
          break
        }
        if (closeIdx > 0) reasoning += this.buffer.slice(0, closeIdx)
        this.buffer = this.buffer.slice(closeIdx + THOUGHT_CLOSE.length)
        this.state = 'normal'
        continue
      }
      // state === 'in-dsml'：寻找闭标签，完整块才解析
      const closeIdx = this.buffer.indexOf(DSML_TOOL_CALLS_CLOSE)
      if (closeIdx === -1) break
      const block = this.buffer.slice(0, closeIdx + DSML_TOOL_CALLS_CLOSE.length)
      const parsed = parseDsmlToolCalls(block)
      if (parsed === undefined) {
        // 解析失败：整块作为纯文本放行，避免吞内容
        text += block
      } else {
        toolCalls.push(...parsed)
      }
      this.buffer = this.buffer.slice(closeIdx + DSML_TOOL_CALLS_CLOSE.length)
      this.state = 'normal'
      continue
    }
    return { text, reasoning, toolCalls }
  }

  flush(): { text: string; reasoning: string } {
    const remaining = this.buffer
    this.buffer = ''
    if (this.state === 'in-thought') {
      this.state = 'normal'
      return { text: '', reasoning: remaining }
    }
    if (this.state === 'in-dsml') {
      // 开标签已在进入 in-dsml 时被消耗，需加回才能保持可见内容完整
      this.state = 'normal'
      return { text: DSML_TOOL_CALLS_OPEN + remaining, reasoning: '' }
    }
    this.state = 'normal'
    return { text: remaining, reasoning: '' }
  }
}

/**
 * 构造让模型以原生 DSML 格式调用工具的 system 提示。
 *
 * 用法：适配器**不**发送 `tools` 字段（否则模型走标准 tool_calls 一次性
 * 打包路径），而是把 OpenAI function schema 以文本注入 system 消息，并明确
 * 要求模型使用 {@link DSML_TOOL_CALLS_OPEN} 语法。
 *
 * ⚠️ **必须与解析侧（{@link DsmlContentExtractor}）成对启用**：本函数只
 *    负责「教模型怎么写」，`DsmlContentExtractor` 负责「把它读回来」。
 *    只教不解 ⇒ 模型写出的 DSML 整段当正文显示、工具永不执行。
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
