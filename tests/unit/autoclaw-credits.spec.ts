import { describe, expect, it, vi } from 'vitest'
import { AUTOCLAW } from '../../src/autoclaw-product.js'
import {
  AUTOCLAW_DAILY_CLAIM_PATH,
  AUTOCLAW_LEDGERS_PATH,
  AUTOCLAW_WALLETS_PATH,
  claimAutoclawDailyQuota,
  fetchAutoclawBalanceDetailed,
  fetchAutoclawCreditBalance,
  parseAutoclawLedgerBatches,
  parseAutoclawWallets,
} from '../../src/autoclaw-credits.js'
import { createProviderCredits } from '../../src/provider-credits.js'
import { AutoclawAuth } from '../../src/autoclaw-auth.js'
import { Context } from '@deepseek-ai/cordis'
import type { AutoclawCredential } from '../../src/autoclaw.js'

const MOCK_CREDENTIAL: AutoclawCredential = {
  access_token: 'test_access_token_1234567890',
  refresh_token: 'test_refresh_token_1234567890',
  device_id: 'test-device-uuid-999',
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 真实的 /agent-assetmgr/api/v2/wallets 响应样例（实测数据结构）。 */
const MOCK_WALLETS_PAYLOAD = {
  code: 0,
  msg: 'SUCCESS',
  time: 1792165659918,
  trace: 'test-trace-id',
  data: {
    schema_version: 'wallets.v2',
    total_balance: 32365,
    wallets: [
      {
        public_wallet_type: 'reward',
        display_name: '奖励积分',
        balance: 32365,
        balance_view: '3.2w',
        display: true,
        priority: 10,
      },
      {
        public_wallet_type: 'daily',
        display_name: '每日积分',
        balance: 0,
        balance_view: '0',
        display: false,
        priority: 20,
      },
      {
        public_wallet_type: 'subscription',
        display_name: '签约积分',
        balance: 0,
        balance_view: '0',
        display: false,
        priority: 30,
      },
      {
        public_wallet_type: 'fuel_pack',
        display_name: '加油包积分',
        balance: 0,
        balance_view: '0',
        display: false,
        priority: 40,
      },
      {
        public_wallet_type: 'other',
        display_name: '其他积分',
        balance: 0,
        balance_view: '0',
        display: false,
        priority: 50,
      },
    ],
  },
}

describe('parseAutoclawWallets', () => {
  it('只保留服务端 display=true 的可见池，其余（display=false）按官方客户端同款过滤', () => {
    const packages = parseAutoclawWallets(MOCK_WALLETS_PAYLOAD.data.wallets)
    // ⚠️ 夹具是真实响应：4 个隐藏池 display=false（官方 main.cjs readWallets
    //    只保留 display === true）。旧断言期望 5 个全出 ⇒ 正是「每日 0」红字的根源。
    expect(packages).toHaveLength(1)

    expect(packages[0]).toMatchObject({
      name: '奖励积分',
      remaining: 32365,
      total: 32365,
      active: true,
      unit: '积分',
    })
    // ⚠️ 「每日红 + 刷新倒计时」按池名匹配（DAILY_POOL_NAMES 含「每日积分」），
    //    是 Loomy 当日重置池的语义；AutoClaw 的每日签到积分按批次到期（见流水批次
    //    分组），隐藏池被滤掉后不再渲染红色「每日 0」。
    expect(packages.some((p) => p.name === '每日积分')).toBe(false)
  })

  it('缺失 display_name 时按 public_wallet_type 回退默认中文标签', () => {
    const raw = [
      { public_wallet_type: 'fuel_pack', balance: 500, priority: 1 },
      { public_wallet_type: 'daily', balance: 100, priority: 2 },
    ]
    const packages = parseAutoclawWallets(raw)
    expect(packages[0]!.name).toBe('加油包积分')
    expect(packages[0]!.remaining).toBe(500)
    expect(packages[1]!.name).toBe('每日积分')
    expect(packages[1]!.remaining).toBe(100)
  })

  it('传入非数组或空数组时安全返回空数组', () => {
    expect(parseAutoclawWallets(null)).toEqual([])
    expect(parseAutoclawWallets({})).toEqual([])
    expect(parseAutoclawWallets('invalid')).toEqual([])
  })
})

describe('fetchAutoclawBalanceDetailed & fetchAutoclawCreditBalance', () => {
  it('正常请求返回余额并携带正确的查询参数与请求头', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(MOCK_WALLETS_PAYLOAD))
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(result.error).toBeUndefined()
    expect(result.balance).not.toBeNull()
    expect(result.balance!.total).toBe(32365)
    // ⚠️ display=false 的隐藏池被滤掉（见 parseAutoclawWallets 的守卫），
    //    且本桩对流水 URL 回钱包载荷（无 entries）⇒ 批次为空 ⇒ 回退钱包包。
    expect(result.balance!.packages).toHaveLength(1)
    expect(result.balance!.expiredTotal).toBe(0)

    // ⚠️ 两次调用：先钱包、再流水（临期桶数据源）。流水响应没有 entries
    //    （本桩对所有 URL 回同一载荷）⇒ 批次为空 ⇒ 回退钱包包，形状不变。
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_WALLETS_PATH}?biz_app_id=autoclaw`)
    expect(init.method).toBe('GET')

    const headers = init.headers as Record<string, string>
    expect(headers['X-Auth-Appid']).toBe(AUTOCLAW.appId)
    expect(headers['X-Auth-TimeStamp']).toBeDefined()
    expect(headers['X-Auth-Sign']).toBeDefined()
    expect(headers['X-Authorization']).toBe(`Bearer ${MOCK_CREDENTIAL.access_token}`)
  })

  it('access_token 缺失时本地快速拦截，返回提示而不发起网络请求', async () => {
    const fetcher = vi.fn()
    const result = await fetchAutoclawBalanceDetailed({ access_token: '' }, {
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(result.balance).toBeNull()
    expect(result.error).toContain('未登录或凭据缺失')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('服务端返回 code 410000 时，返回明确的登录失效重新登录提示', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      code: 410000,
      msg: '用户未登录，请重新登录',
    }))
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(result.balance).toBeNull()
    expect(result.error).toContain('登录凭据失效，请重新登录')
  })

  it('HTTP 状态非 200 或网络请求异常时不崩溃并返回错误原因', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('Gateway Error', { status: 502 }))
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('HTTP 502')

    const netFetcher = vi.fn().mockRejectedValue(new Error('Network connection timeout'))
    const netResult = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: netFetcher as unknown as typeof fetch,
    })
    expect(netResult.balance).toBeNull()
    expect(netResult.error).toContain('Network connection timeout')
  })

  it('fetchAutoclawCreditBalance 与 fetchAutoclawBalanceDetailed 行为一致', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(MOCK_WALLETS_PAYLOAD))
    const balance = await fetchAutoclawCreditBalance(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(balance).not.toBeNull()
    expect(balance!.total).toBe(32365)
  })
})

describe('claimAutoclawDailyQuota', () => {
  /** 造一个按 URL 分流的 fetcher（领取接口 / 钱包接口各返回不同响应）。 */
  function makeFetcher(opts: {
    claimData: Record<string, unknown>
    walletTotal?: number
  }) {
    return vi.fn().mockImplementation((url: string) => {
      if (String(url).includes(AUTOCLAW_WALLETS_PATH)) {
        const total = opts.walletTotal ?? 100
        return Promise.resolve(jsonResponse({
          code: 0,
          msg: 'SUCCESS',
          data: {
            schema_version: 'wallets.v2',
            total_balance: total,
            wallets: [{
              public_wallet_type: 'reward',
              display_name: '奖励积分',
              balance: total,
              display: true,
              priority: 10,
            }],
          },
        }))
      }
      return Promise.resolve(jsonResponse({ code: 0, msg: 'SUCCESS', data: opts.claimData }))
    })
  }

  it('daily_check_in_completed_on_request 为 true 时返回 claimed，并带说明文案', async () => {
    // ⚠️⚠️ 上游**不返回**领到多少（2026-10-17 真机取证：data 只有
    //   `{ uid, daily_check_in_completed_on_request }`）。
    //   ⇒ `credit` 只能是 0，但**必须**附说明文案，
    //     否则界面显示「签到成功，+0 积分」会被读成「白签了一次」。
    // ⚠️ 为什么不在 claim 内部量余额差：那要在领取**前**多读一次钱包，
    //   而 `already-claimed`（最常见的日常路径）也会白付这次请求。
    //   取舍见 `autoclaw-credits.ts` 的注释。
    const fetcher = makeFetcher({
      claimData: { uid: 'user_123', daily_check_in_completed_on_request: true },
    })

    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(outcome.kind).toBe('claimed')
    expect(outcome.kind === 'claimed' && outcome.credit).toBe(0)
    // ⚠️ 这条才是防「+0 被误解」的判据。
    expect((outcome as { delayedMessage?: string }).delayedMessage).toContain('上游不返回积分数量')

    // ⚠️ **只发一次请求**（只有领取接口，不读钱包）。
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_DAILY_CLAIM_PATH}`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      source_id: 'autoclaw',
      device_id: MOCK_CREDENTIAL.device_id,
    })
  })

  it('⚠️ 凭据没有 device_id 时**不得**回落到固定常量（会共用假设备号）', async () => {
    // 修复前回落到 `'dsh-autoclaw-device-001'` —— 所有调用方共用同一个假设备号，
    // 上游风控会把不同用户识别成同一台设备刷接口。
    const fetcher = makeFetcher({
      claimData: { uid: 'user_123', daily_check_in_completed_on_request: false },
    })
    const noDevice: AutoclawCredential = {
      access_token: 'test_access_token_1234567890',
      refresh_token: 'test_refresh_token_1234567890',
    }
    await claimAutoclawDailyQuota(noDevice, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })
    const body = JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.device_id, '不该是那个固定常量').not.toBe('dsh-autoclaw-device-001')
    // ⚠️ 必须是 UUID 形态（随机造的），不是写死的字符串。
    expect(body.device_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('daily_check_in_completed_on_request 为 false 时返回 already-claimed', async () => {
    const fetcher = makeFetcher({
      claimData: { uid: 'user_123', daily_check_in_completed_on_request: false },
    })

    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(outcome).toEqual({
      kind: 'already-claimed',
      message: '今日已完成签到',
    })
    // ⚠️ 这条路径**不该**读钱包（省请求）。
    const urls = fetcher.mock.calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.includes(AUTOCLAW_WALLETS_PATH))).toHaveLength(0)
  })

  it('请求失败或网络异常时不抛错，返回 failed 状态', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      code: 5001,
      msg: '签到服务繁忙',
    }))

    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.message).toContain('签到服务繁忙')
    }

    const netErrFetcher = vi.fn().mockRejectedValue(new Error('Connection abort'))
    const netOutcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      fetcher: netErrFetcher as unknown as typeof fetch,
    })
    expect(netOutcome.kind).toBe('failed')
    if (netOutcome.kind === 'failed') {
      expect(netOutcome.message).toContain('Connection abort')
    }
  })
})

