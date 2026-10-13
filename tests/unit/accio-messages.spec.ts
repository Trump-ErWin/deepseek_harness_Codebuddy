/**
 * Accio 协议层单测：**帧归一化**（Accio 顶层 → 标准 Gemini `candidates`）
 * 与消息 / 工具序列化。
 *
 * ## 守的是什么
 *
 * 本模块存在的**唯一理由**是两种帧形状的差异（见 agent-notes §4.1 / §4.4）：
 *
 * | | Accio | 标准 Gemini |
 * |---|---|---|
 * | 帧 | `{content:{parts}, usage_metadata, partial}` ← **顶层** | `{candidates:[{content}], usageMetadata}` |
 * | 工具 | `parts[].function_call`（snake） | `parts[].functionCall`（camel） |
 *
 * ⚠️ **`consumeGeminiSse` 不接受「帧变换」回调**（它对每帧自己 `JSON.parse`），
 * 所以归一化必须在 `consumeAccioSse` 的 `TransformStream` 里**流式**完成 ——
 * 故下面第三段**真的驱动整条流**，而不是只测纯函数。漏测这一段的代价是：
 * 纯函数全绿、而接线上游帧仍进不去共享消费器（表现为「模型没返回任何内容块」）。
 *
 * ⚠️ 反向验证要求：让 `normalizeAccioFrame` 恒返回 `frame`（= 去掉归一化）
 * 必须让本文件变红 —— 若不会，说明这里的断言全是同义反复。
 */
import { describe, expect, it } from 'vitest'
import {
  consumeAccioSse,
  normalizeAccioFrame,
  toAccioTools,
  serializeAccioMessages,
} from '../../src/accio-messages.js'

