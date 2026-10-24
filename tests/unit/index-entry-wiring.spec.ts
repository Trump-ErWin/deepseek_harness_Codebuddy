/**
 * `plugin-src/client/index.js` 的**接线**行为守卫。
 *
 * ## 为什么需要它（原守卫零覆盖）
 *
 * 2026-10-24 对抗审计实测：把 `registerJetHubPanelEntries(ctx, rpcCall)` 改成
 * `void registerJetHubPanelEntries`（**删掉调用**）后——
 *
 * ```
 * [M9_index_drops_registration_call] 结果: passed=56 failed=0
 * $ npx vitest run  →  Tests  10600 passed | 7 skipped
 * ```
 *
 * **全量测试一条都不红**，而后果是：插件根本不注册任何面板 —— `main` 槽与
 * `settings.section` 都没有，界面里**没有 Jet Hub**（用户以为插件坏了）。
 *
 * 原因：`error-boundary.spec.ts` 只覆盖 `error-boundary.js`；
 * `panel-entry-wiring.spec.ts` 覆盖 `panel-entry.js` 的**内部**行为；
 * 而「上一层到底有没有调用注册器」**没有任何守卫** ——
 * 「接线层零守卫」这个本仓库已记录过的复发形态。
 *
 * ## 判据为什么是行为级
 *
 * `tests/unit/panel-entry.spec.ts` 里只有
 * `expect(source).toContain('export function registerJetHubPanelEntries')`
 * —— 它断言的是「**导出存在**」，与「**被调用**」是两件事。
 * ⇒ 本文件真 import `index.js`、用 mock 的注册器真跑一遍 `apply()`，
 * 直接断言「注册器被调用了、且拿到的是本插件自己的 `ctx` 与一份 rpcCall」。
 *
 * ## 替身的诚实边界
 *
 * 这里 mock 掉 `panel-entry.js`，所以**不**验证面板内部的注册逻辑
 * （那由 `panel-entry-wiring.spec.ts` 负责）。本文件只回答一个问题：
 * **`apply()` 有没有把注册器接上**。
 */
import { describe, expect, it, vi } from 'vitest'

// ── 注册器：本文件的被测对象是「有没有被调用」，故做成 spy ──
const registerSpy = vi.hoisted(() => vi.fn())

vi.mock('../../plugin-src/client/panel-entry.js', () => ({
  registerJetHubPanelEntries: registerSpy,
}))

vi.mock('../../plugin-src/client/settings-card.js', () => ({
  JetHubPanelEntryCard: function JetHubPanelEntryCard() { return null },
}))

vi.mock('../../plugin-src/client/usage-badge.js', () => ({
  UsageBadge: function UsageBadge() { return null },
}))

vi.mock('../../plugin-src/client/jet-hub-styles.js', () => ({
  installJetHubStyles: () => () => {},
}))

vi.mock('../../plugin-src/client/jet-hub.js', () => ({
  JET_HUB_RPC_CHANNEL: 'jet-hub',
  providerLabel: () => 'x',
  JetHubPage: function JetHubPage() { return null },
}))

vi.mock('../../plugin-src/client/zcode-carrier.js', () => ({
  // `ctx.effect` 会把返回值当清理函数，故返回一个函数。
  startCarrierContribution: () => () => {},
}))

vi.mock('../../plugin-src/management-rpc.mjs', () => ({
  callManagementRpc: async () => ({ ok: true }),
  unwrapRpcResult: (raw) => raw,
}))

const { apply } = await import('../../plugin-src/client/index.js')

/** 最小 `ctx`：只提供 `apply()` 真正会碰到的成员。 */
function makeCtx() {
  const effects = []
  const slotInjections = []
  return {
    effects,
    slotInjections,
    ctx: {
      connection: { send: async () => ({}) },
      effect(callback, name) {
        effects.push(name)
        // `ctx.effect` 会执行回调并把返回值当清理函数；这里如实执行。
        const stop = callback()
        return typeof stop === 'function' ? stop : () => {}
      },
      slots: {
        inject(slot, callback) {
          slotInjections.push(slot)
          return () => {}
        },
        register() {
          return () => {}
        },
      },
    },
  }
}

describe('index.js 接线（行为级）', () => {
  it('⚠️⚠️ apply() 必须真的调用 registerJetHubPanelEntries（挡住「接线断开」）', () => {
    registerSpy.mockClear()
    const { ctx } = makeCtx()
    apply(ctx)

    expect(
      registerSpy,
      'apply() 没有调用注册器 —— 插件不会注册任何面板（main / settings.section 都不存在，'
      + '界面里没有 Jet Hub），而**全量测试会全绿**（2026-10-24 对抗审计实测 10600 条零红）',
    ).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 传给注册器的是本插件自己的 ctx 与一份可用的 rpcCall', () => {
    registerSpy.mockClear()
    const { ctx } = makeCtx()
    apply(ctx)

    const call = registerSpy.mock.calls[0]
    expect(call, '注册器没被调用').toBeTruthy()
    const [passedCtx, passedRpcCall] = call
    expect(passedCtx, '注册器拿到的不是本插件的 ctx').toBe(ctx)
    expect(typeof passedRpcCall, '注册器没有拿到 rpcCall 函数').toBe('function')
  })

  it('⚠️ 样式安装与载体贡献循环都已挂上（防止 effect 被整体删除）', () => {
    registerSpy.mockClear()
    const { ctx, effects } = makeCtx()
    apply(ctx)

    const joined = effects.join(' | ')
    expect(joined, '样式安装的 effect 不见了').toContain('install styles')
    expect(joined, '载体贡献循环的 effect 不见了').toContain('zcode')
  })
})