describe('临期桶：display 过滤与流水批次（2026-10-17 用户要求「像 buddy 一样红临期加倒计时」）', () => {
  /** 真实取证（scripts/probe-autoclaw-expiry.mjs）：发放带 wallet_expires_at（秒）。 */
  const LEDGER_PAGE = {
    code: 0,
    msg: 'SUCCESS',
    data: {
      entries: [
        {
          id: '1', asset_type: 'point', wallet_type: 'earned', wallet_scope: 'campaign',
          mutation_type: 'credit', amount: 20000, source: 'campaign',
          description: 'AutoClaw 用户登录奖励积分，7天有效',
          metadata: { description: 'AutoClaw 用户登录奖励积分，7天有效' },
          occurred_at: '2026-10-15T13:44:21Z', wallet_expires_at: 1_798_885_461,
        },
        {
          id: '2', asset_type: 'point', wallet_type: 'earned', wallet_scope: 'annual',
          mutation_type: 'credit', amount: 200, source: 'manual',
          description: '每日签到',
          metadata: { description: '每日签到' },
          occurred_at: '2026-10-17T13:44:43Z', wallet_expires_at: 1_798_885_483,
        },
        {
          id: '3', asset_type: 'point', wallet_type: 'earned', wallet_scope: 'campaign',
          mutation_type: 'credit', amount: 500, source: 'campaign',
          description: '已过期批次', occurred_at: '2026-10-01T00:00:00Z',
          wallet_expires_at: 1_700_000_000,
        },
      ],
    },
  }

  it('① 服务端 display=false 的隐藏池被丢弃（红色「每日 0」的根源）', () => {
    const raw = {
      total_balance: 20700,
      wallets: [
        { public_wallet_type: 'reward', display_name: '奖励积分', balance: 20700, display: true, priority: 10 },
        { public_wallet_type: 'daily', display_name: '每日积分', balance: 0, display: false, priority: 20 },
        { public_wallet_type: 'other', display_name: '其他积分', balance: 0, display: false, priority: 50 },
      ],
    }
    const packages = parseAutoclawWallets(raw.wallets)
    expect(packages, '官方客户端同款过滤（main.cjs readWallets）').toHaveLength(1)
    expect(packages[0]!.name).toBe('奖励积分')
    // ⚠️ 「每日红 + 刷新倒计时」按池名匹配（DAILY_POOL_NAMES），滤掉隐藏池后不再命中。
    expect(packages.some((p) => p.name === '每日积分')).toBe(false)
  })

  it('② 流水批次 → 逐包 deductionEndTime（毫秒），已过期批次丢弃，守恒口径', () => {
    const batches = parseAutoclawLedgerBatches(LEDGER_PAGE.data.entries, 1_798_800_000_000)
    // 已过期（第 3 条）丢弃；两条未过期按到期时刻各自成包，升序。
    expect(batches).toHaveLength(2)
    expect(batches[0]!.name).toContain('登录奖励')
    expect(batches[0]!.remaining).toBe(20000)
    expect(batches[0]!.deductionEndTime).toBe(1_798_885_461_000)
    expect(batches[1]!.name).toBe('每日签到')
    expect(batches[1]!.remaining).toBe(200)
    expect(batches[1]!.deductionEndTime).toBe(1_798_885_483_000)
    // 守恒：批次之和 == 钱包总额（fetch 层以此决定采用批次还是回退）。
    expect(batches.reduce((s, p) => s + p.remaining, 0)).toBe(20200)
  })

  it('③ 无到期字段的发放归永久桶（不带 deductionEndTime）', () => {
    const batches = parseAutoclawLedgerBatches([
      { mutation_type: 'credit', amount: 300, description: '永久赠送' },
      { mutation_type: 'credit', amount: 100, wallet_expires_at: 1_798_885_461, description: '限时' },
    ], 1_798_800_000_000)
    expect(batches).toHaveLength(2)
    const perm = batches.find((p) => p.deductionEndTime === undefined)
    expect(perm?.remaining).toBe(300)
    expect(batches.find((p) => p.deductionEndTime !== undefined)?.remaining).toBe(100)
  })

  it('④ 守恒成立 ⇒ 用批次包（临期桶可渲染）；不守恒 ⇒ 回退钱包包（不给错数）', async () => {
    const walletsPayload = {
      code: 0, msg: 'SUCCESS',
      data: {
        total_balance: 20200,
        wallets: [{ public_wallet_type: 'reward', display_name: '奖励积分', balance: 20200, display: true, priority: 10 }],
      },
    }
    // 守恒：批次之和 20200 == total_balance ⇒ 采用批次包。
    const okFetcher = vi.fn((url: string | URL) => {
      const u = String(url)
      if (u.includes(AUTOCLAW_LEDGERS_PATH)) return jsonResponse(LEDGER_PAGE)
      return jsonResponse(walletsPayload)
    })
    const ok = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, { fetcher: okFetcher as unknown as typeof fetch })
    expect(ok.balance!.total).toBe(20200)
    expect(ok.balance!.packages).toHaveLength(2)
    expect(ok.balance!.packages.every((p) => p.deductionEndTime !== undefined)).toBe(true)

    // 不守恒（钱包报 99999）⇒ 回退钱包包：宁缺临期，不错数。
    const mismatchPayload = { ...walletsPayload, data: { ...walletsPayload.data, total_balance: 99999 } }
    const badFetcher = vi.fn((url: string | URL) => {
      const u = String(url)
      if (u.includes(AUTOCLAW_LEDGERS_PATH)) return jsonResponse(LEDGER_PAGE)
      return jsonResponse(mismatchPayload)
    })
    const bad = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, { fetcher: badFetcher as unknown as typeof fetch })
    expect(bad.balance!.total).toBe(99999)
    expect(bad.balance!.packages).toHaveLength(1)
    expect(bad.balance!.packages[0]!.name).toBe('奖励积分')
  })

  it('⑤ 流水接口失败 ⇒ 回退钱包包（总额与长期数仍正确，只是没有临期桶）', async () => {
    const walletsPayload = {
      code: 0, msg: 'SUCCESS',
      data: {
        total_balance: 20700,
        wallets: [{ public_wallet_type: 'reward', display_name: '奖励积分', balance: 20700, display: true, priority: 10 }],
      },
    }
    const fetcher = vi.fn((url: string | URL) => {
      const u = String(url)
      if (u.includes(AUTOCLAW_LEDGERS_PATH)) return jsonResponse({ code: 500, msg: 'boom' })
      return jsonResponse(walletsPayload)
    })
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, { fetcher: fetcher as unknown as typeof fetch })
    expect(result.error).toBeUndefined()
    expect(result.balance!.total).toBe(20700)
    expect(result.balance!.packages).toHaveLength(1)
  })
})

