import { describe, expect, it, vi } from 'vitest'
import { AUTOCLAW } from '../../src/autoclaw-product.js'
import {
  AUTOCLAW_DAILY_CLAIM_PATH,
  AUTOCLAW_WALLETS_PATH,
  claimAutoclawDailyQuota,
  fetchAutoclawBalanceDetailed,
  fetchAutoclawCreditBalance,
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
  it('正确解析各类型钱包明细并按 priority 升序排序', () => {
    const packages = parseAutoclawWallets(MOCK_WALLETS_PAYLOAD.data.wallets)
    expect(packages).toHaveLength(5)

    expect(packages[0]).toMatchObject({
      name: '奖励积分',
      remaining: 32365,
      total: 32365,
      active: true,
      unit: '积分',
    })
    expect(packages[1]).toMatchObject({
      name: '每日积分',
      remaining: 0,
      active: false,
    })
    expect(packages[2]).toMatchObject({
      name: '签约积分',
      remaining: 0,
    })
    expect(packages[3]).toMatchObject({
      name: '加油包积分',
      remaining: 0,
    })
    expect(packages[4]).toMatchObject({
      name: '其他积分',
      remaining: 0,
    })
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
    expect(result.balance!.packages).toHaveLength(5)
    expect(result.balance!.expiredTotal).toBe(0)

    expect(fetcher).toHaveBeenCalledTimes(1)
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
