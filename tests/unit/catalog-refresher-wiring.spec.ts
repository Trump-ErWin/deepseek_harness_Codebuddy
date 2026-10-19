import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/index.js'

/**
 * ★★ **模型目录刷新器的接线守卫**（走**真实 `apply()`**，不是源码文本断言）。
 *
 * ## ⚠️ 为什么必须有这个文件
 *
 * 刷新器自身的用例（`catalog-refresher.spec.ts`）全部**直接 `new createCatalogRefresher(...)`**，
 * **绕过 `index.ts` 的装配**。实测（2026-10-18）：把 `index.ts` 里的
 * `catalogRefresher.start()` 注释掉后，那 8 条**仍然全绿** —— 接线本身零守卫。
 *
 * ⚠️ 而本仓库**明令禁止**用源码文本断言去凑（实测过 5 条这类判据在 `if (false)`
 * 死分支里恒绿）⇒ 本文件判**行为**：真跑 `apply()`，看刷新器 `start()` 时打的那条
 * `info` 日志是否出现（它接了 `ctx.logger`，删掉 `start()` 就不出现）。
 *
 * ⚠️ 夹具**照抄** `balance-refresher-wiring.spec.ts`（同类接线守卫的既有正确范例），
 * 尤其是「`ctx.logger` 取真实对象再挂方法」与「必须 `vi.useFakeTimers()`」两点 ——
 * 我第一版自己写 `ctx.provide('logger', …)`，结果 `apply()` 一条日志都没产出
 * （桩不满足它的前置），两条用例假红。
 */

class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: 'fake', writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeCtxWithLogs(): { ctx: Context; infos: string[]; warns: string[] } {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace: () => {} }),
    registerAdapter: () => ({ replace: () => {} }),
    listProviders: () => [],
    listModels: async () => [],
  } as never)
  let stored: unknown = { accounts: [], disabledModels: {} }
  ctx.provide('settings', {
    register: () => ({
      get: () => stored,
      replace: async (value: unknown) => { stored = value },
    }),
    describe: () => [],
    configure: () => () => {},
  } as never)

  const infos: string[] = []
  const warns: string[] = []
  // ⚠️ **取真实 `ctx.logger` 再挂方法**（照既有范例）——
  //    自造 `ctx.provide('logger', …)` 会让 `apply()` 一条日志都不产出。
  const logger = ctx.logger as unknown as Record<string, unknown>
  logger['info'] = (...a: unknown[]) => { infos.push(a.map(String).join(' ')) }
  logger['warn'] = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }
  return { ctx, infos, warns }
}

/** 推进 fake timers 并冲干净微任务（⚠️ 不能用 setTimeout，见 `refresh-scheduler-apply.spec.ts`）。 */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

describe('★★ 目录刷新器接线：真 apply() 之后确实武装', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('★★ apply() 之后目录刷新器已武装（删掉 start() 必须变红）', async () => {
    const { ctx, infos } = makeCtxWithLogs()
    apply(ctx)
    await settle()

    expect(
      infos.some((s) => s.includes('模型目录刷新器已武装')),
      '★★ 目录刷新器未武装 —— index.ts 的 ctx.effect 里没调 start()（接线缺口）',
    ).toBe(true)
  })

  it('★★ 武装日志的周期文案来自 CATALOG_REFRESH_INTERVAL_MS（20 分钟）', async () => {
    // ⚠️ 这条锁「周期常量没被写死成别的值」：文案由 `createCatalogRefresher`
    //    按 `intervalMs / 60_000` 算出 ⇒ 它变了说明常量或传参被改动。
    const { ctx, infos } = makeCtxWithLogs()
    apply(ctx)
    await settle()

    expect(
      infos.some((s) => s.includes('模型目录刷新器已武装') && s.includes('20 分钟')),
      '★★ 周期文案必须来自 CATALOG_REFRESH_INTERVAL_MS（20 分钟）',
    ).toBe(true)
  })
})
