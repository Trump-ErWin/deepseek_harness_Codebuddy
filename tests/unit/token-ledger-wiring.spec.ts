import { afterEach, describe, expect, it } from 'vitest'
import {
  channelOfOptions,
  markGatewayChannel,
  GATEWAY_CHANNEL_MARK,
} from '../../src/openai-gateway/channel.js'
import { recordThroughStream, wrapAdapterWithTokenLedger } from '../../src/llm-register-compat.js'
import { readTokenLedger, resetTokenLedgerForTests } from '../../src/token-ledger.js'

/** 假适配器产出的 usage chunk（dsh-llm 契约形状）。 */
function usageChunk(input: number, output: number, extra: Record<string, number> = {}) {
  return { type: 'usage', usage: { inputTokens: input, outputTokens: output, ...extra } }
}

/** 极简假适配器：按脚本逐帧吐出，可选拒绝。 */
function fakeAdapter(script: () => AsyncIterable<unknown>) {
  return { stream: () => script(), resolveModel: () => 'stub' }
}

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of it) out.push(chunk)
  return out
}

afterEach(() => resetTokenLedgerForTests())

describe('channelOfOptions / markGatewayChannel', () => {
  it('打过标 = gateway；未打标对象 / 非对象 = direct', () => {
    const marked = markGatewayChannel({ model: 'GLM-5.2' })
    expect(channelOfOptions(marked)).toBe('gateway')
    expect(channelOfOptions({ model: 'GLM-5.2' })).toBe('direct')
    expect(channelOfOptions(null)).toBe('direct')
    expect(channelOfOptions(undefined)).toBe('direct')
    expect(channelOfOptions('model')).toBe('direct')
  })

  it('mark 是模块级 Symbol：不污染 JSON 序列化与 Object.keys', () => {
    const marked = markGatewayChannel({ model: 'm' })
    expect(Object.keys(marked)).toEqual(['model'])
    expect(JSON.parse(JSON.stringify(marked))).toEqual({ model: 'm' })
    expect((marked as Record<symbol, unknown>)[GATEWAY_CHANNEL_MARK]).toBe(true)
  })

  it('markGatewayChannel 对 sealed 对象不抛错（打不上就保守 direct）', () => {
    const sealed = Object.seal({ model: 'm' })
    expect(() => markGatewayChannel(sealed)).not.toThrow()
    // sealed 允许写已有属性；这里主要验证极端入参（freeze）不炸
    const frozen = Object.freeze({ model: 'm' })
    expect(() => markGatewayChannel(frozen)).not.toThrow()
    expect(channelOfOptions(frozen)).toBe('direct')
  })
})

describe('recordThroughStream：记账骨架', () => {
  it('正常流：透传全部 chunk、记 usage、usageReported=true', async () => {
    resetTokenLedgerForTests()
    const chunks = await collect(recordThroughStream(
      async function* () { yield { type: 'text' }; yield usageChunk(120, 34, { reasoningTokens: 8 }) },
      { channel: 'direct', provider: 'codearts', model: 'GLM-5.2', startedAt: Date.now() - 500 },
    ))
    expect(chunks).toHaveLength(2)
    const snap = readTokenLedger()
    expect(snap.entries).toHaveLength(1)
    const row = snap.entries[0]!
    expect(row.usageReported).toBe(true)
    expect(row.inputTokens).toBe(120)
    expect(row.outputTokens).toBe(34)
    expect(row.reasoningTokens).toBe(8)
    expect(row.provider).toBe('codearts')
    expect(row.model).toBe('GLM-5.2')
    expect(row.channel).toBe('direct')
    expect(row.durationMs).toBeGreaterThanOrEqual(500)
  })

  it('流结束但没等到 usage：usageReported=false（显示 — 而不是 0）', async () => {
    resetTokenLedgerForTests()
    await collect(recordThroughStream(
      async function* () { yield { type: 'text' } },
      { channel: 'direct', provider: 'p', model: 'm', startedAt: Date.now() },
    ))
    const row = readTokenLedger().entries[0]!
    expect(row.usageReported).toBe(false)
  })

  it('抛错：先记失败行再原样再抛（记账不吞错）', async () => {
    resetTokenLedgerForTests()
    const boom = new Error('upstream 502')
    await expect(collect(recordThroughStream(
      async function* () { yield usageChunk(10, 5); throw boom },
      { channel: 'gateway', provider: 'qoder', model: 'qfmodel', startedAt: Date.now() },
    ))).rejects.toBe(boom)
    const row = readTokenLedger().entries[0]!
    expect(row.error).toBe('upstream 502')
    expect(row.channel).toBe('gateway')
    // 流内已经到过的 usage 也算「收到过」
    expect(row.usageReported).toBe(true)
    expect(row.inputTokens).toBe(10)
  })

  it('提前 break（消费方 cancel）：finally 兜底落账', async () => {
    resetTokenLedgerForTests()
    for await (const _ of recordThroughStream(
      async function* () { yield 'a'; yield 'b'; yield 'c' },
      { channel: 'direct', provider: 'p', model: 'm', startedAt: Date.now() },
    )) {
      break
    }
    expect(readTokenLedger().entries).toHaveLength(1)
  })
})

