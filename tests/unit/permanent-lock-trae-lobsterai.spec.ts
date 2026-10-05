import { describe, expect, it } from 'vitest'
import { BuddyBalanceSelector, pickBuddyAccount } from '../../src/buddy-balance-selector.js'
import { BUDDY_BALANCE_TIER, splitBuddyCreditsByExpiry, buddyBalanceTier } from '../../src/buddy-balance-rank.js'
import { PERMANENT_LOCK_PROVIDERS } from '../../src/jet-hub-rpc.js'
import { supportsPermanentLock, permanentLockCopy } from '../../plugin-src/client/credits-capabilities.js'
import type { CreditBalance } from '../../src/credits.js'

/**
 * TRAE（字节）与 LobsterAI（有道）的「锁定永久积分」。
 *
 * ## 为什么这两家能加进来
 *
 * 分档判据 `splitBuddyCreditsByExpiry` 只读通用的
 * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**：
 * - TRAE 的条目级 `expire_time`（秒级 Unix）已归一化到 `deductionEndTime`；
 * - LobsterAI 的 `expiresAt`（ISO 8601）同样已归一化。
 *
 * 两家都没有「每日额度 / 永久积分」两个**命名池**，但「会不会马上作废」这件事
 * 只需到期时间就能判定 —— 这正是锁定功能要的判据。
 */

const DAY = 24 * 60 * 60 * 1000
/** 固定「现在」，让窗口边界断言可复现。 */
const NOW = Date.UTC(2026, 9, 6, 0, 0, 0)
const WINDOW = 15 * DAY

/** 造一份 TRAE 形态的余额（条目级 expire_time 已归一化）。 */
function traeBalance(packages: CreditBalance['packages']): CreditBalance {
  return { total: packages.reduce((s, p) => s + p.remaining, 0), packages, expiredTotal: 0 }
}

describe('TRAE（字节）—— 按到期时间分桶', () => {
  it('签到奖励（3 天后到期）归「快到期」、每月赠送（25 天后）归「永久」', () => {
    const split = splitBuddyCreditsByExpiry(traeBalance([
      { name: '签到奖励', unit: 'credits', remaining: 150, total: 150, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 3 * DAY },
      { name: '每月登录赠送', unit: 'credits', remaining: 500, total: 500, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 25 * DAY },
    ]), NOW, WINDOW)
    expect(split).toEqual({ expiring: 150, permanent: 500 })
  })

  it('★ 拿不到 expire_time（不设 deductionEndTime）归入**永久**桶（保守方向）', () => {
    // `src/trae-credits.ts`：expire_time 为 0 / 缺失时不设 deductionEndTime。
    // 宁可当「不会马上作废」（锁定时少用一个号），也不要把长期积分误当快到期烧掉。
    const split = splitBuddyCreditsByExpiry(traeBalance([
      { name: '免费', unit: 'credits', remaining: 300, total: 300, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '' },
    ]), NOW, WINDOW)
    expect(split).toEqual({ expiring: 0, permanent: 300 })
  })

  it('★ 只剩永久积分时，锁定必须判为不可用（none 档）', () => {
    const split = splitBuddyCreditsByExpiry(traeBalance([
      { name: '每月登录赠送', unit: 'credits', remaining: 500, total: 500, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 25 * DAY },
    ]), NOW, WINDOW)!
    expect(buddyBalanceTier({ expiringBalance: split.expiring, permanentBalance: split.permanent }))
      .toBe(BUDDY_BALANCE_TIER.permanent)
    expect(buddyBalanceTier({ expiringBalance: split.expiring, permanentBalance: split.permanent }, { allowPermanent: false }))
      .toBe(BUDDY_BALANCE_TIER.none)
  })
})

describe('LobsterAI（有道）—— 按到期时间分桶', () => {
  it('每日登录奖励（3/4 天后）归「快到期」、新手礼包（45 天后）归「永久」', () => {
    const split = splitBuddyCreditsByExpiry(traeBalance([
      { name: '每日登录奖励', unit: 'credit', remaining: 100, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 3 * DAY },
      { name: '每日登录奖励', unit: 'credit', remaining: 100, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 4 * DAY },
      { name: '新手礼包', unit: 'credit', remaining: 100, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 45 * DAY },
    ]), NOW, WINDOW)
    expect(split).toEqual({ expiring: 200, permanent: 100 })
  })

  it('★ 已过期包（active:false）不得计入任何一桶', () => {
    // 失效包的服务端仍会返回余额，并进任何一桶都会虚增可用额度。
    const split = splitBuddyCreditsByExpiry(traeBalance([
      { name: '每日登录奖励', unit: 'credit', remaining: 100, total: 0, used: 0, active: false, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW - 1 * DAY },
      { name: '新手礼包', unit: 'credit', remaining: 50, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 40 * DAY },
    ]), NOW, WINDOW)
    expect(split).toEqual({ expiring: 0, permanent: 50 })
  })
})

describe('窗口天数对两家的影响（共用 DSH_BUDDY_EXPIRING_WINDOW_DAYS）', () => {
  it('同一份余额在不同窗口下分桶不同（7 天 vs 15 天）', () => {
    const balance = traeBalance([
      { name: 'a', unit: 'credit', remaining: 100, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 5 * DAY },
      { name: 'b', unit: 'credit', remaining: 500, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 9 * DAY },
    ])
    expect(splitBuddyCreditsByExpiry(balance, NOW, 7 * DAY)).toEqual({ expiring: 100, permanent: 500 })
    expect(splitBuddyCreditsByExpiry(balance, NOW, 15 * DAY)).toEqual({ expiring: 600, permanent: 0 })
  })

  it('查询失败（null）返回 undefined，由调用方归入最后一档', () => {
    expect(splitBuddyCreditsByExpiry(null, NOW, WINDOW)).toBeUndefined()
    expect(splitBuddyCreditsByExpiry(undefined, NOW, WINDOW)).toBeUndefined()
  })
})

