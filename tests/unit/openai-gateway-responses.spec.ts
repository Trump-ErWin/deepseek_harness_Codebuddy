import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpenAiGatewayError } from '../../src/openai-gateway/messages.js'
import {
  collectResponsesResult,
  flatNamespaceToolName,
  responsesMaxOutputTokens,
  responsesNamespaceToolMap,
  responsesReasoningEffort,
  toResponsesGenerateOptions,
  toResponsesSse,
  type OpenAiResponsesRequest,
} from '../../src/openai-gateway/responses.js'

/** 请求转换用例里的假附件服务（与 `images.ts` 的注入形态一致）。 */
const bridge = {
  saveImage: async ({ data, mediaType }: { data: Uint8Array; mediaType: string }) => ({
    attachmentId: `sha256:${mediaType}:${data.length}`,
    mediaType,
  }),
}

const PNG = 'data:image/png;base64,iVBORw0KGgo='

function abort(): AbortSignal {
  return new AbortController().signal
}

async function* chunks(values: StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* values
}

/** 把 SSE 文本解析成 `{ event, data }`，便于按协议断言而不是匹配字符串。 */
async function readSse(
  stream: AsyncIterable<StreamChunk>,
  request: OpenAiResponsesRequest = {},
  suggest?: (message: string) => string | undefined,
): Promise<Array<{ event: string; data: Record<string, any> }>> {
  const events: Array<{ event: string; data: Record<string, any> }> = []
  for await (const raw of toResponsesSse(stream, 'resp_test', 'qoder/qfmodel', request, suggest)) {
    const lines = raw.split('\n')
    const event = lines.find(line => line.startsWith('event: '))!.slice('event: '.length)
    const data = JSON.parse(lines.find(line => line.startsWith('data: '))!.slice('data: '.length))
    events.push({ event, data })
  }
  return events
}

