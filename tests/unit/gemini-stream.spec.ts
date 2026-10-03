/**
 * Gemini 适配器 `stream()` 的**救场链路**单测。
 *
 * ## 守的是什么
 *
 * `gemini-adapter.ts` 的 `stream()` 是本 provider 唯一"自己会重试"的地方，
 * 四层救场的**顺序**就是它的全部语义（计划 §3.1）：
 *
 * 1. 签名被拒 → **去签重试一次**（同账号同端点）
 * 2. 403 / 404 / 400+quota → **先换端点**（廉价兜底，只做一次）
 * 3. 401 → **先续期**（一次），续期成功则**不换端点也不换号**
 * 4. 限流/失效 → 记冷却 → **换账号**（最多 `GEMINI_MAX_ROTATE` 个）
 *
 * ⚠️ 顺序写错的后果不是"多试一次"，而是**用户看到莫名其妙的报错**：
 * 把 429 直接归类成 RATE_LIMIT 会让 harness 原地退避重试同一个已限流的
 * 账号（永远好不了），而正确行为是换号。
 *
 * ⚠️ 本适配器**不走 `fetchImpl` 注入**（直接调全局 `fetch`），故这里必须
 * `vi.stubGlobal('fetch', …)` —— 忘了替换会真的打到 Google 端点。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { GeminiAdapter } from '../../src/gemini-adapter.js'
import {
  GEMINI,
  GEMINI_ENDPOINT_DAILY,
  GEMINI_ENDPOINT_SANDBOX,
  GEMINI_STREAM_PATH,
  type GeminiCredential,
} from '../../src/gemini.js'
import type { AccountPool } from '../../src/account-pool.js'
import type { GeminiSigStore } from '../../src/gemini-sigstore.js'

const MODEL = 'gemini-3.8-flash'

function cred(token: string): GeminiCredential {
  return { access_token: token, refresh_token: 'RT', expiry: '2099-01-01T00:00:00Z' }
}

function options(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: GEMINI.id,
    model: MODEL,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    ...extra,
  }
}

/** 一帧能产出内容块的合法 SSE（`[DONE]` 单独出现会被判成空响应）。 */
const SSE_OK = `data: ${JSON.stringify({
  response: {
    candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
  },
})}\n\ndata: [DONE]\n\n`

function okStream(): Response {
  return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 逐次返回不同响应，并记录每次的 URL 与 init。 */
function recordingFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let index = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const make = responses[Math.min(index, responses.length - 1)]!
    index += 1
    return make()
  }))
  return { calls, count: () => index }
}

/** 只实现换号链路用到的方法。 */
function makePool(plan: {
  current?: string
  next?: Array<{ id: string; token: string }>
  onRateLimit?: (accountId: string, model: string, resetAtMs: number) => void
  onQuery?: (exclude: ReadonlySet<string>) => void
}): AccountPool {
  const queue = [...(plan.next ?? [])]
  return {
    findAccountIdByCredential: async () => plan.current ?? '',
    updateModelRateLimit: async (accountId: string, model: string, resetAtMs: number) => {
      plan.onRateLimit?.(accountId, model, resetAtMs)
    },
    getAvailableAccount: async (
      _provider: string,
      _model: string,
      exclude?: ReadonlySet<string>,
    ) => {
      const skip = exclude ?? new Set<string>()
      plan.onQuery?.(skip)
      while (queue.length > 0) {
        const head = queue.shift()!
        if (skip.has(head.id)) continue
        return { entry: { id: head.id, provider: GEMINI.id }, credential: cred(head.token) }
      }
      return null
    },
  } as unknown as AccountPool
}

