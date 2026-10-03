/**
 * Gemini 消息翻译与 SSE 消费器单测。
 *
 * fixture 按**上游真实形状**写（信封 `{"response":{…}}`、thought part、
 * functionCall 带 thoughtSignature、收尾纯 usageMetadata 帧）。
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalArgs,
  consumeGeminiSse,
  mapGeminiFinish,
  readGeminiUsage,
  translateGeminiRequest,
  translateGeminiResponse,
  type GeminiEnvelope,
} from '../../src/gemini-messages.js'
import { geminiModelSpec, GEMINI_SESSION_ID_INFER } from '../../src/gemini.js'
import type { Message } from '@deepseek-ai/dsh-llm'

const msg = (role: 'user' | 'assistant', content: unknown[]): Message =>
  ({ role, content } as Message)

function translate(messages: readonly Message[], extra: Record<string, unknown> = {}): GeminiEnvelope {
  return translateGeminiRequest({
    modelId: 'gemini-3.8-flash',
    spec: geminiModelSpec('gemini-3.8-flash', 'high'),
    messages,
    sessionId: GEMINI_SESSION_ID_INFER,
    requestId: 'agent/1/aaaaaaaa',
    ...extra,
  })
}

/** 把 SSE 文本包成 `ReadableStream`。 */
function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/** 分片喂入（验证跨 chunk 的行缓冲）。 */
function chunkedStream(pieces: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of consumeGeminiSse({ body })) out.push(chunk as Record<string, unknown>)
  return out
}

/** 上游信封帧。 */
function frame(inner: unknown): string {
  return `data: ${JSON.stringify({ response: inner })}\n\n`
}

describe('canonicalArgs', () => {
  it('按键名升序，空表为 {}', () => {
    expect(canonicalArgs({})).toBe('{}')
    expect(canonicalArgs(undefined)).toBe('{}')
    expect(canonicalArgs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('嵌套对象递归排序，数组保序', () => {
    expect(canonicalArgs({ z: { b: 1, a: 2 }, list: [3, 1] })).toBe('{"list":[3,1],"z":{"a":2,"b":1}}')
  })
})

describe('translateGeminiRequest', () => {
  it('system 走 systemInstruction，不进 contents', () => {
    const envelope = translate([msg('user', [{ type: 'text', text: 'hi' }])], { system: '你是助手' })
    expect(envelope.request.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: '你是助手' }],
    })
    expect(envelope.request.contents).toHaveLength(1)
    expect(envelope.request.contents[0]?.role).toBe('user')
  })

  it('assistant → model 角色', () => {
    const envelope = translate([
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [{ type: 'text', text: 'ok' }]),
    ])
    expect(envelope.request.contents.map((content) => content.role)).toEqual(['user', 'model'])
  })

  it('历史 reasoning 不回传（DSH 的思考块不带签名，回传必被拒）', () => {
    const envelope = translate([
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [
        { type: 'reasoning', text: '先看看目录' },
        { type: 'text', text: 'ok' },
      ]),
    ])
    const modelParts = envelope.request.contents[1]?.parts ?? []
    expect(modelParts).toEqual([{ text: 'ok' }])
  })

  it('tool-call 回填签名（查得到才带 thoughtSignature）', () => {
    const messages = [
      msg('user', [{ type: 'text', text: '读文件' }]),
      msg('assistant', [{ type: 'tool-call', id: 't1', name: 'read_file', arguments: '{"path":"a.go"}' }]),
      msg('user', [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'text', text: '内容' }] }]),
    ]
    const withSig = translate(messages, {
      lookupSignature: (name: string, argsJson: string) =>
        name === 'read_file' && argsJson === '{"path":"a.go"}' ? 'SIG_FC' : undefined,
    })
    const callPart = withSig.request.contents[1]?.parts?.[0]
    expect(callPart).toEqual({
      functionCall: { name: 'read_file', args: { path: 'a.go' } },
      thoughtSignature: 'SIG_FC',
    })

    const withoutSig = translate(messages)
    expect(withoutSig.request.contents[1]?.parts?.[0]).toEqual({
      functionCall: { name: 'read_file', args: { path: 'a.go' } },
    })
  })

  it('tool-result → functionResponse，name 从历史 tool-call 回填', () => {
    const envelope = translate([
      msg('user', [{ type: 'text', text: '读文件' }]),
      msg('assistant', [{ type: 'tool-call', id: 't1', name: 'read_file', arguments: '{}' }]),
      msg('user', [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'text', text: '内容' }] }]),
    ])
    expect(envelope.request.contents[2]?.parts?.[0]).toEqual({
      functionResponse: { name: 'read_file', response: { content: '内容' } },
    })
  })

  it('工具结果标记错误时带 error:true', () => {
    const envelope = translate([
      msg('user', [{ type: 'text', text: '读文件' }]),
      msg('assistant', [{ type: 'tool-call', id: 't1', name: 'read_file', arguments: '{}' }]),
      msg('user', [{
        type: 'tool-result',
        toolCallId: 't1',
        isError: true,
        content: [{ type: 'text', text: '打不开' }],
      }]),
    ])
    expect(envelope.request.contents[2]?.parts?.[0]).toEqual({
      functionResponse: { name: 'read_file', response: { content: '打不开', error: true } },
    })
  })

  it('孤儿 tool-result（无配对 tool-call）不下发', () => {
    const envelope = translate([
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('user', [{ type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'x' }] }]),
    ])
    expect(envelope.request.contents).toHaveLength(1)
  })

  it('空内容抛错', () => {
    expect(() => translate([msg('user', [{ type: 'reasoning', text: '只有思考' }])]))
      .toThrowError(/messages 里没有可用内容/)
  })

  it('图片未内联时抛错（不静默丢图）', () => {
    const messages = [msg('user', [
      { type: 'text', text: '看图' },
      { type: 'image', attachment: { attachmentId: 'img-1' } },
    ])]
    expect(() => translate(messages)).toThrowError(/图片未能内联/)
  })

  it('图片已内联时产出 inlineData', () => {
    const messages = [msg('user', [
      { type: 'text', text: '看图' },
      { type: 'image', attachment: { attachmentId: 'img-1' } },
    ])]
    const envelope = translate(messages, {
      images: new Map([['img-1', { mediaType: 'image/png', data: 'AAAA' }]]),
    })
    expect(envelope.request.contents[0]?.parts?.[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'AAAA' },
    })
  })

  it('工具声明走 functionDeclarations 且 schema 已清洗', () => {
    const envelope = translate([msg('user', [{ type: 'text', text: 'hi' }])], {
      tools: [{
        name: 'read_file',
        description: '读文件',
        parameters: { type: 'object', $schema: 'x', properties: { path: { type: 'string' } } },
      }],
    })
    expect(envelope.request.tools).toEqual([{
      functionDeclarations: [{
        name: 'read_file',
        description: '读文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    }])
    expect(envelope.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } })
  })

  it('tool_choice 映射：none → NONE，tool 名 → ANY + allowedFunctionNames', () => {
    const messages = [msg('user', [{ type: 'text', text: 'hi' }])]
    const tools = [{ name: 'read_file', description: '读', parameters: { type: 'object' } }]
    const none = translate(messages, { tools, toolChoice: 'none' })
    expect(none.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } })

    const any = translate(messages, { tools, toolChoice: { type: 'tool', name: 'read_file' } })
    expect(any.request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] },
    })
  })
})

