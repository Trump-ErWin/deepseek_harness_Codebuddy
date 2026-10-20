/**
 * Codely 的**请求级换号 + 冷却**（2026-10-20 接上）。
 *
 * ## 为什么要有这份用例（用户报障）
 *
 * 积分用完时上游回 **HTTP 402 `budget_exceeded`**，而适配器当时把它归成
 * `SERVER` ⇒ 宿主按「可重试的服务端错误」在**同一个死账号**上退避重试 5 次
 * （截图里 5/5 × 7541ms），然后整轮失败 —— 而池里明明还有别的账号。
 *
 * ## 锁住的四条行为
 *
 * ① 402 / 预算耗尽 ⇒ **换号重发**（不是重试、也不是直接失败）；
 * ② 失败账号**立刻记账**（含最后一个），否则下次仍选中它 ⇒ 又撞一次墙；
 * ③ 冷却时刻按语义分流：402/预算 → UTC+8 次日 0 点，429 → 1h；
 * ④ 非账号级失败（500 等）**不换号**（换了也撞同一堵墙，白烧整池）。
 *
 * ## 关于「假池的两条腿」（与 `accio-account-rotation.spec.ts` 同规格）
 *
 * ⚠️ 替身**必须**同样实现 `exclude` 与 `modelRateLimits` 过滤：少一条腿，
 * 「漏传 `tried`」或「modelId 传空串」这类缺陷在测试里就**看不出来**（该家实测过）。
 */

import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodelyAdapter, isCodelyRotatableFailure } from '../../src/codely-adapter.js'
import { nextUtc8DayStartMs } from '../../src/model-queue.js'
import type { CodelyCredential } from '../../src/codely-auth.js'

const MODEL = 'codely-basic'

const cred = (token: string): CodelyCredential =>
  ({ access_token: token, refresh_token: `refresh-${token}`, obtained_at: 0 }) as never

/** 一次成功的 SSE 流（`data:` 帧 + `[DONE]`，与 `codely-adapter.ts` 的解析口径一致）。 */
const sseOk = (text = 'ok') => () => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
  + 'data: [DONE]\n\n',
  { status: 200 },
)

/** 真实 402 报文（用户报障截图同形）。 */
const budgetExceeded = () => new Response(JSON.stringify({
  error: {
    message: 'Budget has been exceeded! Current cost: 54.708759999999994, Max budget: -1.0.',
    type: 'budget_exceeded',
    param: null,
    code: '402',
  },
}), { status: 402 })

const rateLimited = () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })

/** 与真实 `AccountPool` 同形的替身：`exclude` + `modelRateLimits` 两条腿都在。 */
function makePool(records: Array<{ id: string; credential?: CodelyCredential }>) {
  const picks: Array<{ model: string; exclude: string[] }> = []
  const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
  const limits = new Map<string, Record<string, number>>()
  const accounts = records.map((r) => ({ id: r.id, credential: r.credential ?? cred(`TOK-${r.id}`) }))
  const pool = {
    getAvailableAccount: async (
      _provider: string,
      modelId: string,
      exclude?: ReadonlySet<string>,
    ): Promise<{ entry: { id: string; credentialRef: string }; credential: CodelyCredential } | null> => {
      picks.push({ model: modelId, exclude: [...(exclude ?? [])] })
      for (const account of accounts) {
        if (exclude?.has(account.id)) continue
        // ⚠️ 与真实池同形：空 modelId 短路、不过滤
        if (modelId.length > 0) {
          const resetAt = limits.get(account.id)?.[modelId]
          if (typeof resetAt === 'number' && Date.now() < resetAt) continue
        }
        return { entry: { id: account.id, credentialRef: `REF_${account.id}` }, credential: account.credential }
      }
      return null
    },
    updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
      marks.push({ accountId, modelId, resetAtMs })
      limits.set(accountId, { ...(limits.get(accountId) ?? {}), [modelId]: resetAtMs })
    },
    /** 预置某账号处于冷却中（模拟「上一轮已被 402 标记」）。 */
    preset: (accountId: string, modelId: string, resetAtMs: number) => {
      limits.set(accountId, { ...(limits.get(accountId) ?? {}), [modelId]: resetAtMs })
    },
  }
  return { pool, picks, marks }
}

