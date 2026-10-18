/**
 * Qoder「账号尚未开通每日领取」判据的回归用例。
 *
 * ## 判据演进（两代缺陷）
 *
 * ### 第一代（2026-09-26）：判据取 `addOnQuota` 缺失
 * 用本插件经 GitHub 授权**新注册**的 Qoder 账号，一键签到显示「当前没有可领取
 * 的活动」，用户以为是我们没做对。实测证明不是设备身份问题，而是该账号在 Qoder
 * 侧确实没有每日领取活动。于是判据定为「无 `CLAIM_BENEFIT` 且 `addOnQuota` 缺失」。
 *
 * ### 第二代（2026-10-07，Issue IKJSHK）：`addOnQuota` 不可靠 → 改用活动列表
 * 用户报障：`qoder` / `qodercn` 11 个账号里 **7 个**已开通账号也被判「未开通」。
 * 维护者复核确认：**已开通账号也常常没有 `addOnQuota`**（只有 `userQuota`），
 * 且**同一份响应形状**曾同时被判成「真未开通」与「误报」——`addOnQuota` 分不开
 * 这两类账号。故判据改为**只看服务端活动列表**（`/sash/api/v1/me/campaigns`）：
 *
 * | 活动列表形态 | 判定 |
 * |---|---|
 * | 含任意 `CLAIM_BENEFIT`（可领或已领） | 已开通 → false |
 * | `showCampaign:true` 且无 `CLAIM_BENEFIT`（只剩 `VIEW_DETAILS`） | 未开通 → true |
 * | 空列表 / `showCampaign:false` / 未取到 | 无法判定 → false（保守不误报） |
 */

import { describe, expect, it } from 'vitest'
import {
  claimQoderDailyCheckin,
  fetchQoderCheckinStatus,
  isQoderNotActivated,
  type QoderCampaigns,
} from '../../src/qoder-credits.js'
import { QODER } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/qoder.js'

