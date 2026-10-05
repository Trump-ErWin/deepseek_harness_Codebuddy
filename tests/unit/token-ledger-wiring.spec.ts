import { afterEach, describe, expect, it } from 'vitest'
import {
  channelOfOptions,
  markGatewayChannel,
  GATEWAY_CHANNEL_MARK,
} from '../../src/openai-gateway/channel.js'
import { recordThroughStream, wrapAdapterWithTokenLedger } from '../../src/llm-register-compat.js'
import {
  attachTokenLedgerStore,
  peekLedgerAccount,
  readTokenLedger,
  readTokenLedgerDayMap,
  recordTokenUsage,
  reportLedgerAccount,
  resetLedgerAccountsForTests,
  resetTokenLedgerForTests,
} from '../../src/token-ledger.js'
import type { TokenLedgerDayMap, TokenLedgerEntry } from '../../src/token-ledger.js'

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

afterEach(() => {
  resetTokenLedgerForTests()
  resetLedgerAccountsForTests()
})

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

  /**
   * 第 3 期：首字用时在包装层实测（收第一块时打点），TPS 由记账层按官方口径
   * 算（输出 ÷ (全程 − 首块)）。注意生成器**懒执行**：首块的打点时刻是
   * 「消费方真正开始拉流」之后，与发起时刻的差就是真实的首字延迟。
   */
  it('ttft/tps：包装层实测首块时刻，记账层算出速率', async () => {
    resetTokenLedgerForTests()
    // ⚠️ 生成器**内**跨 tick：首块之后 sleep 一小段再收 usage，让
    // durationMs − ttftMs > 0（tps 的分母）。无间隔时 tps 不可测（省略），
    // ttft 仍然 > 0 —— 那是正确行为，不是缺陷。
    const startedAt = Date.now() - 50
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await collect(recordThroughStream(
      async function* () {
        yield { type: 'reasoning-delta', text: 'thinking...' }
        await sleep(30)
        yield usageChunk(10, 100)
      },
      { channel: 'direct', provider: 'p', model: 'm', startedAt },
    ))
    const row = readTokenLedger().entries[0]!
    expect(row.ttftMs).toBeGreaterThan(0)
    expect(row.tps).toBeGreaterThan(0)
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

  /**
   * 第 2 期（账号维度）：包装层在 **usage 帧到达时** 读回报表 —— 此时
   * `resolveCredential` 早已跑完（凭据先于任何 SSE 帧），时序才正确。
   * ⚠️ 若在 stream 开始前读，会拿到「上一笔请求」的账号（生成器懒执行）。
   */
  it('账号归属（第 2 期）：usage 帧时读取回报表，落到账本 accountId', async () => {
    resetTokenLedgerForTests()
    resetLedgerAccountsForTests()
    // 适配器「尚未解析凭据」：openStream 内部先跑了一段才回报（模拟真实时序）
    const chunks = await collect(recordThroughStream(
      async function* () {
        reportLedgerAccount('codearts', 'acct-live')
        yield { type: 'text' }
        yield usageChunk(50, 5)
      },
      { channel: 'direct', provider: 'codearts', model: 'GLM-5.2', startedAt: Date.now() },
    ))
    expect(chunks).toHaveLength(2)
    const row = readTokenLedger().entries[0]!
    expect(row.accountId).toBe('acct-live')
  })

  it('账号归属：失败行（没等到 usage）用 finally 兜底读回报表', async () => {
    resetTokenLedgerForTests()
    resetLedgerAccountsForTests()
    reportLedgerAccount('qoder', 'acct-stale')
    await expect(collect(recordThroughStream(
      async function* () { throw new Error('502') },
      { channel: 'direct', provider: 'qoder', model: 'm', startedAt: Date.now() },
    ))).rejects.toBeDefined()
    const row = readTokenLedger().entries[0]!
    expect(row.error).toBe('502')
    // 失败行归属退回「最后解析出的账号」：排查「哪个号挂了」需要它。
    expect(row.accountId).toBe('acct-stale')
  })

  it('账号归属：无人回报时空缺（accountId 缺省，不伪造）', async () => {
    resetTokenLedgerForTests()
    resetLedgerAccountsForTests()
    await collect(recordThroughStream(
      async function* () { yield usageChunk(1, 1) },
      { channel: 'direct', provider: 'lonely', model: 'm', startedAt: Date.now() },
    ))
    expect(readTokenLedger().entries[0]!.accountId).toBeUndefined()
  })

  it('report/peek 回报表基础语义（供 index.ts 的 resolveCredential 调用）', () => {
    resetLedgerAccountsForTests()
    reportLedgerAccount('qoder', 'a1')
    expect(peekLedgerAccount('qoder')).toBe('a1')
    reportLedgerAccount('qoder', 'a2')
    expect(peekLedgerAccount('qoder')).toBe('a2')
    expect(peekLedgerAccount('nope')).toBe('')
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

/**
 * ★ 回归（复审发现的真实风险）：**插件 fiber 重启交错时，旧实例的 dispose
 * 不得摘掉新实例挂上的钩子**。
 *
 * `llm-register-compat.ts` 模块头已记载本仓库的真实事故：cordis 重启插件 fiber
 * 时，新 fiber 的同步 apply 与旧 fiber 的**异步 dispose 交错执行**（旧 dispose
 * 会追上来）。而 `index.ts` 原先在 dispose 里**无条件**摘钩子 ⇒ 一旦交错命中，
 * 新一轮挂的钩子立刻被旧一轮摘掉 → **落盘彻底停摆 + 历史视图恒为空**。
 *
 * ⚠️ 这条用**真实的 `attachTokenLedgerStore`**（而不是把接线抄一份进测试）：
 * 抄写式的断言只能证明副本自洽，改动真实接线时不会失败（与 `buddy-wiring.spec.ts`
 * 同款纪律）。
 */
describe('★ attachTokenLedgerStore：成对挂载与所有权校验（fiber 重启交错）', () => {
  /** 假 store：只记录收到哪些 entry，读侧返回固定表。 */
  function fakeStore(label: string) {
    const appended: string[] = []
    const days: TokenLedgerDayMap = new Map()
    return {
      label,
      appended,
      /** 与真实 `FileLedgerStore` 同形：append(entry) / load()。 */
      append: (entry: TokenLedgerEntry) => { appended.push(label) },
      load: () => days,
    }
  }
  const usage = () => ({
    channel: 'direct' as const, provider: 'codearts', model: 'GLM-5.2',
    usageReported: true, inputTokens: 1, outputTokens: 1, durationMs: 1,
  })

  afterEach(() => {
    // 每条用例后清干净，避免钩子泄漏到后续用例（模块级单例）。
    attachTokenLedgerStore(undefined)
  })

  it('正常挂载：记账落盘回调与历史读取器都生效', () => {
    const store = fakeStore('A')
    attachTokenLedgerStore(store as never)
    recordTokenUsage(usage())
    expect(store.appended).toEqual(['A'])
    expect(readTokenLedgerDayMap()).toBe(store.load())
  })

  it('★ 旧实例 dispose 不得摘掉新实例的钩子（交错时序）', () => {
    // ── fiber 第 1 轮 ──
    const old = fakeStore('old')
    const disposeOld = attachTokenLedgerStore(old as never)
    // ── fiber 第 2 轮：新 apply 先跑完 ──
    const fresh = fakeStore('new')
    const disposeNew = attachTokenLedgerStore(fresh as never)
    // ── 旧 fiber 的异步 dispose 追上来（真实事故的时序）──
    disposeOld()
    // 修复前：钩子被清空 ⇒ 落盘停摆、历史视图恒空
    recordTokenUsage(usage())
    expect(fresh.appended, '新实例必须仍在收账').toEqual(['new'])
    expect(old.appended, '旧实例不得再收账').toEqual([])
    expect(readTokenLedgerDayMap()).toBe(fresh.load())
    void disposeNew
  })

  it('★ 卸载语义：当前实例自己 dispose 后钩子才真的清空', () => {
    const store = fakeStore('only')
    const dispose = attachTokenLedgerStore(store as never)
    dispose()
    recordTokenUsage(usage())
    expect(store.appended).toEqual([])
    expect(readTokenLedgerDayMap().size).toBe(0)
  })

  it('★ dispose 幂等且不乱摘：重复调用第二次不得影响后续实例', () => {
    const first = fakeStore('1')
    const disposeFirst = attachTokenLedgerStore(first as never)
    disposeFirst()
    const second = fakeStore('2')
    attachTokenLedgerStore(second as never)
    // 旧 disposer 再被调用一次（cordis 重入）：不得摘掉 second
    disposeFirst()
    recordTokenUsage(usage())
    expect(second.appended).toEqual(['2'])
  })

  /**
   * ★ 回归（审计发现：原用例锁的其实是**所有权校验**，幂等守卫并未被覆盖
   * —— 删掉 `if (disposed) return` 后 61 条用例全绿）。
   *
   * 唯一能观测到幂等守卫的时序是「dispose 后**重新挂载同一个对象**，再重入调用
   * 旧 disposer」。此时所有权令牌已换代，只有幂等守卫能挡住第二次摘除。
   *
   * ⚠️ 且判据**必须用每次挂载新生成的令牌**，不能用 `backend === owned`：
   * 同一对象重复挂载时对象相等无法区分两次挂载（审计已复现该误摘）。
   */
  it('★ 同一后端重复挂载：旧 disposer 不得摘掉后一次挂载（令牌判据）', () => {
    const shared = fakeStore('SHARED')
    const disposeFirst = attachTokenLedgerStore(shared as never)
    // 重新挂载**同一个对象**（对象相等，旧判据在此失效）
    attachTokenLedgerStore(shared as never)
    disposeFirst() // 旧 disposer 追上来
    recordTokenUsage(usage())
    expect(shared.appended, '重新挂载的后端必须仍在收账').toEqual(['SHARED'])
    expect(readTokenLedgerDayMap()).toBe(shared.load())
  })

  it('★ 幂等守卫：卸载后重新挂载，重入旧 disposer 不得摘掉新挂载', () => {
    const store = fakeStore('S')
    const dispose = attachTokenLedgerStore(store as never)
    dispose()
    attachTokenLedgerStore(store as never) // 重新挂同一个对象
    dispose() // 重入：令牌已换代 ⇒ 必须让位
    recordTokenUsage(usage())
    expect(store.appended).toEqual(['S'])
  })
})