describe('normalizeAccioFrame —— Accio 顶层帧 → 标准 Gemini candidates', () => {
  it('⚠️ content 在顶层（不包 candidates）⇒ 必须包一层，否则 consumeGeminiSse 命中不了', () => {
    const raw = { content: { role: 'model', parts: [{ text: 'hi' }] }, partial: true }
    const out = normalizeAccioFrame(raw) as Record<string, unknown>
    expect(Array.isArray(out.candidates)).toBe(true)
    const cands = out.candidates as Array<Record<string, unknown>>
    expect(cands[0]?.content).toEqual({ role: 'model', parts: [{ text: 'hi' }] })
  })

  it('⚠️ usage_metadata（snake）→ usageMetadata（camel）', () => {
    const raw = {
      content: { parts: [{ text: 'x' }] },
      usage_metadata: { prompt_token_count: 3, candidates_token_count: 5, total_token_count: 8 },
    }
    const out = normalizeAccioFrame(raw) as Record<string, unknown>
    expect(out.usageMetadata).toEqual({
      promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8,
    })
  })

  it('thought 标记原样保留（由 consumeGeminiSse 映射到 reasoning）', () => {
    const raw = { content: { parts: [{ text: 'why', thought: true }] } }
    const out = normalizeAccioFrame(raw) as Record<string, unknown>
    const parts = ((out.candidates as any[])[0].content.parts) as any[]
    expect(parts[0].thought).toBe(true)
  })

  it('🔴 空/无效帧返回 undefined（不能包成空 candidates，那会让消费侧以为有内容）', () => {
    expect(normalizeAccioFrame(undefined)).toBeUndefined()
    expect(normalizeAccioFrame(null)).toBeUndefined()
    expect(normalizeAccioFrame('nope')).toBeUndefined()
    expect(normalizeAccioFrame({})).toBeUndefined()
    expect(normalizeAccioFrame({ content: null })).toBeUndefined()
  })

  it('已有 candidates 的帧原样透传（容忍上游某天改成标准形状）', () => {
    const raw = { candidates: [{ content: { parts: [{ text: 'a' }] } }] }
    expect(normalizeAccioFrame(raw)).toBe(raw)
  })

  // ⚠️ 下面三条锁的是**差异表的第二行**（brief 的测试漏了它、实现初版也漏了它）：
  // `parts[].function_call`（snake，参数是 `args_json` **字符串**）→
  // `parts[].functionCall`（camel，参数是 `args` **对象**）。
  // 漏掉的运行时后果不是「参数丢了」而是**整帧被当纯 usageMetadata 帧**，
  // `consumeGeminiSse` 于是判定「模型未返回任何内容块」并抛错。
  describe('⚠️ part 级：function_call（snake）→ functionCall（camel）', () => {
    it('args_json 字符串被解析成 args 对象（消费器的契约是对象）', () => {
      const raw = {
        content: {
          role: 'model',
          parts: [{ function_call: { id: 'c1', name: 'read_file', args_json: '{"path":"a"}' } }],
        },
      }
      const out = normalizeAccioFrame(raw) as Record<string, unknown>
      const parts = ((out.candidates as any[])[0].content.parts) as any[]
      expect(parts).toEqual([{ functionCall: { name: 'read_file', args: { path: 'a' } } }])
    })

    it('🔴 无 name 的调用整块丢弃（不能产出无名工具调用）', () => {
      const raw = { content: { parts: [{ function_call: { args_json: '{}' } }] } }
      const out = normalizeAccioFrame(raw) as Record<string, unknown>
      const parts = ((out.candidates as any[])[0].content.parts) as any[]
      expect(parts).toEqual([])
    })

    it('text / thought part 原样保留（归一化不得吃掉正文与思考标记）', () => {
      const raw = { content: { parts: [{ text: 'why', thought: true }, { text: '正文' }] } }
      const out = normalizeAccioFrame(raw) as Record<string, unknown>
      const parts = ((out.candidates as any[])[0].content.parts) as any[]
      expect(parts).toEqual([{ text: 'why', thought: true }, { text: '正文' }])
    })

    it('⚠️ args_json 不是合法 JSON 时回退空对象（不抛错，不让整轮失败）', () => {
      const raw = {
        content: { parts: [{ function_call: { id: 'c1', name: 'f', args_json: 'NOT JSON' } }] },
      }
      const out = normalizeAccioFrame(raw) as any
      expect(out.candidates[0].content.parts[0].functionCall.args).toEqual({})
    })
  })

  // ⚠️⚠️ 2026-10-13 真实缺陷（用户报障「accio 思考一下就中断」的根因）：
  // 旧判据「无 content 一律 return undefined」把三类**有语义**的帧整帧丢弃 ——
  // 顶层 function_call（task-6-report 逐字记录的真实形状，不带 content）、
  // 终帧的 usage_metadata / finish_reason（工具轮次的终帧只有它们没有正文）。
  // 运行时后果：模型思考完决定调工具 → 工具帧被丢 → 流里只剩思考 → 兜底 stop
  // → 「思考一下就中断、无正文无工具、轮次显示正常完成」，且 usage 恒归零。
  // 实测证据：session 35b01df3（accio/deepseek-v4-1-flash）13 轮静默 stop，
  // 每轮思考结尾都是工具意图（"Let me call get_goal."）。
  describe('⚠️⚠️ 无 content 但有语义的帧不得丢弃（2026-10-13 静默 stop 根因）', () => {
    it('🔴 顶层 function_call（无 content 信封）⇒ 包成 candidates[0].content.parts（snake→camel）', () => {
      const raw = { function_call: { id: 'call_c3a3', name: 'read_file' } }
      const out = normalizeAccioFrame(raw) as any
      expect(Array.isArray(out?.candidates)).toBe(true)
      const parts = out.candidates[0].content.parts as any[]
      expect(parts[0].functionCall).toEqual({ name: 'read_file', args: {} })
    })

    it('🔴 顶层 function_call 带 args_json 字符串 ⇒ 解析成 args 对象', () => {
      const raw = { function_call: { id: 'c1', name: 'f', args_json: '{"path":"a"}' } }
      const out = normalizeAccioFrame(raw) as any
      expect(out.candidates[0].content.parts[0].functionCall.args).toEqual({ path: 'a' })
    })

    it('🔴 无 content 的终帧：finish_reason + usage_metadata 都必须保住', () => {
      const raw = {
        turn_complete: true,
        finish_reason: 'MAX_TOKENS',
        usage_metadata: { prompt_token_count: 10, candidates_token_count: 7, total_token_count: 17 },
      }
      const out = normalizeAccioFrame(raw) as any
      // finish 必须挂在**非空** candidate 上（空 candidates 在读 finishReason 前就 return）
      expect(out.candidates[0].finishReason).toBe('MAX_TOKENS')
      expect(out.usageMetadata).toEqual({ promptTokenCount: 10, candidatesTokenCount: 7, totalTokenCount: 17 })
    })

    it('🔴 纯 usage 帧（无 finish）⇒ 空 candidates + usageMetadata（消费侧只记用量不算内容）', () => {
      const raw = { usage_metadata: { prompt_token_count: 3, total_token_count: 5 } }
      const out = normalizeAccioFrame(raw) as any
      expect(out.candidates).toEqual([])
      expect(out.usageMetadata).toEqual({ promptTokenCount: 3, totalTokenCount: 5 })
    })

    it('🔴 无 content 且无任何语义字段 ⇒ 仍返回 undefined（真无用帧不编造）', () => {
      expect(normalizeAccioFrame({ turn_complete: true })).toBeUndefined()
      expect(normalizeAccioFrame({ partial: true })).toBeUndefined()
    })

    it('🔴 顶层 function_call 无 name ⇒ 仍丢弃（与 content.parts 内的判据同口径）', () => {
      expect(normalizeAccioFrame({ function_call: { args_json: '{}' } })).toBeUndefined()
    })
  })
})

