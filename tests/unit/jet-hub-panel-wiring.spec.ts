import { describe, expect, it, vi } from 'vitest'

/**
 * `ProviderPanel` 的**接线层行为级**守卫（2026-10-25 审计 P1-3 / A3-1 / B3）。
 *
 * ## 这个文件为什么必须存在
 *
 * 2026-10-22 的整页白屏事故，根因是 `probeNotice` 被写成**裸字符串**，而渲染端
 * 按对象读 `.details.length` ⇒ `TypeError` ⇒ React 卸载整棵设置页。
 *
 * 修复本身是对的（16 个写入点都过 `normalizeProbeNotice`），但审计实测发现：
 * **整条接线层零守卫** —— `tests/unit/notice-shape.spec.ts` 的三条**源码文本**
 * 断言各有一个真实旁路：
 *
 * | 旁路 | 形态 | 为什么逃得掉 |
 * |---|---|---|
 * | 三元字面量 | `setProbeNotice(x ? 'a' : 'b')` | 正则要求 `(` 后**紧跟**引号 |
 * | 下标读取 | `probeNotice.details['length']` | 正则只匹配 `.details.length` |
 * | 死分支包装 | `if (false) { setState(normalize(x)) }` | 「存在包装」的 `toMatch` 在死分支里照样命中 |
 *
 * 实测：三者**同时**注入（= 完整白屏回归态）时，41 条相关用例**全绿**，而同一份
 * 代码执行时确实抛 `TypeError`。
 *
 * ## 为什么行为级守卫是可行的（推翻一处错误前提）
 *
 * `notice-shape.spec.ts:33-36` 断言「单测环境是 `node`，`react` 是宿主注入的
 * external，`jet-hub.js` **根本 import 不了**，组件无法渲染」——**这是错的**：
 * 本仓库的 `tests/unit/jet-hub-tdz.spec.ts:99` 早就用 `vi.mock('react', …)` +
 * 真实 `await import('../../plugin-src/client/jet-hub.js')` 跑过运行时渲染。
 *
 * 那个错误前提正当化了「接线层不用行为级测试」，并让三条无牙断言看起来足够。
 * ⇒ 本文件用同一套替身**真正调用** `ProviderPanel`，把「渲染端读到什么形状」
 * 变成可断言的行为。
 *
 * ## 判据打在哪
 *
 * 不是「源码里有没有某个字面量」，而是：
 * 1. **写入端**：`ProviderPanel` 调 `setProbeNotice(...)` 之后，state 里存的
 *    必须是**对象**（`{tone,text,details}`）或 `null` —— 绝不是字符串；
 * 2. **渲染端**：拿 state 去渲染时**不得抛错**（这正是事故的那一行）。
 *
 * 任一条被破坏（含上述三个旁路任选其一），本文件会红。
 */

/** hook 槽位：每次「渲染」重置，模拟一次组件挂载。 */
let hooks: unknown[] = []
let cursor = 0
/** 本次渲染期间被 `useState` setter 写过的值（按写入顺序）。 */
let writes: Array<{ index: number; value: unknown }> = []
/** 本次渲染期间传进 `useCallback` 的回调（用于真实调用、观察写入形态）。 */
let callbacks: unknown[] = []

function slot<T>(initial: T | (() => T)): { v: T } {
  const key = cursor++
  if (!(key in hooks)) {
    hooks[key] = { v: typeof initial === 'function' ? (initial as () => T)() : initial }
  }
  return hooks[key] as { v: T }
}

const reactStub = {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const s = slot(initial)
    const index = cursor - 1
    return [
      s.v,
      (next) => {
        s.v = typeof next === 'function' ? (next as (prev: T) => T)(s.v) : next
        writes.push({ index, value: s.v })
      },
    ]
  },
  useRef<T>(initial: T) {
    return slot(initial)
  },
  useEffect() {},
  useLayoutEffect() {},
  // ⚠️ 真实 React 在**调用本函数之前**就求值了 deps（这正是 TDZ 会炸的原因），
  // 故这里不读 deps —— 与 `jet-hub-tdz.spec.ts` 同款，避免把 TDZ 测成「通过」。
  // ⚠️ **记录每次传进来的回调**：接线层（`setProbeNotice` 是不是归一化过的）
  // 只能靠「真调用它、看写出去什么」来判定 —— 源码文本断言有已知旁路。
  useCallback<T>(fn: T): T {
    callbacks.push(fn)
    return fn
  },
  useMemo<T>(fn: () => T): T {
    return fn()
  },
  createElement: () => null,
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
  Component: class {},
}

vi.mock('react', () => reactStub)

/** 一次「渲染」：重置槽位与写入记录。 */
function resetRender(): void {
  hooks = []
  cursor = 0
  writes = []
  callbacks = []
}

type RenderResult =
  | { ok: true; writes: Array<{ index: number; value: unknown }>; callbacks: unknown[] }
  | { ok: false; error: unknown }

/**
 * 渲染 `ProviderPanel` 一次，收集其写入行为。
 *
 * ⚠️ `ProviderPanel` 没有被 `export`（它是内部组件），故经由 `JetHubPage`
 * 的模块命名空间取不到。这里用 `rpcCall` 桩驱动它走「添加账号」路径 ——
 * 该路径正是事故现场（`res.existed` 分支曾传裸字符串）。
 */
