/**
 * Accio LLM 适配器单元测试。
 *
 * 覆盖 `src/accio-adapter.ts` 的模型目录与流式转换：
 * - `displayNameOfAccioModel` 的倍率后缀（倍率必须进 `name`）；
 * - `listModels` 的远端/兜底切换与「倍率进 name」；
 * - `resolveModel` 的 `contextWindow` 与 **`inputModalities` 三态**（省略 = 未知）；
 * - `stream()` 的信封构造（token 进 body、`system_instruction` 是字符串、
 *   `max_output_tokens` 必须下发）、流内 402 归额度、工具调用**分片合并**；
 * - `prepareCall` 与 DSH 0.1.7 消息双形状兼容。
 *
 * 全部使用注入的 fetch 桩，不发真实网络请求。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  ACCIO_PROVIDER,
  AccioAdapter,
  displayNameOfAccioModel,
  normalizeAccioModel as adapterNormalizeAccioModel,
} from '../../src/accio-adapter.js'
// ⚠️ 目录解析的**唯一实现**在 accio-auth.ts（adapter 只再导出）。
import { normalizeAccioModel } from '../../src/accio-auth.js'
import { ACCIO } from '../../src/accio-product.js'
import type { AccioCredential } from '../../src/accio.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

function makeCredential(overrides: Partial<AccioCredential> = {}): AccioCredential {
  return {
    access_token: 'TOK',
    refresh_token: 'RT',
    expires_at: Date.now() + 3_600_000,
    region: 'cn',
    ...overrides,
  }
}

/** 上游真实帧形状：`content` 在**顶层**（不包 `candidates`）。 */
function frame(parts: unknown[]): Record<string, unknown> {
  return { content: { role: 'model', parts }, partial: true }
}

function textPart(text: string): Record<string, unknown> {
  return { text }
}

function thoughtPart(text: string): Record<string, unknown> {
  return { text, thought: true }
}

function callPart(id: string, name: string, argsJson?: string): Record<string, unknown> {
  const call: Record<string, unknown> = { id, name }
  if (argsJson !== undefined) call.args_json = argsJson
  return { function_call: call }
}

