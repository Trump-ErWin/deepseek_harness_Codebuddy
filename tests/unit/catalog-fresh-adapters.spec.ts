/**
 * A 类四家（loomy / minimax / zcode / raccoon）的目录 TTL 行为。
 *
 * ⚠️ 判据打在**行为**上：`fetchRemoteModels` 的调用次数 + 返回的目录内容，
 *    不锁内部字段（`remoteModels` / `catalogAt` 是实现细节）。
 *
 * 范本是既有的 `aggregate-adapter.ts:715`（它已带 catalogAt + TTL）。
 */
import { describe, expect, it, vi } from 'vitest'
import { LoomyAdapter } from '../../src/loomy-adapter.js'
import { CATALOG_REFRESH_INTERVAL_MS } from '../../src/model-catalog.js'

describe('A 类：目录缓存的 20 分钟 TTL', () => {
  /**
   * 用一个**全新的适配器**跑（无缓存）。
   * ⚠️ `model-catalog-parity.spec.ts` 的 (j) 守着「冷缓存下 listAllModels 非空」，
   *    本文件刻意不依赖它 —— 那是另一条不变式。
   */
  it('⚪️ 冷缓存首次 listModels 必拉一次远端', async () => {
    const fetchRemoteModels = vi.fn(async () => [
      { id: 'm1', name: 'M1' },
      { id: 'm2', name: 'M2' },
    ])
    const adapter = new LoomyAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
    } as never)
    const models = await adapter.listModels('loomy')
    expect(fetchRemoteModels, '⚪️ 冷缓存必须真拉').toHaveBeenCalledTimes(1)
    expect(models.length, '⚪️ 拉到的目录必须可见').toBe(2)
  })

  it('⚪️ 周期内再调 listModels **不再**打远端', async () => {
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = new LoomyAdapter({ fetchRemoteModels: fetchRemoteModels as never } as never)
    await adapter.listModels('loomy')
    await adapter.listModels('loomy')
    await adapter.listModels('loomy')
    expect(fetchRemoteModels, '⚪️ 周期内零额外请求（这是「有缓存」的全部意义）').toHaveBeenCalledTimes(1)
  })

  it('⚪️ 超过 20 分钟后重新拉远端', async () => {
    // ⚠️ 必须能推进时钟，否则这条恒绿 —— 那正是「TTL 判据没生效」的形态。
    let clock = 1_000_000
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = new LoomyAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
      now: () => clock,
    } as never)
    await adapter.listModels('loomy')
    clock += CATALOG_REFRESH_INTERVAL_MS - 1
    await adapter.listModels('loomy')
    expect(fetchRemoteModels, '⚪️ 差 1ms 仍不重拉').toHaveBeenCalledTimes(1)
    clock += 1
    await adapter.listModels('loomy')
    expect(fetchRemoteModels, '⚪️ 满 20 分钟必须重拉').toHaveBeenCalledTimes(2)
  })

  it('⚪️ 拉取失败时保住*旧*（不得清空成兜底）', async () => {
    let clock = 1_000_000
    let broken = false
    const fetchRemoteModels = vi.fn(async () => {
      if (broken) throw new Error('上游 503')
      return [{ id: 'm1', name: 'M1' }]
    })
    const adapter = new LoomyAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
      now: () => clock,
    } as never)
    await adapter.listModels('loomy')
    clock += CATALOG_REFRESH_INTERVAL_MS + 1
    broken = true
    const models = await adapter.listModels('loomy')
    expect(models.length, '⚪️ 上游挂了也要保住上次的目录（空列表会让 DSH 隐藏整个分组）')
      .toBeGreaterThan(0)
  })
})