function makeAdapter(config: {
  credential?: GeminiCredential
  afterRefresh?: GeminiCredential
  refreshCalls?: { count: number }
  pool?: AccountPool
  sigStore?: GeminiSigStore
  sessionId?: string
}): GeminiAdapter {
  let current = config.credential
  return new GeminiAdapter({
    credentialRef: credentialRef('GEMINI_ACCOUNT_TEST'),
    resolveCredential: async () => current,
    refresh: async () => {
      if (config.refreshCalls !== undefined) config.refreshCalls.count += 1
      if (config.afterRefresh !== undefined) current = config.afterRefresh
    },
    ...config.pool === undefined ? {} : { accountPool: config.pool },
    ...config.sigStore === undefined ? {} : { sigStore: config.sigStore },
    ...config.sessionId === undefined ? {} : { sessionId: config.sessionId },
    product: GEMINI,
  })
}

async function drain(adapter: GeminiAdapter, opts: GenerateOptions): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of adapter.stream(opts)) chunks.push(chunk)
  return chunks
}

async function capture(
  adapter: GeminiAdapter,
  opts: GenerateOptions,
): Promise<{ code?: string; message: string; failure?: { status?: number } } | undefined> {
  try {
    await drain(adapter, opts)
    return undefined
  } catch (error) {
    return error as { code?: string; message: string; failure?: { status?: number } }
  }
}

function makeSigStore(signature: string | undefined): {
  store: GeminiSigStore
  puts: Array<[string, string, string]>
  flushes: () => number
} {
  const puts: Array<[string, string, string]> = []
  let flushes = 0
  const store = {
    get: () => signature,
    put: (name: string, argsJson: string, sig: string) => { puts.push([name, argsJson, sig]) },
    flush: async () => { flushes += 1 },
  } as unknown as GeminiSigStore
  return { store, puts, flushes: () => flushes }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gemini stream · 凭据与请求形状', () => {
  it('未知模型 id 抛 INVALID_REQUEST（先查表，不取凭据不发请求）', async () => {
    const { calls } = recordingFetch([() => okStream()])
    const refreshCalls = { count: 0 }
    const adapter = makeAdapter({ refreshCalls })
    const error = await capture(adapter, options({ model: 'gemini-9.9-fake' }))
    expect(error?.code).toBe('INVALID_REQUEST')
    expect(error?.message).toContain('gemini-9.9-fake')
    // ⚠️ 状态码是给网关看的：只读 `failure.status`（顶层无 status），缺了它
    // 这条确定性失败会以 502 离开网关，被客户端当服务端故障反复重试。
    expect(error?.failure?.status).toBe(404)
    expect(calls).toHaveLength(0)
    // 纯本地判定：连凭据续期都不该触发
    expect(refreshCalls.count).toBe(0)
  })

  it('带档位的模型 id（限流标记/探测形态）照常发请求', async () => {
    const { calls } = recordingFetch([() => okStream()])
    await drain(makeAdapter({ credential: cred('AT') }), options({ model: 'gemini-3.8-flash-high' }))
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string }
    // upstream 由 effort 决定（未传档位 = medium），不是 id 后缀
    expect(body.model).toBe('gemini-3.8-flash-medium')
  })

  it('无凭据抛 MISSING_CREDENTIAL（不发请求）', async () => {
    const { calls } = recordingFetch([() => okStream()])
    const adapter = makeAdapter({})
    const error = await capture(adapter, options())
    expect(error?.code).toBe('MISSING_CREDENTIAL')
    expect(calls).toHaveLength(0)
  })

  it('凭据过期时先 refresh 再取新凭据', async () => {
    const refreshCalls = { count: 0 }
    const { calls } = recordingFetch([() => okStream()])
    const adapter = makeAdapter({
      credential: { access_token: 'OLD', refresh_token: 'RT', expiry: '2000-01-01T00:00:00Z' },
      afterRefresh: cred('NEW'),
      refreshCalls,
    })
    const chunks = await drain(adapter, options())
    expect(refreshCalls.count).toBe(1)
    expect((calls[0]!.init.headers as Headers).get('Authorization')).toBe('Bearer NEW')
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('请求发往 daily 端点、带流式路径，且**不带 Accept**', async () => {
    const { calls } = recordingFetch([() => okStream()])
    await drain(makeAdapter({ credential: cred('AT') }), options())
    expect(calls[0]!.url).toBe(`${GEMINI_ENDPOINT_DAILY}${GEMINI_STREAM_PATH}`)
    const headers = calls[0]!.init.headers as Headers
    expect(headers.get('Accept')).toBeNull()
    expect(headers.get('x-client-name')).toBe('antigravity')
    expect(headers.get('User-Agent')).toContain('antigravity/')
  })

  it('请求体是字母序信封，且模型名带档位后缀', async () => {
    const { calls } = recordingFetch([() => okStream()])
    await drain(makeAdapter({ credential: cred('AT') }), options({ reasoningEffort: 'high' as never }))
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.model).toBe('gemini-3.8-flash-high')
    expect(body.request).toBeDefined()
    // 字母序：model < project < request < requestId < userAgent
    const keys = Object.keys(body)
    expect(keys).toEqual([...keys].sort())
  })
})

