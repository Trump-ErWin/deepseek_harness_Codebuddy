import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpencodeAdapter } from '../../src/opencode-adapter.js'
import { listIdentitySlots } from '../../src/opencode-auth.js'
import { buildOpencodeRequest } from '../../src/opencode-messages.js'
import { normalizeOpencodeResponse } from '../../src/opencode-stream.js'

const toolNames = ['read', 'shell', 'edit', 'write', 'glob', 'grep']
const tools = toolNames.map((name) => ({ name, description: '客户端工具', parameters: { type: 'object' } }))
const slots = () => listIdentitySlots([{ id: 'anon-a', enabled: true, apiKey: 'public' }, { id: 'anon-b', enabled: true, apiKey: 'public' }], 'opencode/1.18.22')
const frame = (calls: unknown[], finish?: string): unknown => ({ choices: [{ index: 0, delta: { tool_calls: calls }, ...(finish ? { finish_reason: finish } : {}) }] })
const call = (name?: string, args?: string, extra: Record<string, unknown> = {}): unknown => ({ ...extra, function: { ...(name === undefined ? {} : { name }), ...(args === undefined ? {} : { arguments: args }) } })
const sse = (frames: unknown[], done = true): string => frames.map((data) => `data: ${JSON.stringify(data)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')

async function run(frames: unknown[], enabledTools = tools, done = true): Promise<{ chunks: StreamChunk[]; fetchSpy: ReturnType<typeof vi.fn> }> {
  const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response(sse(frames, done), { headers: { 'content-type': 'text/event-stream' } }))
  vi.stubGlobal('fetch', fetchSpy)
  const chunks: StreamChunk[] = []
  const adapter = new OpencodeAdapter({ identitySlots: async () => slots() })
  for await (const chunk of adapter.stream({ provider: 'opencode', model: 'big-pickle', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: enabledTools } as unknown as GenerateOptions)) chunks.push(chunk)
  return { chunks, fetchSpy }
}

afterEach(() => vi.unstubAllGlobals())

describe('OpenCode 专用响应归一', () => {
  it('真实请求发 dsh_ 别名，delta/block-end 都还原原名，stop 归一为 tool-calls', async () => {
    const { chunks, fetchSpy } = await run([
      frame([call('dsh_read', '{"path":', { index: 0, id: 'A' })]),
      frame([call('', '"文件"}', { index: 0 })], 'stop'),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ])
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://opencode.ai/inference/v1/chat/completions')
    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(String(init.body))
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([...toolNames.map((name) => `dsh_${name}`), 'shell', 'read'])
    const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
    expect(deltas.map((chunk) => chunk.argumentsDelta).join('')).toBe('{"path":"文件"}')
    expect(deltas.every((chunk) => chunk.name === 'read')).toBe(true)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-end', block: { type: 'tool-call', id: 'A', name: 'read', arguments: '{"path":"文件"}' } }))
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks.some((chunk) => chunk.type === 'usage')).toBe(true)
  })
  it('跨帧名字 + 参数先到：不泄漏别名，参数不丢不重复', async () => {
    const { chunks } = await run([
      frame([call('dsh_', '{', { id: 'A', index: 0 })]),
      frame([call('re', '"x":1', { index: 0 })]),
      frame([call('ad', '}', { index: 0 })], 'tool_calls'),
    ])
    const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
    expect(deltas.map((chunk) => chunk.argumentsDelta).join('')).toBe('{"x":1}')
    expect(deltas.every((chunk) => chunk.name === 'read')).toBe(true)
  })
  it('短别名是另一别名的前缀时，不提前发错工具名', async () => {
    const clientTools = [{ name: 'read', description: '' }, { name: 'read_1', description: '' }]
    const { chunks } = await run([
      frame([call('dsh_read', '', { id: 'A', index: 0 })]),
      frame([call('_1', '{}', { index: 0 })], 'tool_calls'),
    ], clientTools)
    expect(chunks.filter((chunk) => chunk.type === 'tool-call-delta').map((chunk) => chunk.name)).toEqual(['read_1'])
  })
  it('并行无 index 的调用按 id 归并，迟到 index 不改变下游调用身份', async () => {
    const { chunks } = await run([
      frame([call('dsh_read', '{', { id: 'A' }), call('dsh_edit', '{', { id: 'B' })]),
      frame([call(undefined, '"a":1}', { id: 'A', index: 7 }), call(undefined, '"b":2}', { id: 'B', index: 3 })], 'tool_calls'),
    ])
    const ends = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(ends.map((chunk) => chunk.block)).toEqual([
      { type: 'tool-call', id: 'A', name: 'read', arguments: '{"a":1}' },
      { type: 'tool-call', id: 'B', name: 'edit', arguments: '{"b":2}' },
    ])
  })
  it('无 index 的参数续传进入当前调用，不产生多条工具', async () => {
    const { chunks } = await run([frame([call('dsh_read', '{', { id: 'A' })]), frame([call(undefined, '}')], 'tool_calls')])
    expect(chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toHaveLength(1)
  })
  it('重复完整名字不重复拼接，只有一个客户端调用', async () => {
    const { chunks } = await run([frame([call('dsh_read', '{', { index: 0, id: 'A' })]), frame([call('dsh_read', '}', { index: 0 })], 'tool_calls')])
    expect(chunks.filter((chunk) => chunk.type === 'tool-call-delta').every((chunk) => chunk.name === 'read')).toBe(true)
  })
  it('兼容 legacy function_call 的名字与参数分片', async () => {
    const { chunks } = await run([
      { choices: [{ delta: { function_call: { name: 'dsh_re', arguments: '{' } } }] },
      { choices: [{ delta: { function_call: { name: 'ad', arguments: '}' } }, finish_reason: 'function_call' }] },
    ])
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-end', block: { type: 'tool-call', id: 'call_legacy_0', name: 'read', arguments: '{}' } }))
  })
  it.each(['read', 'shell', 'unknown', 'dsh_unknown'])('拦截保留/未知名字 %s，不换槽不标额度', async (name) => {
    const fetchSpy = vi.fn(async () => new Response(sse([frame([call(name, '{}', { index: 0, id: 'A' })], 'tool_calls')])))
    const mark = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new OpencodeAdapter({ identitySlots: async () => slots(), markLimited: mark })
    const emitted: StreamChunk[] = []
    const drain = async (): Promise<void> => {
      for await (const chunk of adapter.stream({ provider: 'opencode', model: 'big-pickle', messages: [], tools } as unknown as GenerateOptions)) emitted.push(chunk)
    }
    await expect(drain()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(emitted).toEqual([])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(mark).not.toHaveBeenCalled()
  })
  it.each(['finish', 'done', 'eof'])('残缺名称在 %s 路径报错，不发可执行块', async (ending) => {
    const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools })
    const response = new Response(sse([frame([call('dsh_re', '{}', { index: 0, id: 'A' })], ending === 'finish' ? 'stop' : undefined)], ending === 'done'))
    await expect(normalizeOpencodeResponse(response, request).text()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })
  it('没有启用工具时，连 finish_reason:tool_calls 也必须拦截', async () => {
    await expect(run([frame([], 'tool_calls')], [])).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await expect(run([frame([call('dsh_read', '{}', { index: 0 })])], [])).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })
  it('CRLF、多行 data、UTF-8 跨网络块与 EOF 末帧正确改写', async () => {
    const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools })
    const text = 'event: message\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"中文","tool_calls":[{"id":"A","index":0,"function":{"name":"dsh_read","arguments":"{}"}}]},"finish_reason":"stop"}]} '
    const bytes = new TextEncoder().encode(text)
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    } }))
    const normalized = await normalizeOpencodeResponse(response, request).text()
    expect(normalized).toContain('中文')
    expect(normalized).toContain('"name":"read"')
    expect(normalized).not.toContain('dsh_read')
    expect(normalized).toContain('event: message')
  })
  it('名称前缀有歧义时，前帧已经开始的参数也能确定短别名', async () => {
    const clientTools = [{ name: 'read', description: '' }, { name: 'read_1', description: '' }]
    const { chunks } = await run([
      frame([call('dsh_', '{}', { index: 0, id: 'A' })]),
      frame([call('read', undefined, { index: 0 })], 'tool_calls'),
    ], clientTools)
    expect(chunks.filter((chunk) => chunk.type === 'tool-call-delta').map((chunk) => chunk.name)).toEqual(['read'])
  })
  it('前置流逐帧产出，不能等 EOF 才把正文交给消费器', async () => {
    const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools: [] })
    const upstream = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"先到"}}]}\n\n'))
      // 刻意不关闭：首个事件必须现在就可读。
    } }))
    const reader = normalizeOpencodeResponse(upstream, request).body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('先到')
    await reader.cancel()
  })
  it('HTTP 200 裸 JSON 错误不等 EOF 即透传', async () => {
    const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools: [] })
    const upstream = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":{"message":"失败"}}'))
    } }))
    const reader = normalizeOpencodeResponse(upstream, request).body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('失败')
    await reader.cancel()
  })
  it('调用方取消立即透传，不换槽不写额度标记', async () => {
    const controller = new AbortController()
    const reason = new DOMException('主动取消', 'AbortError')
    const mark = vi.fn()
    const fetchSpy = vi.fn(async () => { controller.abort(reason); throw reason })
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new OpencodeAdapter({ identitySlots: async () => slots(), markLimited: mark })
    await expect(adapter.stream({ provider: 'opencode', model: 'big-pickle', messages: [], tools, signal: controller.signal } as unknown as GenerateOptions).next()).rejects.toBe(reason)
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(mark).not.toHaveBeenCalled()
  })
  it('取消前置流会取消上游，不能留后台读取', async () => {
    const cancelled = vi.fn()
    const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools })
    const upstream = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }))
    const response = normalizeOpencodeResponse(upstream, request)
    await response.body!.cancel()
    await Promise.resolve()
    expect(cancelled).toHaveBeenCalledOnce()
  })
})