function accioSse(...frames: unknown[]): string {
  return `${frames.map((f) => `data: ${JSON.stringify(f)}\n`).join('')}data: [DONE]\n`
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

interface AdapterHarness {
  adapter: AccioAdapter
  fetcher: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}

function makeAdapter(options: {
  /** 传 `null` 表示「解析不到凭据」。 */
  credential?: AccioCredential | null
  /**
   * 调用 `refresh()` **之后**才生效的凭据（缺省恒返回 `credential`）。
   *
   * ⚠️ 必须有这个缝：本用例要验证「401 重试带的是**新** token」，
   * 而 refresh 前后返回同一个 `'TOK'` 的桩**结构上抓不到**该缺陷
   * （旧实现在这种桩下照样通过 —— 这正是初版用例漏掉它的原因）。
   */
  credentialAfterRefresh?: AccioCredential | null
  responses?: Array<Response | (() => Response | Promise<Response>)>
  remoteModels?: Array<{
    id: string
    name: string
    contextWindow?: number
    maxTokens?: number
    supportsImage?: boolean
    multiple?: number
  }>
  /** 传 `'throw'` 模拟远端目录整体失败。 */
  remote?: 'throw'
  accountPool?: unknown
} = {}): AdapterHarness {
  const credential = options.credential === undefined ? makeCredential() : options.credential ?? undefined
  let refreshedOnce = false
  const responses = [...(options.responses ?? [])]
  const fetcher = vi.fn(async () => {
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected fetch call')
    return typeof next === 'function' ? await next() : next
  })
  const refresh = vi.fn(async () => { refreshedOnce = true })
  const adapter = new AccioAdapter({
    resolveCredential: async () => {
      if (!refreshedOnce) return credential
      return options.credentialAfterRefresh === undefined
        ? credential
        : options.credentialAfterRefresh ?? undefined
    },
    refresh,
    fetchImpl: fetcher as unknown as typeof fetch,
    ...options.remote === 'throw'
      ? { fetchRemoteModels: async () => { throw new Error('目录不可用') } }
      : options.remoteModels === undefined
        ? {}
        : { fetchRemoteModels: async () => options.remoteModels! },
    ...options.accountPool === undefined ? {} : { accountPool: options.accountPool as never },
  })
  return { adapter, fetcher, refresh }
}

/** 收集 `stream()` 产出的全部 chunk。 */
async function collect(adapter: AccioAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

/** 取出 fetch 桩实际发出的请求体。 */
function sentBody(fetcher: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return JSON.parse((fetcher.mock.calls[call] as [string, { body: string }])[1].body) as Record<string, unknown>
}

/** 取出 fetch 桩实际发出的 URL 与请求头。 */
function sentInit(fetcher: ReturnType<typeof vi.fn>, call = 0): { url: string; init: RequestInit } {
  const [url, init] = fetcher.mock.calls[call] as [string, RequestInit]
  return { url, init }
}

const BASIC_OPTIONS: GenerateOptions = {
  model: '1Drift-N8kP2Q7wR5mX',
  messages: [{ role: 'user', content: '你好' }],
} as unknown as GenerateOptions

/**
 * 一个最小的「正常回复」响应**工厂**。
 *
 * ⚠️ 必须是工厂而不是常量：`Response` 的 body 只能被读一次，多个用例共享
 * 同一个实例会让后续用例读到空流（表现为「模型未返回任何内容块」的假失败）。
 */
function okResponse(): Response {
  return sseResponse(accioSse(frame([textPart('好')])))
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('ACCIO_PROVIDER', () => {
  it('是纯小写字母且无连字符', () => {
    expect(ACCIO_PROVIDER).toBe('accio')
    expect(ACCIO_PROVIDER).toMatch(/^[a-z]+$/)
  })

  it('与产品配置的 id 同形', () => {
    expect(ACCIO_PROVIDER).toBe(ACCIO.id)
  })
})

describe('displayNameOfAccioModel —— ⚠️ 倍率必须进 name，不是 description', () => {
  // composer 的模型切换菜单**只渲染 `name`**（`description` 完全不读），
  // 故倍率写进 description 等于没写（用户报障的原始成因）。
  it('有倍率时拼上 x 后缀', () => {
    expect(displayNameOfAccioModel({ name: 'Qwen 3.8 Flash', multiple: 0.03 }))
      .toBe('Qwen 3.8 Flash · x0.03')
  })

  it('倍率为 1 也照拼（1 不是「无」）', () => {
    expect(displayNameOfAccioModel({ name: 'Professional', multiple: 1 }))
      .toBe('Professional · x1')
  })

  it('无倍率时不拼后缀', () => {
    expect(displayNameOfAccioModel({ name: 'X' })).toBe('X')
  })

  it('倍率为 0 是合法值（免费），不得与「无倍率」混同', () => {
    // 上游 `effectiveMultiple` 可能为 0；`0` 与 `undefined` 语义不同，
    // 用 `if (multiple)` 会把免费模型显示成「没有倍率」。
    expect(displayNameOfAccioModel({ name: 'Free', multiple: 0 })).toBe('Free · x0')
  })

  it('跨度大（0.013 vs 2.8）时必须可区分', () => {
    expect(displayNameOfAccioModel({ name: 'A', multiple: 0.013 })).toContain('x0.013')
    expect(displayNameOfAccioModel({ name: 'B', multiple: 2.8 })).toContain('x2.8')
  })

  it('非有限倍率不拼（不产出 xNaN）', () => {
    expect(displayNameOfAccioModel({ name: 'A', multiple: Number.NaN })).toBe('A')
    expect(displayNameOfAccioModel({ name: 'A', multiple: Number.POSITIVE_INFINITY })).toBe('A')
  })
})

describe('目录解析只有一份实现（adapter 只再导出）', () => {
  it('⚠️ adapter 导出的 normalizeAccioModel 与 accio-auth 的是同一个函数', () => {
    // 「同一语义两套判据」是本仓库首条红线：adapter 不得自带第二份解析器。
    expect(adapterNormalizeAccioModel).toBe(normalizeAccioModel)
  })

  it('从 modelList 条目取字段', () => {
    const m = normalizeAccioModel({
      modelCode: '1X', modelDisplayName: 'X', contextWindow: 512000,
      multimodal: true, effectiveMultiple: 0.013, visible: true,
    })
    expect(m?.id).toBe('1X')
    expect(m?.name).toBe('X')
    expect(m?.contextWindow).toBe(512000)
    expect(m?.supportsImage).toBe(true)
    expect(m?.multiple).toBe(0.013)
  })

  it('⚠️ visible !== true 一律剔除（不可见模型不该进目录）', () => {
    expect(normalizeAccioModel({ modelCode: 'A', visible: false })).toBeUndefined()
    expect(normalizeAccioModel({ modelCode: 'A' })).toBeUndefined()
  })

  it('缺 modelCode 时剔除', () => {
    expect(normalizeAccioModel({ visible: true })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

describe('AccioAdapter · providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    const { adapter } = makeAdapter()
    expect(adapter.providerInfo(ACCIO_PROVIDER)).toEqual({
      id: ACCIO_PROVIDER,
      name: ACCIO.displayName,
    })
  })

  it('provider 非字符串时回退产品 id（防御 undefined.toUpperCase 崩溃）', () => {
    const { adapter } = makeAdapter()
    expect((adapter.providerInfo(undefined as never) as { id: string }).id).toBe(ACCIO_PROVIDER)
  })
})

describe('AccioAdapter · listModels', () => {
  it('远端目录可用时采信远端，且**倍率拼进 name**', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'm1', name: 'Qwen 3.8 Flash', contextWindow: 1_000_000, multiple: 0.03 }],
    })
    const models = await adapter.listModels(ACCIO_PROVIDER)
    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe('m1')
    expect(models[0]!.name).toBe('Qwen 3.8 Flash · x0.03')
  })

  it('远端目录失败时回退 ACCIO.fallbackModels（且同样带倍率）', async () => {
    const { adapter } = makeAdapter({ remote: 'throw' })
    const models = await adapter.listModels(ACCIO_PROVIDER)
    expect(models).toHaveLength(ACCIO.fallbackModels.length)
    // 兜底表首条：Qwen 3.8 27B，倍率 0.013。
    expect(models[0]!.id).toBe(ACCIO.fallbackModels[0]!.id)
    expect(models[0]!.name).toBe(`${ACCIO.fallbackModels[0]!.name} · x${ACCIO.fallbackModels[0]!.multiple}`)
  })

  it('远端未提供时不拉取（无 fetchRemoteModels 时直接用兜底表）', async () => {
    const { adapter, fetcher } = makeAdapter()
    const models = await adapter.listModels(ACCIO_PROVIDER)
    expect(models).toHaveLength(ACCIO.fallbackModels.length)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('应用账号池的模型黑名单（关闭的模型不出现在目录里）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'a', name: 'A', multiple: 0.1 },
        { id: 'b', name: 'B', multiple: 0.2 },
      ],
      accountPool: { disabledModelsFor: () => new Set(['a']) },
    })
    expect((await adapter.listModels(ACCIO_PROVIDER)).map((m) => m.id)).toEqual(['b'])
  })

  it('listAllModels 不受黑名单影响（设置页要能重新打开已关闭的模型）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'a', name: 'A', multiple: 0.1 },
        { id: 'b', name: 'B', multiple: 0.2 },
      ],
      accountPool: { disabledModelsFor: () => new Set(['a']) },
    })
    await adapter.listModels(ACCIO_PROVIDER)
    expect(adapter.listAllModels().map((m) => m.id).sort()).toEqual(['a', 'b'])
  })
})

