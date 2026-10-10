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
import { readFileSync } from 'node:fs'

import { descriptorOf, PROVIDER_REGISTRY } from '../../src/provider-registry.js'
import {
  clearProviderRuntimes,
  registerProviderRuntime,
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
  it('⑦ registry 的 channel 集合 == `index.ts` 里 modelAdapters 的键集合', () => {
    // ⚠️ **2026-10-08 独立复审重写本条**。原版是**恒真**的：
    //
    //     for (const id of channelIds) {
    //       if (runtimeOf(id) !== undefined) continue
    //       registerProviderRuntime({ descriptor: descriptorOf(id)! })   // ← 自己注册
    //     }
    //     const runtimeChannels = registeredRuntimeIds()...                 // ← 再自断言
    //     expect(runtimeChannels).toEqual(channelIds)                       // ← 恒成立
    //
    //  用例自己把缺的都补上再比对，断言的是「我刚注册的东西」，与 `index.ts` 的
    //  `modelAdapters` **毫无关系** —— 漏一个键它照样绿。这是本仓库最重的一条红线
    //  （同义反复 / 恒真用例比没有更糟：它看起来像个守卫）。
    //
    // ## 改成什么
    //
    // `modelAdapters` 是 `apply()` 内的**局部变量**，单测取不到实例，但它的
    // **键**在源码里是逐行字面量（每行 `key: pruned(...)`）⇒ 可以**剥注释后**
    // 精确提取，与 registry 的 channel 集合**双向**比对。
    // ⚠️ 必须剥注释：本文件上方那段很长的注释里**逐字出现** `aggregate:` 形态。
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    const start = source.indexOf('const modelAdapters')
    expect(start, 'index.ts 里找不到 modelAdapters 定义').toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n  }', start))
    // 顶层键：四空格缩进 + `id:`（值是 `pruned(...)` 或任意表达式）。
    const keys = [...body.matchAll(/^ {4}([a-z][a-z0-9]*):/gm)].map((m) => m[1]).sort()
    expect(keys.length, 'modelAdapters 提取到的键太少，说明提取正则与源码形态脱节了')
      .toBeGreaterThanOrEqual(13)

    const channelIds = PROVIDER_REGISTRY.filter((d) => d.channel).map((d) => d.id).sort()
    // ⚠️ **`aggregate` 是登记在案的例外**（实测 `channel: false` 只有它一家）：
    //    它必须进本表，理由与别家**相反** —— 别的家进表是为了「关闭时把模型写进
    //    黑名单」，而聚合层**明确不参与**该机制（`pruned(..., { enabled: false })`，
    //    见 `index.ts` 那段长注释 §5.2）。它进表是为了 `fullCatalogIds` 能拿到
    //    **不套黑名单**的全量目录；漏了它会让「关闭整个聚合 provider」时
    //    只拿到未被关闭的 id。⇒ 它**不该**被当成「多余的键」删掉。
    const EXTRA_KEYS = ['aggregate']
    const expected = [...channelIds, ...EXTRA_KEYS].sort()
    expect(
      keys,
      'modelAdapters 的键与期望集合不一致：'
      + '左侧多出 = 表里多了个未登记的键（若是新例外，请连同理由加进 EXTRA_KEYS，'
      + '别默默放过），'
      + '右侧多出 = **漏键**（该 provider 的「显示列表」拿不到全量目录 ⇒ '
      + '关闭它时模型不会被写进黑名单，出现「provider 已关闭、模型仍可选」的矛盾态）',
    ).toEqual(expected)

    // ⚠️ 反向：`EXTRA_KEYS` 里的每一个都必须**确实不是** channel —— 否则它该由
    //    channel 集合覆盖，留在例外名单里会让「漏键」被例外掩盖。
    for (const id of EXTRA_KEYS) {
      expect(
        descriptorOf(id)?.channel,
        `${id} 在 EXTRA_KEYS 里却有 channel: true —— 应从例外名单删掉`,
      ).not.toBe(true)
    }
  })
})
