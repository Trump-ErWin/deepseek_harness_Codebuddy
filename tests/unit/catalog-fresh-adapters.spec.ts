/**
 * B 类四家（trae / lobsterai / accio / codearts 系）+ **buddy 的重测分离**。
 *
 * ⚠️ 判据打在**行为**上：`fetchRemoteModels` 的调用次数 + 返回的目录内容，
 *    不锁内部字段（`remoteModels` / `catalogAt` / `remoteComplete` 是实现细节）。
 *
 * ⚠️ 与 A 类那份用例的关系：A 类的缓存判据是 `if (remoteModels !== undefined)`
 *    换成的「方法入口 + gate 后复查」两处形态（见 `loomy-adapter.ts` 的
 *    `loadModels`）；**B 类四家的形态不同** —— 它们有 `RemoteCatalogGate`
 *    包裹，且短路只有**一处**（`ensureRemoteModels` 入口）。故这里**不**照抄
 *    A 类的用例结构，只共享「调用次数」这一条可观测面。
 *
 * ⚠️⚠️ buddy 的断言落在**两条路径的分离**上：
 *    `refreshCatalog()`（用户主动重测）**必须无视 TTL 强制重拉**，
 *    而 `ensureRemoteModels`（日常保鲜）**必须**在 20 分钟内短路。
 *    两者共用同一份「拉取次数」观测面，故这两条用例合起来才锁住分离。
 */
import { describe, expect, it, vi } from 'vitest'
import { CATALOG_REFRESH_INTERVAL_MS } from '../../src/model-catalog.js'
import { AccioAdapter } from '../../src/accio-adapter.js'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { TraeAdapter } from '../../src/trae-adapter.js'

/**
 * 造一个**全新的**适配器（无缓存），并返回可推进的时钟。
 *
 * ⚠️ `accountPool` 一律不给：`createModelCatalog` 的 `listModels` 首行就是
 *    `providerCatalogVisible(deps.accountPool, id)`，无池时它放行（返回 true），
 *    于是目录读取路径一定会被走到 —— 否则这条用例会退化成「什么都没发生也绿」。
 */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let clock = 1_000_000
  return { now: () => clock, advance: (ms: number) => { clock += ms } }
}

