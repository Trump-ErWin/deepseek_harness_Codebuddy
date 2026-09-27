import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  QoderAdapter,
  QODER_QUEUE_MAX_ATTEMPTS,
  parseQoderQueueError,
  qoderQueueDelayMs,
} from '../../src/qoder-adapter.js'
import { QODER } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/qoder.js'

/** 源码级断言的路径基准（与 `jet-hub-rpc.spec.ts` 同款）。 */
const here = dirname(fileURLToPath(import.meta.url))

const cred: QoderCredential = buildQoderCredential(
  // ⚠️ `uid` 是**加密推理必需**的（`generate_runtime_auth_fields` 用它派生
  // `encrypt_user_info`）；缺了 WASM 会挂起。真实值来自设备码响应的 `user_id`。
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
  { machineId: 'm-1' })

/** 构造适配器（默认注入可用凭据与 noop refresh）。 */
function makeAdapter(overrides: Partial<ConstructorParameters<typeof QoderAdapter>[0]> = {}): QoderAdapter {
  return new QoderAdapter({
    credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
    resolveCredential: async () => cred,
    refresh: async () => {},
    product: QODER,
    ...overrides,
  })
}

/** 一段标准 OpenAI 正文帧。 */
function textFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })
}

/** 一段标准 OpenAI 结束帧。 */
const finishFrame = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })

/**
 * 构造**加密端点风格**的信封 SSE 响应。
 *
 * 真实形态（实测）：每帧多一层 `{headers, body, statusCode}` 包装，
 * 内层 `body` 是标准 OpenAI chunk 的 **JSON 字符串**（未加密）。
 */