interface Harness {
  adapter: CodelyAdapter
  /** 每次**推理**请求带的 `Authorization`（可反查用的是哪个账号的 key）。 */
  chatAuth: string[]
  chatCalls: () => number
}

function makeAdapter(opts: {
  pool?: unknown
  chatQueue: Array<Response | (() => Response)>
  credentialProvider?: () => Promise<CodelyCredential | undefined>
}): Harness {
  const chatAuth: string[] = []
  let chatCalls = 0
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (url.includes('/api/api-token/cli-api-key')) {
      // ⚠️ key 必须按**该账号的 access_token** 派生，才能在推理侧反查账号身份。
      const token = String(headers.Authorization ?? '').replace(/^Bearer\s+/i, '')
      return new Response(JSON.stringify({ cli_api_key: `sk-${token}`, user_id: 1 }), { status: 200 })
    }
    chatCalls += 1
    chatAuth.push(String(headers.Authorization ?? ''))
    const next = opts.chatQueue.shift()
    if (next === undefined) throw new Error('unexpected chat request')
    return typeof next === 'function' ? next() : next
  })
  const adapter = new CodelyAdapter({
    ...opts.credentialProvider === undefined ? {} : { credentialProvider: opts.credentialProvider },
    ...opts.pool === undefined ? {} : { accountPool: opts.pool as never },
    fetchImpl: fetchImpl as never,
  })
  return { adapter, chatAuth, chatCalls: () => chatCalls }
}

/** 跑一次 `stream()`；返回 chunk 或抛出的错误。 */
async function run(adapter: CodelyAdapter): Promise<{ chunks: StreamChunk[]; error?: unknown }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream({
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) {
      chunks.push(chunk)
    }
    return { chunks }
  } catch (error) {
    return { chunks, error }
  }
}