describe('AccioAdapter · resolveModel', () => {
  it('已知模型解析出 contextWindow（来自目录）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'm1', name: 'Qwen', contextWindow: 512_000, multiple: 0.013 }],
    })
    const resolved = await adapter.resolveModel(ACCIO_PROVIDER, 'm1')
    expect(resolved.id).toBe('m1')
    expect(resolved.context?.contextWindow).toBe(512_000)
  })

  it('resolveModel 的 name **不带倍率**（价格只属于选择列表语境）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'm1', name: 'Qwen', contextWindow: 512_000, multiple: 0.013 }],
    })
    expect((await adapter.resolveModel(ACCIO_PROVIDER, 'm1')).name).toBe('Qwen')
  })

  it('⚠️⚠️ inputModalities 必须**省略**（三态：省略 = 未知）', async () => {
    // 图片通路在本 provider **未实测**（`ACCIO_IMAGE_PIXEL_BUDGET` 只是预留接入点）。
    // 省略 = 未知是诚实的编码；写 ['text','image'] 是编造能力，
    // 写 ['text'] 则是把「未知」写成「明确不支持」（AGENTS.md 的静默失效格）。
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'img', name: '声明支持图片', contextWindow: 1_000_000, supportsImage: true, multiple: 0.1 },
        { id: 'txt', name: '声明不支持图片', contextWindow: 1_000_000, supportsImage: false, multiple: 0.2 },
      ],
    })
    const img = await adapter.resolveModel(ACCIO_PROVIDER, 'img')
    const txt = await adapter.resolveModel(ACCIO_PROVIDER, 'txt')
    expect(img.inputModalities, '声明 multimodal 也不得写 image').toBeUndefined()
    expect(txt.inputModalities, '声明不支持也不得写成明确否定').toBeUndefined()
    expect(img.inputModalities).not.toEqual(['text', 'image'])
    expect(txt.inputModalities).not.toEqual(['text'])
  })

  it('listModels 同样省略 inputModalities（与 resolveModel 同源）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'm1', name: 'Qwen', contextWindow: 1_000_000, supportsImage: true, multiple: 0.1 }],
    })
    const models = await adapter.listModels(ACCIO_PROVIDER)
    expect(models[0]!.inputModalities).toBeUndefined()
  })

  it('未知模型 id 同样省略 inputModalities（不编造、也不写成否定）', async () => {
    const { adapter } = makeAdapter()
    const resolved = await adapter.resolveModel(ACCIO_PROVIDER, 'no-such-model')
    expect(resolved.name).toBe('no-such-model')
    expect(resolved.inputModalities).toBeUndefined()
    expect(resolved.context).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

describe('AccioAdapter · stream 请求构造', () => {
  it('打到 generateContent 端点，sg_k = md5(request_id)', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    const { url } = sentInit(fetcher)
    expect(url.startsWith(`${ACCIO.gatewayBaseUrl}/api/adk/llm/generateContent?sg_k=`)).toBe(true)
    const body = sentBody(fetcher)
    const requestId = String(body.request_id)
    const sgK = url.slice(url.indexOf('sg_k=') + 5)
    const { createHash } = await import('node:crypto')
    expect(sgK).toBe(createHash('md5').update(requestId, 'utf8').digest('hex'))
  })

  it('⚠️ token 必须在 body，且**不得**出现在 Authorization 头', async () => {
    // 放 Authorization 头恒得 HTTP 200 + 流内 402（实测四格矩阵）。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    expect(sentBody(fetcher).token).toBe('TOK')
    const headers = new Headers(sentInit(fetcher).init.headers)
    expect(headers.get('Authorization')).toBeNull()
  })

  it('恒带 Content-Type / Accept / utdid / version / appKey，且无 SecurityGuard 头', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    const headers = new Headers(sentInit(fetcher).init.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Accept')).toBe('text/event-stream')
    expect(headers.get('appKey')).toBe(ACCIO.appKey)
    for (const [key] of headers) expect(key.startsWith('pctb-')).toBe(false)
  })

  it('empid / tenant / iai_tag 恒空串', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    const body = sentBody(fetcher)
    expect(body.empid).toBe('')
    expect(body.tenant).toBe('')
    expect(body.iai_tag).toBe('')
  })

  it('⚠️ maxOutputTokens **必须下发**（不能只用来过滤）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, { ...BASIC_OPTIONS, maxTokens: 4096 } as GenerateOptions)
    expect(sentBody(fetcher).max_output_tokens).toBe(4096)
  })

  it('未指定 maxTokens 时不发该字段（不编造数值）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    expect(Object.hasOwn(sentBody(fetcher), 'max_output_tokens')).toBe(false)
  })

  it('temperature 透传', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, { ...BASIC_OPTIONS, temperature: 0.3 } as GenerateOptions)
    expect(sentBody(fetcher).temperature).toBe(0.3)
  })

  it('tools 转成 { name, description, parameters_json } 下发', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      tools: [{
        name: 'read_file',
        description: '读文件',
        // ⚠️ 刻意用**驼峰参数名**：下面两条反向断言要证明它不被递归改写。
        parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
      }],
    } as unknown as GenerateOptions)
    const tools = sentBody(fetcher).tools as Array<Record<string, unknown>>
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('read_file')
    // ⚠️ 键名经 `accioToSnake` 变成 `parameters_json`。形状是**实测**的扁平形态
    //    （**不是** Gemini 的 `{function_declarations:[…]}`）：
    //    · 证据来源：Task 6 的真机探针 `probe-tool-shards.mjs` / `probe-tool-merge.mjs`
    //      下发的就是这个形态，上游回了真实 `function_call` 帧（`task-6-report.md` §4.2
    //      的 frame#8/#9/#10）。
    //    · ⚠️ **已验证但证据未留存**：探针在 gitignore 的 `.tmp-accio/`、无日志入库
    //      ⇒ 结论照用，但没有可复核的产物（agent-notes §10 的 U-F）。
    //    · ⚠️ 参数名安全的原因：schema 被 `JSON.stringify` 成**字符串**，而
    //      `accioToSnake` **不下钻字符串** ⇒ `filePath` 这类驼峰参数名是「数据」、
    //      不在改写路径上。见 `src/accio.ts` 的 `buildAccioBody` tools 区域警告。
    expect(typeof tools[0]!.parameters_json).toBe('string')
    // ⚠️⚠️ 反向守卫：schema 里出现**驼峰参数名**时，它必须逐字节保留在字符串里，
    //    绝不能被 `accioToSnake` 递归改写（那会让参数名与调用方按原 schema 消费的
    //    那份定义失配，且没有任何报错）。
    expect(tools[0]!.parameters_json).toContain('"filePath"')
    expect(tools[0]!.parameters_json).not.toContain('"file_path"')
    // 且**不得**退化成 Gemini 的包装形态（那是未实测的形状，且会激活上面的隐患）。
    expect(tools[0]).not.toHaveProperty('function_declarations')
    expect(tools[0]).not.toHaveProperty('functionDeclarations')
  })

  it('无 tools 时不发该字段', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    expect(Object.hasOwn(sentBody(fetcher), 'tools')).toBe(false)
  })

  it('⚠️⚠️ system_instruction 必须是**字符串**（对象形态实测恒流内 400）', async () => {
    // 实测（2026-10-13，唯一变量对照，各 3 轮）：
    //   system_instruction = "…"                ⇒ 200 ✅
    //   system_instruction = {parts:[{text}]}   ⇒ 200 + 流内 400 Invalid request format ❌
    // 而 `buildAccioBody` 产出的正是**对象**形态 ⇒ 适配器必须改写成字符串。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, { ...BASIC_OPTIONS, system: '你是助手' } as GenerateOptions)
    const sent = sentBody(fetcher).system_instruction
    expect(typeof sent, 'system_instruction 必须是字符串').toBe('string')
    expect(sent).toBe('你是助手')
  })

  it('无 system 时不发 system_instruction', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    expect(Object.hasOwn(sentBody(fetcher), 'system_instruction')).toBe(false)
  })

  it('会话命名请求（purpose=session-title）把预算抬到兜底下限', async () => {
    // Accio **关不掉思考**（实测四类字段全部无效）⇒ 只能走 `planSessionTitleThinking`
    // 的抬预算兜底；DSH 默认发 64 token 会被思考吃满、正文零产出（issue IKKVDH）。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS, purpose: 'session-title', maxTokens: 64,
    } as GenerateOptions)
    expect(sentBody(fetcher).max_output_tokens).toBe(512)
  })

  it('普通请求的预算不被抬高（逐字段原样透传）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, { ...BASIC_OPTIONS, maxTokens: 64 } as GenerateOptions)
    expect(sentBody(fetcher).max_output_tokens).toBe(64)
  })
})