function envelopeResponse(frames: string[]): Response {
  const body = frames
    .map((inner) => `data:${JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body: inner,
      statusCodeValue: 200,
      statusCode: 'OK',
    })}\n\n`)
    .join('')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收集一次 stream 的全部 chunk。 */
async function collect(adapter: QoderAdapter, model = 'auto'): Promise<Array<Record<string, unknown>>> {
  return collectWith(adapter, {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
}

/** 用**自定义 options** 收集一次 stream 的全部 chunk。 */
async function collectWith(
  adapter: QoderAdapter,
  options: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream(options as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('QoderAdapter 模型目录', () => {
  it('listModels 返回兜底表（本插件不发远端请求）', async () => {
    const models = await makeAdapter().listModels('qoder')
    expect(models.length).toBe(QODER.fallbackModels.length)
    expect(models.some((m) => m.id === 'auto')).toBe(true)
    expect(models.every((m) => m.provider === 'qoder')).toBe(true)
  })

  it('listModels 应用 Jet Hub 黑名单', async () => {
    const adapter = makeAdapter({
      accountPool: { disabledModelsFor: () => new Set(['auto']) } as never,
    })
    const models = await adapter.listModels('qoder')
    expect(models.some((m) => m.id === 'auto')).toBe(false)
    expect(models.some((m) => m.id === 'dmodel')).toBe(true)
  })

  // 目录门控：没有已登录账号时不显示该 provider 的任何模型。
  // 见 `providerCatalogVisible`（src/account-pool.ts）。
  describe('无已登录账号时隐藏整个 provider 目录', () => {
    it('没有已登录账号 → 返回空数组', async () => {
      const adapter = makeAdapter({
        accountPool: {
          disabledModelsFor: () => new Set<string>(),
          hasLoggedInAccount: async () => false,
        } as never,
      })
      expect(await adapter.listModels('qoder')).toEqual([])
    })

    it('有已登录账号 → 正常返回目录', async () => {
      const adapter = makeAdapter({
        accountPool: {
          disabledModelsFor: () => new Set<string>(),
          hasLoggedInAccount: async () => true,
        } as never,
      })
      expect((await adapter.listModels('qoder')).length).toBe(QODER.fallbackModels.length)
    })
  })

  it('providerInfo 返回 qoder', () => {
    expect(makeAdapter().providerInfo('qoder')).toEqual({ id: 'qoder', name: QODER.displayName })
  })

  // 计费倍率展示（目录 `price_factor`）。
  //
  // ⚠️ **必须写进 `name`，不是 `description`**：composer 的模型切换菜单只渲染
  // `name`（ModelSelect 的 `children: model.name`），`description` 仅用于
  // `/model` 弹窗。用户报障「消耗倍率没有显示在切换模型列表的后面」。
  describe('listModels 的计费倍率', () => {
    it('price_factor=0 显示为「免费」而非 x0', async () => {
      // 实测 Qwen3.8-Flash（qfmodel）的 price_factor 正是 0。
      const models = await makeAdapter().listModels('qoder')
      const flash = models.find((m) => m.id === 'qfmodel')
      expect(flash?.name).toBe('Qwen3.8-Flash · 免费')
    })

    it('其余模型显示 x 倍率（数值对照真实 catalog）', async () => {
      const models = await makeAdapter().listModels('qoder')
      // ⚠️ 早期用例断言的是 `x0.8` / `x3.2` —— 那是兜底表的**过期估值**，
      // 真实 catalog 为 0.5 / 8（用户报障后逐条校正，见 qoder-product.spec.ts）。
      expect(models.find((m) => m.id === 'dmodel')?.name).toBe('DeepSeek-V4-Pro · x0.5')
      expect(models.find((m) => m.id === 'gfmodel')?.name).toBe('GLM-5.3-Flash · x0.1')
      expect(models.find((m) => m.id === 'smodel')?.name).toBe('Sonus · x8')
    })

    // ⚠️ 角标**不再**由目录快照 `promotion.active` 决定 —— 那是采集时刻的值，
    // 会随错峰窗口切换而失真。真实判据是 `windowStart`/`windowEnd` 的本地推算
    // （边界用例见 qoder-product.spec.ts 的「错峰时段判定」）。
    // 这里只验证**无窗口字段时的回退行为**，与当前钟点无关、恒定可复现。
    it('无窗口字段时回退到 active：false 不显示角标、用原价', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{
          id: 'promo', name: 'Promo', contextWindow: 1000,
          priceFactor: 0.2,
          promotion: { active: false, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, badgeZh: '错峰 4 折' },
        }],
      }
      const adapter = makeAdapter({ product: product as never })
      const models = await adapter.listModels('qoder')
      // 窗口外 → 原价、无角标（避免用户按折扣价预期却被按原价计费）
      expect(models[0]?.name).toBe('Promo · x0.5')
      expect(models[0]?.name).not.toContain('折')
    })

    it('无窗口字段时回退到 active：true 显示 原价→折后价', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{
          id: 'promo', name: 'Promo', contextWindow: 1000,
          priceFactor: 0.2,
          promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, badgeZh: '错峰 4 折' },
        }],
      }
      const adapter = makeAdapter({ product: product as never })
      const models = await adapter.listModels('qoder')
      // 窗口内 → `原价→折后价`（0.5→0.2），与 TRAE / buddy 同形态。
      // ⚠️ 旧形态是 `x0.2 错峰 4 折`（只有折后价 + 角标），用户要求对齐 TRAE。
      expect(models[0]?.name).toBe('Promo · x0.5→x0.2')
    })

    it('无 priceFactor 时 name 保持原样（不编造倍率）', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{ id: 'unknown', name: 'Unknown', contextWindow: 1000 }],
      }
      const adapter = makeAdapter({ product: product as never })
      expect((await adapter.listModels('qoder'))[0]?.name).toBe('Unknown')
    })

    // resolveModel 的 name 用于会话中的模型显示，**不带**价格后缀
    // （价格只属于选择列表这个语境）。
    it('resolveModel 的 name 不带倍率后缀', async () => {
      expect((await makeAdapter().resolveModel('qoder', 'qfmodel')).name).toBe('Qwen3.8-Flash')
    })
  })
})