describe('Codely 请求级换号 + 冷却', () => {
  it('★ 402 积分耗尽 ⇒ 换到第二个账号重发（不再同一账号重试 5 次）', async () => {
    const { pool, marks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    const { adapter, chatAuth, chatCalls } = makeAdapter({ pool, chatQueue: [budgetExceeded(), sseOk()] })
    const { chunks, error } = await run(adapter)

    expect(error).toBeUndefined()
    expect(chatCalls(), '两次推理请求：一次的 402 + 换号后成功').toBe(2)
    // ⚠️ 决定性断言：第二次请求必须换成**另一个账号**的 key（不是同一个死账号重试）。
    expect(chatAuth).toEqual(['Bearer sk-TOK-A', 'Bearer sk-TOK-B'])
    // 失败账号必须被记账（否则下次请求仍会先选中它）。
    expect(marks.map((m) => m.accountId)).toEqual(['acc-1'])
    expect(marks[0]?.modelId).toBe(MODEL)
    // 402/预算 ⇒ 精确到 **UTC+8 次日 0 点**（比「大于 now」更严：它同时排除了
    // 「记成 1h 档」与「记成某个随手的时间」；且与时区/当前时刻无关，永不腐坏）
    expect(marks[0]?.resetAtMs).toBe(nextUtc8DayStartMs())
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)).toEqual(['ok'])
  })

  it('★ 整池耗尽 ⇒ QUOTA_EXCEEDED（绝不归 SERVER）+ 每个失败账号都被记账', async () => {
    const { pool, marks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    const { adapter, chatCalls } = makeAdapter({ pool, chatQueue: [budgetExceeded(), budgetExceeded()] })
    const { error } = await run(adapter)

    expect((error as { code?: string }).code, '402 必须归 QUOTA_EXCEEDED：'
      + '归 SERVER 会让宿主退避重试 5 次（每次都注定失败）').toBe('QUOTA_EXCEEDED')
    expect(String((error as Error).message)).toMatch(/已轮换 2 个账号/)
    expect(String((error as Error).message), '必须指路到「签到」这个唯一有效动作').toMatch(/签到/)
    expect(chatCalls(), '两个账号各发一次，换不到第三个就停').toBe(2)
    // ⚠️ 关键：**两个**都要记账（只记第一个 = minimax「8 号只记 7」的同型缺陷）
    expect(marks.map((m) => m.accountId)).toEqual(['acc-1', 'acc-2'])
  })

  it('★ 换号预算上限：账号再多也只试 5 个（不得无限换号）', async () => {
    const accounts = Array.from({ length: 8 }, (_, i) => ({ id: `acc-${i}`, credential: cred(`TOK-${i}`) }))
    const { pool, marks } = makePool(accounts)
    const { adapter, chatCalls } = makeAdapter({
      pool,
      chatQueue: Array.from({ length: 8 }, () => budgetExceeded()),
    })
    const { error } = await run(adapter)

    expect(chatCalls(), 'CODERLY_MAX_ROTATE = 5').toBe(5)
    expect(marks.length, '5 个试过的账号都要记账').toBe(5)
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
  })

  it('★ 冷却中的账号被跳过（初始选号就绕开它）', async () => {
    const { pool, marks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    // 模拟：acc-1 上一轮已被 402 标记，处于冷却期。
    pool.preset('acc-1', MODEL, Date.now() + 3_600_000)
    const { adapter, chatAuth, chatCalls } = makeAdapter({ pool, chatQueue: [sseOk()] })
    const { error } = await run(adapter)

    expect(error).toBeUndefined()
    expect(chatAuth, '冷却中的 acc-1 不得被选中').toEqual(['Bearer sk-TOK-B'])
    expect(chatCalls()).toBe(1)
    expect(marks.length, '成功路径不写任何冷却标记').toBe(0)
  })

  it('★ 429 限流 ⇒ 记 1 小时冷却并换号（与 402 的「次日解冻」分流）', async () => {
    const { pool, marks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    const { adapter, chatAuth } = makeAdapter({ pool, chatQueue: [rateLimited(), sseOk()] })
    const { error } = await run(adapter)

    expect(error).toBeUndefined()
    expect(chatAuth).toEqual(['Bearer sk-TOK-A', 'Bearer sk-TOK-B'])
    // ⚠️ 1 小时档（±10s 容差），绝不能是「次日 0 点」那一档
    expect(marks[0]?.resetAtMs).toBeGreaterThan(Date.now() + 3_500_000)
    expect(marks[0]?.resetAtMs).toBeLessThan(Date.now() + 3_650_000)
  })

  it('非账号级失败（500）⇒ SERVER 且不换号（换了也撞同一堵墙）', async () => {
    const { pool, marks, picks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    const { adapter, chatCalls } = makeAdapter({
      pool,
      chatQueue: [new Response('upstream boom', { status: 500 })],
    })
    const { error } = await run(adapter)

    expect((error as { code?: string }).code).toBe('SERVER')
    expect(chatCalls(), '500 只发一次：换号无益').toBe(1)
    expect(marks.length, '500 不写冷却标记').toBe(0)
    // ⚠️ 换号查询只在「可换号失败」时发生（500 不该触发第二次选号）
    expect(picks.length, '仅初始选号一次').toBe(1)
  })

  it('无账号池（旧桩路径）⇒ 402 仍归 QUOTA_EXCEEDED，且不重试（单次请求）', async () => {
    const { adapter, chatCalls } = makeAdapter({
      credentialProvider: async () => cred('TOK-A'),
      chatQueue: [budgetExceeded()],
    })
    const { error } = await run(adapter)

    expect((error as { code?: string }).code, '无池也要正确归类 —— 归类与换号是两件事').toBe('QUOTA_EXCEEDED')
    expect(String((error as Error).message)).toMatch(/预算已用尽/)
    expect(chatCalls(), '无池 ⇒ 无换号能力，只发一次').toBe(1)
  })

  it('★ 换号判类（可换号 vs 不换号）', () => {
    expect(isCodelyRotatableFailure(402, '')).toBe(true)
    expect(isCodelyRotatableFailure(429, '')).toBe(true)
    // 报文里有 `budget_exceeded` 也认（上游偶发以其它状态码带该语义）
    expect(isCodelyRotatableFailure(200, '{"error":{"type":"budget_exceeded"}}')).toBe(true)
    // ⚠️ 401/403 不换号：Codely 的 401 绝大多数是「团队无权访问该模型」，
    //    换账号撞的是同一个团队策略。
    expect(isCodelyRotatableFailure(401, '')).toBe(false)
    expect(isCodelyRotatableFailure(403, '')).toBe(false)
    expect(isCodelyRotatableFailure(500, '')).toBe(false)
  })
})
