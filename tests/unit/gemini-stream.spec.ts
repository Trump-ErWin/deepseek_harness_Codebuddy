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
  GEMINI_DEFAULT_PROJECT,
  GEMINI_ENDPOINT_DAILY,
  GEMINI_ENDPOINT_SANDBOX,
  GEMINI_SESSION_ID_INFER,
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
  sessionLane?: string
  project?: string
  /** true = 走**自动探测**路径（缺省则显式钉兜底串，让既有用例行为不变）。 */
  autoProject?: boolean
  projectFetcher?: typeof fetch
  persistProject?: (value: string) => Promise<void>
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
    ...config.sessionLane === undefined ? {} : { sessionLane: config.sessionLane },
    // ⚠️ 缺省**显式钉**兜底串：不钉就会走自动探测，多打一次 `loadCodeAssist`
    // 并吃掉 stub 的第一个响应 —— 既有用例会集体错位。
    ...config.autoProject === true ? {} : { project: config.project ?? GEMINI_DEFAULT_PROJECT },
    ...config.projectFetcher === undefined ? {} : { projectFetcher: config.projectFetcher },
    ...config.persistProject === undefined ? {} : { persistProject: config.persistProject },
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
  it('未知模型 id 抛 INVALID_REQUEST（先查表，不取凭据不发请求不续期）', async () => {
    const { calls } = recordingFetch([() => okStream()])
    const refreshCalls = { count: 0 }
    const error = await capture(makeAdapter({ refreshCalls }), options({ model: 'gemini-9.9-fake' }))
    expect(error?.code).toBe('INVALID_REQUEST')
    expect(error?.message).toContain('gemini-9.9-fake')
    // ⚠️ 状态码是给网关看的：只读 `failure.status`（顶层无 status），缺了它
    // 这条确定性失败会以 502 离开网关，被客户端当服务端故障反复重试。
    expect(error?.failure?.status).toBe(404)
    expect(calls).toHaveLength(0)
    // 纯本地判定：连凭据续期都不该触发
    expect(refreshCalls.count).toBe(0)
  })

  it('无凭据抛 MISSING_CREDENTIAL（不发请求）；凭据过期则先 refresh 再取新凭据', async () => {
    const empty = recordingFetch([() => okStream()])
    const missing = await capture(makeAdapter({}), options())
    expect(missing?.code).toBe('MISSING_CREDENTIAL')
    expect(empty.calls).toHaveLength(0)

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

  it('请求发往 daily + 流式路径、不带 Accept、身份头齐、body 字母序且模型名带档位后缀', async () => {
    const { calls } = recordingFetch([() => okStream()])
    await drain(makeAdapter({ credential: cred('AT') }), options({ reasoningEffort: 'high' as never }))
    expect(calls[0]!.url).toBe(`${GEMINI_ENDPOINT_DAILY}${GEMINI_STREAM_PATH}`)
    const headers = calls[0]!.init.headers as Headers
    // ⚠️ 流式**刻意不带** Accept（上游按它分流，带了会走非流式语义）。
    expect(headers.get('Accept')).toBeNull()
    expect(headers.get('x-client-name')).toBe('antigravity')
    expect(headers.get('User-Agent')).toContain('antigravity/')
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown> & { model: string }
    expect(body.model).toBe('gemini-3.8-flash-high')
    expect(body.request).toBeDefined()
    // 字母序：model < project < request < requestId < userAgent
    const keys = Object.keys(body)
    expect(keys).toEqual([...keys].sort())

    // 带档位的模型 id（限流标记/探测形态）照常发；upstream 由 effort 决定而非 id 后缀。
    const tiered = recordingFetch([() => okStream()])
    await drain(makeAdapter({ credential: cred('AT') }), options({ model: 'gemini-3.8-flash-high' }))
    expect(JSON.parse(String(tiered.calls[0]!.init.body)).model).toBe('gemini-3.8-flash-medium')
  })
})

