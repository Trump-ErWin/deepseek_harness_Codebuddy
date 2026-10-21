import { describe, expect, it, vi } from 'vitest'
import { fetchQoderCreditBalance, QODER_USAGE_PATH } from '../../src/qoder-credits.js'
import { QODER } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/qoder.js'

const cred: QoderCredential = buildQoderCredential(
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref' }), { machineId: 'm-1' })

/** 实测的真实响应形状（2026-09-19，真实凭据）。 */
function usageResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    displayMode: 'qoder',
    qoderUsage: {
      userId: '01a0b514-ad7c-7dca-ae92-70181beb532e',
      userType: 'personal_standard',
      usageType: 'credits',
      totalUsagePercentage: 0,
      isQuotaExceeded: false,
      expiresAt: 253402214400000,
      upgradeUrl: 'https://qoder.com/pricing?client=qoder',
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
      addOnQuota: {
        total: 100, used: 0, remaining: 100, percentage: 0, unit: 'credits',
        detailUrl: 'https://qoder.com/account/usage',
      },
      isPlanQuotaProrated: false,
      ...overrides,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('Qoder 积分余额', () => {
  it('读取 addOnQuota 的 100 积分（真实响应形状）', async () => {
    // 实测：userQuota.remaining=0 而 addOnQuota.remaining=100
    // —— 资源包余额在 addOnQuota 里，只读 userQuota 会得到 0（真实缺陷风险）
    const fetcher = vi.fn(async () => usageResponse()) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance).not.toBeNull()
    expect(balance!.total).toBe(100)
    expect(balance!.packages.length).toBeGreaterThan(0)
  })

  it('请求路径与鉴权头正确（Bearer + Cosy-ClientType，且不带签名）', async () => {
    const fetcher = vi.fn(async () => usageResponse()) as unknown as typeof fetch
    await fetchQoderCreditBalance(cred, QODER, fetcher)
    const call = (fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    expect(String(call[0])).toBe(`https://openapi.qoder.sh${QODER_USAGE_PATH}`)
    const headers = (call[1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers['Cosy-ClientType']).toBe('10')
  })

  it('userQuota 与 addOnQuota 同时非零时相加', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 500, used: 200, remaining: 300, percentage: 0.4, unit: 'credits' },
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    // 300（套餐剩余）+ 100（资源包剩余）
    expect(balance!.total).toBe(400)
  })

  it('累加专用资源包（dedicatedResourcePackages）', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      dedicatedResourcePackages: [
        { id: 'p1', name: '包A', total: 50, used: 10, remaining: 40, unit: 'credits' },
      ],
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance!.total).toBe(140)
  })

  /**
   * ★★ **`dedicatedResourcePackages` 的永久哨兵也必须被拦住**
   * （2026-10-21 合并审计发现，真实缺陷）。
   *
   * ## 缺陷
   *
   * PR !131 只对 `userQuota` 那一路的数字 `expiresAt` 做了哨兵识别，判定为永久后
   * **直接落到 `expiredTime` 字符串那一路**（`dedicatedResourcePackages[]` 走的正是
   * 它），而**那一路没有哨兵判据**。本机账号该字段实测是 `undefined` ⇒ 这条路径
   * **没有真机样本**，缺陷因此从未暴露。
   *
   * 实测后果（本用例固化）：
   * 1. `deductionEndTime` 被写成 `253402214400000` ⇒ 客户端
   *    `formatPackageExpiry` 渲染出 **「9999-12-31（2912150 天后）」**；
   * 2. 该包落 **`longTerm`** 而不是 `permanent`，而 `longTerm` 在**锁定永久积分时
   *    仍然可选** ⇒ 「锁住的永久积分」在这一路径上照样被烧，锁定形同虚设。
   *
   * ⚠️ 本用例**必须断言 `deductionEndTime` 不存在**，不能只断言 `total` ——
   *    上面那条既有用例只断言 `total`，改坏哨兵判据它照样绿（这就是它没抓到
   *    本缺陷的原因）。
   */
  it('★★ dedicatedResourcePackages 的 9999 哨兵不得写进 deductionEndTime', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      dedicatedResourcePackages: [
        {
          id: 'p1',
          name: '包A',
          total: 100,
          used: 0,
          remaining: 100,
          unit: 'credits',
          expiresAt: '9999-12-31T00:00:00.000Z',
        },
      ],
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    const pkg = balance!.packages.find((p) => p.name === '包A')
    expect(pkg, '包A 应被解析出来').toBeDefined()
    expect(
      pkg!.deductionEndTime,
      '★ 9999 哨兵不得写进 deductionEndTime（否则渲染成「9999-12-31（约 290 万天后）」）',
    ).toBeUndefined()
    // 余额照常计入（哨兵只影响「何时作废」，不影响「有多少」）。
    // ⚠️ `usageResponse` 的默认报文里 `addOnQuota` 带 100 ⇒ 合计 100 + 100。
    expect(balance!.total).toBe(200)
  })

  it('★★ 同上，纯日期形态 "9999-12-31" 与 9999 年内其它日期也要挡', async () => {
    for (const raw of ['9999-12-31', '9999-01-01', '9999-06-15T12:00:00.000Z']) {
      const fetcher = vi.fn(async () => usageResponse({
        userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
        dedicatedResourcePackages: [
          { id: 'p', name: 'P', total: 10, used: 0, remaining: 10, unit: 'credits', expiresAt: raw },
        ],
      })) as unknown as typeof fetch
      const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
      expect(
        balance!.packages.find((p) => p.name === 'P')!.deductionEndTime,
        `${raw} 必须被识别为哨兵`,
      ).toBeUndefined()
    }
  })

  /**
   * ★★ **哨兵命中时 `expiredTime` 也必须清空**（2026-10-21 对抗性审计发现，P1）。
   *
   * ## 缺陷：只挡 `deductionEndTime` 是**不完整的修复**
   *
   * 客户端 `credit-expiry.js` 的 `packageExpiryMs()` 是**两段回落**：
   * 先读 `deductionEndTime`（数字），读不到再读 `expiredTime`（字符串，
   * `Date.parse`）。⇒ 即使上一版已把 `deductionEndTime` 正确清空，
   * 只要 `expiredTime` 还留着原串，tooltip 照样渲染哨兵日期。
   *
   * 实测（本机，构造报文）：
   * ```
   * { deductionEndTime: undefined, expiredTime: '9999-12-31T00:00:00.000Z' }
   * → packageExpiryMs    = 253402214400000
   * → formatPackageExpiry = "9999-12-31（2912150 天后）"
   * ```
   * ⇒ 正是本 PR 声称「已消灭」的那句荒谬文案，**换了个字段入口又回来**。
   *   分桶不受影响（`permanent`，锁定会拦），但三档行说「永久」、hover 里说
   *   「9999-12-31 到期」，**同一个包两句话互相矛盾**。
   *
   * ⚠️ 这条用例**必须断言 `expiredTime` 为空串** —— 只断言
   *    `deductionEndTime === undefined`（上面两条）抓不到本缺陷。
   */
  it('★★ 哨兵命中时 expiredTime 也必须清空（否则前端回落到它，照样渲染 9999）', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      dedicatedResourcePackages: [
        {
          id: 'p', name: 'P', total: 100, used: 0, remaining: 100,
          unit: 'credits', expiresAt: '9999-12-31T00:00:00.000Z',
        },
      ],
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    const pkg = balance!.packages.find((p) => p.name === 'P')!
    expect(
      pkg.expiredTime,
      '★ 哨兵串不得留在 expiredTime 里 —— 前端 packageExpiryMs 会回落到它并渲染「9999-12-31（约 290 万天后）」',
    ).toBe('')
  })

  it('★ 反面对照：真实日期的 expiredTime 必须原样保留（tooltip 要显示上游原文）', async () => {
    // 若把 `expiredTime` 一律清空，上面那条会绿而真实原文丢失 —— 这是反向对照。
    const raw = '2026-11-19T00:00:00.000Z'
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      dedicatedResourcePackages: [
        { id: 'p', name: 'P', total: 100, used: 0, remaining: 100, unit: 'credits', expiresAt: raw },
      ],
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    const pkg = balance!.packages.find((p) => p.name === 'P')!
    expect(pkg.expiredTime).toBe(raw)
    expect(pkg.deductionEndTime).toBe(Date.parse(raw))
  })

  it('★ 反面对照：dedicatedResourcePackages 的**真实**到期日期仍要写进 deductionEndTime', async () => {
    // 若把哨兵判据写成「一律不写」，上面两条会全绿而真实日期丢失 ——
    // 这条是那个方向的反面对照（本仓库红线：守卫必须有反向对照）。
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      dedicatedResourcePackages: [
        {
          id: 'p', name: '真实包', total: 100, used: 0, remaining: 100,
          unit: 'credits', expiresAt: '2026-11-19T00:00:00.000Z',
        },
      ],
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    const pkg = balance!.packages.find((p) => p.name === '真实包')!
    expect(pkg.deductionEndTime).toBe(Date.parse('2026-11-19T00:00:00.000Z'))
  })

  it('企业版（displayMode=enterprise）返回带原因的 null，而非 0', async () => {
    // 「查不到」与「余额为 0」必须严格区分（AGENTS.md 约定）
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      displayMode: 'enterprise',
      enterpriseUsage: { openMode: 'externalBrowser', detailUrl: 'https://qoder.com/x' },
    }), { status: 200 })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance).toBeNull()
  })

  it('401 返回带原因的 null（凭据失效）', async () => {
    const fetcher = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance).toBeNull()
  })

  it('网络失败返回 null（不抛错，与其它 provider 同语义）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    await expect(fetchQoderCreditBalance(cred, QODER, fetcher)).resolves.toBeNull()
  })

  it('响应形状非法时返回 null（不误报 0）', async () => {
    const fetcher = vi.fn(async () => new Response('{"displayMode":"qoder"}', { status: 200 })) as unknown as typeof fetch
    await expect(fetchQoderCreditBalance(cred, QODER, fetcher)).resolves.toBeNull()
  })
})