describe('serializeAccioMessages', () => {
  it('system 抽到 systemInstruction，其余进 contents', () => {
    const out = serializeAccioMessages([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ])
    expect(out.systemInstruction).toBe('你是助手')
    expect(out.contents).toEqual([{ role: 'user', parts: [{ text: '你好' }] }])
  })

  it('⚠️ assistant → role: "model"，tool_calls → functionCall(argsJson 是字符串)', () => {
    const out = serializeAccioMessages([
      {
        role: 'assistant',
        content: '让我看看',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a"}' },
        }],
      },
    ])
    expect(out.contents).toEqual([{
      role: 'model',
      parts: [
        { text: '让我看看' },
        { functionCall: { id: 'c1', name: 'read_file', argsJson: '{"path":"a"}' } },
      ],
    }])
  })

  it('⚠️ 工具结果（role:tool）→ user + functionResponse(id/name/responseJson)', () => {
    const out = serializeAccioMessages([
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: '{"ok":true}' },
    ])
    expect(out.contents).toEqual([{
      role: 'user',
      parts: [{ functionResponse: { id: 'c1', name: 'read_file', responseJson: '{"ok":true}' } }],
    }])
  })

  it('content 为数组时只取 text 块（图片本轮不发：见 ACCIO_IMAGE_PIXEL_BUDGET 注释）', () => {
    const out = serializeAccioMessages([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ])
    expect(out.contents).toEqual([{ role: 'user', parts: [{ text: 'ab' }] }])
  })

  it('空内容不产出空 parts 条目', () => {
    expect(serializeAccioMessages([{ role: 'user', content: '' }]).contents).toEqual([])
    expect(serializeAccioMessages([]).contents).toEqual([])
  })
})

describe('toAccioTools', () => {
  it('OpenAI 工具定义 → { name, description, parametersJson }', () => {
    const out = toAccioTools([{
      type: 'function',
      function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } },
    }])
    expect(out).toEqual([{
      name: 'read_file', description: '读文件', parametersJson: '{"type":"object","properties":{}}',
    }])
  })

  it('空/非法输入返回 undefined（不产出空数组）', () => {
    expect(toAccioTools([])).toBeUndefined()
    expect(toAccioTools([{ type: 'function' }])).toBeUndefined()
  })
})

