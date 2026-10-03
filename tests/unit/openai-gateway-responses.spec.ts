import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpenAiGatewayError } from '../../src/openai-gateway/messages.js'
import {
  collectResponsesResult,
  responsesMaxOutputTokens,
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
      ['top_p', { model: 'qoder/qfmodel', input: 'hi', top_p: 0.5 }],
      ['item_reference', { model: 'qoder/qfmodel', input: [{ type: 'item_reference', id: 'msg_1' }] }],
      ['web_search 工具', { model: 'qoder/qfmodel', input: 'hi', tools: [{ type: 'web_search' }] }],
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