// ---------------------------------------------------------------------------
// 消息序列化（DSH 0.1.7 双形状）
// ---------------------------------------------------------------------------

describe('AccioAdapter · 消息序列化', () => {
  it('system 抽到 system_instruction，用户消息进 contents', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [{ role: 'user', content: '你好' }],
      system: 'SYS',
    } as GenerateOptions)
    const body = sentBody(fetcher)
    expect(body.system_instruction).toBe('SYS')
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '你好' }] }])
  })

  it('⚠️ 工具历史（0.1.7 一等 role:tool）必须下发为 functionResponse', async () => {
    // 真实缺陷形态：不归一化时 `tool-result` 判据恒不命中 ⇒ 工具输出被静默丢弃
    // ⇒ 模型看不到工具结果，表现为提前结束或循环思考。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: '读文件' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"file_path":"a.txt"}' }],
        },
        // 0.1.7：工具结果是一等消息，toolCallId 在**顶层**。
        { role: 'tool', toolCallId: 'c1', content: '文件内容' },
      ],
    } as unknown as GenerateOptions)

    const contents = sentBody(fetcher).contents as Array<Record<string, unknown>>
    const assistant = contents.find((c) => c.role === 'model') as { parts: Array<Record<string, unknown>> }
    expect(assistant, 'assistant 的 tool_calls 不得被剔除').toBeDefined()
    // ⚠️ 断言的是**真实 wire 形状**：`buildAccioBody` 会走 `accioToSnake`，
    // 故 `functionCall` → `function_call`、`argsJson` → `args_json`（实测如此）。
    const call = assistant.parts.find((p) => p.function_call !== undefined) as {
      function_call: { id: string; name: string; args_json: string }
    }
    expect(call, 'assistant 必须下发 function_call').toBeDefined()
    expect(call.function_call.name).toBe('read_file')
    expect(call.function_call.id).toBe('c1')
    expect(JSON.parse(call.function_call.args_json)).toEqual({ file_path: 'a.txt' })

    // ⚠️ 工具结果必须真的下发，且带上 **id 与 name**（上游按 name 配对）。
    const resultPart = contents
      .flatMap((c) => (c.parts ?? []) as Array<Record<string, unknown>>)
      .find((p) => p.function_response !== undefined) as
      | { function_response: { id: string; name: string; response_json: string } }
      | undefined
    expect(resultPart, '工具结果不得被静默丢弃').toBeDefined()
    expect(resultPart!.function_response.id).toBe('c1')
    expect(resultPart!.function_response.name).toBe('read_file')
    expect(resultPart!.function_response.response_json).toBe('文件内容')
  })

  it('0.1.5 包裹形态（tool-result 块）与 0.1.7 形态序列化结果一致', async () => {
    const legacy = {
      ...BASIC_OPTIONS,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"file_path":"a.txt"}' }],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '文件内容' }] }],
        },
      ],
    } as unknown as GenerateOptions
    const modern = {
      ...BASIC_OPTIONS,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"file_path":"a.txt"}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: '文件内容' },
      ],
    } as unknown as GenerateOptions

    const a = makeAdapter({ responses: [okResponse()] })
    await collect(a.adapter, legacy)
    const b = makeAdapter({ responses: [okResponse()] })
    await collect(b.adapter, modern)

    // ⚠️ 逐字节等价：比逐个断言字段更强，且对实现方式中立。
    const norm = (body: Record<string, unknown>): unknown => {
      const contents = body.contents as Array<Record<string, unknown>>
      // name 在 0.1.5 形态下由 assistant 的 tool-call 回填，两条路径都必须有。
      return contents
    }
    expect(norm(sentBody(b.fetcher))).toEqual(norm(sentBody(a.fetcher)))
  })

  it('孤儿 tool-call 被剔除（无结果时不下发，避免上游 400）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'orphan', name: 'read_file', arguments: '{}' }] },
      ],
    } as unknown as GenerateOptions)
    // ⚠️⚠️ 判据必须是 **snake_case** 的 `function_call`：`buildAccioBody` 会走
    // `accioToSnake`，wire 上没有 `functionCall` 这个键。初版按驼峰过滤
    // ⇒ 过滤结果恒为 `[]` ⇒ 断言恒真、**什么都没锁住**（本用例当时是空转的）。
    const contents = sentBody(fetcher).contents as Array<Record<string, unknown>>
    const calls = contents.flatMap((c) => (c.parts ?? []) as Array<Record<string, unknown>>)
      .filter((p) => p.function_call !== undefined)
    expect(calls, '孤儿 tool-call 不得下发').toHaveLength(0)
  })

  it('⚠️ 正向对照：配对完整的 tool-call **必须**在 body 里（否则上面的过滤器恒空也照样通过）', async () => {
    // 没有这条对照，`filter(p => p.function_call !== undefined)` 即使写成
    // 恒不命中的键名也能「通过」—— 那是同义反复，不是守卫。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"file_path":"a.txt"}' }] },
        { role: 'tool', toolCallId: 'c1', content: '文件内容' },
      ],
    } as unknown as GenerateOptions)
    const contents = sentBody(fetcher).contents as Array<Record<string, unknown>>
    const calls = contents.flatMap((c) => (c.parts ?? []) as Array<Record<string, unknown>>)
      .filter((p) => p.function_call !== undefined)
    // 必须恰好一条：既证明过滤器能命中，也证明配对完整的调用没被误剔。
    expect(calls, '配对完整的 tool-call 必须下发').toHaveLength(1)
    expect((calls[0]!.function_call as { id: string }).id).toBe('c1')
    // 结果侧同样要有对照（孤儿剔除不能把合法结果也剔掉）。
    const results = contents.flatMap((c) => (c.parts ?? []) as Array<Record<string, unknown>>)
      .filter((p) => p.function_response !== undefined)
    expect(results, '配对完整的工具结果必须下发').toHaveLength(1)
  })

  it('孤儿 tool-result 同样被剔除（有结果但无对应调用）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', toolCallId: 'no-such-call', content: '文件内容' },
      ],
    } as unknown as GenerateOptions)
    const contents = sentBody(fetcher).contents as Array<Record<string, unknown>>
    const results = contents.flatMap((c) => (c.parts ?? []) as Array<Record<string, unknown>>)
      .filter((p) => p.function_response !== undefined)
    expect(results, '孤儿 tool-result 不得下发').toHaveLength(0)
  })

  it('developer 消息被丢弃（它只承载工具增删元数据）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'developer', content: 'tool-addition metadata' },
        { role: 'user', content: 'hi' },
      ],
    } as unknown as GenerateOptions)
    const text = JSON.stringify(sentBody(fetcher).contents)
    expect(text).not.toContain('tool-addition metadata')
  })
})