describe('Responses API 请求转换', () => {
  it('input 字符串 + instructions：instructions 变成 system 消息，input 变成 user 消息', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      instructions: '你是助手',
      input: '你好',
    }, abort())
    expect(options.provider).toBe('qoder')
    expect(options.model).toBe('qfmodel')
    expect(options.messages).toHaveLength(2)
    expect(options.messages[0].role).toBe('system')
    expect(options.messages[0].content).toEqual([{ type: 'text', text: '你是助手' }])
    expect(options.messages[1].role).toBe('user')
    expect(options.messages[1].content).toEqual([{ type: 'text', text: '你好' }])
  })

  it('input 数组：文本 / 图片 / 工具调用 / 工具结果 / 推理项各归其位', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: [
        { type: 'message', role: 'user', content: [
          { type: 'input_text', text: '看图' },
          { type: 'input_image', image_url: PNG },
        ] },
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'xxx' },
        { type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'read', arguments: '{"path":"a"}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'file content' },
      ],
    }, abort(), undefined, undefined, { bridge })

    // 图片经附件服务落成 ImageBlock（与 Chat 路径同一份实现）。
    expect(options.messages[0].content[1]).toMatchObject({ type: 'image' })
    // 推理项**刻意丢弃**：网关拿不到可回放的等价物。
    expect(options.messages.some(message => JSON.stringify(message.content).includes('encrypted'))).toBe(false)
    expect(options.messages[1].content).toContainEqual(expect.objectContaining({
      type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}',
    }))
    expect(options.messages[2].content).toContainEqual(expect.objectContaining({
      type: 'tool-result', toolCallId: 'call-1',
    }))
  })

  // ⚠️⚠️ **真实缺陷回归**（2026-10-04，用户报障）：「codex 里用 trae 出现
  // tool 消息的内容不能包含图片」。Codex 的 `view_image` 把读到的图直接放进
  // `function_call_output.output`（`[{type:'input_image',image_url:'data:…'}]`），
  // 而网关原先对工具结果只走 `textFromContent` —— 它对图片**一律抛错** ⇒
  // 一让模型看图整轮就 400，且坏报文落进历史被每次重放，换 provider 才能恢复。
  //
  // ⚠️ 判据不能只是「不报错」：**图片必须真的落进 tool-result 的内层 content**。
  // 静默压成文本/丢掉同样是缺陷（用户以为模型看到了图）。
  it('★ 工具结果的 output 带图时：图片落进 tool-result 内层（不是报错，也不是静默丢弃）', async () => {
    const saved: string[] = []
    const imageBridge = {
      saveImage: async ({ data, mediaType }: { data: Uint8Array; mediaType: string }) => {
        saved.push(mediaType)
        return { attachmentId: `sha256:${mediaType}:${data.length}`, mediaType }
      },
    }
    const options = await toResponsesGenerateOptions({
      model: 'trae/deepseek-v4.1-flash',
      input: [
        { type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'view_image', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-1', output: [
          { type: 'input_image', image_url: PNG, detail: 'high' },
        ] },
      ],
    }, abort(), undefined, undefined, { bridge: imageBridge })

    const results = options.messages
      .flatMap(message => message.content ?? [])
      .filter(block => block.type === 'tool-result')
    expect(results).toHaveLength(1)
    expect(results[0].content.map(block => block.type)).toEqual(['image'])
    expect(results[0].content[0]).toMatchObject({ type: 'image' })
    // 图片真的经附件服务落盘了（不是凭空造一个块）。
    expect(saved).toEqual(['image/png'])
  })

  it('★ 工具结果 output 为「文字 + 图」时两类块都在且顺序保持', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'trae/deepseek-v4.1-flash',
      input: [
        { type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'view_image', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-1', output: [
          { type: 'input_text', text: '截图如下' },
          { type: 'input_image', image_url: PNG },
        ] },
      ],
    }, abort(), undefined, undefined, { bridge })

    const results = options.messages
      .flatMap(message => message.content ?? [])
      .filter(block => block.type === 'tool-result')
    expect(results[0].content.map(block => block.type)).toEqual(['text', 'image'])
    expect(results[0].content[0]).toMatchObject({ type: 'text', text: '截图如下' })
  })

  it('★ 连续的 assistant 项合并成一条消息（否则每个用过工具的会话都会给上游留下两条连续 assistant）', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: [
        { type: 'message', role: 'user', content: '开始' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我看看' }] },
        { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{}' },
      ],
    }, abort())

    expect(options.messages).toHaveLength(2)
    expect(options.messages[1].role).toBe('assistant')
    expect(options.messages[1].content).toEqual([
      { type: 'text', text: '我看看' },
      expect.objectContaining({ type: 'tool-call', id: 'call-1' }),
    ])
  })

  it('工具定义：扁平（Responses）与嵌套（Chat）两种形状都认，转成 DSH 的 ToolSchema', async () => {
    const flat = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: 'hi',
      tools: [{ type: 'function', name: 'read', description: '读文件', parameters: { type: 'object' } }],
    }, abort())
    expect(flat.tools).toEqual([{ name: 'read', description: '读文件', parameters: { type: 'object' } }])

    const nested = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: 'hi',
      tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
    }, abort())
    expect(nested.tools).toEqual([{ name: 'read', description: '', parameters: {} }])
  })

  it('max_output_tokens 与 reasoning.effort 透传；档位归一化的三态不被抵消', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: 'hi',
      max_output_tokens: 1234,
      reasoning: { effort: 'high' },
    }, abort(), 'high')
    expect(options.maxTokens).toBe(1234)
    expect(options.reasoningEffort).toBe('high')

    // `null` = 明确不下发（模型未声明思考档位）：不得让请求体里的 effort 复活。
    const suppressed = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: 'hi',
      reasoning: { effort: 'high' },
    }, abort(), null)
    expect('reasoningEffort' in suppressed).toBe(false)

    expect(responsesReasoningEffort({ reasoning: { effort: 'low' } })).toBe('low')
    expect(responsesReasoningEffort({})).toBeUndefined()
    expect(responsesMaxOutputTokens({ max_output_tokens: 12 })).toBe(12)
    // SDK 常把「未设置」序列化成 null：按没给处理，而不是回 400。
    expect(responsesMaxOutputTokens({ max_output_tokens: null })).toBeUndefined()
  })

  it('★ 语义会变的字段必须明确报错，不静默忽略', async () => {
    const cases: Array<[string, OpenAiResponsesRequest]> = [
      ['previous_response_id', { model: 'qoder/qfmodel', input: 'hi', previous_response_id: 'resp_1' }],
      ['background', { model: 'qoder/qfmodel', input: 'hi', background: true }],
      ['text.format', { model: 'qoder/qfmodel', input: 'hi', text: { format: { type: 'json_schema' } } }],
      // ⚠️ 漏写 `type` 的结构化输出请求：响应固定回 `text:{format:{type:'text'}}`，
      // 静默放行等于骗客户端说「拿到的是纯文本」，用户会拿到不合规的 JSON 而不知情。
      ['text.format 缺 type', { model: 'qoder/qfmodel', input: 'hi', text: { format: { name: 'x', schema: { type: 'object' } } } }],
      ['top_p', { model: 'qoder/qfmodel', input: 'hi', top_p: 0.5 }],
      ['item_reference', { model: 'qoder/qfmodel', input: [{ type: 'item_reference', id: 'msg_1' }] }],
      ['file_id 图片', { model: 'qoder/qfmodel', input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file-1' }] }] }],
      ['tool_choice required', { model: 'qoder/qfmodel', input: 'hi', tool_choice: 'required' }],
      ['input 为空', { model: 'qoder/qfmodel', input: [] }],
      ['temperature 非数字', { model: 'qoder/qfmodel', input: 'hi', temperature: 'hot' }],
    ]
    for (const [name, body] of cases) {
      await expect(toResponsesGenerateOptions(body, abort()), name).rejects.toThrow(OpenAiGatewayError)
    }
    // top_p: 1 是默认值，等价于不设置 ⇒ 必须放行（否则常见客户端一律 400）。
    await expect(toResponsesGenerateOptions({ model: 'qoder/qfmodel', input: 'hi', top_p: 1 }, abort())).resolves.toBeTruthy()
    // text.format 'text' 是默认值，同样放行。
    await expect(toResponsesGenerateOptions({
      model: 'qoder/qfmodel', input: 'hi', text: { format: { type: 'text' }, verbosity: 'low' },
    }, abort())).resolves.toBeTruthy()
  })

  /**
   * Codex 0.142+ 的工具声明形状（**真实报障，2026-10-03**）。
   *
   * 报障原文：`tool type namespace is not supported（网关只提供 function 工具）`
   * —— 代价是**整轮对话不可用**，而 namespace 只是**分组容器**，里面的 function
   * 完全可以表达给模型。故这里锁死「摊平 + 响应侧还原 + 表达不了的丢弃」三条。
   */
  it('★ namespace 工具必须摊平（不是报错）：子工具以 <namespace>__<child> 声明给上游', async () => {
    const dropped: string[] = []
    const options = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: 'hi',
      tools: [
        { type: 'function', name: 'plain_tool', parameters: {} },
        {
          type: 'namespace',
          name: 'mcp__files__',
          description: '文件相关',
          tools: [
            { type: 'function', name: 'read', description: '读文件', parameters: { type: 'object' } },
            { type: 'function', name: 'write', parameters: {} },
            // `defer_loading`（延迟加载，本应由 tool_search 搜出来）：那套机制我们
            // 表达不了，**照样摊平**给模型 —— 否则工具等于凭空消失。
            { type: 'function', name: 'deferred', parameters: {}, defer_loading: true },
            // namespace 里的非 function 子工具（如 custom）无法表达 ⇒ 丢弃 + 上报。
            { type: 'custom', name: 'apply_patch' },
          ],
        },
      ],
    }, abort(), undefined, undefined, {}, (tool) => dropped.push(`${tool.type}/${tool.name}`))

    expect(options.tools?.map(tool => tool.name)).toEqual([
      'plain_tool',
      'mcp__files____read',
      'mcp__files____write',
      'mcp__files____deferred',
    ])
    expect(options.tools?.[1]).toEqual({
      name: 'mcp__files____read', description: '读文件', parameters: { type: 'object' },
    })
    expect(dropped).toEqual(['custom/apply_patch'])
  })

  it('★ 顶层无法表达的工具类型：丢弃 + 上报，绝不 400（否则 Codex 整轮失败）', async () => {
    const dropped: string[] = []
    const options = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: 'hi',
      tools: [
        { type: 'tool_search' },
        { type: 'custom', name: 'apply_patch', format: { type: 'grammar' } },
        { type: 'web_search' },
        { type: 'function', name: 'shell', parameters: {} },
      ],
    }, abort(), undefined, undefined, {}, (tool) => dropped.push(tool.type))
    expect(options.tools?.map(tool => tool.name)).toEqual(['shell'])
    expect(dropped).toEqual(['tool_search', 'custom', 'web_search'])
  })

  it('tool_choice 为 namespace 时降级成 auto（而不是让整轮 400）', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: 'hi',
      tool_choice: { type: 'namespace', name: 'mcp__files__' },
      tools: [{ type: 'namespace', name: 'mcp__files__', tools: [{ type: 'function', name: 'read', parameters: {} }] }],
    }, abort())
    // DSH 只认 auto/none：降级后模型仍能从已摊平的工具里挑（cc-switch / sub2api 同款）。
    expect(options.tools?.map(tool => tool.name)).toEqual(['mcp__files____read'])
  })

  it('扁平名确定性：两侧各自算也一致，超 64 字符时截断且不碰撞', () => {
    expect(flatNamespaceToolName('mcp__files__', 'read')).toBe('mcp__files____read')
    // 请求侧摊平与响应侧还原是两次独立计算，必须逐字符一致。
    const map = responsesNamespaceToolMap({
      tools: [{
        type: 'namespace',
        name: 'mcp__files__',
        tools: [{ type: 'function', name: 'read', parameters: {} }],
      }],
    })
    expect(map.get(flatNamespaceToolName('mcp__files__', 'read'))).toEqual({
      namespace: 'mcp__files__', name: 'read',
    })

    const longA = 'a'.repeat(80)
    const longB = `${'a'.repeat(79)}b`
    const flatA = flatNamespaceToolName('ns', longA)
    const flatB = flatNamespaceToolName('ns', longB)
    expect(flatA.length).toBeLessThanOrEqual(64)
    expect(flatB.length).toBeLessThanOrEqual(64)
    // 纯截断会让这两个长名字撞在一起 —— 8 位哈希后缀就是为了防这个。
    expect(flatA).not.toBe(flatB)
  })

  // ⚠️ 下面三条锁的是「工具名清洗口径必须三处一致」这个不变式。修复前摊平侧用
  // `String(child.name ?? '')`（不 trim）、还原表 trim、历史回放两者都不管 —— 三套口径
  // 两两不等，症状是模型调通了、客户端却收到一个自己没声明过的工具名。
  it('★ 工具名带首尾空白时：摊平 / 还原表 / 历史回放三处必须逐字符一致', async () => {
    const tools = [{
      type: 'namespace', name: 'mcp__files__',
      tools: [{ type: 'function', name: ' read ', parameters: {} }],
    }]
    const options = await toResponsesGenerateOptions({ model: 'qoder/qfmodel', input: 'hi', tools }, abort())
    const flat = options.tools?.map(tool => tool.name)
    // 发给上游的名字是 trim 后的（与客户端声明的语义一致）
    expect(flat).toEqual(['mcp__files____read'])
    // 还原表的键必须就是那个**实际发出去**的名字，否则响应侧永远配不上
    expect([...responsesNamespaceToolMap({ tools }).keys()]).toEqual(flat)
    // 历史回放也要换回同一个扁平名
    const replay = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: [{ type: 'function_call', call_id: 'c1', name: ' read ', namespace: 'mcp__files__', arguments: '{}' }],
    }, abort())
    expect(replay.messages[0].content).toContainEqual(expect.objectContaining({
      type: 'tool-call', name: flat![0],
    }))
  })

  it('★ 子工具名为空时不得凭空造出 `ns____` 幽灵工具（还原表永远配不上它）', async () => {
    const dropped: Array<{ type: string; name?: string }> = []
    const options = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: 'hi',
      tools: [{
        type: 'namespace', name: 'mcp__files__',
        tools: [{ type: 'function', name: '', parameters: {} }, { type: 'function', name: '  ', parameters: {} }],
      }],
    }, abort(), undefined, undefined, {}, tool => dropped.push(tool))
    // 空名与纯空白名都表达不了工具 —— 丢弃，且**一个都不能发出去**
    expect(options.tools).toEqual([])
    expect(dropped).toEqual([{ type: 'function', name: undefined }, { type: 'function', name: undefined }])
    expect(JSON.stringify(options.messages)).not.toContain('mcp__files____')
  })

  it('★ 顶层工具与摊平名撞车时先来先到，且被丢弃的那个不得进还原表（否则静默误路由）', async () => {
    const tools = [
      // 顶层普通工具**故意**取 namespace 摊平后会得到的那个名字
      { type: 'function', name: 'mcp__files____read', parameters: {} },
      { type: 'namespace', name: 'mcp__files__', tools: [{ type: 'function', name: 'read', parameters: {} }] },
    ]
    const options = await toResponsesGenerateOptions({ model: 'qoder/qfmodel', input: 'hi', tools }, abort())
    expect(options.tools?.map(tool => tool.name)).toEqual(['mcp__files____read'])
    // ⚠️ 若还原表仍把 `mcp__files____read` 映射回 `{namespace:'mcp__files__'}`，
    // 上游对**那个顶层工具**的调用就会被报成 namespace 里的另一个工具。
    expect(responsesNamespaceToolMap({ tools }).has('mcp__files____read')).toBe(false)
  })

  it('★ 反向验证：还原表对「请求里没发出去的工具」一律为空', async () => {
    // 只声明 namespace 里的非 function 子工具 —— 全被丢弃，还原表必须为空
    const tools = [{ type: 'namespace', name: 'mcp__files__', tools: [{ type: 'custom', name: 'apply_patch' }] }]
    const options = await toResponsesGenerateOptions({ model: 'qoder/qfmodel', input: 'hi', tools }, abort())
    expect(options.tools).toEqual([])
    expect(responsesNamespaceToolMap({ tools }).size).toBe(0)
  })

  it('历史里带 namespace 的 function_call 必须换回扁平名（否则上游认为调了个没见过的工具）', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      input: [
        { type: 'message', role: 'user', content: '读一下' },
        { type: 'function_call', call_id: 'call-1', name: 'read', namespace: 'mcp__files__', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-1', output: '内容' },
      ],
    }, abort())
    expect(options.messages[1].content).toContainEqual(expect.objectContaining({
      type: 'tool-call', id: 'call-1', name: 'mcp__files____read',
    }))
  })
})