describe('gemini stream · 空响应与网络失败', () => {
  it('ok 但没有 body → EMPTY_RESPONSE', async () => {
    recordingFetch([() => new Response(null, { status: 200 })])
    const error = await capture(makeAdapter({ credential: cred('AT') }), options())
    expect(error?.code).toBe('EMPTY_RESPONSE')
  })

  it('fetch 抛错 → TRANSPORT（交给 harness 退避）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const error = await capture(makeAdapter({ credential: cred('AT') }), options())
    expect(error?.code).toBe('TRANSPORT')
    expect(error?.message).toMatch(/请求发送失败/)
  })

  it('空 SSE（只有 [DONE]）→ 透传消费器的「未返回任何内容块」', async () => {
    recordingFetch([() => new Response('data: [DONE]\n\n', { status: 200 })])
    const error = await capture(makeAdapter({ credential: cred('AT') }), options())
    expect(error?.message).toMatch(/未返回任何内容块/)
  })
})

describe('gemini stream · 签名去签重试', () => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: '读文件' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'read_file', arguments: '{"path":"a.go"}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'text', text: '内容' }] }] },
  ] as unknown as GenerateOptions['messages']

  it('签名被拒 → 去签重试一次（同账号、同端点）', async () => {
    const { calls } = recordingFetch([
      () => new Response('Invalid thought signature', { status: 400 }),
      () => okStream(),
    ])
    const sig = makeSigStore('SIG_FC')
    const chunks = await drain(
      makeAdapter({ credential: cred('AT'), sigStore: sig.store }),
      options({ messages: history }),
    )

    expect(calls).toHaveLength(2)
    // 同端点：签名问题与端点无关，翻端点只是白费一次。
    expect(calls[0]!.url).toBe(calls[1]!.url)
    expect(String(calls[0]!.init.body)).toContain('thoughtSignature')
    expect(String(calls[1]!.init.body)).not.toContain('thoughtSignature')
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('上游下发的签名被写入缓存，且退出时落盘', async () => {
    const sse = `data: ${JSON.stringify({
      response: {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.go' } }, thoughtSignature: 'SIG_NEW' }] },
          finishReason: 'STOP',
        }],
      },
    })}\n\ndata: [DONE]\n\n`
    recordingFetch([() => new Response(sse, { status: 200 })])
    const sig = makeSigStore(undefined)
    await drain(makeAdapter({ credential: cred('AT'), sigStore: sig.store }), options())
    expect(sig.puts).toEqual([['read_file', '{"path":"a.go"}', 'SIG_NEW']])
    expect(sig.flushes()).toBeGreaterThan(0)
  })
})

