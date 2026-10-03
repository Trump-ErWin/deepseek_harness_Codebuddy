/**
 * Gemini **配额窗口**查询单测。
 *
 * ## 守的是什么
 *
 * Gemini 免费线给的是**配额窗口**（5 小时 / 周两个窗口的剩余比例），
 * 不是充值积分。这里锁死三件容易"顺手改坏"的事：
 *
 * 1. **`bucketId` 是唯一判据** —— 响应里还有 `3p-*`（Claude/GPT 产品线）的桶，
 *    按 `displayName` / `window` 匹配会把别家产品的额度显示成 Gemini 的。
 * 2. **`resetTime` 不可解析 ⇒ 整条丢弃** —— 编一个空串会让面板显示一个
 *    "永远不过期"的窗口，比少一个包更误导。
 * 3. **未授权不是错误** —— 没登录时返回 `{balance: null, error:'尚未授权 Google 账号'}`，
 *    抛异常会让账号卡片显示成故障。
 *
 * ⚠️ `total` 取两窗口的**平均**而不是 min（见 `gemini-credits.ts` 的口径注释）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GEMINI_BUCKET_FIVE_HOUR,
  GEMINI_BUCKET_WEEKLY,
  GEMINI_UNAUTHORIZED_MESSAGE,
  GEMINI_WINDOW_LABEL_FIVE_HOUR,
  GEMINI_WINDOW_LABEL_WEEKLY,
  clearGeminiCreditCache,
  fetchGeminiCreditBalance,
  parseGeminiQuotaWindow,
  parseGeminiQuotaWindows,
  toGeminiCreditBalance,
} from '../../src/gemini-credits.js'
import {
  GEMINI,
  GEMINI_ENDPOINT_SANDBOX,
  GEMINI_QUOTA_PATH,
  type GeminiCredential,
} from '../../src/gemini.js'

const RESET_5H = '2026-10-03T18:00:00Z'
const RESET_WEEKLY = '2026-10-06T00:00:00Z'

function credential(token = 'AT'): GeminiCredential {
  return { access_token: token, refresh_token: 'RT' }
}

/** 上游真实形状：三组桶，第三组属于别家产品线。 */
function upstreamPayload(fiveHour = 0.99, weekly = 0.99): unknown {
  return {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: GEMINI_BUCKET_WEEKLY, window: 'weekly', resetTime: RESET_WEEKLY, remainingFraction: weekly },
          { bucketId: GEMINI_BUCKET_FIVE_HOUR, window: '5h', resetTime: RESET_5H, remainingFraction: fiveHour },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-5h', window: '5h', resetTime: RESET_5H, remainingFraction: 0.5 },
          { bucketId: '3p-weekly', window: 'weekly', resetTime: RESET_WEEKLY, remainingFraction: 0.5 },
        ],
      },
    ],
  }
}

/** 让 fetch 返回给定响应，并记录调用。 */
function stubQuota(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return response()
  }))
  return calls
}

function jsonOk(payload: unknown): () => Response {
  return () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  clearGeminiCreditCache()
  vi.unstubAllGlobals()
})