describe('响应翻译', () => {
  it('functionCall → tool-call 块并回调签名；thought text → reasoning 块', () => {
    const signatures: Array<[string, string, string]> = []
    const translated = translateGeminiResponse({
      response: {
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { text: '先看看目录', thought: true, thoughtSignature: 'SIG_A' },
              { functionCall: { name: 'read_file', args: { path: 'a.go' } }, thoughtSignature: 'SIG_FC' },
            ],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 30, totalTokenCount: 180, cachedContentTokenCount: 20 },
      },
      onSignature: (name, argsJson, signature) => signatures.push([name, argsJson, signature]),
    })
    expect(translated.blocks[0]).toEqual({ type: 'reasoning', text: '先看看目录' })
    const call = translated.blocks[1] as { type: string; name: string; arguments: string }
    expect(call.type).toBe('tool-call')
    expect(call.name).toBe('read_file')
    expect(call.arguments).toBe('{"path":"a.go"}')
    // ⚠️ 只存 functionCall 上的签名（纯文本 part 的签名不回传，存了是噪音）。
    expect(signatures).toEqual([['read_file', '{"path":"a.go"}', 'SIG_FC']])
    expect(translated.reason).toEqual({ kind: 'tool-calls' })
    expect(translated.usage).toEqual({
      inputTokens: 80,
      cacheReadTokens: 20,
      outputTokens: 50,
      totalTokens: 180,
      reasoningTokens: 30,
    })
  })

  it('纯文本响应', () => {
    const translated = translateGeminiResponse({
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      },
    })
    expect(translated.blocks).toEqual([{ type: 'text', text: 'ok' }])
    expect(translated.reason).toEqual({ kind: 'stop' })
  })

  it('finishReason 映射', () => {
    expect(mapGeminiFinish('MAX_TOKENS', 0)).toEqual({ kind: 'max-tokens' })
    expect(mapGeminiFinish('STOP', 0)).toEqual({ kind: 'stop' })
    expect(mapGeminiFinish('SOMETHING_NEW', 0)).toEqual({ kind: 'stop' })
    expect(mapGeminiFinish('STOP', 2)).toEqual({ kind: 'tool-calls' })
  })

  it('usage 扣掉缓存（promptTokenCount 含缓存，不减会双重计费）', () => {
    // 缺字段时**不产出 undefined 键**（下游按「缺省即未知」处理）。
    expect(readGeminiUsage({ promptTokenCount: 10, cachedContentTokenCount: 25 })).toEqual({
      inputTokens: 0,
      cacheReadTokens: 25,
    })
    expect(readGeminiUsage(undefined)).toEqual({})
  })
})