describe('gemini stream · 端点救场', () => {
  it('403 先翻到 sandbox 端点，再失败才归类 SERVER（无池时）', async () => {
    const { calls } = recordingFetch([() => new Response('forbidden', { status: 403 })])
    const error = await capture(makeAdapter({ credential: cred('AT') }), options())
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url.startsWith(GEMINI_ENDPOINT_DAILY)).toBe(true)
    expect(calls[1]!.url.startsWith(GEMINI_ENDPOINT_SANDBOX)).toBe(true)
    // ⚠️ 403 归 SERVER 而不是 AUTH —— 否则会把用户引向「重新登录」这个无效动作。
    expect(error?.code).toBe('SERVER')
    expect(error?.failure?.status).toBe(403)
  })

  it('429 也先翻端点（端点切换只做一次，不无限来回）', async () => {
    const { calls } = recordingFetch([() => new Response('rate limited', { status: 429 })])
    const error = await capture(makeAdapter({ credential: cred('AT') }), options())
    expect(calls).toHaveLength(2)
    expect(error?.code).toBe('RATE_LIMIT')
  })
})

describe('gemini stream · 401 先续期', () => {
  it('401 → 续期一次后用新凭据重试，**不换端点也不换号**', async () => {
    const refreshCalls = { count: 0 }
    const rateLimited: string[] = []
    const { calls } = recordingFetch([
      () => new Response('unauthorized', { status: 401 }),
      () => okStream(),
    ])
    const adapter = makeAdapter({
      credential: cred('AT-OLD'),
      afterRefresh: cred('AT-NEW'),
      refreshCalls,
      pool: makePool({ current: 'acc-1', onRateLimit: (id) => rateLimited.push(id) }),
    })
    await drain(adapter, options())

    expect(refreshCalls.count).toBe(1)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url.startsWith(GEMINI_ENDPOINT_DAILY)).toBe(true)
    expect((calls[1]!.init.headers as Headers).get('Authorization')).toBe('Bearer AT-NEW')
    // 续期救回来了，就不该记冷却、也不该换号。
    expect(rateLimited).toEqual([])
  })
})