describe('B 类：目录缓存的 20 分钟 TTL', () => {
  it('⚠️ trae 周期内不重拉、超期重拉', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = new TraeAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
      now: clock.now,
    } as never)
    await adapter.listModels('trae')
    await adapter.listModels('trae')
    expect(fetchRemoteModels, '⚠️ 周期内零额外请求').toHaveBeenCalledTimes(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS)
    await adapter.listModels('trae')
    expect(fetchRemoteModels, '⚠️ 超 20 分钟必须重拉').toHaveBeenCalledTimes(2)
  })

  it('⚠️ lobsterai 周期内不重拉、超期重拉', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = new LobsteraiAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
      now: clock.now,
    } as never)
    await adapter.listModels('lobsterai')
    await adapter.listModels('lobsterai')
    expect(fetchRemoteModels, '⚠️ 周期内零额外请求').toHaveBeenCalledTimes(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS)
    await adapter.listModels('lobsterai')
    expect(fetchRemoteModels, '⚠️ 超 20 分钟必须重拉').toHaveBeenCalledTimes(2)
  })

  it('⚠️ accio 周期内不重拉、超期重拉', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = new AccioAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
      now: clock.now,
    } as never)
    await adapter.listModels('accio')
    await adapter.listModels('accio')
    expect(fetchRemoteModels, '⚠️ 周期内零额外请求').toHaveBeenCalledTimes(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS)
    await adapter.listModels('accio')
    expect(fetchRemoteModels, '⚠️ 超 20 分钟必须重拉').toHaveBeenCalledTimes(2)
  })

  it('⚠️ codearts 周期内不重拉、超期重拉', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    // ⚠️ `catalogComplete` 必须上报**完整**：codearts 的短路判据是
    //    「已完整 **且** 未超期」，只给「有值」这一半 ⇒ 残缺目录永不重拉。
    //    本用例测 TTL 那一半，故必须显式给出完整判定。
    const adapter = new CodeArtsAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
      catalogComplete: () => true,
      now: clock.now,
    } as never)
    await adapter.listModels('codearts')
    await adapter.listModels('codearts')
    expect(fetchRemoteModels, '⚠️ 周期内零额外请求').toHaveBeenCalledTimes(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS)
    await adapter.listModels('codearts')
    expect(fetchRemoteModels, '⚠️ 超 20 分钟必须重拉').toHaveBeenCalledTimes(2)
  })

  /**
   * ⚠️⚠️ **codearts 的残缺目录必须仍能被后续成功拉取替换**。
   *
   * 这是加 TTL 前必须核实的那条不变式（见 `llm-adapter.ts` 的 `ensureRemoteModels`）：
   * 两个独立目录端点下，一个成功一个失败时 `models.length > 0` 但**残缺**。
   * 加 TTL 若误把残缺判成「新鲜」，残缺就会**永久固化**（原缺陷的翻版）。
   */
  it('⚠️ codearts 残缺目录不得被判为「新鲜」（TTL 不得掩盖完整性判据）', async () => {
    const clock = makeClock()
    // ⚠️⚠️ `RemoteCatalogGate` 的冷却走**墙钟**（`Date.now`），而 codearts 的
    //    闸门构造**没有**注入 `options.now`（见 `llm-adapter.ts` 的构造）。
    //    ⇒ 本用例必须让墙钟与注入时钟**同步推进**，否则第二次拉取会被 30 秒
    //    冷却挡掉 —— 那样断言的就不再是「完整性判据」，而是「冷却」。
    //    这是 `Date.now` 替身，与 `vi.useFakeTimers()` 不同：只在本用例内生效。
    const realNow = vi.spyOn(Date, 'now').mockImplementation(() => clock.now())
    try {
      let complete = false
      const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
      const adapter = new CodeArtsAdapter({
        fetchRemoteModels: fetchRemoteModels as never,
        catalogComplete: () => complete,
        now: clock.now,
      } as never)
      // 第一次：残缺（两个端点只有一个成功）。
      await adapter.listModels('codearts')
      expect(fetchRemoteModels).toHaveBeenCalledTimes(1)

      // ⚠️ **只推进 31 秒**（越过冷却，**远在 20 分钟 TTL 之内**）：
      //    此刻若 TTL 被当成唯一判据，残缺目录会被判「新鲜」⇒ 永远不重拉 ⇒
      //    残缺固化。完整性判据必须**独立**生效。
      clock.advance(31_000)
      await adapter.listModels('codearts')
      expect(
        fetchRemoteModels,
        '⚠️ 残缺目录必须在周期内也继续重拉（完整性判据不得被 TTL 吞掉）',
      ).toHaveBeenCalledTimes(2)

      // 第二个端点恢复后目录变完整 ⇒ 此后进入 TTL 的**保鲜**语义。
      complete = true
      clock.advance(31_000)
      await adapter.listModels('codearts')
      const callsAfterComplete = fetchRemoteModels.mock.calls.length
      // ⚠️ 冷却已过、但仍远在 TTL 之内 ⇒ 完整目录必须短路。
      clock.advance(31_000)
      await adapter.listModels('codearts')
      expect(
        fetchRemoteModels.mock.calls.length,
        '⚠️ 完整目录进入 20 分钟保鲜（周期内零额外请求）',
      ).toBe(callsAfterComplete)
    } finally {
      realNow.mockRestore()
    }
  })

  it('⚠️ 上游失败不得刷新时刻（失败不写 catalogAt）', async () => {
    const clock = makeClock()
    let broken = false
    const fetchRemoteModels = vi.fn(async () => {
      if (broken) throw new Error('上游 503')
      return [{ id: 'm1', name: 'M1' }]
    })
    const adapter = new TraeAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
      now: clock.now,
    } as never)
    await adapter.listModels('trae')
    expect(fetchRemoteModels).toHaveBeenCalledTimes(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS + 1)
    broken = true
    await adapter.listModels('trae')
    expect(fetchRemoteModels, '⚠️ 超期后必须真的再试一次（时刻已被刷新会短路）')
      .toHaveBeenCalledTimes(2)
  })
})

/**
 * buddy：重测与日常保鲜是**两条路**。
 *
 * ⚠️ 入口说明：本家的 `refreshCatalog()` 是**公开方法**（`BuddyAdapter` 上），
 *    不必绕 `registerBuddyLlm` 的回调。生产侧有两个调用点：
 *    ① `stream()` 里贴图能力未知时（`buddy-adapter.ts` 的图片分支）；
 *    ② 客户端「重测」按钮经 RPC 触发的宿主路径。
 *    两者都落到同一个公开方法，故这里直接调它。
 */