describe('SSE 消费器', () => {
  it('思考 → 文本 → 工具调用，块序号连续', async () => {
    const chunks = await collect(sseStream(
      frame({ candidates: [{ content: { parts: [{ text: '先看看目录', thought: true, thoughtSignature: 'SIG_A' }] } }] }) +
      frame({ candidates: [{ content: { parts: [{ text: '继续', thought: true }] } }] }) +
      frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.go' } }, thoughtSignature: 'SIG_FC' }] } }] }) +
      frame({ candidates: [{ content: { parts: [{ text: '完成' }] }, finishReason: 'STOP' }] }) +
      frame({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 13 } }) +
      'data: [DONE]\n\n',
    ))
    const types = chunks.map((chunk) => chunk.type)
    expect(types).toContain('block-start')
    expect(types).toContain('reasoning-delta')
    expect(types).toContain('text-delta')
    expect(types).toContain('tool-call-delta')
    expect(types.at(-1)).toBe('finish')

    const starts = chunks.filter((chunk) => chunk.type === 'block-start')
    expect(starts.map((chunk) => chunk.index)).toEqual([0, 1, 2])
    expect(starts.map((chunk) => chunk.blockType)).toEqual(['reasoning', 'tool-call', 'text'])

    const finish = chunks.at(-1) as { reason: unknown }
    expect(finish.reason).toEqual({ kind: 'tool-calls' })
  })

  it('签名回调只对 functionCall 触发', async () => {
    const signatures: Array<[string, string, string]> = []
    for await (const _chunk of consumeGeminiSse({
      body: sseStream(
        frame({ candidates: [{ content: { parts: [{ text: '想', thought: true, thoughtSignature: 'SIG_TEXT' }] } }] }) +
        frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} }, thoughtSignature: 'SIG_FC' }] }, finishReason: 'STOP' }] }) +
        'data: [DONE]\n\n',
      ),
      onSignature: (name, argsJson, signature) => signatures.push([name, argsJson, signature]),
    })) {
      void _chunk
    }
    expect(signatures).toEqual([['f', '{}', 'SIG_FC']])
  })

  it('用量取 totalTokenCount 最大的那一份（收尾帧可能只有 usageMetadata）', async () => {
    const chunks = await collect(sseStream(
      frame({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 5, promptTokenCount: 3, candidatesTokenCount: 2 } }) +
      frame({ usageMetadata: { totalTokenCount: 13, promptTokenCount: 7, candidatesTokenCount: 4, thoughtsTokenCount: 2 } }) +
      'data: [DONE]\n\n',
    ))
    const usage = chunks.find((chunk) => chunk.type === 'usage') as { usage: Record<string, number> }
    expect(usage.usage.totalTokens).toBe(13)
    expect(usage.usage.outputTokens).toBe(4)
    expect(usage.usage.reasoningTokens).toBe(2)
  })

  it('跨 chunk 切分的行也能正确解析（末帧不丢）', async () => {
    const chunks = await collect(chunkedStream([
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},',
      '"finishReason":"STOP"}]}}\n\ndata: {"response":{"usageMetadata":{"totalTokenCount":9}}}\n\n',
    ]))
    const finish = chunks.at(-1) as { reason: unknown }
    expect(finish.reason).toEqual({ kind: 'stop' })
    expect((chunks.find((chunk) => chunk.type === 'usage') as { usage: { totalTokens: number } }).usage.totalTokens).toBe(9)
  })

  it('心跳注释行被跳过', async () => {
    const chunks = await collect(sseStream(
      ': keep-alive\n\n' +
      frame({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }) +
      'data: [DONE]\n\n',
    ))
    expect((chunks.at(-1) as { reason: unknown }).reason).toEqual({ kind: 'stop' })
  })

  it('空响应抛错（静默结束会让 harness 不重试）', async () => {
    await expect(collect(sseStream('data: [DONE]\n\n'))).rejects.toThrowError(/未返回任何内容块/)
  })
})
