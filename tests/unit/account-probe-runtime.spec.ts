/**
 * `account-probe` 的**适配器构造**走能力注册表（Task 8）。
 *
 * ## 本文件守什么
 *
 * 旧实现是一条 `else if (provider === …)` 链，**末尾的 `else` 兜底**会把
 * **未登记的 provider** 交给「**华为云 HMAC 签名**的 `CodeArtsAdapter`」去发
 * 别家凭据 —— 探测必然失败，而该 provider 的限流标记（UTC+8 当日 24:00）
 * **永远清不掉**。
 *
 * ⚠️ `src/account-probe.ts` 的注释记录该缺陷**同型复发 4 次**
 * （workbuddy → trae → qoder/qodercn/cline → zcode），根因是「清单靠记忆维护」。
 * ⇒ 本 Task 把它改成**查注册表**：未登记 ⇒ **抛可读错误**，绝不落回 CodeArts。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { adapterForProbe } from '../../src/account-probe.js'
import { descriptorOf } from '../../src/provider-registry.js'
import { clearProviderRuntimes, registerProviderRuntime } from '../../src/provider-runtime.js'

afterEach(() => { clearProviderRuntimes() })

describe('account-probe：适配器构造走能力注册表', () => {
  it('① 已注册 probe 的 provider 走它自己的工厂（拿到的是**实例本身**）', () => {
    const sentinel = { marker: 'zcode-probe' }
    const createProbeAdapter = vi.fn(() => sentinel as never)
    registerProviderRuntime({ descriptor: descriptorOf('zcode')!, probe: { createProbeAdapter } })

    const got = adapterForProbe('zcode', 'ZCODE_ACCOUNT_X', { zcode_jwt: 'j' })

    expect(got).toBe(sentinel)
    expect(createProbeAdapter).toHaveBeenCalledWith('ZCODE_ACCOUNT_X', { zcode_jwt: 'j' })
  })

  it('② ⚠️ 未注册 probe 的 provider **抛可读错误**，不得落回 CodeArtsAdapter', () => {
    // ⚠️ 这是本 Task 的核心：旧实现落 else 会交给华为云 HMAC 签名的
    //    CodeArtsAdapter 去发别家凭据 —— 探测必然失败、限流标记永远清不掉，
    //    而症状只是「重测按钮点了没用」，极难定位。
    expect(() => adapterForProbe('cline', 'CLINE_ACCOUNT_X', {}))
      .toThrow(/不支持重测|没有探测适配器/)
  })

  it('③ 完全未知的 provider 同样抛可读错误（不是 TypeError 之类）', () => {
    expect(() => adapterForProbe('never-heard-of-it', 'X', {}))
      .toThrow(/不支持重测|没有探测适配器/)
  })

  it('④ 错误信息**带 provider 名**（否则用户与排查者都不知道是哪个渠道）', () => {
    expect(() => adapterForProbe('cline', 'CLINE_ACCOUNT_X', {}))
      .toThrow(/cline/)
  })

  it('⑤ 注册了别的域（但没有 probe）⇒ 仍抛错，不得因「有 runtime」就放行', () => {
    // ⚠️ 真实陷阱：`runtimeOf(provider)` 有值 ≠ 它支持探测。
    //    只注册 `expiry` 而不注册 `probe` 时，必须仍然抛错。
    registerProviderRuntime({
      descriptor: descriptorOf('zcode')!,
      expiry: { credentialExpiry: async () => 1 },
    })
    expect(() => adapterForProbe('zcode', 'ZCODE_ACCOUNT_X', {})).toThrow(/不支持重测|没有探测适配器/)
  })
})