describe('QoderAdapter resolveModel', () => {
  it('已知模型带 contextWindow 与展示名', async () => {
    // dmodel = DeepSeek-V4-Pro，实测 max_input_tokens=1000000
    const resolved = await makeAdapter().resolveModel('qoder', 'dmodel')
    expect(resolved.name).toBe('DeepSeek-V4-Pro')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('未知模型不编造 context（id 即 name）', async () => {
    const resolved = await makeAdapter().resolveModel('qoder', 'some-future-model')
    expect(resolved.name).toBe('some-future-model')
    expect(resolved.context).toBeUndefined()
  })

  it('inputModalities 按模型的 supportsImage 判定', async () => {
    const adapter = makeAdapter()
    // 实测 17 个目录模型 is_vl 全为 true
    expect((await adapter.resolveModel('qoder', 'dmodel')).inputModalities).toEqual(['text', 'image'])
    expect((await adapter.resolveModel('qoder', 'qmodel_38max')).inputModalities).toEqual(['text', 'image'])
    // 未知模型保守报 text（宁可少报能力）
    expect((await adapter.resolveModel('qoder', 'unknown-x')).inputModalities).toEqual(['text'])
  })
})

describe('QoderAdapter 请求构造（加密端点）', () => {
  it('URL 指向 api2.qoder.sh 的 agent_chat_generation（**不是** api2-v2）', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const url = String(call[0])
    // ⚠️ 加密端点与公开端点是**不同 host**：混用会 404
    expect(url.startsWith('https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation')).toBe(true)
    expect(url).toContain('Encode=1')
    expect(url).not.toContain('api2-v2')
  })

  it('请求体是**加密**的（不是 JSON），且带 X-Model-Key 头', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const body = String((call[1] as { body: string }).body)
    // 加密体不是 JSON（朴素 JSON.parse 会失败）
    expect(() => JSON.parse(body)).toThrow()
    expect(body.length).toBeGreaterThan(0)
    // 模型 key 走独立头（服务端据此路由）
    const headers = (call[1] as { headers: Headers }).headers
    const get = (k: string): string | null => (headers instanceof Headers ? headers.get(k) : null)
    expect(get('X-Model-Key')).toBe('auto')
    expect(get('X-Model-Source')).toBe('system')
  })

  it('Authorization 是 WASM 生成的 COSY 签名，**不是**普通 Bearer token', async () => {
    // ⚠️ 用普通 `Bearer <token>` 覆盖会得到 403 Signature invalid。
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const headers = (call[1] as { headers: Headers }).headers
    const get = (k: string): string | null => (headers instanceof Headers ? headers.get(k) : null)
    const auth = get('authorization')
    expect(auth).toContain('Bearer COSY.')
    expect(auth).not.toBe('Bearer tok')
    expect(get('accept')).toBe('text/event-stream')
  })

  it('请求体必须含 `business`（缺了服务端路由到坏节点）', async () => {
    // ⚠️ 真实缺陷（2026-09-20 定位）：
    //   `qfmodel`（Qwen3.8-Flash）在**不带 `business`** 时恒落到故障节点
    //   `oa_qwen-plus-2025-04-28` 并返回 `[FAIL]node:... msg:Execution failed`；
    //   补上 `business` 后立即正常（其余模型如 `qmodel_38max` 恰好不受影响，
    //   故极易误判为「该模型服务端故障」——IDE 里同一模型完全可用）。
    //
    // 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
    // —— 服务端按 `business.type` 选路由池。
    //
    // 请求体是加密的，单测无法直接读字段，故用**源码级断言**锁死
    // （与 `jet-hub-rpc.spec.ts` 的守卫同款做法）。
    const source = readFileSync(resolve(here, '../../src/qoder-adapter.ts'), 'utf8')
    const code = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code).toContain('business: { type:')
  })

  it('system 提示与用户文本都进加密体（本地不可解，只校验非空）', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    const adapter = makeAdapter({ fetchImpl })
    for await (const _ of adapter.stream({
      model: 'auto',
      system: '你是助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const withSystem = String((call[1] as { body: string }).body)

    const fetchImpl2 = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    for await (const _ of makeAdapter({ fetchImpl: fetchImpl2 }).stream({
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const call2 = (fetchImpl2 as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const withoutSystem = String((call2[1] as { body: string }).body)

    // 有 system 时密文更长（内容确实进了请求）
    expect(withSystem.length).toBeGreaterThan(withoutSystem.length)
  })
})

describe('QoderAdapter 鉴权与重试', () => {
  it('401 时刷新一次凭据后重试', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('unauthorized', { status: 401 })
      return envelopeResponse([textFrame('你好'), finishFrame])
    }) as unknown as typeof fetch
    const refresh = vi.fn(async () => {})
    const chunks = await collect(makeAdapter({ fetchImpl, refresh }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('无凭据时报 MISSING_CREDENTIAL', async () => {
    const adapter = makeAdapter({ resolveCredential: async () => undefined })
    await expect(collect(adapter)).rejects.toThrow(/log in|凭据|credential/i)
  })
})

describe('QoderAdapter SSE 解析', () => {
  it('解析正文与 reasoning_content', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] }),
      textFrame('你好'),
      finishFrame,
    ])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    expect(chunks.some((c) => c.type === 'reasoning-delta')).toBe(true)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish).toBeDefined()
  })

  it('delta.content 显式为 null 时不崩溃（真实形态）', async () => {
    // 实测：一个模型要么走 content、要么走 reasoning_content，另一侧恒为 null
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: 'r' } }] }),
      finishFrame,
    ])) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).resolves.toBeDefined()
  })

  it('工具调用分片合并', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1',
        function: { name: 'read', arguments: '{"p"' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0,
        function: { arguments: ':"x"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    const end = chunks.find((c) => c.type === 'block-end'
      && (c.block as { type?: string } | undefined)?.type === 'tool-call')
    expect(end).toBeDefined()
    const block = end!.block as { name: string; arguments: string }
    expect(block.name).toBe('read')
    expect(block.arguments).toBe('{"p":"x"}')
  })
})