describe('gemini stream · 空响应与网络失败', () => {
  it('ok 但无 body → EMPTY_RESPONSE；fetch 抛错 → TRANSPORT（交给 harness 退避）', async () => {
    recordingFetch([() => new Response(null, { status: 200 })])
    expect((await capture(makeAdapter({ credential: cred('AT') }), options()))?.code).toBe('EMPTY_RESPONSE')

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

describe('gemini stream · 签名往返', () => {
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

describe('gemini stream · 端点与续期救场', () => {
  it('403 先翻到 sandbox 端点，再失败才归类 SERVER（无池时）；429 也先翻端点', async () => {
    const forbidden = recordingFetch([() => new Response('forbidden', { status: 403 })])
    const error = await capture(makeAdapter({ credential: cred('AT') }), options())
    expect(forbidden.calls).toHaveLength(2)
    expect(forbidden.calls[0]!.url.startsWith(GEMINI_ENDPOINT_DAILY)).toBe(true)
    expect(forbidden.calls[1]!.url.startsWith(GEMINI_ENDPOINT_SANDBOX)).toBe(true)
    // ⚠️ 403 归 SERVER 而不是 AUTH —— 否则会把用户引向「重新登录」这个无效动作。
    expect(error?.code).toBe('SERVER')
    expect(error?.failure?.status).toBe(403)

    // 端点切换只做一次，不无限来回。
    const limited = recordingFetch([() => new Response('rate limited', { status: 429 })])
    expect((await capture(makeAdapter({ credential: cred('AT') }), options()))?.code).toBe('RATE_LIMIT')
    expect(limited.calls).toHaveLength(2)
  })

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
  it('429 换到下一个账号并成功（新凭据、回到默认端点、冷却 60 秒打在旧账号上）', async () => {
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

  it('全不可用 → QUOTA_EXCEEDED（不无限循环）；换号带上起始账号且最多换 3 个', async () => {
    const exhausted = recordingFetch([() => new Response('rate limited', { status: 429 })])
    const error = await capture(
      makeAdapter({ credential: cred('AT-1'), pool: makePool({ current: 'acc-1', next: [] }) }),
      options(),
    )
    expect(error?.code).toBe('QUOTA_EXCEEDED')
    expect(error?.message).toMatch(/所有账号均不可用/)
    // 一次端点切换 + 一次换号失败判定，不该再多。
    expect(exhausted.calls.length).toBeLessThanOrEqual(3)

    // 起始账号会先按凭据反查并加入 tried（不会换回自己）；换到第三个账号才成功。
    const seen: Array<string[]> = []
    const rotated = recordingFetch([
      () => new Response('rate limited', { status: 429 }),
      () => new Response('rate limited', { status: 429 }),
      () => new Response('rate limited', { status: 429 }),
      () => new Response('rate limited', { status: 429 }),
      () => okStream(),
    ])
    const chunks = await drain(makeAdapter({
      credential: cred('AT-1'),
      pool: makePool({
        current: 'acc-1',
        next: [{ id: 'acc-2', token: 'AT-2' }, { id: 'acc-3', token: 'AT-3' }],
        onQuery: (exclude) => seen.push([...exclude]),
      }),
    }), options())
    expect(chunks.length).toBeGreaterThan(0)
    expect((rotated.calls.at(-1)!.init.headers as Headers).get('Authorization')).toBe('Bearer AT-3')
    expect(seen[0]).toEqual(['acc-1'])
  })
})

describe('gemini stream · 档位', () => {
  it('未知档位回落到默认 medium；自适应档只发 includeThoughts', async () => {
    const unknown = recordingFetch([() => okStream()])
    await drain(makeAdapter({ credential: cred('AT') }), options({ reasoningEffort: 'ultra' as never }))
    expect(JSON.parse(String(unknown.calls[0]!.init.body)).model).toBe('gemini-3.8-flash-medium')

    const tiered = recordingFetch([() => okStream()])
    await drain(makeAdapter({ credential: cred('AT') }), options({ reasoningEffort: 'tiered' as never }))
    const body = JSON.parse(String(tiered.calls[0]!.init.body)) as {
      request: { generationConfig: { thinkingConfig: Record<string, unknown> } }
    }
    expect(body.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true })

    // 未知 id 不再静默落回 3.8 —— 那正是本次修复的行为，见「凭据与请求形状」段。
  })

  it('sessionId 可被覆盖（用于复刻历史抓包 / 联调）', async () => {
    const { calls } = recordingFetch([() => okStream()])
    await drain(makeAdapter({ credential: cred('AT'), sessionId: 'S-1' }), options())
    const body = JSON.parse(String(calls[0]!.init.body)) as { request: { sessionId: string } }
    expect(body.request.sessionId).toBe('S-1')
  })
})

/**
 * sessionId 的**内容派生**（2026-10-05 指纹修复）。
 *
 * ## 为什么不能是常量
 *
 * 早前把推理/冒烟各钉一个常量（`3124275334370613369` / `-6686302828062879362`），
 * 依据是历次抓包逐字恒定。真机对照实验推翻了它：那两个值只是**特定输入的
 * 输出**被反复抓到 —— `sessionId = f(project, contents[0].text, lane)`。
 *
 * 常量化的后果：所有用户、所有对话共用一个会话。上游的会话归并与
 * `thoughtSignature` 回填都挂在这个字段上，共用会让它们全部错乱。
 *
 * ⚠️ 断言的是**依赖维度**（哪些输入进哈希），不是具体数值 —— 原版哈希函数
 * 本体尚未反推出来，逐字对齐做不到（见 `deriveGeminiSessionId` 注释）。
 */
describe('gemini sessionId 内容派生', () => {
  /** 取一次请求体里的 sessionId。 */
  async function sessionIdOf(
    config: Parameters<typeof makeAdapter>[0],
    text: string,
    extra: Partial<GenerateOptions> = {},
  ): Promise<string> {
    const { calls } = recordingFetch([() => okStream()])
    await drain(
      makeAdapter(config),
      options({
        messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
        ...extra,
      }),
    )
    const body = JSON.parse(String(calls[0]!.init.body)) as { request: { sessionId: string } }
    return body.request.sessionId
  }

  it('★ 缺省不再用历史常量，且同一输入跨调用稳定', async () => {
    const first = await sessionIdOf({ credential: cred('AT') }, 'AAA')
    const second = await sessionIdOf({ credential: cred('AT') }, 'AAA')
    expect(first).toBe(second)
    // 必须是**有符号 int64 十进制串**（上游信封里就是这个形态，取值正负都有）。
    expect(first).toMatch(/^-?\d+$/)
    expect(BigInt(first) >= -(2n ** 63n) && BigInt(first) < 2n ** 63n).toBe(true)
    // 回归锁：缺省值绝不能退化回那个历史常量。
    expect(first).not.toBe(GEMINI_SESSION_ID_INFER)
  })

  it('★ 换首条 user 文本 ⇒ sessionId 变', async () => {
    const a = await sessionIdOf({ credential: cred('AT') }, 'AAA')
    const b = await sessionIdOf({ credential: cred('AT') }, 'BBB')
    expect(a).not.toBe(b)
  })

  it('★ 换 project ⇒ sessionId 变', async () => {
    const a = await sessionIdOf({ credential: cred('AT'), project: 'proj-one' }, 'AAA')
    const b = await sessionIdOf({ credential: cred('AT'), project: 'proj-two' }, 'AAA')
    expect(a).not.toBe(b)
  })

  it('★ 换 lane ⇒ sessionId 变（推理与冒烟不能共用会话）', async () => {
    const infer = await sessionIdOf({ credential: cred('AT'), sessionLane: 'infer' }, 'AAA')
    const smoke = await sessionIdOf({ credential: cred('AT'), sessionLane: 'smoke' }, 'AAA')
    expect(infer).not.toBe(smoke)
  })

  it('★ 换 model / maxOutputTokens 都不影响 sessionId', async () => {
    // 实测口径：只有 (project, contents[0].text, lane) 进哈希。
    const base = await sessionIdOf({ credential: cred('AT') }, 'AAA')
    const otherModel = await sessionIdOf({ credential: cred('AT') }, 'AAA', {
      model: 'gemini-3.8-flash-high',
      maxTokens: 123,
    })
    expect(otherModel).toBe(base)
  })
})

/**
 * 会话升代自愈（`[FIX session-1M]`）。
 *
 * ## 现象
 *
 * 上游按 `sessionId` 在**服务端**累计对话输入；长工具循环会把累计推过 1M，
 * 此后该 sessionId 的**每个**请求都 400
 * `The input token count exceeds the maximum number of tokens allowed 1048576`，
 * 直到该服务端会话过期 —— 即**对话永久卡死**。
 *
 * ## 为什么不能靠「削本地历史」
 *
 * 累计发生在**服务端、按 sessionId 计**，削本地历史改变不了服务端的计数。
 * 唯一出路是**升代换一个全新 sessionId**，让上游开新会话。
 *
 * 判据逐字抄自 `Antigravity-Manager`（`proxy/handlers/gemini.rs:983`）：
 * `status == 400 && 正文含 "exceeds the maximum number of tokens"`。
 */
describe('gemini 会话升代自愈（1M 累计超限）', () => {
  const OVERFLOW_BODY =
    '{"error":{"code":400,"message":"The input token count exceeds the maximum number of tokens allowed 1048576.","status":"INVALID_ARGUMENT"}}'

  /** 一次 400 overflow，之后成功。 */
  function overflowThenOk(): Array<() => Response> {
    return [
      () => new Response(OVERFLOW_BODY, { status: 400, headers: { 'content-type': 'application/json' } }),
      () => okStream(),
    ]
  }

  /** 始终 400 overflow。 */
  function alwaysOverflow(): Array<() => Response> {
    return [
      () => new Response(OVERFLOW_BODY, { status: 400, headers: { 'content-type': 'application/json' } }),
    ]
  }

  it('★ 400 overflow ⇒ 升代换新 sessionId 重发，并成功', async () => {
    const { calls } = recordingFetch(overflowThenOk())
    const chunks = await drain(makeAdapter({ credential: cred('AT') }), options())

    // 恰好两次请求：第一次 400 → 升代 → 第二次成功。
    expect(calls).toHaveLength(2)
    const first = JSON.parse(String(calls[0]!.init.body)) as { request: { sessionId: string } }
    const second = JSON.parse(String(calls[1]!.init.body)) as { request: { sessionId: string } }
    // 升代必须真的换了 sessionId（否则等于原地重试，毫无意义）。
    expect(second.request.sessionId).not.toBe(first.request.sessionId)
    // 两次都必须是合法 int64 串。
    expect(first.request.sessionId).toMatch(/^-?\d+$/)
    expect(second.request.sessionId).toMatch(/^-?\d+$/)
    // 重试成功，正常产出内容块。
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('★ 升代后仍 400 ⇒ 有界停止，不无限升代', async () => {
    const { calls } = recordingFetch(alwaysOverflow())
    const failure = await capture(makeAdapter({ credential: cred('AT') }), options())

    // 一次原请求 + 最多 GEMINI_MAX_SESSION_BUMPS 次升代重试。
    // 若实现成无界循环，这里会跑到 fetch 被调爆（测试超时/内存）而不是 2 次。
    expect(calls).toHaveLength(2)
    // 如实透传上游错误，不吞掉、也不误判成 QUOTA_EXCEEDED。
    expect(failure).toBeDefined()
    expect(failure?.failure?.status).toBe(400)
  })

  it('★ 显式钉住 sessionId 时不升代（调用方要复刻特定会话）', async () => {
    const { calls } = recordingFetch(alwaysOverflow())
    await capture(makeAdapter({ credential: cred('AT'), sessionId: 'PINNED' }), options())

    // 只发一次：显式钉值意味着不许擅自换掉它。
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0]!.init.body)) as { request: { sessionId: string } }
    expect(body.request.sessionId).toBe('PINNED')
  })

  it('★ 普通的 400 不触发升代（不误判）', async () => {
    const { calls } = recordingFetch([
      () => new Response('{"error":{"code":400,"message":"Invalid JSON payload received."}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    ])
    await capture(makeAdapter({ credential: cred('AT') }), options())
    expect(calls).toHaveLength(1)
  })
})

/**
 * `project` 的**自动探测**在适配器层的集成（单测见 `gemini-project.spec.ts`）。
 *
 * 这一层要证明的是：探测结果**真的进了信封**，且探测**失败时一个推理请求都不发**。
 */
describe('gemini project 自动探测（适配器集成）', () => {
  /** 假 LCA 端点，记录调用。 */
  function lcaFetch(response: () => Response): { fetcher: typeof fetch; calls: string[] } {
    const calls: string[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return response()
    }) as unknown as typeof fetch
    return { fetcher, calls }
  }

  const lcaOk = (project: string): (() => Response) =>
    () => new Response(`{"cloudaicompanionProject":"${project}"}`, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  it('★ 信封 project 用探测值（不再是兜底串）', async () => {
    const { calls } = recordingFetch([() => okStream()])
    const lca = lcaFetch(lcaOk('CCP-FROM-LCA'))
    await drain(
      makeAdapter({ credential: cred('AT'), autoProject: true, projectFetcher: lca.fetcher }),
      options(),
    )
    const body = JSON.parse(String(calls[0]!.init.body)) as { project: string }
    expect(body.project).toBe('CCP-FROM-LCA')
    expect(lca.calls).toHaveLength(1)
  })

  it('★ 探测失败 ⇒ **一个推理请求都不发**（与原版一致）', async () => {
    const { calls } = recordingFetch([() => okStream()])
    const lca = lcaFetch(() => new Response('{"error":{"code":500}}', { status: 500 }))
    const failure = await capture(
      makeAdapter({ credential: cred('AT'), autoProject: true, projectFetcher: lca.fetcher }),
      options(),
    )
    // 关键断言：推理端点一次都没被碰过。
    expect(calls).toHaveLength(0)
    expect(failure?.message).toContain('项目号探测失败')
    // 探测本身在两个端点上各试了一次。
    expect(lca.calls).toHaveLength(2)
  })

  it('★ 探测到真值 ⇒ 回写凭据；兜底串不回写', async () => {
    const persisted: string[] = []
    recordingFetch([() => okStream()])
    const lca = lcaFetch(lcaOk('CCP-REAL'))
    await drain(makeAdapter({
      credential: cred('AT'),
      autoProject: true,
      projectFetcher: lca.fetcher,
      persistProject: async (value) => { persisted.push(value) },
    }), options())
    expect(persisted).toHaveLength(1)
    expect(JSON.parse(persisted[0]!).cloudaicompanionProject).toBe('CCP-REAL')

    // 免费档（project 为空）⇒ 兜底串，**不**回写。
    const freeTierPersisted: string[] = []
    recordingFetch([() => okStream()])
    const freeTier = lcaFetch(() => new Response('{"currentTier":{"id":"free-tier"}}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await drain(makeAdapter({
      credential: cred('AT'),
      autoProject: true,
      projectFetcher: freeTier.fetcher,
      persistProject: async (value) => { freeTierPersisted.push(value) },
    }), options())
    expect(freeTierPersisted).toHaveLength(0)
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

  it('★ 门控：无已登录账号返空数组（不抛错）；被禁用的模型从目录剔除', async () => {
    const anonymous = makeAdapter({ credential: cred('AT'), pool: gatePool(false) })
    // ⚠️ **空数组**（隐藏整个 provider 分组），且**不抛错** —— 抛错会让面板上
    // 多出一条 provider 级报错，用户看到的是「插件坏了」而不是「还没登录」。
    expect(await anonymous.listModels(GEMINI.id)).toEqual([])

    const disabled = makeAdapter({
      credential: cred('AT'),
      pool: gatePool(true, ['gemini-3.8-flash']),
    })
    expect(await disabled.listModels(GEMINI.id)).toEqual([])
  })

  it('★ 有账号时暴露恰好 1 个模型、声明 image、不含 lite、不认领 claude-*', async () => {
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

  it('★ resolveModel 声明 1M 上下文 + 四个中文档位 + medium 默认档', async () => {
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

  it('★ 未知模型不编造上下文窗口也不编造档位（宁可让 DSH 用默认值）', async () => {
    const adapter = makeAdapter({ credential: cred('AT'), pool: gatePool(true) })
    const resolved = await adapter.resolveModel(GEMINI.id, 'gemini-9.9-imaginary')
    expect(resolved.context).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
    expect(resolved.reasoning).toBeUndefined()
    // 名字退化用 model id 本身，不留空。
    expect(resolved.name).toBe('gemini-9.9-imaginary')
  })
})