describe('parseGeminiQuotaWindow 的硬约束', () => {
  it('完整字段正常解析', () => {
    expect(parseGeminiQuotaWindow({
      bucketId: GEMINI_BUCKET_FIVE_HOUR,
      window: '5h',
      resetTime: RESET_5H,
      remainingFraction: 0.42,
    })).toEqual({
      bucketId: GEMINI_BUCKET_FIVE_HOUR,
      window: '5h',
      resetTime: RESET_5H,
      remainingFraction: 0.42,
    })
  })

  it('bucketId 缺失/为空 → 丢弃', () => {
    expect(parseGeminiQuotaWindow({ resetTime: RESET_5H, remainingFraction: 0.5 })).toBeUndefined()
    expect(parseGeminiQuotaWindow({ bucketId: '', resetTime: RESET_5H, remainingFraction: 0.5 }))
      .toBeUndefined()
  })

  it('remainingFraction 非有限数字 → 丢弃（NaN / 字符串 / 缺失）', () => {
    const base = { bucketId: GEMINI_BUCKET_FIVE_HOUR, resetTime: RESET_5H }
    expect(parseGeminiQuotaWindow({ ...base, remainingFraction: Number.NaN })).toBeUndefined()
    expect(parseGeminiQuotaWindow({ ...base, remainingFraction: '0.5' })).toBeUndefined()
    expect(parseGeminiQuotaWindow(base)).toBeUndefined()
  })

  it('resetTime 不可解析 → **整条丢弃**（不编造一个永不过期的窗口）', () => {
    const base = { bucketId: GEMINI_BUCKET_FIVE_HOUR, remainingFraction: 0.5 }
    expect(parseGeminiQuotaWindow(base)).toBeUndefined()
    expect(parseGeminiQuotaWindow({ ...base, resetTime: '' })).toBeUndefined()
    expect(parseGeminiQuotaWindow({ ...base, resetTime: '不是时间' })).toBeUndefined()
  })

  it('window 缺失时退化为空串（仅诊断用，不参与匹配）', () => {
    const parsed = parseGeminiQuotaWindow({
      bucketId: GEMINI_BUCKET_WEEKLY,
      resetTime: RESET_WEEKLY,
      remainingFraction: 1,
    })
    expect(parsed?.window).toBe('')
  })

  it('非对象输入 → undefined（不抛错）', () => {
    expect(parseGeminiQuotaWindow(null)).toBeUndefined()
    expect(parseGeminiQuotaWindow([])).toBeUndefined()
    expect(parseGeminiQuotaWindow('x')).toBeUndefined()
  })
})

describe('parseGeminiQuotaWindows 的选取口径', () => {
  it('按 bucketId 挑出两个桶，忽略别家产品的桶', () => {
    const { fiveHour, weekly } = parseGeminiQuotaWindows(upstreamPayload())
    expect(fiveHour?.bucketId).toBe(GEMINI_BUCKET_FIVE_HOUR)
    expect(weekly?.bucketId).toBe(GEMINI_BUCKET_WEEKLY)
    expect(fiveHour?.remainingFraction).toBe(0.99)
  })

  it('displayName 改文案不影响识别（判据是 id 不是显示名）', () => {
    const payload = {
      groups: [{
        displayName: '完全改过的文案',
        buckets: [{ bucketId: GEMINI_BUCKET_FIVE_HOUR, resetTime: RESET_5H, remainingFraction: 0.3 }],
      }],
    }
    expect(parseGeminiQuotaWindows(payload).fiveHour?.remainingFraction).toBe(0.3)
  })

  it('同 id 出现多次时取第一次命中', () => {
    const payload = {
      groups: [
        { buckets: [{ bucketId: GEMINI_BUCKET_FIVE_HOUR, resetTime: RESET_5H, remainingFraction: 0.1 }] },
        { buckets: [{ bucketId: GEMINI_BUCKET_FIVE_HOUR, resetTime: RESET_5H, remainingFraction: 0.9 }] },
      ],
    }
    expect(parseGeminiQuotaWindows(payload).fiveHour?.remainingFraction).toBe(0.1)
  })

  it('形状完全不对 → 空对象（由调用方判成失败，不伪造 100%）', () => {
    expect(parseGeminiQuotaWindows(null)).toEqual({})
    expect(parseGeminiQuotaWindows({})).toEqual({})
    expect(parseGeminiQuotaWindows({ groups: 'x' })).toEqual({})
    expect(parseGeminiQuotaWindows({ groups: [{ buckets: 'x' }] })).toEqual({})
  })
})