describe('QoderAdapter SSE 错误帧（真实缺陷：报错被静默吞掉）', () => {
  /**
   * 真实缺陷（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止了」。
   *
   * 服务端对无效模型的真实响应（实测 2026-09-19）：
   * ```
   * event: error
   * data: {"code":"invalid_model_error","message":"Unsupported model \"qfmodel\"",
   *        "request_id":"...","type":"invalid_model_error"}
   * ```
   *
   * ⚠️ 两处与 OpenAI 标准不同，早期实现因此**整帧丢弃**：
   * 1. 有独立的 `event: error` 行（我们的解析器只处理 `data:` 行）；
   * 2. 错误信息在**顶层 `code`/`message`**，而非 `{error: {message}}`。
   *
   * 后果：错误被当成「正常结束、无内容」→ 只产出
   * `[{type:'finish', reason:{kind:'stop'}}]`，UI 表现为
   * 「没回复就干净地停止」，用户看不到任何原因。
   */
  const errorFrame = 'event: error\ndata: {"code":"invalid_model_error","message":"Unsupported model \\"qfmodel\\"","request_id":"abc","type":"invalid_model_error"}\n\n'

  it('顶层 code/message 的错误帧必须抛错，而不是静默 finish', async () => {
    const fetchImpl = vi.fn(async () => new Response(errorFrame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).rejects.toThrow(/Unsupported model/)
  })

  it('错误必须带上服务端 message，便于用户定位', async () => {
    const fetchImpl = vi.fn(async () => new Response(errorFrame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    const error = await collect(makeAdapter({ fetchImpl })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('invalid_model_error')
    expect((error as Error).message).toContain('qfmodel')
  })

  it('标准 OpenAI 形态 {error:{message}} 仍要抛错（不回归）', async () => {
    const frame = 'data: {"error":{"message":"boom"}}\n\n'
    const fetchImpl = vi.fn(async () => new Response(frame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).rejects.toThrow(/boom/)
  })

  it('正常帧不受影响（event: 行被忽略，data 帧照常解析）', async () => {
    const frame = `event: message\ndata: ${textFrame('你好')}\ndata: ${finishFrame}\ndata: [DONE]\n\n`
    const fetchImpl = vi.fn(async () => new Response(frame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('QoderAdapter 图片输入', () => {
  it('不支持图片的模型收到图片时报 UNSUPPORTED_CONTENT', async () => {
    // 实测真实模型 is_vl 全为 true，故用**未知模型**测「保守报 text」这条路径
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('你好'), finishFrame])) as unknown as typeof fetch
    const adapter = makeAdapter({ fetchImpl, readImage: async () => undefined })
    const iterate = async (): Promise<void> => {
      for await (const _ of adapter.stream({
        model: 'text-only-unknown',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image', attachment: { attachmentId: 'a1' } },
          ],
        }],
      } as never)) { /* drain */ }
    }
    await expect(iterate()).rejects.toThrow(/不支持图片/)
  })

  it('支持图片的模型接受图片并真的读取了附件', async () => {
    // ⚠️ 请求体已加密，无法再断言明文 image_url 形态
    // （那是公开端点的形态）。且加密体长度因分块填充而**不单调**，
    // 也不能用长度断言。这里验证真正可观察的行为：
    //   1. 不抛 UNSUPPORTED_CONTENT（图片被接受）
    //   2. readImage 被调用（附件确实被读取，而非静默丢弃）
    const readImage = vi.fn(async (): Promise<{ data: Uint8Array; mediaType: string }> =>
      ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }))

    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('你好'), finishFrame])) as unknown as typeof fetch
    const chunks = await collectWith(makeAdapter({ fetchImpl, readImage }), {
      model: 'dmodel',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', attachment: { attachmentId: 'a1' } },
        ],
      }],
    })

    expect(readImage).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

/**
 * ## 真实缺陷（用户报障，2026-09-27）：Qoder 的**排队错误**被当成认证失败
 *
 * 用户给的两条真实错误（都是 HTTP 403 + 业务码 `10605`）：
 *
 * ```
 * 国际版: {"code":"10605","message":"{\"isQueued\":true,…,\"retryAfterSeconds\":30,
 *          \"serviceAvailable\":false,\"waitTime\":30}"}      → 真排队 30s
 * 中国版: {"code":"10605","message":"{\"isQueued\":false,…,\"retryAfterSeconds\":2,
 *          \"serviceAvailable\":true,\"waitTime\":0}"}        → 瞬时，等 2s 即成功
 * ```
 *
 * ⚠️ **关键结构**：`message` 是**一个 JSON 字符串**（不是对象），必须**二次解析**。
 * 客户端 `lFc()` 为此递归遍历 `data`/`result`/`message`/`body`，字符串则
 * `JSON.parse`。旧实现只读顶层 `code`，因此从未识别出排队。
 *
 * 客户端的权威算法（obf 产物取证，`scripts/probe-qoder-queue-error.mjs`）：
 * - 排队码 `mRA="10605"` → `model_queued`；认证码 `MF="105"` → `auth_error`
 *   —— **两者互相独立**（`rJc()`），不能都归为 AUTH；
 * - 延迟优先序（`kJa()`/`EV()`/`IRA()`）：`retry_after_ms` → `retryAfterMs`
 *   → `queue.retryAfterSeconds×1000` → 兜底 `Retry-After` 响应头；
 * - 决策（`W7c()`）：**有 `retryAfterMs` 就精确等它**，没有才退避。
 */
describe('QoderAdapter 排队错误（10605 model_queued）', () => {
  /** 构造一条真实的 403 排队响应（`message` 是 JSON 字符串）。 */
  function queueResponse(info: Record<string, unknown>): Response {
    return new Response(
      JSON.stringify({ code: '10605', message: JSON.stringify(info) }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )
  }

  /** 国际版真排队：等 30s。 */
  const REAL_QUEUED = {
    isQueued: true, modelKey: 'qfmodel', queueCount: 0, queueType: 'p3',
    retryAfterSeconds: 30, serviceAvailable: false, waitTime: 30,
  }
  /** 中国版瞬时排队：等 2s，重试即成功。 */
  const REAL_TRANSIENT = {
    isQueued: false, modelKey: 'qfmodel', queueCount: 0, queueType: 'p3',
    retryAfterSeconds: 2, serviceAvailable: true, waitTime: 0,
  }

  describe('parseQoderQueueError（纯函数：二次解析 message）', () => {
    it('解析出排队信息（message 是 JSON 字符串，必须二次解析）', () => {
      const info = parseQoderQueueError(JSON.stringify({ code: '10605', message: JSON.stringify(REAL_QUEUED) }))
      expect(info).toEqual(REAL_QUEUED)
    })

    it('中国版瞬时排队同样解析出来', () => {
      const info = parseQoderQueueError(JSON.stringify({ code: '10605', message: JSON.stringify(REAL_TRANSIENT) }))
      expect(info).toEqual(REAL_TRANSIENT)
    })

    it('非 10605 的 403（真认证失败）不算排队', () => {
      // 认证失败的业务码是 105，不是 10605 —— 两者**必须分开**（客户端 rJc()）。
      expect(parseQoderQueueError(JSON.stringify({ code: '105', message: 'login expired' }))).toBeUndefined()
      expect(parseQoderQueueError(JSON.stringify({ code: '10605', message: 'not json' }))).toBeUndefined()
      expect(parseQoderQueueError('not json at all')).toBeUndefined()
      expect(parseQoderQueueError('')).toBeUndefined()
    })

    it('message 是对象而非字符串时也能取到（上游形态变化时更鲁棒）', () => {
      const info = parseQoderQueueError(JSON.stringify({ code: '10605', message: REAL_QUEUED }))
      expect(info).toEqual(REAL_QUEUED)
    })

    it('code 兼容字符串与数字两种编码', () => {
      expect(parseQoderQueueError(JSON.stringify({ code: 10605, message: JSON.stringify(REAL_TRANSIENT) })))
        .toEqual(REAL_TRANSIENT)
    })
  })

  describe('qoderQueueDelayMs（纯函数：延迟换算与封顶）', () => {
    it('小于 10 秒按服务端的值（2s → 2000ms）', () => {
      expect(qoderQueueDelayMs({ retryAfterSeconds: 2 })).toBe(2000)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 0 })).toBe(0)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 9 })).toBe(9000)
    })

    it('≥ 10 秒封顶到 10 秒（30s → 10000ms）', () => {
      // 用户明确要求：大于 10 秒就按 10 秒排队（避免一次阻塞 30 秒，
      // 分多次尝试更稳 —— 后端可能提前放行）。
      expect(qoderQueueDelayMs({ retryAfterSeconds: 10 })).toBe(10_000)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 30 })).toBe(10_000)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 3600 })).toBe(10_000)
    })

    it('优先用 retry_after_ms / retryAfterMs（毫秒口径，同样封顶）', () => {
      // 客户端 kJa() 的优先序：retry_after_ms → retryAfterMs → retryAfterSeconds×1000
      expect(qoderQueueDelayMs({ retry_after_ms: 1500, retryAfterSeconds: 30 })).toBe(1500)
      expect(qoderQueueDelayMs({ retryAfterMs: 2500 })).toBe(2500)
      // 毫秒值超上限同样封顶
      expect(qoderQueueDelayMs({ retry_after_ms: 99_999 })).toBe(10_000)
    })

    it('非法值被忽略，退回退避（而不是等 NaN 毫秒）', () => {
      // 客户端 W7c() 对非有限/负值直接判 fail；我们取保守：退回退避。
      expect(qoderQueueDelayMs({ retryAfterSeconds: -5 })).toBeUndefined()
      expect(qoderQueueDelayMs({ retryAfterSeconds: Number.NaN })).toBeUndefined()
      expect(qoderQueueDelayMs({})).toBeUndefined()
      expect(qoderQueueDelayMs({ retryAfterSeconds: '2' as never })).toBeUndefined()
    })

    it('非排队错误不产生延迟', () => {
      expect(qoderQueueDelayMs(undefined)).toBeUndefined()
    })
  })

  describe('stream 行为：排队时内部等待并重试', () => {
    it('瞬时排队（2s）等待后重试即成功，且**不刷新凭据**', async () => {
      const refresh = vi.fn(async () => {})
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        // 第 1 次排队，第 2 次成功（与用户观察一致：一次重试就能过）
        return call === 1
          ? queueResponse(REAL_TRANSIENT)
          : envelopeResponse([textFrame('好了'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      const pending = collectWith(makeAdapter({
        fetchImpl, refresh, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      const chunks = await pending
      expect(sleeps, '应按服务端给的 2s 等待').toEqual([2000])
      // ⚠️ 排队不是认证问题：绝不能刷新凭据（旧实现会先 refresh 再重试）
      expect(refresh, '排队期间不应刷新凭据').not.toHaveBeenCalled()
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    it('真排队（30s）按 10s 封顶等待，多次重试直到成功', async () => {
      const refresh = vi.fn(async () => {})
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        if (call <= 3) return queueResponse(REAL_QUEUED)
        return envelopeResponse([textFrame('排到了'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      const chunks = await collectWith(makeAdapter({
        fetchImpl, refresh, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      // 30s 被压到 10s（用户要求：>10s 按 10s 排）
      expect(sleeps).toEqual([10_000, 10_000, 10_000])
      expect(refresh).not.toHaveBeenCalled()
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    it('排队次数超过上限后抛错（不无限阻塞）', async () => {
      const fetchImpl = vi.fn(async () => queueResponse(REAL_QUEUED)) as unknown as typeof fetch
      const sleeps: number[] = []
      const adapter = makeAdapter({
        fetchImpl,
        sleep: async (ms) => { sleeps.push(ms); if (sleeps.length > QODER_QUEUE_MAX_ATTEMPTS + 5) throw new Error('sleep 未收敛') },
      })

      await expect(collectWith(adapter, {
        model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })).rejects.toThrow(/排队|queue/i)

      // 精确上限：不多不少
      expect(sleeps.length).toBe(QODER_QUEUE_MAX_ATTEMPTS)
      expect(QODER_QUEUE_MAX_ATTEMPTS).toBe(180)
    })

    it('等待期间 signal 中止则立即停止（不再重试）', async () => {
      const controller = new AbortController()
      const fetchImpl = vi.fn(async () => queueResponse(REAL_QUEUED)) as unknown as typeof fetch
      const adapter = makeAdapter({
        fetchImpl,
        sleep: async () => { controller.abort() },
      })

      await expect(collectWith(adapter, {
        model: 'qfmodel',
        signal: controller.signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })).rejects.toThrow()
    })

    it('真认证失败（非 10605 的 403）仍走 refresh + AUTH（不误判为排队）', async () => {
      const refresh = vi.fn(async () => {})
      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ code: '105', message: 'login expired' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch

      const sleeps: number[] = []
      await expect(collectWith(makeAdapter({
        fetchImpl, refresh, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toThrow()

      expect(sleeps, '认证失败不该走排队等待').toEqual([])
      expect(refresh, '认证失败应触发续期').toHaveBeenCalled()
    })

    it('排队总时长上限可用 DSH_QODER_QUEUE_TIMEOUT_MS 覆盖', async () => {
      // ⚠️ 上限判定是**时间**驱动（默认 30 分钟），单测不能真等 —— 这里设 0，
      // 语义是「立即判超时」，从而在毫秒级验证该开关确实生效且**不被 180 次
      // 次数上限抢先命中**（两者的判定顺序是实现细节，此用例锁住它）。
      process.env.DSH_QODER_QUEUE_TIMEOUT_MS = '0'
      try {
        const fetchImpl = vi.fn(async () => queueResponse(REAL_QUEUED)) as unknown as typeof fetch
        const sleeps: number[] = []
        await expect(collectWith(makeAdapter({
          fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
        }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
          .rejects.toThrow(/排队等待超时/)

        // 上限为 0 → 第一次排队即判超时，**一次都不等**（而不是把 180 次耗完）。
        expect(sleeps).toEqual([])
      } finally {
        delete process.env.DSH_QODER_QUEUE_TIMEOUT_MS
      }
    })
  })
})