describe('gemini stream · 换号救场', () => {
  it('429 换到下一个账号并成功（新凭据、回到默认端点）', async () => {
    const { calls } = recordingFetch([
      () => new Response('rate limited', { status: 429 }),
      () => new Response('rate limited', { status: 429 }),
      () => okStream(),
    ])
    const marks: Array<{ id: string; model: string; at: number }> = []
    const adapter = makeAdapter({
      credential: cred('AT-1'),
      pool: makePool({
        current: 'acc-1',
        next: [{ id: 'acc-2', token: 'AT-2' }],
        onRateLimit: (id, model, at) => marks.push({ id, model, at }),
      }),
    })
    const chunks = await drain(adapter, options())

    expect(calls).toHaveLength(3)
    // 第 3 次：新账号 + 回到 daily（换号后端点状态被重置）。
    expect(calls[2]!.url.startsWith(GEMINI_ENDPOINT_DAILY)).toBe(true)
    expect((calls[2]!.init.headers as Headers).get('Authorization')).toBe('Bearer AT-2')
    expect(chunks.length).toBeGreaterThan(0)
    // 冷却标记打在**被限流的那个账号**上，时长是 60 秒（不是 401 的 300 秒）。
    expect(marks).toHaveLength(1)
    expect(marks[0]!.id).toBe('acc-1')
    expect(marks[0]!.model).toBe(MODEL)
    expect(marks[0]!.at - Date.now()).toBeGreaterThan(50_000)
    expect(marks[0]!.at - Date.now()).toBeLessThanOrEqual(60_000)
  })

  it('401 换号时冷却时长是 300 秒（凭据失效比限流更严重）', async () => {
    const { calls } = recordingFetch([
      () => new Response('unauthorized', { status: 401 }),
      () => new Response('unauthorized', { status: 401 }),
      () => okStream(),
    ])
    const marks: Array<{ id: string; at: number }> = []
    const adapter = makeAdapter({
      credential: cred('AT-1'),
      pool: makePool({
        current: 'acc-1',
        next: [{ id: 'acc-2', token: 'AT-2' }],
        onRateLimit: (id, _model, at) => marks.push({ id, at }),
      }),
    })
    await drain(adapter, options())

    expect(calls).toHaveLength(3)
    expect(marks).toHaveLength(1)
    expect(marks[0]!.at - Date.now()).toBeGreaterThan(290_000)
    expect(marks[0]!.at - Date.now()).toBeLessThanOrEqual(300_000)
  })

  it('所有账号都不可用 → QUOTA_EXCEEDED（不无限循环）', async () => {
    const { calls } = recordingFetch([() => new Response('rate limited', { status: 429 })])
    const adapter = makeAdapter({
      credential: cred('AT-1'),
      pool: makePool({ current: 'acc-1', next: [] }),
    })
    const error = await capture(adapter, options())
    expect(error?.code).toBe('QUOTA_EXCEEDED')
    expect(error?.message).toMatch(/所有账号均不可用/)
    // 一次端点切换 + 一次换号失败判定，不该再多。
    expect(calls.length).toBeLessThanOrEqual(3)
  })

  it('换号后仍限流 → 继续换到第三个账号（GEMINI_MAX_ROTATE = 3）', async () => {
    const { calls } = recordingFetch([
      () => new Response('rate limited', { status: 429 }),
      () => new Response('rate limited', { status: 429 }),
      () => new Response('rate limited', { status: 429 }),
      () => new Response('rate limited', { status: 429 }),
      () => okStream(),
    ])
    const adapter = makeAdapter({
      credential: cred('AT-1'),
      pool: makePool({
        current: 'acc-1',
        next: [{ id: 'acc-2', token: 'AT-2' }, { id: 'acc-3', token: 'AT-3' }],
      }),
    })
    const chunks = await drain(adapter, options())
    expect(chunks.length).toBeGreaterThan(0)
    // 最后一次成功请求用的是第三个账号。
    expect((calls.at(-1)!.init.headers as Headers).get('Authorization')).toBe('Bearer AT-3')
  })

  it('起始账号会先按凭据反查并加入 tried（不会换回自己）', async () => {
    const seen: Array<string[]> = []
    const { calls } = recordingFetch([
      () => new Response('rate limited', { status: 429 }),
      () => new Response('rate limited', { status: 429 }),
      () => okStream(),
    ])
    const adapter = makeAdapter({
      credential: cred('AT-1'),
      pool: makePool({
        current: 'acc-1',
        next: [{ id: 'acc-2', token: 'AT-2' }],
        onQuery: (exclude) => seen.push([...exclude]),
      }),
    })
    await drain(adapter, options())
    expect(calls).toHaveLength(3)
    expect(seen[0]).toEqual(['acc-1'])
  })
})

describe('gemini stream · 档位与模型', () => {
  it('未知档位被丢弃（回落到默认 medium，不发一个上游不认的档）', async () => {
    const { calls } = recordingFetch([() => okStream()])
    await drain(
      makeAdapter({ credential: cred('AT') }),
      options({ reasoningEffort: 'ultra' as never }),
    )
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string }
    expect(body.model).toBe('gemini-3.8-flash-medium')
  })

  // （原「未知模型 id 也被拼上默认档后缀」用例已随严格校验移除：
  //  未知 id 现在在查表处直接抛 INVALID_REQUEST，见「凭据与请求形状」段 ——
  //  静默落回 3.8 正是本次修复的行为。）

  it('自适应档只发 includeThoughts（不发 thinkingBudget）', async () => {
    const { calls } = recordingFetch([() => okStream()])
    await drain(
      makeAdapter({ credential: cred('AT') }),
      options({ reasoningEffort: 'tiered' as never }),
    )
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      request: { generationConfig: { thinkingConfig: Record<string, unknown> } }
    }
    expect(body.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true })
  })

  it('sessionId 可被覆盖（缺省用 GEMINI_SESSION_ID_INFER）', async () => {
    const { calls } = recordingFetch([() => okStream()])
    await drain(makeAdapter({ credential: cred('AT'), sessionId: 'S-1' }), options())
    const body = JSON.parse(String(calls[0]!.init.body)) as { request: { sessionId: string } }
    expect(body.request.sessionId).toBe('S-1')
  })
})