/** 把若干 SSE 文本行做成一个 ReadableStream（模拟上游响应体）。 */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line))
      controller.close()
    },
  })
}

/**
 * 与 {@link sseStream} 同形，但**额外**把 `consumeAccioSse` 改写层的产物也交出来。
 *
 * ## 为什么需要这个缝
 *
 * `consumeGeminiSse` 的 `consumeSseLine` 会**跳过** `:`（注释心跳）与 `event:`
 * 行 —— 于是「改写层把非 data 行丢了」这个缺陷在消费侧**完全观测不到**
 * （实测：删掉透传分支，只断言正文的版本照样全绿）。要真正锁住「非 data 行原样
 * 发回」，只能直接看改写层的字节。
 *
 * 做法：拦下 `pipeThrough`，用 `tee()` 把改写结果**分流一份**给检查用，
 * 另一份照常交给消费器。`pipeTo` 的 rejection 与检查流的读取都**吞掉异常**
 * （错误帧用例会让它们 reject，而那不是本缝要断言的东西）。
 *
 * @returns `body` 交给 `consumeAccioSse`；`rewritten` 解析为改写层产出的全部文本。
 */
function tapRewrittenBody(lines: string[]): {
  body: ReadableStream<Uint8Array>
  rewritten: Promise<string>
} {
  const source = sseStream(lines)
  let resolveRewritten: (text: string) => void = () => {}
  const rewritten = new Promise<string>((resolve) => { resolveRewritten = resolve })
  const body = {
    pipeThrough(ts: TransformStream<Uint8Array, Uint8Array>): ReadableStream<Uint8Array> {
      const [forConsumer, forInspection] = ts.readable.tee()
      source.pipeTo(ts.writable).catch(() => {})
      void (async () => {
        const decoder = new TextDecoder()
        let text = ''
        const reader = forInspection.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            text += decoder.decode(value, { stream: true })
          }
        } catch {
          // 改写层抛错（错误帧用例）：已收到的部分照样交出去。
        }
        resolveRewritten(text + decoder.decode())
      })()
      return forConsumer
    },
  } as unknown as ReadableStream<Uint8Array>
  return { body, rewritten }
}

