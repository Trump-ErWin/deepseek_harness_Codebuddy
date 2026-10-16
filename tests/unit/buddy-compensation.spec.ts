import { describe, expect, it, vi } from 'vitest'
import {
  COMPENSATION_CLAIM_PATH,
  COMPENSATION_STATUS_PATH,
  claimCompensation,
  describeCompensationFailure,
  fetchCompensationStatus,
} from '../../src/buddy-compensation.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

/**
 * ⚠️ fixture 的形状取自 **2026-10-16 的真实报文**（本机 buddy 账号实发，
 * 未经浏览器、纯 Node fetch）：
 *
 * POST {webBase}/billing/meter/compensation-status   body {}
 * → 200 {"code":0,"msg":"OK","requestId":"…","data":{
 *        "claimed":false,"active":true,"credit_num":500,
 *        "validity_period":1,"end_time":"2026-10-22 23:59:59"}}
 *
 * 端点原文取自 www.codebuddy.cn 的前端 bundle：
 *   bp=async()=>await cn.post("/billing/meter/compensation-status")、
 *   vp=async()=>await cn.post("/billing/meter/claim-compensation")。
 *
 * 若将来实测发现字段变了，**改解析层 + 本 fixture 一起改**，不要只改一边。
 */
const STATUS_ACTIVE = {
  code: 0,
  msg: 'OK',
  requestId: '5d0d907e-949e-4392-bd8e-5326181b2c7a',
  data: {
    claimed: false,
    active: true,
    credit_num: 500,
    validity_period: 1,
    end_time: '2026-10-22 23:59:59',
  },
}

const CREDENTIAL = {
  access_token: 'test-access-token',
  domain: 'copilot.tencent.com',
  user_id: 'u-1',
  enterprise_id: 'e-1',
} as unknown as BuddyCredential

/** 造一个只回一种响应的 fetcher，并记录收到的请求。 */
function fakeFetcher(body: string, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

describe('buddy-compensation：端点常量', () => {
  it('两条路径**都没有 /v2 前缀**（与 WorkBuddy 的 /v2/billing/meter/… 不同产品面）', () => {
    expect(COMPENSATION_STATUS_PATH).toBe('/billing/meter/compensation-status')
    expect(COMPENSATION_CLAIM_PATH).toBe('/billing/meter/claim-compensation')
    expect(COMPENSATION_STATUS_PATH.startsWith('/v2/')).toBe(false)
    expect(COMPENSATION_CLAIM_PATH.startsWith('/v2/')).toBe(false)
  })
})

describe('buddy-compensation：状态查询', () => {
  it('打的是 webBase 而不是推理站 endpoint', async () => {
    // ⚠️ 断言**不写死主机名**：`webBase` 是产品配置，改了配置不该让用例假红。
    //    这里锁的是「用的是 webBase 那一格」这个**取舍**（见模块头）。
    const { fetcher, calls } = fakeFetcher(JSON.stringify(STATUS_ACTIVE))
    await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(CODEBUDDY.webBase + COMPENSATION_STATUS_PATH)
    expect(calls[0]!.url.startsWith(CODEBUDDY.endpoint)).toBe(false)
  })

  it('POST + 空 JSON body + Bearer 鉴权（无需浏览器 cookie）', async () => {
    const { fetcher, calls } = fakeFetcher(JSON.stringify(STATUS_ACTIVE))
    await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.body).toBe('{}')
    const headers = calls[0]!.init.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer test-access-token')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('真实报文逐字段映射（含 credit_num / end_time 原文）', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify(STATUS_ACTIVE))
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status.claimed).toBe(false)
    expect(result.status.active).toBe(true)
    expect(result.status.creditNum).toBe(500)
    expect(result.status.validityPeriod).toBe(1)
    expect(result.status.endTime).toBe('2026-10-22 23:59:59')
  })

  it('已领取 / 活动已结束的形态如实反映', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({
      code: 0, msg: 'OK',
      data: { claimed: true, active: false, credit_num: 500, end_time: '2026-10-22 23:59:59' },
    }))
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status.claimed).toBe(true)
    expect(result.status.active).toBe(false)
    expect(result.status.creditNum).toBe(500)
  })

  it('可选字段缺失时不报错（validity_period / end_time 省略）', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({
      code: 0, msg: 'OK', data: { claimed: false, active: true, credit_num: 0 },
    }))
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status.creditNum).toBe(0)
    expect(result.status.validityPeriod).toBeUndefined()
    expect(result.status.endTime).toBeUndefined()
  })
})