describe('Responses API 输出（非流式）', () => {
  const request: OpenAiResponsesRequest = { model: 'qoder/qfmodel', input: 'hi' }

  it('文本 + usage + stop：组装成完整的 response 对象', async () => {
    const result = await collectResponsesResult(chunks([
      { type: 'text-delta', index: 0, text: '你' },
      { type: 'text-delta', index: 0, text: '好' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cacheReadTokens: 1, reasoningTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'resp_1', 'qoder/qfmodel', request)

    expect(result).toMatchObject({
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      model: 'qoder/qfmodel',
      error: null,
      incomplete_details: null,
      store: false,
      previous_response_id: null,
    })
    const output = result.output as Array<Record<string, any>>
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ type: 'message', status: 'completed', role: 'assistant' })
    expect(output[0].content[0]).toMatchObject({ type: 'output_text', text: '你好' })
    expect(result.usage).toEqual({
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 1 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 5,
    })
  })

  it('max-tokens：status 是 incomplete 并给出 incomplete_details（不是 completed）', async () => {
    const result = await collectResponsesResult(chunks([
      { type: 'text-delta', index: 0, text: '半句' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]), 'resp_2', 'qoder/qfmodel', request)
    expect(result.status).toBe('incomplete')
    expect(result.incomplete_details).toEqual({ reason: 'max_output_tokens' })
  })

  it('★ block-end 是权威覆盖：死循环截断后的文本才是最终文本', async () => {
    const result = await collectResponsesResult(chunks([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '重复重复重复' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '重复' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'resp_3', 'qoder/qfmodel', request)
    const output = result.output as Array<Record<string, any>>
    expect(output[0].content[0].text).toBe('重复')
  })

  // ⚠️ 上面那条只锁了**非流式**。流式侧的 done 事件（output_text.done /
  // content_part.done / output_item.done）走的是另一条组装路径，而「正文以 block-end
  // 为权威」正是本 PR 声明的两处有意差异之一 —— 少了这条，差一个实现就会静默地
  // 把截断后的文本又放回去（Chat 端点确实那样，但那是本 PR 之外的行为）。
  it('★ 流式侧同样以 block-end 为权威（done 事件与 completed 都不能放回未截断的文本）', async () => {
    const events = await readSse(chunks([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '重复重复重复' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '重复' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    const textDone = events.find(event => event.event === 'response.output_text.done')
    expect(textDone?.data.text).toBe('重复')
    const itemDone = events.find(event => event.event === 'response.output_item.done')
    expect(itemDone?.data.item.content[0].text).toBe('重复')
    const completed = events.find(event => event.event === 'response.completed')
    expect(completed?.data.response.output[0].content[0].text).toBe('重复')
  })

  // ⚠️ 锁住「首帧 call_id 为空也能被 block-end 修正」这一自愈路径（见 responses.ts
  // 里 tool-call-delta 分支的注释）：added 事件带的是空串，但 done 与最终 output
  // 必须是真实 id —— 官方 SDK 以这两者为准。
  it('首帧 call_id 为空时：output_item.done 与最终 output 必须被 block-end 修正为真实 id', async () => {
    const events = await readSse(chunks([
      { type: 'tool-call-delta', index: 0, id: '' as never, name: 'read', argumentsDelta: '{"pa' },
      { type: 'tool-call-delta', index: 0, id: '' as never, name: undefined, argumentsDelta: 'th":"a"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-real' as never, name: 'read', arguments: '{"path":"a"}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]))
    const added = events.find(event => event.event === 'response.output_item.added')
    // 首帧没有 id ⇒ added 只能带空串（该事件发出去就改不了，见实现里的注释）
    expect(added?.data.item.call_id).toBe('')
    const done = events.find(event => event.event === 'response.output_item.done')
    expect(done?.data.item.call_id).toBe('call-real')
    expect(done?.data.item.arguments).toBe('{"path":"a"}')
    const completed = events.find(event => event.event === 'response.completed')
    expect(completed?.data.response.output[0].call_id).toBe('call-real')
  })

  it('工具调用：function_call 项带 call_id / name / arguments（block-end 覆盖参数）', async () => {
    const result = await collectResponsesResult(chunks([
      { type: 'tool-call-delta', index: 0, id: 'call-1' as never, name: 'read', argumentsDelta: '{"path":"a","x":1}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1' as never, name: 'read', arguments: '{"path":"a"}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'resp_4', 'qoder/qfmodel', request)
    const output = result.output as Array<Record<string, any>>
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({
      type: 'function_call', status: 'completed', call_id: 'call-1', name: 'read', arguments: '{"path":"a"}',
    })
  })

  it('★ namespace 工具的调用要还原成 {name, namespace}（Codex 按 (namespace, name) 索引工具）', async () => {
    const nsRequest: OpenAiResponsesRequest = {
      model: 'qoder/qfmodel',
      input: 'hi',
      tools: [{
        type: 'namespace',
        name: 'mcp__files__',
        tools: [{ type: 'function', name: 'read', parameters: {} }],
      }],
    }
    const result = await collectResponsesResult(chunks([
      { type: 'tool-call-delta', index: 0, id: 'call-1' as never, name: 'mcp__files____read', argumentsDelta: '{"path":"a"}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'resp_ns', 'qoder/qfmodel', nsRequest)
    const output = result.output as Array<Record<string, any>>
    // ⚠️ 只回扁平名 `mcp__files____read` 的话，Codex 会认为「模型调了一个不存在的工具」。
    expect(output[0]).toMatchObject({
      type: 'function_call', call_id: 'call-1', name: 'read', namespace: 'mcp__files__',
    })
    expect(JSON.stringify(result)).not.toContain('mcp__files____read')
  })

  it('模型只给了思考：output 里出现 reasoning 项（summary_text）而不是丢失', async () => {
    const result = await collectResponsesResult(chunks([
      { type: 'reasoning-delta', index: 0, text: '想一想' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'resp_5', 'qoder/qfmodel', request)
    const output = result.output as Array<Record<string, any>>
    expect(output[0].type).toBe('reasoning')
    expect(output[0].summary).toEqual([{ type: 'summary_text', text: '想一想' }])
  })

  it('上游「模型不存在」翻成 404 + 纠错建议（不是会被重试的 502）', async () => {
    await expect(collectResponsesResult(chunks([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: 'codearts: The model is not registered' } } },
    ]), 'resp_6', 'codearts/wrong', request, () => '你是不是想用 codearts/glm-5.3-flash')).rejects.toMatchObject({
      status: 404,
      code: 'model_not_found',
      message: expect.stringContaining('你是不是想用 codearts/glm-5.3-flash'),
    })
  })

  it('上游没给 finish 就断了：报 incomplete_stream，而不是「干净地停在半句话上」', async () => {
    await expect(collectResponsesResult(chunks([
      { type: 'text-delta', index: 0, text: '半句' },
    ]), 'resp_7', 'qoder/qfmodel', request)).rejects.toMatchObject({ status: 502, code: 'incomplete_stream' })
  })
})

describe('Responses API 输出（流式）', () => {
  const request: OpenAiResponsesRequest = { model: 'qoder/qfmodel', input: 'hi' }

  it('事件序列与 sequence_number：created → in_progress → item/part/delta/done → completed', async () => {
    const events = await readSse(chunks([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '你好' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), request)

    expect(events.map(event => event.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
    expect(events.map(event => event.data.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(events[4].data).toMatchObject({ type: 'response.output_text.delta', delta: '你好', content_index: 0 })
    const completed = events.at(-1)!.data.response
    expect(completed.status).toBe('completed')
    expect(completed.output[0].content[0].text).toBe('你好')
    expect(completed.usage).toMatchObject({ input_tokens: 1, output_tokens: 2, total_tokens: 3 })
  })

  it('★ 不发 data: [DONE]（那是 Chat Completions 的收尾约定）', async () => {
    const raw: string[] = []
    for await (const item of toResponsesSse(chunks([
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'resp_x', 'qoder/qfmodel', request)) raw.push(item)
    expect(raw.join('')).not.toContain('[DONE]')
    expect(raw.at(-1)).toContain('event: response.completed')
  })

  it('推理与正文各成一项：reasoning 用 summary 事件，正文用 output_text 事件', async () => {
    const events = await readSse(chunks([
      { type: 'reasoning-delta', index: 0, text: '思考' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '答案' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), request)

    const names = events.map(event => event.event)
    expect(names).toContain('response.reasoning_summary_text.delta')
    expect(names).toContain('response.output_text.delta')
    // `block-start` 先收尾前一项：reasoning 的 done 必须排在正文的 added 之前。
    const reasoningDone = names.indexOf('response.output_item.done')
    const textAdded = names.lastIndexOf('response.output_item.added')
    expect(reasoningDone).toBeLessThan(textAdded)
    expect(events.find(event => event.event === 'response.reasoning_summary_text.delta')!.data.output_index).toBe(0)
    expect(events.find(event => event.event === 'response.output_text.delta')!.data.output_index).toBe(1)
  })

  it('工具调用：added 事件里就带上了 call_id / name（延迟到第一帧 delta 才打开）', async () => {
    const events = await readSse(chunks([
      { type: 'tool-call-delta', index: 0, id: 'call-9' as never, name: 'read', argumentsDelta: '{"a"' },
      { type: 'tool-call-delta', index: 0, id: 'call-9' as never, argumentsDelta: ':1}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), request)

    const added = events.find(event => event.event === 'response.output_item.added')!.data.item
    expect(added).toMatchObject({ type: 'function_call', call_id: 'call-9', name: 'read' })
    const deltas = events.filter(event => event.event === 'response.function_call_arguments.delta')
    expect(deltas.map(event => event.data.delta).join('')).toBe('{"a":1}')
    const done = events.find(event => event.event === 'response.function_call_arguments.done')!.data
    expect(done.arguments).toBe('{"a":1}')
    const completed = events.at(-1)!.data.response
    expect(completed.status).toBe('completed')
    expect(completed.output[0]).toMatchObject({ type: 'function_call', call_id: 'call-9', name: 'read' })
  })

  it('★ 流式：namespace 工具的三个 function_call 事件都要还原（added / arguments.done / done）', async () => {
    const nsRequest: OpenAiResponsesRequest = {
      model: 'qoder/qfmodel',
      input: 'hi',
      tools: [{
        type: 'namespace',
        name: 'mcp__files__',
        tools: [{ type: 'function', name: 'read', parameters: {} }],
      }],
    }
    const events = await readSse(chunks([
      { type: 'tool-call-delta', index: 0, id: 'call-1' as never, name: 'mcp__files____read', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), nsRequest)

    const added = events.find(event => event.event === 'response.output_item.added')!.data.item
    expect(added).toMatchObject({ name: 'read', namespace: 'mcp__files__' })
    const argsDone = events.find(event => event.event === 'response.function_call_arguments.done')!.data
    expect(argsDone).toMatchObject({ name: 'read', namespace: 'mcp__files__' })
    const itemDone = events.find(event => event.event === 'response.output_item.done')!.data.item
    expect(itemDone).toMatchObject({ name: 'read', namespace: 'mcp__files__' })
    // 扁平名是对上游的中间表示，绝不能漏给客户端。
    expect(events.map(event => JSON.stringify(event.data)).join('')).not.toContain('mcp__files____read')
  })

  it('上游在流里报错：以 response.failed 收尾（HTTP 已经 200，状态码改不了）', async () => {
    const events = await readSse(chunks([
      { type: 'text-delta', index: 0, text: '半句' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'upstream exploded' } } },
    ]), request)
    const last = events.at(-1)!
    expect(last.event).toBe('response.failed')
    // ⚠️ `code` 必须是官方枚举里的值（`server_error`）：DSH 的内部码（`SERVER`）
    // 会让按 Literal 校验的 SDK 在解析失败事件时抛错，用户看到「客户端崩了」。
    expect(last.data.response).toMatchObject({
      status: 'failed',
      error: { code: 'server_error', message: 'upstream exploded', status: 502, dsh_code: 'SERVER' },
    })
  })

  it('没有 finish 就断流：同样是 response.failed + incomplete_stream', async () => {
    const events = await readSse(chunks([{ type: 'text-delta', index: 0, text: '半句' }]), request)
    const last = events.at(-1)!
    expect(last.event).toBe('response.failed')
    expect(last.data.response.error).toMatchObject({ code: 'server_error', status: 502, dsh_code: 'incomplete_stream' })
  })

  it('只发 block-end（没有 delta）的块不会被丢掉（Chat 路径正是这么丢的）', async () => {
    const events = await readSse(chunks([
      { type: 'block-end', index: 0, block: { type: 'text', text: '只有结束帧' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), request)
    const completed = events.at(-1)!.data.response
    expect(completed.output[0].content[0].text).toBe('只有结束帧')
  })
})
