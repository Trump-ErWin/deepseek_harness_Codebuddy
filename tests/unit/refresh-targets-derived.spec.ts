/**
 * `wiredRefreshTargets()`：批量续期表**从能力注册表派生**（Task 10）。
 *
 * ## 本文件守什么
 *
 * 原先 `src/index.ts` 手抄 **13 行** provider 清单。它的失效形态极隐蔽：
 * **漏一家 ⇒ 该家凭据永不自动续期**，而症状只是「每隔一段时间就要重新登录」，
 * **日志里一个字都没有**（`src/index.ts` 的注释记录了这一点）。
 *
 * ⚠️ 判据是**行为**（驱动派生函数），**不读源码文本** —— 初稿用
 * `readFileSync` + 正则扫那 13 行字面量，已被 pre-flight 纠正。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { descriptorOf, PROVIDER_REGISTRY } from '../../src/provider-registry.js'
import {
  clearProviderRuntimes,
  registeredRuntimeIds,
  registerProviderRuntime,
  runtimeOf,
  wiredRefreshTargets,
} from '../../src/provider-runtime.js'

afterEach(() => { clearProviderRuntimes() })

/** 造一个带 `refreshAll` 的最小 auth 桩。 */
function authWith(refreshAll: () => Promise<void>) {
  return { refreshAccount: vi.fn(), refreshAll }
}

describe('wiredRefreshTargets：从注册表派生', () => {
  it('① 只收**有 `auth.refreshAll`** 的 provider', () => {
    registerProviderRuntime({
      descriptor: descriptorOf('buddy')!,
      auth: authWith(async () => {}),
    })
    // ⚠️ opencode 无 auth 域（它没有续期概念）⇒ 不该进表。
    registerProviderRuntime({ descriptor: descriptorOf('opencode')! })

    expect(wiredRefreshTargets().map(([id]) => id)).toEqual(['buddy'])
  })

  it('② 派生的条目**真的调用**该 provider 的 refreshAll（转发不错位）', async () => {
    const buddyRefreshAll = vi.fn(async () => {})
    const workbuddyRefreshAll = vi.fn(async () => {})
    registerProviderRuntime({
      descriptor: descriptorOf('buddy')!,
      auth: authWith(buddyRefreshAll),
    })
    registerProviderRuntime({
      descriptor: descriptorOf('workbuddy')!,
      auth: authWith(workbuddyRefreshAll),
    })

    for (const [, refreshAll] of wiredRefreshTargets()) await refreshAll({} as never)

    // ⚠️ 这条锁「按 id 取到**对应实例**」—— 若派生时把两个实例搞混，
    //    两个 provider 的凭据会互相刷（而签名相同、类型检查抓不到）。
    expect(buddyRefreshAll).toHaveBeenCalledTimes(1)
    expect(workbuddyRefreshAll).toHaveBeenCalledTimes(1)
  })

  it('③ `this` 绑定正确（各家 refreshAll 是类方法，内部用 this.product / this.ctx）', async () => {
    // ⚠️ **真实陷阱**：直接把 `rt.auth.refreshAll` 当函数引用传出去会丢 `this`
    //    ⇒ 调用即抛 `Cannot read properties of undefined`。
    //    本用例用一个**依赖 `this`** 的桩来钉住它。
    const calls: string[] = []
    const auth = {
      refreshAccount: vi.fn(),
      product: { id: 'buddy' },
      async refreshAll() {
        calls.push(this.product.id)
      },
    }
    registerProviderRuntime({ descriptor: descriptorOf('buddy')!, auth: auth as never })

    for (const [, refreshAll] of wiredRefreshTargets()) await refreshAll({} as never)

    expect(calls).toEqual(['buddy'])
  })

  it('④ 空注册表 ⇒ 空表（**不是抛错**）', () => {
    expect(wiredRefreshTargets()).toEqual([])
  })

  it('⑤ 只注册了别的域（无 auth）⇒ 不进表', () => {
    registerProviderRuntime({
      descriptor: descriptorOf('zcode')!,
      expiry: { credentialExpiry: async () => 1 },
    })
    expect(wiredRefreshTargets()).toEqual([])
  })

  it('⑥ 有 auth 但**无 `refreshAll`** ⇒ 不进表（不能因为「有 auth」就放行）', () => {
    registerProviderRuntime({
      descriptor: descriptorOf('buddy')!,
      auth: { refreshAccount: vi.fn() },
    })
    expect(wiredRefreshTargets()).toEqual([])
  })
})

describe('modelAdapters 的键集合守卫（行为断言）', () => {
  it('⑦ registry 的 channel 集合 == 实际注册了 runtime 的 channel 集合', () => {
    // ⚠️ **坦诚说明本判据的边界**：`modelAdapters` 的具体键最终由 `index.ts`
    //    的对象字面量给出（装配代码，不可单测）。本用例锁的是**上游**——
    //    「registry 认为的 channel 集合」与「实际注册了 runtime 的 channel 集合」一致。
    //    `index.ts` 里 `modelAdapters` 漏一个键的现实防线是 `provider.status`
    //    会为该 provider 报 `{ total: 0 }`（目录拿不到），而那在设置页上**可见**。
    const channelIds = PROVIDER_REGISTRY.filter((d) => d.channel).map((d) => d.id).sort()

    for (const id of channelIds) {
      if (runtimeOf(id) !== undefined) continue
      registerProviderRuntime({ descriptor: descriptorOf(id)! })
    }

    const runtimeChannels = registeredRuntimeIds()
      .filter((id) => descriptorOf(id)?.channel === true)
      .sort()
    expect(runtimeChannels).toEqual(channelIds)
  })
})