describe('toGeminiCreditBalance 的口径', () => {
  it('两个窗口各一个包，单位是百分比、总额 100、总额减去剩余即已用', () => {
    const { fiveHour, weekly } = parseGeminiQuotaWindows(upstreamPayload(0.8, 0.6))
    const balance = toGeminiCreditBalance(fiveHour, weekly)
    expect(balance.packages.map((item) => item.name))
      .toEqual([GEMINI_WINDOW_LABEL_FIVE_HOUR, GEMINI_WINDOW_LABEL_WEEKLY])
    expect(balance.packages[0]).toEqual({
      name: GEMINI_WINDOW_LABEL_FIVE_HOUR,
      unit: '%',
      remaining: 80,
      total: 100,
      used: 20,
      active: true,
      cycleStartTime: '',
      cycleEndTime: RESET_5H,
      expiredTime: '',
    })
    // ⚠️ 汇总取**平均**（80 与 60 → 70），不是 min（会显示成 60，误导成快用完了）。
    expect(balance.total).toBe(70)
    expect(balance.expiredTotal).toBe(0)
  })

  it('只剩一个窗口时汇总就是那一个', () => {
    const { fiveHour } = parseGeminiQuotaWindows(upstreamPayload(0.42, 0.42))
    const balance = toGeminiCreditBalance(fiveHour, undefined)
    expect(balance.packages).toHaveLength(1)
    expect(balance.total).toBe(42)
  })

  it('两个窗口都没有 → 空余额（不是 100）', () => {
    expect(toGeminiCreditBalance(undefined, undefined)).toEqual({
      total: 0,
      packages: [],
      expiredTotal: 0,
    })
  })

  it('比例越界被收敛（上游给了 1.5 / -0.2 也不能显示成 150% / -20%）', () => {
    const high = { bucketId: GEMINI_BUCKET_FIVE_HOUR, window: '5h', resetTime: RESET_5H, remainingFraction: 1.5 }
    const low = { bucketId: GEMINI_BUCKET_WEEKLY, window: 'weekly', resetTime: RESET_WEEKLY, remainingFraction: -0.2 }
    const balance = toGeminiCreditBalance(high, low)
    expect(balance.packages[0]?.remaining).toBe(100)
    expect(balance.packages[1]?.remaining).toBe(0)
    expect(balance.total).toBe(50)
  })
})

describe('fetchGeminiCreditBalance · 未授权', () => {
  it('没有 access_token → 返回文案而不是抛错（面板据此区分「没登录」）', async () => {
    const calls = stubQuota(jsonOk({}))
    const result = await fetchGeminiCreditBalance({ access_token: '' })
    expect(result).toEqual({ balance: null, error: GEMINI_UNAUTHORIZED_MESSAGE })
    // 未授权时**不发请求**。
    expect(calls).toHaveLength(0)
  })
})