// ---------------------------------------------------------------------------
// 图片：明确报错，不静默丢弃
// ---------------------------------------------------------------------------

describe('AccioAdapter · 图片', () => {
  it('⚠️ 收到图片时显式报 UNSUPPORTED_CONTENT（不静默丢弃）', async () => {
    // `inputModalities` 省略 = 未知 ⇒ DSH 会把图片放行到这里。
    // 而本 provider 的图片通路**未实测**、序列化层只保留 text 块 ⇒
    // 若不显式拒绝，图片会被**静默丢掉**（用户以为模型看到了）。
    const { adapter } = makeAdapter({ responses: [okResponse()] })
    const error = await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image', attachment: { attachmentId: 'att-1' } },
        ],
      }],
    } as unknown as GenerateOptions).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
  })

  it('⚠️⚠️ 嵌套在 tool-result 里的图片同样必须报错（守卫必须递归）', async () => {
    // 真实缺陷（本轮修复）：守卫初版只扫**顶层** `message.content`，
    // 而 `normalizeHarnessMessages` 刻意**整体保留** content 数组，
    // `tool-result` 块的 `content` 里可以内嵌 `image`（本仓库其余适配器
    // 都按这个形状收图）。只扫一层 ⇒ 这种图片**绕过守卫**，
    // 再被 `serializeAccioMessages` 的 `flattenText`（只留 text 块）
    // **静默丢掉** —— 与守卫自己承诺的「绝不静默丢弃」直接矛盾。
    //
    // ⚠️ 本用例覆盖 **0.1.7 一等 `role:'tool'`** 形态。注意：守卫看的是
    // `options.messages`（**未归一化**的原始形状），而 0.1.7 的一等工具消息
    // 其 `content` 本来就在**顶层** ⇒ 该形态**不足以**区分「递归」与「只扫一层」。
    // 真正能区分的是下一条 **0.1.5 包裹形态**用例（那里 `tool-result`
    // 的 `content` 才是真正的第二层）—— 反向验证时红的正是它。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    const error = await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: '看图' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'screenshot', arguments: '{}' }],
        },
        {
          role: 'tool',
          toolCallId: 'c1',
          content: [
            { type: 'text', text: '截图如下' },
            { type: 'image', attachment: { attachmentId: 'att-nested' } },
          ],
        },
      ],
    } as unknown as GenerateOptions).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
    // 而且必须**在发请求之前**就拒绝（守卫在 `stream()` 第一段）。
    expect(fetcher, '不得先把带图的请求发出去').not.toHaveBeenCalled()
  })

  it('⚠️⚠️ 0.1.5 包裹形态里**第二层**的嵌套图片必须报错（递归守卫的判别用例）', async () => {
    // ⚠️ 这条是 Finding #3 的**判别用例**：图片在 `tool-result` 块的 `content`
    // 里（真正的第二层）。只扫顶层的旧实现会漏掉它 ⇒ 图片被 `flattenText`
    // 静默丢弃。反向验证 (b) 时**只有这条**变红。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    const error = await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        {
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'c1',
            content: [
              { type: 'text', text: '截图如下' },
              { type: 'image', attachment: { attachmentId: 'att-nested' } },
            ],
          }],
        },
      ],
    } as unknown as GenerateOptions).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
    expect(fetcher, '不得先把带图的请求发出去').not.toHaveBeenCalled()
  })

  it('无图片时不误报（纯文本与纯文本工具结果照常放行）', async () => {
    // 反向对照：递归收集器不能把「没有图片」判成「有图片」，
    // 否则所有带工具结果的会话都会被这条守卫拒掉。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '文件内容' }] },
      ],
    } as unknown as GenerateOptions)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// SSE → StreamChunk
