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
  it('daily_check_in_completed_on_request 为 true 时返回 claimed', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      code: 0,
      msg: 'SUCCESS',
      data: {
        uid: 'user_123',
        daily_check_in_completed_on_request: true,
      },
    }))

    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(outcome).toEqual({
      kind: 'claimed',
      credit: 0,
      streakDays: 0,
      isStreakDay: false,
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_DAILY_CLAIM_PATH}`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      source_id: 'autoclaw',
      device_id: MOCK_CREDENTIAL.device_id,
    })
  })

  it('daily_check_in_completed_on_request 为 false 时返回 already-claimed', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      code: 0,
      msg: 'SUCCESS',
      data: {
        uid: 'user_123',
        daily_check_in_completed_on_request: false,
      },
    }))

    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(outcome).toEqual({
      kind: 'already-claimed',
      message: '今日已完成签到',
    })
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