describe('src/provider-credits.ts autoclaw 接线注册', () => {
  it('autoclaw 注册了 fetchBalanceDetailed 和 claim，且 precheckStatus 为 false', async () => {
    const table = createProviderCredits()
    const autoclawCredits = table.autoclaw

    expect(autoclawCredits).toBeDefined()
    expect(autoclawCredits?.fetchBalanceDetailed).toBeTypeOf('function')
    expect(autoclawCredits?.claim).toBeTypeOf('function')
    expect(autoclawCredits?.precheckStatus).toBe(false)
  })
})

/**
 * ★★ **登录后自动领取每日积分**（2026-10-17 新增）
 *
 * ## 为什么需要这组守卫
 *
 * 桌面端源码里有 `claimDailyCreditsOnSignIn(account, dailyCredits)`：
 * 账号状态刚变为 `authenticated` 时触发 `dailyCredits.claim()`。
 * ⇒ 这就是「登录即领」的**真实机制** —— 不是登录的副作用，而是登录后紧跟
 * 一次 `POST /userapi/v1/user-info`。
 *
 * ⚠️ 用户实测过的症状：纯插件登录后新账号**没有积分**（推理回 402
 * 「积分不足,请充值」），而在 IDE 里登录同一账号就有 —— 差别正是这一次调用。
 */