// ---------------------------------------------------------------------------

describe('AccioAdapter · SSE 转换', () => {
  it('正文与思考各自成块（thought 不得混入正文）', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([thoughtPart('想想')]),
        frame([textPart('你好')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const kinds = chunks.filter((c) => c.type === 'block-start').map((c) => (c as { blockType: string }).blockType)
    expect(kinds).toEqual(['reasoning', 'text'])
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(reasoning).toBe('想想')
    expect(text).toBe('你好')
  })

  it('usage 与 finish 正常收尾', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([textPart('好')]),
        { content: { role: 'model', parts: [] }, usage_metadata: { prompt_token_count: 3, candidates_token_count: 1, total_token_count: 4 } },
        { turn_complete: true, finish_reason: 'stop' },
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(chunks.some((c) => c.type === 'usage')).toBe(true)
    const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string } }
    expect(finish.reason.kind).toBe('stop')
  })
})

describe('AccioAdapter · 工具调用分片合并（实测缺陷回归）', () => {
  /**
   * 实测（2026-10-13，三轮取样）上游把**一次**工具调用拆成多帧：
   * 首帧 `{id,name}`（无 `args_json`），后续帧**重复完整的** `args_json`。
   * `consumeAccioSse` 不跨帧合并 ⇒ 会产出 N 个独立 tool-call 块
   * （首块参数 `{}`，后续块参数完整）⇒ harness 会执行 **3 次**同一个工具调用。
   * 合并职责归适配器（设计如此）。
   */
  const SHARDED = [
    frame([callPart('call_1', 'read_file')]),
    frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
    frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
  ]

  it('⚠️ 三帧分片合并成**恰好一个** tool-call 块，且参数完整', async () => {
    const { adapter } = makeAdapter({ responses: [sseResponse(accioSse(...SHARDED))] })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const toolEnds = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(toolEnds, '分片必须合并成一个调用').toHaveLength(1)
    const block = (toolEnds[0] as { block: { name: string; arguments: string } }).block
    expect(block.name).toBe('read_file')
    expect(JSON.parse(block.arguments)).toEqual({ file_path: 'a.txt' })
    const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string } }
    expect(finish.reason.kind).toBe('tool-calls')
  })

  it('两个**参数不同**的并行调用不被误合并', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([callPart('call_a', 'read_file')]),
        frame([callPart('call_a', 'read_file', '{"file_path":"a.txt"}')]),
        frame([callPart('call_a', 'read_file', '{"file_path":"a.txt"}')]),
        frame([callPart('call_b', 'read_file')]),
        frame([callPart('call_b', 'read_file', '{"file_path":"b.txt"}')]),
        frame([callPart('call_b', 'read_file', '{"file_path":"b.txt"}')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const args = chunks
      .filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
      .map((c) => JSON.parse((c as { block: { arguments: string } }).block.arguments) as Record<string, unknown>)
    expect(args).toHaveLength(2)
    expect(args.map((a) => a.file_path).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('单个完整帧（无分片）原样透传', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const toolEnds = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(toolEnds).toHaveLength(1)
    expect(JSON.parse((toolEnds[0] as { block: { arguments: string } }).block.arguments))
      .toEqual({ file_path: 'a.txt' })
  })

  it('工具调用与正文并存时，正文块不受合并影响', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([textPart('让我看看')]),
        frame([callPart('call_1', 'read_file')]),
        frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text).toBe('让我看看')
    expect(chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')).toHaveLength(1)
  })

  it('⚠️ 同一帧里 text 与 function_call 并存时，正文不得被吞掉', async () => {
    // 真实缺陷（自审抓到）：合并层若把**整帧**吸收进缓冲，同一帧里的
    // `text` part 会**静默消失** —— 模型写的话凭空不见，且没有任何报错。
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([textPart('我要读文件'), callPart('call_1', 'read_file')]),
        frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text, '同帧正文不得被静默丢弃').toBe('我要读文件')
    const toolEnds = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(toolEnds).toHaveLength(1)
    expect(JSON.parse((toolEnds[0] as { block: { arguments: string } }).block.arguments))
      .toEqual({ file_path: 'a.txt' })
  })

  it('⚠️ 同帧里的 thought part 也不得被吞掉', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([thoughtPart('需要读文件'), callPart('call_1', 'read_file')]),
        frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta')
      .map((c) => (c as { text: string }).text).join('')
    expect(reasoning, '同帧思考不得被静默丢弃').toBe('需要读文件')
  })
})

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