describe('选号器泛型化后对两家的实际行为', () => {
  /** 造一个选择器：余额由固定表给出，凭据解析恒成功。 */
  function makeSelector<TProduct, TCredential extends { token: string }>(
    product: TProduct,
    balanceById: Record<string, CreditBalance>,
  ) {
    return new BuddyBalanceSelector<TProduct, TCredential>({
      product,
      resolveCredential: async (ref) => ({ token: `cred-${ref}` }) as TCredential,
      fetchBalance: async (credential) => balanceById[credential.token.replace('cred-', '')] ?? null,
    })
  }

  const CANDIDATES = [
    { id: 'permanent-only', credentialRef: 'permanent-only' },
    { id: 'has-expiring', credentialRef: 'has-expiring' },
  ]
  const BALANCES = {
    'permanent-only': traeBalance([
      { name: '长期包', unit: 'credit', remaining: 500, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: Date.now() + 30 * DAY },
    ]),
    'has-expiring': traeBalance([
      { name: '签到奖励', unit: 'credit', remaining: 150, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: Date.now() + 3 * DAY },
    ]),
  }

  // 两家各跑一遍：泛型化的意义就是同一套编排对任意 provider 成立。
  for (const label of ['TRAE', 'LobsterAI']) {
    it(`${label}：未锁定 → 优先选有快到期积分的号（哪怕它排在后面）`, async () => {
      const selector = makeSelector<{ id: string }, { token: string }>({ id: label }, BALANCES)
      const picked = await pickBuddyAccount(selector, CANDIDATES, {
        allowPermanent: true,
        resolveCredential: async (ref) => ({ token: `cred-${ref}` }),
      })
      expect(picked.kind).toBe('account')
      if (picked.kind === 'account') expect(picked.account.id).toBe('has-expiring')
    })

    it(`${label}：★ 已锁定 + 只剩永久积分 → locked（不消耗永久积分）`, async () => {
      const selector = makeSelector<{ id: string }, { token: string }>({ id: label }, BALANCES)
      const picked = await pickBuddyAccount(selector, [CANDIDATES[0]!], {
        allowPermanent: false,
        resolveCredential: async (ref) => ({ token: `cred-${ref}` }),
      })
      expect(picked.kind).toBe('locked')
    })

    it(`${label}：未锁定 + 只剩永久积分 → 可用（解锁生效）`, async () => {
      const selector = makeSelector<{ id: string }, { token: string }>({ id: label }, BALANCES)
      const picked = await pickBuddyAccount(selector, [CANDIDATES[0]!], {
        allowPermanent: true,
        resolveCredential: async (ref) => ({ token: `cred-${ref}` }),
      })
      expect(picked.kind).toBe('account')
    })
  }
})

describe('前后端能力声明一致（trae / lobsterai）', () => {
  it('后端白名单含两家，且未误加其它 provider', () => {
    expect(PERMANENT_LOCK_PROVIDERS.has('trae')).toBe(true)
    expect(PERMANENT_LOCK_PROVIDERS.has('lobsterai')).toBe(true)
    // 原有三家不得丢失
    expect(PERMANENT_LOCK_PROVIDERS.has('loomy')).toBe(true)
    expect(PERMANENT_LOCK_PROVIDERS.has('buddy')).toBe(true)
    expect(PERMANENT_LOCK_PROVIDERS.has('workbuddy')).toBe(true)
    // ⚠️ 这两家没有逐包到期时间，加进来开关无效
    expect(PERMANENT_LOCK_PROVIDERS.has('qoder')).toBe(false)
    expect(PERMANENT_LOCK_PROVIDERS.has('cline')).toBe(false)
  })

  it('前端 supportsPermanentLock 与后端逐项一致', () => {
    for (const id of PERMANENT_LOCK_PROVIDERS) {
      expect(supportsPermanentLock(id), id).toBe(true)
    }
    // 反向：后端没登记的，前端也不得渲染按钮
    for (const id of ['qoder', 'qodercn', 'cline', 'raccoon', 'minimax', 'zcode', 'codearts']) {
      expect(supportsPermanentLock(id), id).toBe(false)
    }
  })

  it('★ 两家走「带天数」的文案（不得落到 Loomy 那套「每日赠送额度」）', () => {
    // ⚠️ 这是真实易错点：它们没有「每日额度」概念，落到 Loomy 文案会说反。
    for (const id of ['trae', 'lobsterai', 'buddy', 'workbuddy']) {
      const copy = permanentLockCopy(id, 7)
      expect(copy.days, id).toBe(7)
      expect(copy.lockTitle, id).toContain('7 天内到期')
    }
  })

  it('Loomy 仍走「每日赠送额度」文案（无窗口概念）', () => {
    const copy = permanentLockCopy('loomy', 7)
    expect(copy.days).toBeNull()
    expect(copy.lockTitle).toContain('每日赠送额度')
    expect(copy.lockTitle).not.toContain('7 天内到期')
  })
})