/** 有 CLAIM_BENEFIT 且已领（已开通账号的「今天已领」形态，真实抓包 CAMPAIGNS_AFTER_CLAIM）。 */
const CAMPAIGNS_BENEFIT_CLAIMED: QoderCampaigns = {
  showCampaign: true,
  claimable: false,
  campaigns: [
    { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED' },
    { campaignId: 'c2', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' },
  ],
}

/** 有 CLAIM_BENEFIT 且可领（已开通账号的「可领」形态，真实抓包 CAMPAIGNS_BODY）。 */
const CAMPAIGNS_BENEFIT_CLAIMABLE: QoderCampaigns = {
  showCampaign: true,
  claimable: true,
  campaigns: [
    { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' },
  ],
}

/** 只有 VIEW_DETAILS（未开通账号的实测形态，结构见 CAMPAIGNS_ONLY_VIEW）。 */
const CAMPAIGNS_ONLY_VIEW: QoderCampaigns = {
  showCampaign: true,
  claimable: true,
  campaigns: [{ campaignId: 'c1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMABLE' }],
}

/**
 * 空列表。
 *
 * ⚠️ 该形态由**请求头不完整**（缺 `Cosy-MachineToken`/`Cosy-MachineType`）
 * 或瞬时故障产生，与「未开通」**不可区分** ⇒ 必须判 false（不误报）。
 */
const CAMPAIGNS_EMPTY: QoderCampaigns = { showCampaign: false, claimable: false, campaigns: [] }

/** `showCampaign:true` 但活动数组为空（另一条瞬时形态）。 */
const CAMPAIGNS_SHOW_BUT_EMPTY: QoderCampaigns = { showCampaign: true, claimable: false, campaigns: [] }

describe('isQoderNotActivated（判据只看活动列表）', () => {
  /** 实测的未开通形态：只有 VIEW_DETAILS，无任何 CLAIM_BENEFIT。 */
  it('只有 VIEW_DETAILS（无 CLAIM_BENEFIT）→ 判为未开通', () => {
    expect(isQoderNotActivated(CAMPAIGNS_ONLY_VIEW)).toBe(true)
  })

  /**
   * ⚠️⚠️ **第二代核心回归（Issue IKJSHK）**：已开通账号**只要有 CLAIM_BENEFIT**
   * 就绝不能被判「未开通」—— 即便它的用量响应里 `addOnQuota` 缺失（旧判据正是在
   * 这里误报 7/11 账号）。本判据根本不看用量响应，故此形态恒为 false。
   */
  it('有 CLAIM_BENEFIT 一律算已开通（与合作过的 addOnQuota 有无无关）', () => {
    expect(isQoderNotActivated(CAMPAIGNS_BENEFIT_CLAIMED)).toBe(false)
    expect(isQoderNotActivated(CAMPAIGNS_BENEFIT_CLAIMABLE)).toBe(false)
  })

  /**
   * ⚠️ 空列表 / showCampaign:false / 活动数组为空 → **保守 false**。
   *
   * 这是请求头不完整或瞬时的形态，与「未开通」不可区分。判成未开通会让缺 machine
   * 头的请求把所有账号误报成「未开通」，用户白跑一趟官方客户端。
   */
  it('空列表 / showCampaign:false / 未取到 → 保守返回 false（不误报）', () => {
    expect(isQoderNotActivated(CAMPAIGNS_EMPTY)).toBe(false)
    expect(isQoderNotActivated(CAMPAIGNS_SHOW_BUT_EMPTY)).toBe(false)
    expect(isQoderNotActivated(undefined)).toBe(false)
  })

  /** 只有非领分类活动（VIEW_DETAILS 之外还有别的 actionType）也按「无 CLAIM_BENEFIT」判未开通。 */
  it('有其它 actionType 但无 CLAIM_BENEFIT → 判为未开通', () => {
    const campaigns: QoderCampaigns = {
      showCampaign: true,
      claimable: false,
      campaigns: [{ campaignId: 'c1', actionType: 'SOMETHING_ELSE', claimStatus: 'CLAIMED' }],
    }
    expect(isQoderNotActivated(campaigns)).toBe(true)
  })
})

/**
 * ⚠️ **`actionRequired` 字段的回归（2026-09-26 用户报障）**。
 *
 * 用户指出：不该让前端靠**文案**去猜「这条提示要不要单独展示」，应该改造
 * `ClaimOutcome` 让语义显式。故加了可选字段 `actionRequired?: boolean`
 * （`CheckinStatus` 同步）。
 *
 * 本组用例锁死：**未开通时必须置位**，且**已开通/已领/普通无活动时不得置位**
 * —— 置错会误导用户去官方客户端白跑一趟。
 */
describe('actionRequired 置位规则（走真实产品函数）', () => {
  const cred: QoderCredential = buildQoderCredential(
    parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref' }), { machineId: 'm-1' },
  )

  /** 按 URL 分派的假 fetcher：只服务活动列表端点（判据已不查用量）。 */
  function fetcherFor(campaigns: unknown) {
    return (async (url: unknown) => {
      const href = String(url)
      const body = href.includes('/campaigns') ? campaigns : {}
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  it('未开通（只有 VIEW_DETAILS）→ inactive 且 actionRequired=true（提示去官方客户端）', async () => {
    const outcome = await claimQoderDailyCheckin(
      cred, QODER, fetcherFor(CAMPAIGNS_ONLY_VIEW),
    )
    expect(outcome.kind).toBe('inactive')
    expect(outcome).toMatchObject({ actionRequired: true })
    expect(String((outcome as { message: string }).message)).toContain('官方客户端')
  })

  /** 普通「暂时没活动」（空列表）→ inactive 但**不得**置位（形同瞬时/头不全）。 */
  it('空列表（无法判定）→ inactive 且不置 actionRequired', async () => {
    const outcome = await claimQoderDailyCheckin(
      cred, QODER, fetcherFor(CAMPAIGNS_EMPTY),
    )
    expect(outcome.kind).toBe('inactive')
    expect(outcome).not.toHaveProperty('actionRequired')
  })

  /** 今天已领 → already-claimed，与未开通无关。 */
  it('今天已领 → already-claimed（不涉及 actionRequired）', async () => {
    const outcome = await claimQoderDailyCheckin(
      cred, QODER,
      fetcherFor(CAMPAIGNS_BENEFIT_CLAIMED),
      // ⚠️ 注入「已过 10:00（UTC+8）」的固定时刻：那条 CLAIMED 痕迹在刷新前
      // 属于昨天，会被判成「还没刷新」而不是「今天已领」（见 qoder-claim.spec.ts）。
      Date.UTC(2026, 8, 21, 6, 0, 0),
    )
    expect(outcome.kind).toBe('already-claimed')
    expect(outcome).not.toHaveProperty('actionRequired')
  })

  /** `CheckinStatus` 同步带该字段（判据与领取路径同源）。 */
  it('状态查询：未开通 → actionRequired=true', async () => {
    const status = await fetchQoderCheckinStatus(
      cred, QODER, fetcherFor(CAMPAIGNS_ONLY_VIEW),
    )
    expect(status).toMatchObject({ active: true, todayCheckedIn: false, actionRequired: true })
  })

  it('状态查询：已开通（有 CLAIM_BENEFIT）→ 不置 actionRequired', async () => {
    const status = await fetchQoderCheckinStatus(
      cred, QODER, fetcherFor(CAMPAIGNS_BENEFIT_CLAIMED), Date.UTC(2026, 8, 21, 6, 0, 0),
    )
    expect(status).not.toHaveProperty('actionRequired')
  })
})