describe('consumeAccioSse —— 归一化后交给共享消费器', () => {
  it('thinking 与正文各自成块（thought 不得混入正文）', async () => {
    const chunks = []
    for await (const c of consumeAccioSse({
      body: sseStream([
        'data: {"content":{"role":"model","parts":[{"text":"想想","thought":true}]},"partial":true}\n',
        'data: {"content":{"role":"model","parts":[{"text":"你好"}]}}\n',
        'data: [DONE]\n',
      ]),
    })) chunks.push(c)

    const kinds = chunks.filter((c) => c.type === 'block-start').map((c) => c.blockType)
    expect(kinds).toEqual(['reasoning', 'text'])

    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    expect(reasoning).toBe('想想')
    expect(text).toBe('你好')          // ⚠️ 正文里绝不能出现思维链
  })

  it('工具调用产出 tool-call 块，参数是完整 JSON 串', async () => {
    const chunks = []
    for await (const c of consumeAccioSse({
      body: sseStream([
        'data: {"content":{"role":"model","parts":[{"function_call":{"id":"c1","name":"read_file","args_json":"{\\"path\\":\\"a\\"}"}}]}}\n',
        'data: [DONE]\n',
      ]),
    })) chunks.push(c)

    const call = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(call).toBeDefined()
    expect(call.block.name).toBe('read_file')
    expect(JSON.parse(call.block.arguments)).toEqual({ path: 'a' })
  })

  it('usage_metadata 的 snake 字段被认出来（取最大 total）', async () => {
    const chunks = []
    for await (const c of consumeAccioSse({
      body: sseStream([
        'data: {"content":{"parts":[{"text":"a"}]},"usage_metadata":{"prompt_token_count":3,"candidates_token_count":1,"total_token_count":4}}\n',
        'data: {"content":{"parts":[{"text":"b"}]},"usage_metadata":{"prompt_token_count":3,"candidates_token_count":9,"total_token_count":12}}\n',
        'data: [DONE]\n',
      ]),
    })) chunks.push(c)

    const usage = chunks.find((c) => c.type === 'usage')
    expect(usage).toBeDefined()
    expect(usage.usage.outputTokens).toBe(9)   // 取 total 最大的那一份
  })

  it('🔴 空流必须抛错（静默结束 harness 不会重试）', async () => {
    const drain = async () => {
      for await (const _ of consumeAccioSse({ body: sseStream(['data: [DONE]\n']) })) { /* drain */ }
    }
    await expect(drain()).rejects.toThrow()
  })

  // ⚠️ 下面三条锁的是**流内错误帧**（HTTP 200 + `error_code`）。这类帧**没有
  // `content`** ⇒ `normalizeAccioFrame` 恒返回 `undefined` ⇒ 若判据缺失，整帧会被
  // `continue` 丢掉，最终由共享消费器抛 `gemini: 模型未返回任何内容块` ——
  // 用户看到「模型没返回内容」而不是「额度/认证失败」（agent-notes §4.3 记的
  // 那条误导性症状）。实测报文见 agent-notes §4.2 的第 2/4 格。
  it('🔴 流内 error_code:402 必须抛额度错误（不能退化成「没返回内容」）', async () => {
    const drain = async () => {
      for await (const _ of consumeAccioSse({
        body: sseStream(['data: {"turn_complete":true,"error_code":"402","error_message":"unauthorized"}\n']),
      })) { /* drain */ }
    }
    await expect(drain()).rejects.toThrow(/402|unauthorized|QUOTA/i)
  })

  it('error_code:200 是成功哨兵，不得抛错', async () => {
    const chunks = []
    for await (const c of consumeAccioSse({
      body: sseStream([
        'data: {"error_code":"200","content":{"parts":[{"text":"ok"}]}}\n',
        'data: [DONE]\n',
      ]),
    })) chunks.push(c)
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('ok')
  })

  it('⚠️ 其它非 200 的 error_code 也必须抛，且逐字带上服务端原文', async () => {
    const drain = async () => {
      for await (const _ of consumeAccioSse({
        body: sseStream(['data: {"error_code":"500","error_message":"internal boom"}\n']),
      })) { /* drain */ }
    }
    // ⚠️ 断言服务端原文**逐字**在 message 里：本仓库铁律是绝不丢服务端原文
    //（丢了就只能靠猜，排障成本极高）。
    await expect(drain()).rejects.toThrow(/500/)
    await expect(drain()).rejects.toThrow(/internal boom/)
  })

  it('⚠️ 注释行心跳与非 data 行不炸（跨 chunk 切分的帧也要还原）', async () => {
    const { body, rewritten } = tapRewrittenBody([
      // ⚠️ 故意把一个 data: 行**切成两块**，验证 TransformStream 的缓冲
      ': keep-alive\n',
      'event: ping\n',
      'data: {"content":{"parts":[{"te',
      'xt":"拼起来"}]}}\n',
      'data: [DONE]\n',
    ])
    const chunks = []
    for await (const c of consumeAccioSse({ body })) chunks.push(c)

    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('拼起来')
    // ⚠️ 光断言正文**锁不住非 data 行的透传**：`consumeGeminiSse` 的
    // `consumeSseLine` 会跳过 `:` 与 `event:` 行，所以「改写层把这两行丢了」
    // 在消费侧完全观测不到（实测：删掉透传分支，只断言正文的版本照样全绿）。
    // 故这里直接断言**改写层的产物**里含这两行。
    // ⚠️ 措辞如实：改写层会裁掉行尾的 `\r`，所以是「原样发回」而非「逐字透传」。
    expect(await rewritten).toContain(': keep-alive')
    expect(await rewritten).toContain('event: ping')
  })

  // ⚠️⚠️ 2026-10-13 真实缺陷的**端到端**回归（session 35b01df3 的真实形状）：
  // 思考（content.parts 里的 thought）→ 顶层 function_call 分片（**无 content 信封**，
  // task-6-report 逐字记录的 frame#8/#9/#10 形状）→ 无 content 的终帧。
  // 修复前：工具帧与终帧全被归一化层丢弃 ⇒ 流里只剩思考 ⇒ 兜底 stop ⇒
  // 「思考一下就中断」，usage 全零、无工具调用、轮次显示正常完成。
  // ⚠️ 走**完整管线**（先 accioToolCallMergeTransform 合并、再归一化消费）：
  // 顶层 function_call 分片必须被合并成恰好一个调用 —— 只测归一化层会看到
  // 2 个块（合并不在那一层），那不是真实链路。
  it('🔴 端到端：思考 → 顶层 function_call 分片 → 终帧 ⇒ 必须产出工具调用 + 真实 usage + tool-calls 收尾', async () => {
    const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
    const merged = sseStream([
      'data: {"content":{"role":"model","parts":[{"text":"Let me call get_goal.","thought":true}]},"partial":true}\n',
      'data: {"function_call":{"id":"call_c3a3","name":"get_goal"}}\n',
      'data: {"function_call":{"id":"call_c3a3","name":"get_goal","args_json":"{}"}}\n',
      'data: {"turn_complete":true,"finish_reason":"stop","usage_metadata":{"prompt_token_count":100,"candidates_token_count":50,"thoughts_token_count":30,"total_token_count":150}}\n',
      'data: [DONE]\n',
    ]).pipeThrough(accioToolCallMergeTransform())
    const chunks = []
    for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)

    // 思考块必须在（不被工具帧吞掉）
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
    expect(reasoning).toBe('Let me call get_goal.')
    // 工具调用必须在，且分片合并成**恰好一个**块
    const calls = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(calls.length).toBe(1)
    expect((calls[0]!.block as { name: string }).name).toBe('get_goal')
    // 终帧的 usage 必须真实到达（修复前恒为 {0,0}）
    const usage = chunks.find((c) => c.type === 'usage')
    expect(usage?.usage.inputTokens).toBe(100)
    expect(usage?.usage.outputTokens).toBe(50)
    expect(usage?.usage.reasoningTokens).toBe(30)
    // finish 必须是 tool-calls（修复前是兜底 stop）
    const finish = chunks.find((c) => c.type === 'finish')
    expect((finish as { reason?: { kind?: string } })?.reason?.kind).toBe('tool-calls')
  })

  it('🔴 端到端：无 content 的 MAX_TOKENS 终帧 ⇒ finish 必须是 max-tokens（不得伪装成 stop）', async () => {
    const chunks = []
    for await (const c of consumeAccioSse({
      body: sseStream([
        'data: {"content":{"role":"model","parts":[{"text":"想想","thought":true}]},"partial":true}\n',
        'data: {"turn_complete":true,"finish_reason":"MAX_TOKENS","usage_metadata":{"prompt_token_count":10,"candidates_token_count":64,"total_token_count":74}}\n',
        'data: [DONE]\n',
      ]),
    })) chunks.push(c)

    const finish = chunks.find((c) => c.type === 'finish')
    expect((finish as { reason?: { kind?: string } })?.reason?.kind).toBe('max-tokens')
  })

  // ⚠️⚠️ 2026-10-13 深夜 wire 探针定罪的**双重丢失**（第一轮修复后仍复发的那条）：
  //
  // 上游真实形状（probe-wire-frames 抓的 frame#13/#14）：终帧把**最后一个
  // function_call 分片**与 `turn_complete`/`usage_metadata`/`finish_reason` 放在
  // **同一帧**，且整条流**没有 `[DONE]`**。两处缺陷叠加：
  //
  // 1. **合并层吞元数据**：`accioToolCallMergeTransform` 把带 function_call 的
  //    终帧吸收进 pending 缓冲，flush 只吐工具 part ⇒ usage/finish 丢失；
  // 2. **归一化层 flush 裸透尾行**：合并层 flush 产物**不带尾换行** ⇒
  //    `consumeAccioSse` 的 transform 把它留在 buffer ⇒ flush 原样吐出
  //    **未归一化**的顶层帧 ⇒ `consumeGeminiSse` 当纯 usageMetadata 帧 ⇒
  //    工具调用/usage/finish 全丢。
  //
  // 复合症状 = 用户报障「思考一下就中断」：思考正常、无工具调用、usage 全零、
  // finish 兜底 stop、轮次显示正常完成。
  describe('⚠️⚠️ 终帧与最后一个工具分片同帧 + 流无 [DONE]（wire 实测形状）', () => {
    /** 复刻 wire 探针抓到的真实帧序列（截短 raw_response_json）。 */
    const realWireLines = [
      'data: {"content":{"role":"model","parts":[{"text":"Use","thought":true}]},"partial":true}\n',
      'data: {"content":{"role":"model","parts":[{"text":" the","thought":true}]},"partial":true}\n',
      'data: {"content":{"role":"model","parts":[{"text":" tool.","thought":true}]},"partial":true}\n',
      'data: {"content":{"role":"model","parts":[{"function_call":{"id":"call_00","name":"get_current_time"}}]},"partial":true}\n',
      // ⚠️ 终帧：最后一个分片 + 元数据同帧，且**没有后续 [DONE]**（真实流如此）
      'data: {"content":{"role":"model","parts":[{"function_call":{"id":"call_00","name":"get_current_time","args_json":"{}"}}]},"turn_complete":true,"usage_metadata":{"prompt_token_count":301,"candidates_token_count":36,"total_token_count":337,"thoughts_token_count":13},"finish_reason":"STOP"}\n',
    ]

    it('🔴 完整管线：工具调用 + 真实 usage + tool-calls 收尾（终帧元数据不得被合并缓冲吞掉）', async () => {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream(realWireLines).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)

      const calls = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
      expect(calls.length).toBe(1)
      expect((calls[0]!.block as { name: string }).name).toBe('get_current_time')
      const usage = chunks.find((c) => c.type === 'usage')
      expect(usage?.usage.inputTokens).toBe(301)
      expect(usage?.usage.outputTokens).toBe(36)
      expect(usage?.usage.reasoningTokens).toBe(13)
      const finish = chunks.find((c) => c.type === 'finish')
      expect((finish as { reason?: { kind?: string } })?.reason?.kind).toBe('tool-calls')
    })

    it('🔴 归一化层 flush 不得裸透尾行（无 [DONE] 的流，尾行必须照常归一化）', async () => {
      // 不走合并层，直接喂归一化层：终帧是**最后一行且无尾换行**，
      // transform 会把它留在 buffer —— flush 必须对它跑同一条归一化路径。
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(
            'data: {"content":{"role":"model","parts":[{"text":"想想","thought":true}]},"partial":true}\n'
            // ⚠️ 无换行结尾：模拟合并层 flush 产物 / 上游不带 [DONE] 的收尾
            + 'data: {"content":{"role":"model"},"turn_complete":true,"usage_metadata":{"prompt_token_count":5,"candidates_token_count":2,"total_token_count":7},"finish_reason":"STOP"}',
          ))
          controller.close()
        },
      })
      const chunks = []
      for await (const c of consumeAccioSse({ body })) chunks.push(c)

      const usage = chunks.find((c) => c.type === 'usage')
      expect(usage?.usage.inputTokens).toBe(5)
      expect(usage?.usage.outputTokens).toBe(2)
      const finish = chunks.find((c) => c.type === 'finish')
      expect((finish as { reason?: { kind?: string } })?.reason?.kind).toBe('stop')
    })
  })
})