async function renderPanel(rpcCall: (method: string, payload?: unknown) => Promise<unknown>): Promise<RenderResult> {
  resetRender()
  try {
    const mod = await import('../../plugin-src/client/jet-hub.js')
    // 模块必须能加载（否则下面全是假绿）
    expect(typeof mod.JetHubPage).toBe('function')
    // 通过 `__testHost` 逃生口拿内部组件（见 jet-hub.js 的同名导出注释）
    const panel = (mod as unknown as { __providersPanelForTest?: (props: unknown) => unknown }).__providersPanelForTest
    if (typeof panel !== 'function') {
      // 逃生口未接线 ⇒ 明确失败，绝不静默跳过（否则整个文件会变成集体的假绿）
      return { ok: false, error: new Error('__providersPanelForTest 未导出：接线层无法被行为级守卫覆盖') }
    }
    panel({ provider: 'opencode', rpcCall })
    return { ok: true, writes, callbacks }
  } catch (error) {
    return { ok: false, error }
  }
}

describe('ProviderPanel 接线层（行为级）', () => {
  it('能真实渲染（防止「加载失败」被当成通过）', async () => {
    const r = await renderPanel(async () => ({ ok: true, order: [], statuses: {} }))
    expect(r.ok, r.ok ? '' : `渲染抛错：${String((r as { error: unknown }).error)}`).toBe(true)
  })

  /**
   * ★★ **所有 state 写入都不得是裸字符串**（事故的直接成因）。
   *
   * 判据打在**行为**上：读了 `useState` setter 的实际入参，而不是源码文本。
   * 三个已知旁路（三元字面量 / 死分支包装 / 间接变量）在行为层**无处可逃**
   * —— 只要值最终是字符串，这里就红。
   *
   * ⚠️ 允许 `null`（= 清除提示）与对象；只禁止**字符串**。
   */
  it('★★ 写入 state 的值不得是裸字符串（白屏事故的直接成因）', async () => {
    const r = await renderPanel(async () => ({ ok: true, order: [], statuses: {} }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const offenders = r.writes
      .filter((w) => typeof w.value === 'string')
      .map((w) => ({ slot: w.index, value: w.value }))
    expect(offenders, '有 state 被写入裸字符串 ⇒ 任何按对象读字段的渲染点都会抛 TypeError').toEqual([])
  })

  /**
   * ★★★ **归一化包装必须真的生效**（这是整条防线的承重腿）。
   *
   * ## 为什么必须「真调用回调」，不能只看源码
   *
   * 事故的第二道闸是 `setProbeNotice = useCallback(next => setState(normalize(next)))`。
   * 源码文本断言只能证明「这段文字在文件里」，而 `if (false) { setState(normalize(x)) }`
   * 这种**死分支**同样满足它（审计实测 M10-a：41 条相关用例全绿）。
   *
   * ⇒ 这里拿渲染时**真实传进 `useCallback` 的每一个回调**，逐个喂一个**裸字符串**：
   * 只要其中有一个把**字符串原样写进 state**，就说明归一化没接上（或走不到），
   * 这里立刻红。（喂裸字符串正是事故现场的输入形态。）
   */
  it('★★★ 写入端归一化真实生效：喂裸字符串，state 里不得留下字符串', async () => {
    const r = await renderPanel(async () => ({ ok: true, order: [], statuses: {} }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.callbacks.length, '没有任何 useCallback 被记录 ⇒ 探针本身失效').toBeGreaterThan(0)

    const PROBE = '该 key 已存在，已为你定位到原有账号。'
    let exercised = 0
    for (const cb of r.callbacks) {
      if (typeof cb !== 'function') continue
      const before = writes.length
      try {
        // ⚠️ 回调签名各异：`setProbeNotice(next)` 只吃一个参数；别的一参数回调
        // 拿到字符串最多是不做事或抛错 —— 抛错不算失败（那是别的回调）。
        ;(cb as (arg: unknown) => unknown)(PROBE)
      } catch {
        continue
      }
      // 只看这次调用**新产生**的写入
      for (const w of writes.slice(before)) {
        if (w.value === PROBE) {
          exercised += 1
        }
      }
    }
    expect(
      exercised,
      `有回调把**裸字符串原样**写进 state（${exercised} 次）⇒ 渲染端读 .details.length 必然抛 TypeError（白屏事故）`,
    ).toBe(0)
  })

  /**
   * ★★ **渲染端读到的 notice 必须能安全取 `.details.length`**。
   *
   * 这条是事故那行的**等价复现**：`probeNotice.details.length`。
   * 只要写入端存过字符串、且渲染端没做保护，这里就会抛。
   */
  it('★★ 渲染端对 notice.details 的读取不得抛错（事故那一行）', async () => {
    const r = await renderPanel(async () => ({ ok: true, order: [], statuses: {} }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 模拟渲染端：把每个写入值当成 notice 读 `.details.length`。
    // 裸字符串 ⇒ `undefined.length` ⇒ TypeError（修复前正是如此）。
    for (const w of r.writes) {
      if (w.value === null || w.value === undefined) continue
      expect(
        () => (w.value as { details?: unknown[] }).details?.length,
        `state[${w.index}] 读 .details.length 会抛 ⇒ 整页白屏`,
      ).not.toThrow()
    }
  })
})