/**
 * 计划 §五 第 7 步的两条验收项（模型目录门控 + `resolveModel` 声明契约）。
 *
 * 这两条**都不发请求**，故不需要 `recordingFetch`；它们守的是「模型选择器里
 * 显示什么」，而不是「请求长什么样」。
 */
describe('gemini 模型目录与声明契约', () => {
  /** 只实现门控用到的两个方法。 */
  function gatePool(loggedIn: boolean, disabled: string[] = []): AccountPool {
    return {
      hasLoggedInAccount: async () => loggedIn,
      disabledModelsFor: () => new Set(disabled),
    } as unknown as AccountPool
  }

  it('★ 门控：没有已登录账号时 listModels 返回空数组（不是抛错、不是只隐藏一部分）', async () => {
    const adapter = makeAdapter({ credential: cred('AT'), pool: gatePool(false) })
    const models = await adapter.listModels(GEMINI.id)
    // ⚠️ **空数组**（隐藏整个 provider 分组），且**不抛错** —— 抛错会让面板上
    // 多出一条 provider 级报错，用户看到的是「插件坏了」而不是「还没登录」。
    expect(models).toEqual([])
  })

  it('★ 有账号时暴露恰好 1 个模型，且声明 image 模态', async () => {
    const adapter = makeAdapter({ credential: cred('AT'), pool: gatePool(true) })
    const models = await adapter.listModels(GEMINI.id)
    expect(models.map((m) => m.id)).toEqual(['gemini-3.8-flash'])
    expect(models.map((m) => m.provider)).toEqual([GEMINI.id])
    expect(models.every((m) => m.inputModalities?.includes('image'))).toBe(true)
    // ⚠️ **不暴露 lite**（用户 2026-10-03 拍板：上游恒 404）。
    expect(models.some((m) => m.id.includes('lite'))).toBe(false)
    // ⚠️ **不认领 `claude-*`**（计划 §八.1）：认领会让用户选 claude 时走 gemini。
    expect(models.some((m) => m.id.startsWith('claude'))).toBe(false)
  })

  it('★ 被禁用的模型从目录里剔除（禁用是 provider 级共享状态）', async () => {
    const adapter = makeAdapter({
      credential: cred('AT'),
      pool: gatePool(true, ['gemini-3.8-flash']),
    })
    const models = await adapter.listModels(GEMINI.id)
    expect(models).toEqual([])
  })

  it('★ resolveModel 声明 1M 上下文 + 四个档位 + medium 为默认档', async () => {
    const adapter = makeAdapter({ credential: cred('AT'), pool: gatePool(true) })
    const resolved = await adapter.resolveModel(GEMINI.id, 'gemini-3.8-flash')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    expect(resolved.defaultMaxTokens).toBe(64_000)
    // 档位是**中文名**（DSH 档位选择器直接渲染 name，不本地化）。
    expect(resolved.reasoning?.efforts?.map((e) => [String(e.id), e.name])).toEqual([
      ['low', '低'],
      ['medium', '中'],
      ['high', '高'],
      ['tiered', '自适应'],
    ])
    expect(String(resolved.reasoning?.defaultEffort)).toBe('medium')
  })

  it('★ 未知模型不编造档位声明（宁可让 DSH 用默认，也不给一个点不开的空下拉框）', async () => {
    const adapter = makeAdapter({ credential: cred('AT'), pool: gatePool(true) })
    const resolved = await adapter.resolveModel(GEMINI.id, 'gemini-9.9-imaginary')
    expect(resolved.reasoning).toBeUndefined()
  })

  it('★ 未知模型不编造上下文窗口（宁可让 DSH 用默认值）', async () => {
    const adapter = makeAdapter({ credential: cred('AT'), pool: gatePool(true) })
    const resolved = await adapter.resolveModel(GEMINI.id, 'gemini-9.9-imaginary')
    expect(resolved.context).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
    expect(resolved.reasoning).toBeUndefined()
    // 名字退化用 model id 本身，不留空。
    expect(resolved.name).toBe('gemini-9.9-imaginary')
  })
})