describe('AccioAdapter · 错误分类', () => {
  it('⚠️ 流内 402 ⇒ QUOTA_EXCEEDED（不得归 SERVER，否则白重试 5 次）', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse('data: {"turn_complete":true,"error_code":"402","error_message":"unauthorized"}\n')],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
  })

  it('流内 402 的文案逐字保留服务端原文（便于排障）', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse('data: {"turn_complete":true,"error_code":"402","error_message":"unauthorized"}\n')],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { message: string }).message).toContain('unauthorized')
  })

  it('HTTP 402 ⇒ QUOTA_EXCEEDED', async () => {
    const { adapter } = makeAdapter({
      responses: [new Response('{"error":"insufficient balance"}', { status: 402 })],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
  })

  it('HTTP 401 ⇒ AUTH（且刷新一次凭据后重试）', async () => {
    const { adapter, fetcher, refresh } = makeAdapter({
      responses: [
        new Response('unauthorized', { status: 401 }),
        sseResponse(accioSse(frame([textPart('好了')]))),
      ],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(refresh).toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('⚠️⚠️ 401 重试必须带**刷新后的新 token**（旧 token 在 body 里，不是请求头）', async () => {
    // 真实缺陷（本轮修复）：令牌在 `body.token`，而 `send()` 只从 `credential`
    // 取 `sgcookie` **请求头** ⇒ 刷新后沿用同一个 `body` 就是「重发旧 token」，
    // 该分支结构性失效，且 `AUTH` 不在 harness 的可重试集合里 ⇒ 本可自愈的
    // 凭据退化成硬失败 + 白烧一次 refresh_token。
    //
    // ⚠️ 本用例的关键是 `credentialAfterRefresh`：若 refresh 前后都返回 `'OLD'`
    // （既有那条用例的桩），**旧实现照样通过** —— 那样的用例抓不到这个缺陷。
    const { adapter, fetcher, refresh } = makeAdapter({
      credential: makeCredential({ access_token: 'OLD' }),
      credentialAfterRefresh: makeCredential({ access_token: 'NEW' }),
      responses: [
        new Response('unauthorized', { status: 401 }),
        sseResponse(accioSse(frame([textPart('好了')]))),
      ],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    // 断言**两次真实请求体**（不是断言实现细节）。
    expect(sentBody(fetcher, 0).token, '首次必须用刷新前的 token').toBe('OLD')
    expect(sentBody(fetcher, 1).token, '重试必须用刷新后的 token').toBe('NEW')
    // ⚠️ 同一次逻辑请求：`message_id` / `request_id` 不得因重试而改变
    // （重建 body 会经 `accioMessageId()` 掺入新随机量，等于换了请求身份）。
    expect(sentBody(fetcher, 1).message_id).toBe(sentBody(fetcher, 0).message_id)
    expect(sentBody(fetcher, 1).request_id).toBe(sentBody(fetcher, 0).request_id)
    // 重试成功后照常产出内容（证明它真的能自愈）。
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('HTTP 403 同样刷新后带新 token 重试（与 401 同一分支）', async () => {
    const { adapter, fetcher } = makeAdapter({
      credential: makeCredential({ access_token: 'OLD' }),
      credentialAfterRefresh: makeCredential({ access_token: 'NEW' }),
      responses: [
        new Response('forbidden', { status: 403 }),
        sseResponse(accioSse(frame([textPart('好了')]))),
      ],
    })
    await collect(adapter, BASIC_OPTIONS)
    expect(sentBody(fetcher, 0).token).toBe('OLD')
    expect(sentBody(fetcher, 1).token).toBe('NEW')
  })

  it('HTTP 500 ⇒ SERVER（可重试类）', async () => {
    const { adapter } = makeAdapter({ responses: [new Response('boom', { status: 500 })] })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('SERVER')
  })

  it('HTTP 429 ⇒ RATE_LIMIT', async () => {
    const { adapter } = makeAdapter({ responses: [new Response('slow down', { status: 429 })] })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('RATE_LIMIT')
  })

  it('无可用凭据 ⇒ MISSING_CREDENTIAL', async () => {
    const { adapter } = makeAdapter({ credential: null })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('MISSING_CREDENTIAL')
  })

  it('凭据过期时先静默续期再发请求', async () => {
    const expired = makeCredential({ expires_at: Date.now() - 1000 })
    const { adapter, refresh } = makeAdapter({
      credential: expired,
      responses: [sseResponse(accioSse(frame([textPart('好')])))],
    })
    await collect(adapter, BASIC_OPTIONS)
    expect(refresh).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// prepareCall
// ---------------------------------------------------------------------------

describe('AccioAdapter · prepareCall', () => {
  it('返回模型信息与绑定的 stream 函数（PR !66：必须包 prepareCall）', async () => {
    const { adapter, fetcher } = makeAdapter({
      remoteModels: [{ id: 'm1', name: 'Qwen', contextWindow: 512_000, multiple: 0.013 }],
      responses: [sseResponse(accioSse(frame([textPart('好')])))],
    })
    const prepared = await adapter.prepareCall(ACCIO_PROVIDER, 'm1')
    expect(prepared.model.id).toBe('m1')
    expect(prepared.model.context?.contextWindow).toBe(512_000)
    expect(typeof prepared.stream).toBe('function')
    // 经 prepareCall 返回的 stream 必须真能发请求（不是空壳）。
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...BASIC_OPTIONS, model: 'm1' } as GenerateOptions)) chunks.push(chunk)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})