describe('★★ 登录后自动领取每日积分（对齐桌面端 claimDailyCreditsOnSignIn）', () => {
  class FakeCredentials {
    readonly store = new Map<string, string>()
    async resolve(ref: string) {
      const value = this.store.get(ref)
      return value === undefined ? undefined : { value }
    }
    async describe(ref: string) {
      return { configured: this.store.has(ref), writable: true }
    }
    async set(ref: string, value: string) { this.store.set(ref, value) }
    async unset(ref: string) { this.store.delete(ref) }
  }

  /** 造 ctx + 记录调用顺序的 fetcher。 */
  function setup(opts: { claimData?: Record<string, unknown>; claimFails?: boolean } = {}) {
    const ctx = new Context()
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    ctx.provide('commands', { register: () => () => {} } as never)
    const calls: string[] = []
    const fetcher = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes(AUTOCLAW_DAILY_CLAIM_PATH)) {
        calls.push('claim')
        if (opts.claimFails) return Promise.reject(new Error('claim network down'))
        return Promise.resolve(jsonResponse({
          code: 0,
          msg: 'SUCCESS',
          data: opts.claimData ?? { uid: 'u1', daily_check_in_completed_on_request: true },
        }))
      }
      if (u.includes('/userapi/v1/agent-login')) {
        calls.push('login')
        return Promise.resolve(jsonResponse({
          code: 0,
          msg: 'SUCCESS',
          data: {
            user_id: 'u1',
            user_name: 'tester',
            access_token: 'AT_123',
            refresh_token: 'RT_456',
            account_type: 'personal',
          },
        }))
      }
      calls.push('other')
      return Promise.resolve(jsonResponse({ code: 0, data: {} }))
    })
    const service = new AutoclawAuth(ctx, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })
    return { service, credentials, calls, fetcher }
  }

  it('★ 登录成功后**自动**调一次领取接口（这是「登录即领」的机制）', async () => {
    const { service, calls } = setup()
    const res = await service.loginWithCode('13015225433', '123456', 'AUTOCLAW_ACCOUNT_TEST')
    expect(res.ok).toBe(true)
    // ⚠️ 顺序必须是 login → claim（先拿凭据才能领）。
    expect(calls.filter((c) => c === 'login' || c === 'claim')).toEqual(['login', 'claim'])
  })

  it('★ 凭据必须在领取**之前**落盘（领取要用刚写入的凭据）', async () => {
    const { service, credentials } = setup()
    await service.loginWithCode('13015225433', '123456', 'AUTOCLAW_ACCOUNT_TEST')
    // ⚠️ 若顺序反了，领取时读不到凭据 ⇒ 线上恒失败但单测可能仍绿。
    expect(credentials.store.has('AUTOCLAW_ACCOUNT_TEST')).toBe(true)
    const written = JSON.parse(credentials.store.get('AUTOCLAW_ACCOUNT_TEST')!)
    expect(written.access_token).toBe('AT_123')
  })

  it('⚠️⚠️ 领取失败**绝不反噬登录**（凭据已落盘且可用）', async () => {
    // ⚠️ 这是本组最重要的一条：若把领取失败上抛，用户会以为「登录失败」
    //   而反复重新登录 —— 比「没领到积分」更糟。
    const { service, credentials } = setup({ claimFails: true })
    const res = await service.loginWithCode('13015225433', '123456', 'AUTOCLAW_ACCOUNT_TEST')
    expect(res.ok, '领取失败时登录仍须成功').toBe(true)
    expect(credentials.store.has('AUTOCLAW_ACCOUNT_TEST'), '凭据仍须落盘').toBe(true)
  })

  it('⚠️ 领取返回业务错误（code!=0）也不反噬登录', async () => {
    const ctx = new Context()
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    ctx.provide('commands', { register: () => () => {} } as never)
    const fetcher = vi.fn().mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes(AUTOCLAW_DAILY_CLAIM_PATH)) {
        return Promise.resolve(jsonResponse({ code: 400001, msg: '请求数据有问题' }))
      }
      return Promise.resolve(jsonResponse({
        code: 0,
        data: { user_id: 'u1', access_token: 'AT', refresh_token: 'RT' },
      }))
    })
    const service = new AutoclawAuth(ctx, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })
    const res = await service.loginWithCode('13015225433', '123456', 'AUTOCLAW_ACCOUNT_TEST')
    expect(res.ok).toBe(true)
  })

  it('⚠️ 登录失败时**不得**调领取（没有凭据可领）', async () => {
    const ctx = new Context()
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    ctx.provide('commands', { register: () => () => {} } as never)
    const calls: string[] = []
    const fetcher = vi.fn().mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes(AUTOCLAW_DAILY_CLAIM_PATH)) { calls.push('claim'); return Promise.resolve(jsonResponse({ code: 0, data: {} })) }
      calls.push('login')
      return Promise.resolve(jsonResponse({ code: 10001, msg: '验证码错误' }))
    })
    const service = new AutoclawAuth(ctx, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })
    const res = await service.loginWithCode('13015225433', '000000', 'AUTOCLAW_ACCOUNT_TEST')
    expect(res.ok).toBe(false)
    expect(calls, '登录失败时不该调领取').not.toContain('claim')
    expect(credentials.store.size).toBe(0)
  })
})