describe('buddy：重测与日常保鲜是两条路', () => {
  it('⚠️ 重测 refreshCatalog 无视 TTL，强制重拉（重测按钮不得变哑）', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1', supportsImages: true }])
    const adapter = new BuddyAdapter({
      credentialRef: 'CRED' as never,
      resolveCredential: async () => ({ token: 't' } as never),
      refresh: async () => {},
      fetchRemoteModels: fetchRemoteModels as never,
      catalogComplete: () => true,
      now: clock.now,
    } as never)
    await adapter.listModels('buddy')
    expect(fetchRemoteModels, '⚠️ 冷缓存首拉').toHaveBeenCalledTimes(1)

    // ⚠️ **只推 11 秒** —— 越过「距上次尝试 ≥10 秒」的节流，却**远在 20 分钟 TTL
    //    之内**。这正是让断言可识别的窗口：若 refreshCatalog 也带 TTL 判据，
    //    此刻 `catalogAt` 未超期 ⇒ 会被短路 ⇒ 这条变红。
    //    （「推 11 秒就重拉」与下面「10 秒内不重拉」不矛盾：量的正是两条判据的分工。）
    clock.advance(11_000)
    await adapter.refreshCatalog()
    expect(
      fetchRemoteModels,
      '⚠️ 周期内点重测也必须重拉（这条变绿说明 TTL 吞掉了用户主动操作）',
    ).toHaveBeenCalledTimes(2)
  })

  it('⚠️ 日常保鲜仍受 TTL 约束（重测路径不得反向污染 ensureRemoteModels）', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1', supportsImages: true }])
    const adapter = new BuddyAdapter({
      credentialRef: 'CRED' as never,
      resolveCredential: async () => ({ token: 't' } as never),
      refresh: async () => {},
      fetchRemoteModels: fetchRemoteModels as never,
      catalogComplete: () => true,
      now: clock.now,
    } as never)
    await adapter.listModels('buddy')
    await adapter.listModels('buddy')
    await adapter.resolveModel('buddy', 'm1')
    expect(
      fetchRemoteModels,
      '⚠️ listModels/resolveModel 共用同一条保鲜路径，周期内零额外请求',
    ).toHaveBeenCalledTimes(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS)
    await adapter.listModels('buddy')
    expect(fetchRemoteModels, '⚠️ 超 20 分钟后日常路径必须重拉').toHaveBeenCalledTimes(2)
  })

  it('⚠️ 重测后拉取失败仍保住*旧*目录（不得把列表清空）', async () => {
    const clock = makeClock()
    let broken = false
    const fetchRemoteModels = vi.fn(async () => {
      if (broken) throw new Error('目录端点挂了')
      return [{ id: 'm1', name: 'M1', supportsImages: true }]
    })
    const adapter = new BuddyAdapter({
      credentialRef: 'CRED' as never,
      resolveCredential: async () => ({ token: 't' } as never),
      refresh: async () => {},
      fetchRemoteModels: fetchRemoteModels as never,
      catalogComplete: () => true,
      now: clock.now,
    } as never)
    const before = await adapter.listModels('buddy')
    clock.advance(CATALOG_REFRESH_INTERVAL_MS + 1)
    broken = true
    await adapter.refreshCatalog()
    const after = await adapter.listModels('buddy')
    expect(after.length, '⚠️ 重测失败后目录不得被清空').toBeGreaterThan(0)
    expect(after.length, '⚠️ 重测失败后仍应是上次那份').toBe(before.length)
  })

  it('⚠️ 重测仍受「距上次尝试 ≥10 秒」节流约束（用户定的规则不得被绕过）', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1', supportsImages: true }])
    const adapter = new BuddyAdapter({
      credentialRef: 'CRED' as never,
      resolveCredential: async () => ({ token: 't' } as never),
      refresh: async () => {},
      fetchRemoteModels: fetchRemoteModels as never,
      catalogComplete: () => true,
      now: clock.now,
    } as never)
    await adapter.listModels('buddy')
    expect(fetchRemoteModels).toHaveBeenCalledTimes(1)
    // ⚠️ 不推时钟 ⇒ 距上次尝试不足 10 秒 ⇒ 节流命中，**不得**重拉。
    //    这条与上面那条「周期内必须重拉」看似矛盾，量的正是**两条判据的分工**：
    //    节流（10s，拉取频率）与 TTL（20min，缓存保鲜）是**两件事**。
    await adapter.refreshCatalog()
    expect(fetchRemoteModels, '⚠️ 10 秒节流内不得重复拉取').toHaveBeenCalledTimes(1)
  })
})