describe('fetchGeminiCreditBalance · 请求形状', () => {
  it('POST 到 sandbox 的配额端点，空对象请求体，带身份头', async () => {
    const calls = stubQuota(jsonOk(upstreamPayload()))
    await fetchGeminiCreditBalance(credential())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${GEMINI_ENDPOINT_SANDBOX}${GEMINI_QUOTA_PATH}`)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.body).toBe('{}')
    const headers = calls[0]!.init.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer AT')
    expect(headers.get('x-client-name')).toBe('antigravity')
    expect(headers.get('x-machine-id')).toBe('cmdc-pak')
  })

  it('正常响应产出两个包', async () => {
    stubQuota(jsonOk(upstreamPayload(0.99, 0.98)))
    const result = await fetchGeminiCreditBalance(credential())
    expect(result.error).toBeUndefined()
    expect(result.balance?.packages).toHaveLength(2)
    expect(result.balance?.total).toBe(98.5)
  })
})

describe('fetchGeminiCreditBalance · 缓存', () => {
  it('60 秒内命中缓存，不再发请求', async () => {
    const calls = stubQuota(jsonOk(upstreamPayload()))
    const now = 1_000_000
    await fetchGeminiCreditBalance(credential('AT-CACHE'), GEMINI, { now: () => now })
    await fetchGeminiCreditBalance(credential('AT-CACHE'), GEMINI, { now: () => now + 59_000 })
    expect(calls).toHaveLength(1)
  })

  it('超过 60 秒重新查询', async () => {
    const calls = stubQuota(jsonOk(upstreamPayload()))
    const now = 1_000_000
    await fetchGeminiCreditBalance(credential('AT-TTL'), GEMINI, { now: () => now })
    await fetchGeminiCreditBalance(credential('AT-TTL'), GEMINI, { now: () => now + 61_000 })
    expect(calls).toHaveLength(2)
  })

  it('force 跳过缓存（面板「刷新」按钮）', async () => {
    const calls = stubQuota(jsonOk(upstreamPayload()))
    const now = 1_000_000
    await fetchGeminiCreditBalance(credential('AT-FORCE'), GEMINI, { now: () => now })
    await fetchGeminiCreditBalance(credential('AT-FORCE'), GEMINI, { now: () => now, force: true })
    expect(calls).toHaveLength(2)
  })

  it('缓存按 access_token 分键（换号不会读到别人的配额）', async () => {
    const calls = stubQuota(jsonOk(upstreamPayload()))
    const now = 1_000_000
    await fetchGeminiCreditBalance(credential('AT-A'), GEMINI, { now: () => now })
    await fetchGeminiCreditBalance(credential('AT-B'), GEMINI, { now: () => now })
    expect(calls).toHaveLength(2)
  })

  it('失败结果也会进缓存（避免面板 30 秒刷一次把上游刷爆）', async () => {
    const calls = stubQuota(() => new Response('boom', { status: 500 }))
    const now = 1_000_000
    const first = await fetchGeminiCreditBalance(credential('AT-ERR'), GEMINI, { now: () => now })
    const second = await fetchGeminiCreditBalance(credential('AT-ERR'), GEMINI, { now: () => now + 1_000 })
    expect(first.error).toBeDefined()
    expect(second).toEqual(first)
    expect(calls).toHaveLength(1)
  })
})

describe('fetchGeminiCreditBalance · 失败文案', () => {
  it('网络失败 → 「配额查询网络失败」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const result = await fetchGeminiCreditBalance(credential())
    expect(result.balance).toBeNull()
    expect(result.error).toMatch(/配额查询网络失败/)
  })

  it('401 / 403 → 明确的「重新登录」指引', async () => {
    stubQuota(() => new Response('unauthorized', { status: 401 }))
    const result = await fetchGeminiCreditBalance(credential('AT-401'))
    expect(result.error).toBe('凭据已失效（HTTP 401），请重新登录该账号')
  })

  it('其他 HTTP 失败带上状态码与正文片段', async () => {
    stubQuota(() => new Response('internal error', { status: 500 }))
    const result = await fetchGeminiCreditBalance(credential('AT-500'))
    expect(result.error).toMatch(/配额查询失败（HTTP 500）/)
    expect(result.error).toMatch(/internal error/)
  })

  it('响应不是 JSON → 如实说「不是 JSON」', async () => {
    stubQuota(() => new Response('<html>502</html>', { status: 200 }))
    const result = await fetchGeminiCreditBalance(credential('AT-HTML'))
    expect(result.error).toBe('配额响应不是 JSON（HTTP 200）')
  })

  it('认不出任何 Gemini 桶 → null + 文案（**不伪造 100%**）', async () => {
    stubQuota(jsonOk({ groups: [{ buckets: [{ bucketId: '3p-5h', resetTime: RESET_5H, remainingFraction: 0.5 }] }] }))
    const result = await fetchGeminiCreditBalance(credential('AT-EMPTY'))
    expect(result.balance).toBeNull()
    expect(result.error).toBe('配额响应里没有 Gemini 配额桶')
  })

  it('只有周窗口也算成功（不要求两个桶都在）', async () => {
    stubQuota(jsonOk({
      groups: [{ buckets: [{ bucketId: GEMINI_BUCKET_WEEKLY, resetTime: RESET_WEEKLY, remainingFraction: 0.5 }] }],
    }))
    const result = await fetchGeminiCreditBalance(credential('AT-WEEKLY-ONLY'))
    expect(result.error).toBeUndefined()
    expect(result.balance?.packages).toHaveLength(1)
    expect(result.balance?.total).toBe(50)
  })
})
