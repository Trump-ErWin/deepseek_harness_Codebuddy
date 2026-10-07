/**
 * zcode 的额度是**按模型绑定**的 —— 渠道有余额 ≠ 任意模型可用。
 *
 * ## 缺陷（用户实测 2026-10-07）
 *
 * 用户 zcode 账号**有余额**，但只有 `GLM-5.3-Flash` 能调用；auto（以及聚合层）
 * 选中 zcode 后按倍率挑了别的模型，上游返回 200 空流 +
 * 「额度已用尽 / 没有可用权益」（`QUOTA_EXCEEDED`）。
 *
 * 根因：额度桶带 `showName`（上游注释写明「实测为模型名」），而折算函数只算
 * 「渠道有没有钱」（渠道级），**没有任何一层把「钱能买哪个模型」传给选型**。
 *
 * ## 本文件守什么
 *
 * 1. `zcodeQuotaModelIds` 收集**有余额的桶**的 `showName`；
 * 2. 探针的 `quotaModels()` 做**全账号并集**并带缓存；
 * 3. **「查不到」必须返回 `undefined`**（调用方据此不收窄，宁可少筛不可误剔）；
 * 4. `clear()` 必须一并清掉模型集合缓存。
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createExpiryProbe,
  zcodeQuotaModelIds,
  EXPIRY_CACHE_TTL_MS,
} from '../../src/aggregate-expiry.js'
import { fetchZcodeBalance } from '../../src/zcode-upstream.js'

vi.mock('../../src/zcode-upstream.js', () => ({
  fetchZcodeBalance: vi.fn(),
}))

const mockedFetch = vi.mocked(fetchZcodeBalance)

/** 一个只实现了「取号」的最小账号池替身（`quotaModels` 走 `listAvailableCredentials`）。 */
function poolWith(credentials: unknown[]) {
  return {
    listAvailableCredentials: async () => credentials.map((credential) => ({ credential })),
  } as never
}

describe('zcodeQuotaModelIds：收集有余额的桶对应的模型', () => {
  it('只收有余额的桶，且取 showName 作为模型名', async () => {
    mockedFetch.mockResolvedValue({
      buckets: [
        { showName: 'GLM-5.3-Flash', availableUnits: 94_539_275 },
        { showName: 'GLM-5.3', availableUnits: 0 },
        { showName: 'GLM-5-Turbo', remainingUnits: 0 },
      ],
    } as never)
    await expect(zcodeQuotaModelIds({} as never)).resolves.toEqual(['GLM-5.3-Flash'])
  })

  it('没有 showName 的桶被跳过（无法绑定到具体模型）', async () => {
    mockedFetch.mockResolvedValue({ buckets: [{ availableUnits: 100 }] } as never)
    await expect(zcodeQuotaModelIds({} as never)).resolves.toEqual([])
  })

  it('★ 查询失败返回 undefined（不是空数组）—— 空数组会被读成「一个模型都没有」', async () => {
    mockedFetch.mockRejectedValue(new Error('network down'))
    await expect(zcodeQuotaModelIds({} as never)).resolves.toBeUndefined()
  })
})

describe('探针的 quotaModels 通道', () => {
  it('多账号取并集（任一账号的额度能买的模型都算数）', async () => {
    mockedFetch
      .mockResolvedValueOnce({ buckets: [{ showName: 'GLM-5.3-Flash', availableUnits: 1 }] } as never)
      .mockResolvedValueOnce({ buckets: [{ showName: 'GLM-5.3', availableUnits: 2 }] } as never)

    const probe = createExpiryProbe(poolWith([{}, {}]), async () => 'GLM-5.3-Flash')
    await expect(probe.quotaModels()).resolves.toEqual(
      expect.arrayContaining(['GLM-5.3-Flash', 'GLM-5.3']),
    )
  })

  it('★ 查不到返回 undefined —— 调用方据此不收窄候选', async () => {
    mockedFetch.mockRejectedValue(new Error('boom'))
    const probe = createExpiryProbe(poolWith([{}]), async () => 'GLM-5.3-Flash')
    await expect(probe.quotaModels()).resolves.toBeUndefined()
  })

  it('★ 多账号里**任一**查不到 ⇒ 整体返回 undefined（不是「其余账号的并集」）', async () => {
    //
    // 这条是「查不到 ⇒ 不收窄」的**真正判据**：单账号时，故意吞掉 undefined
    // （`continue`）也会因并集为空而返回 undefined —— 两者无法区分。
    // 只有多账号场景才能区分：
    //   - 正确：遇到 undefined 立刻返回 undefined（不写缓存、不收窄）；
    //   - 缺陷：continue 掉那个账号，把**其余**账号的模型当成「全部」返回
    //     ⇒ zcode 候选被收窄到一个**可能不完整**的集合（误剔可用模型）。
    mockedFetch
      .mockResolvedValueOnce({ buckets: [{ showName: 'GLM-5.3-Flash', availableUnits: 1 }] } as never)
      .mockRejectedValueOnce(new Error('second account unreachable'))
    const probe = createExpiryProbe(poolWith([{}, {}]), async () => 'GLM-5.3-Flash')
    await expect(probe.quotaModels()).resolves.toBeUndefined()
  })

  it('命中缓存时不再打上游（与折算缓存同一个 TTL）', async () => {
    mockedFetch.mockResolvedValue({ buckets: [{ showName: 'GLM-5.3-Flash', availableUnits: 1 }] } as never)
    const probe = createExpiryProbe(poolWith([{}]), async () => 'GLM-5.3-Flash')
    await probe.quotaModels()
    const afterFirst = mockedFetch.mock.calls.length
    await probe.quotaModels()
    expect(mockedFetch.mock.calls.length).toBe(afterFirst)
    expect(EXPIRY_CACHE_TTL_MS).toBe(60_000)
  })

  it('★ clear() 必须一并清掉模型集合缓存（否则用户换号后旧绑定继续生效）', async () => {
    mockedFetch.mockResolvedValue({ buckets: [{ showName: 'GLM-5.3-Flash', availableUnits: 1 }] } as never)
    const probe = createExpiryProbe(poolWith([{}]), async () => 'GLM-5.3-Flash')
    await probe.quotaModels()
    const before = mockedFetch.mock.calls.length
    probe.clear()
    mockedFetch.mockResolvedValue({ buckets: [{ showName: 'GLM-5.3', availableUnits: 1 }] } as never)
    await probe.quotaModels()
    expect(mockedFetch.mock.calls.length).toBeGreaterThan(before)
  })
})