describe('buddy-compensation：失败分类（三层不合并）', () => {
  it('业务码非 0 ⇒ upstream，且带上游 msg 原文', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({ code: 40301, msg: '活动已结束' }))
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('upstream')
    expect(describeCompensationFailure(result.failure)).toContain('活动已结束')
    expect(describeCompensationFailure(result.failure)).toContain('40301')
  })

  it('缺 data ⇒ shape（不是 upstream，也不当成成功）', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({ code: 0, msg: 'OK' }))
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('shape')
  })

  it('非 JSON（HTML 错误页）⇒ network，且带 HTTP 状态码', async () => {
    const { fetcher } = fakeFetcher('<html><body>502 Bad Gateway</body></html>', 502)
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('network')
    expect(describeCompensationFailure(result.failure)).toContain('502')
  })

  it('fetch 抛错（超时/断连）⇒ network，不冒泡', async () => {
    const fetcher = (async () => { throw new Error('The operation was aborted') }) as unknown as typeof fetch
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('network')
    expect(describeCompensationFailure(result.failure)).toContain('aborted')
  })

  it('缺 webBase/claimBase 配置 ⇒ 可读错误，不拼出 undefined/…', async () => {
    const broken = { ...CODEBUDDY, webBase: undefined, claimBase: undefined } as unknown as typeof CODEBUDDY
    const { fetcher, calls } = fakeFetcher(JSON.stringify(STATUS_ACTIVE))
    const result = await fetchCompensationStatus(CREDENTIAL, broken, fetcher)
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
    if (result.ok) return
    expect(describeCompensationFailure(result.failure)).toContain('webBase')
  })
})

describe('buddy-compensation：领取（写操作）', () => {
  it('POST 到 claim 路径，成功即 ok', async () => {
    const { fetcher, calls } = fakeFetcher(JSON.stringify({ code: 0, msg: 'OK', data: {} }))
    const result = await claimCompensation(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(true)
    expect(calls[0]!.url).toBe(CODEBUDDY.webBase + COMPENSATION_CLAIM_PATH)
    expect(calls[0]!.init.method).toBe('POST')
  })

  it('⚠️ 最多发一次请求：不做重试（一次性写操作，超时可能已成功）', async () => {
    const { fetcher, calls } = fakeFetcher(JSON.stringify({ code: 500, msg: 'boom' }), 500)
    await claimCompensation(CREDENTIAL, CODEBUDDY, fetcher)
    expect(calls).toHaveLength(1)
  })

  it('业务码非 0 ⇒ 失败且带原文（"已领取"不能被误报成成功）', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({ code: 40901, msg: '已领取过' }))
    const result = await claimCompensation(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(describeCompensationFailure(result.failure)).toContain('已领取过')
  })
})

describe('buddy-compensation：产品隔离', () => {
  it('workbuddy 走自己的 webBase（函数层产品无关；宿主侧另有 provider 硬门控）', async () => {
    const { fetcher, calls } = fakeFetcher(JSON.stringify(STATUS_ACTIVE))
    await fetchCompensationStatus(CREDENTIAL, WORKBUDDY, fetcher)
    expect(calls[0]!.url.startsWith(WORKBUDDY.webBase)).toBe(true)
  })
})

describe('buddy-compensation：接线守卫（源码级）', () => {
  /**
   * ⚠️ 本仓库的既有铁律：一次性/有代价动作**默认不自动执行**
   * （buddy-growth.ts 的 runExotic 是同一约定的先例）。
   *
   * 故这里必须有守卫锁住「补偿没有被偷偷接进自动签到」——
   * 否则将来有人顺手加进去，用户的一次性机会会在无人察觉时被用掉。
   */
  it('⚠️ 补偿不得出现在 auto-checkin / credits 里', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = resolve(fileURLToPath(import.meta.url), '..')

    for (const rel of ['../../src/auto-checkin.ts', '../../src/credits.ts']) {
      const source = readFileSync(resolve(here, rel), 'utf8')
      expect(source.includes('buddy-compensation'), rel + ' 引入了 buddy-compensation').toBe(false)
      expect(/claimCompensation/.test(source), rel + ' 调用了 claimCompensation').toBe(false)
    }
  })

  it('宿主 RPC 用 provider 硬门控（非 buddy 请求被拒）', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = resolve(fileURLToPath(import.meta.url), '..')
    const source = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
    expect(source).toContain("case 'buddy.compensationStatus'")
    expect(source).toContain("case 'buddy.claimCompensation'")
    const guardCount = (source.match(/req\.provider !== CODEBUDDY\.id/g) ?? []).length
    expect(guardCount, '两条补偿 RPC 都应有 provider 硬门控').toBeGreaterThanOrEqual(2)
  })
})