describe('wrapAdapterWithTokenLedger：包装注册', () => {
  it('包装后的 stream 记账，其余方法原样透传', async () => {
    resetTokenLedgerForTests()
    const adapter = fakeAdapter(async function* () { yield usageChunk(7, 3) })
    const wrapped = wrapAdapterWithTokenLedger(['codearts'], adapter) as typeof adapter
    // 非 stream 方法保留
    expect(wrapped.resolveModel()).toBe('stub')
    await collect(wrapped.stream({ model: 'GLM-5.2' } as never))
    const row = readTokenLedger().entries[0]!
    expect(row.provider).toBe('codearts')
    expect(row.model).toBe('GLM-5.2')
    expect(row.inputTokens).toBe(7)
  })

  it('网关打标经包装层正确落到 channel=gateway（端到端打标→记账）', async () => {
    resetTokenLedgerForTests()
    const adapter = fakeAdapter(async function* () { yield usageChunk(7, 3) })
    const wrapped = wrapAdapterWithTokenLedger(['qoder'], adapter) as typeof adapter
    await collect(wrapped.stream(markGatewayChannel({ model: 'qfmodel' }) as never))
    const row = readTokenLedger().entries[0]!
    expect(row.channel).toBe('gateway')
  })

  it('model 缺失/垃圾值记空串不抛错', async () => {
    resetTokenLedgerForTests()
    const adapter = fakeAdapter(async function* () { yield usageChunk(1, 1) })
    const wrapped = wrapAdapterWithTokenLedger(['p'], adapter) as typeof adapter
    await collect(wrapped.stream(undefined as never))
    expect(readTokenLedger().entries[0]!.model).toBe('')
  })

  it('this 绑定：包装层把 this 还给原适配器（有状态适配器不被拆散）', async () => {
    resetTokenLedgerForTests()
    let seenThis: unknown = null
    const adapter = {
      flag: 42,
      stream(this: { flag: number }) {
        seenThis = this
        return (async function* () { yield usageChunk(1, 1) })()
      },
    }
    const wrapped = wrapAdapterWithTokenLedger(['p'], adapter)
    await collect((wrapped.stream as (o: never) => AsyncIterable<unknown>)(undefined as never))
    expect((seenThis as { flag?: number }).flag).toBe(42)
  })

  /**
   * ⚠️ 真实缺陷回归（2026-10-05）：首版用 `{ ...adapter }` 展开实现包装，
   * **class 实例的原型方法（providerInfo / listModels…）全部丢失** ——
   * buddy 的「注册的适配器与其路由使用同一产品」用例当场变红
   * （`adapter.providerInfo is not a function`）。Proxy 必须把**一切属性
   * 访问**（含原型链）转给原适配器。
   */
  it('原型方法不丢：class 实例包装后 providerInfo / listModels 仍然可用', () => {
    class FakeAdapter {
      hidden = 7
      providerInfo() { return { id: 'workbuddy' } }
      async listModels() { return [{ provider: 'workbuddy' }] }
      async *stream() { yield usageChunk(1, 1) }
    }
    const wrapped = wrapAdapterWithTokenLedger(['workbuddy'], new FakeAdapter()) as unknown as FakeAdapter
    expect(wrapped.providerInfo()).toEqual({ id: 'workbuddy' })
    expect(wrapped.hidden).toBe(7)
    expect(typeof wrapped.listModels).toBe('function')
  })

  it('私有字段：this 绑回原适配器，#field 不因 proxy 而抛 TypeError', async () => {
    resetTokenLedgerForTests()
    class PrivateAdapter {
      #secret = 41
      get secret() { return this.#secret }
      async *stream() {
        // ⚠️ 读 this.#secret：若包装层把 this 绑成 proxy，这里会直接 TypeError
        yield usageChunk(this.#secret, 1)
      }
    }
    const wrapped = wrapAdapterWithTokenLedger(['p'], new PrivateAdapter())
    await collect((wrapped.stream as (o: never) => AsyncIterable<unknown>)(undefined as never))
    const row = readTokenLedger().entries[0]!
    expect(row.inputTokens).toBe(41)
    expect(row.usageReported).toBe(true)
  })
})
