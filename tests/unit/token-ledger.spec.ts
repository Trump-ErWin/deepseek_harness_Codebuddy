import { describe, expect, it } from 'vitest'
import {
  TOKEN_LEDGER_LIMIT,
  readTokenLedger,
  recordTokenUsage,
  resetTokenLedgerForTests,
  tokenLedgerSize,
} from '../../src/token-ledger.js'

/** 每条用例前清空：模块级可变状态会在用例间泄漏（cline-request-log 同款）。 */
function seed(entries: Array<Parameters<typeof recordTokenUsage>[0]>): void {
  resetTokenLedgerForTests()
  for (const entry of entries) recordTokenUsage(entry)
}

const OK = {
  channel: 'direct' as const,
  provider: 'codearts',
  model: 'GLM-5.2',
  usageReported: true,
  inputTokens: 100,
  outputTokens: 50,
  durationMs: 1200,
}

describe('recordTokenUsage / readTokenLedger：明细', () => {
  it('记录后按「最新在前」读出，快照含全局小计', () => {
    seed([OK, { ...OK, provider: 'qoder', model: 'qfmodel' }])
    const snap = readTokenLedger()
    expect(snap.entries).toHaveLength(2)
    expect(snap.entries[0]!.provider).toBe('qoder')
    expect(snap.totals.requests).toBe(2)
    expect(snap.totals.inputTokens).toBe(200)
    expect(snap.totals.outputTokens).toBe(100)
  })

  it('channel 只认 direct/gateway，垃圾值保守落 direct', () => {
    // ⚠️ 记录是「最新在前」：后记的 bogus/undefined 排在前面（与 unshift 同序）。
    seed([{ ...OK, channel: 'bogus' as never }, { ...OK, channel: undefined as never }, { ...OK, channel: 'gateway' }])
    const channels = readTokenLedger().entries.map((e) => e.channel)
    expect(channels).toEqual(['gateway', 'direct', 'direct'])
  })

  it('usageReported 只认严格 true（垃圾值一律当「没收到 usage」）', () => {
    for (const value of [1, 'true', 'yes', {}, []] as unknown[]) {
      seed([{ ...OK, usageReported: value as boolean }])
      expect(readTokenLedger().entries[0]!.usageReported, String(value)).toBe(false)
    }
  })

  it('缓存/思考为 0 或缺失时省略字段（不伪造 0）', () => {
    seed([{ ...OK, cacheReadTokens: 1_200, reasoningTokens: 33, cacheWriteTokens: 7 }])
    const row = readTokenLedger().entries[0]!
    expect(row.cacheReadTokens).toBe(1200)
    expect(row.reasoningTokens).toBe(33)
    expect(row.cacheWriteTokens).toBe(7)
    seed([OK])
    const bare = readTokenLedger().entries[0]!
    expect(bare.cacheReadTokens).toBeUndefined()
    expect(bare.cacheWriteTokens).toBeUndefined()
    expect(bare.reasoningTokens).toBeUndefined()
  })

  it('负数 / NaN / 小数统一钳制成非负整数', () => {
    seed([{ ...OK, inputTokens: -5, outputTokens: Number.NaN, durationMs: 12.9 }])
    const row = readTokenLedger().entries[0]!
    expect(row.inputTokens).toBe(0)
    expect(row.outputTokens).toBe(0)
    expect(row.durationMs).toBe(12)
  })

  it('error 截断到 200 字；成功行无 error 字段', () => {
    seed([OK, { ...OK, error: 'x'.repeat(500) }])
    const rows = readTokenLedger().entries
    expect(rows[0]!.error).toHaveLength(200)
    expect(rows[1]!.error).toBeUndefined()
  })

  it('写满上限后淘汰最旧（保持 TOKEN_LEDGER_LIMIT 条）', () => {
    resetTokenLedgerForTests()
    for (let i = 0; i < TOKEN_LEDGER_LIMIT + 50; i++) {
      recordTokenUsage({ ...OK, outputTokens: i })
    }
    expect(tokenLedgerSize()).toBe(TOKEN_LEDGER_LIMIT)
    // 最新在前：最旧（outputTokens=0..49）已被淘汰，最前是最新的那条
    expect(readTokenLedger().entries[0]!.outputTokens).toBe(TOKEN_LEDGER_LIMIT + 49)
  })

  it('record 绝不抛错：垃圾入参（null/undefined/异常对象）安静落账', () => {
    resetTokenLedgerForTests()
    expect(() => recordTokenUsage(null as never)).not.toThrow()
    expect(() => recordTokenUsage(undefined as never)).not.toThrow()
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'provider', { get() { throw new Error('boom') } })
    expect(() => recordTokenUsage(hostile as never)).not.toThrow()
  })
})

describe('readTokenLedger：三维聚合树', () => {
  it('渠道 → provider → 模型 逐级分桶，各级小计 = 子级之和', () => {
    // ⚠️ codearts 的两条用**不同模型名**：同 provider 下同名模型会合并成一行，
    // 覆盖后只留最后一条（600 = 100+500），故给 qoder 那条换 provider 后
    // codearts 只该有 2 个模型、2 条记录。
    seed([
      { ...OK, model: 'GLM-5.2', inputTokens: 100, outputTokens: 10 },
      { ...OK, model: 'deepseek-v4.1-flash', inputTokens: 200, outputTokens: 20 },
      { ...OK, provider: 'qoder', model: 'GLM-5.2', inputTokens: 300, outputTokens: 30 },
      { ...OK, channel: 'gateway', provider: 'qoder', inputTokens: 400, outputTokens: 40 },
    ])
    const snap = readTokenLedger()
    expect(snap.channels).toHaveLength(2)
    // 渠道排序：direct 在前
    const direct = snap.channels[0]!
    expect(direct.channel).toBe('direct')
    expect(direct.providers).toHaveLength(2)
    const codearts = direct.providers.find((p) => p.provider === 'codearts')!
    expect(codearts.models).toHaveLength(2)
    expect(codearts.totals.inputTokens).toBe(300)
    expect(codearts.totals.outputTokens).toBe(30)
    // direct 渠道小计 = codearts(300) + qoder 直连那条(300) = 600
    expect(direct.totals.inputTokens).toBe(600)
    expect(direct.totals.outputTokens).toBe(60)
    const gateway = snap.channels.find((c) => c.channel === 'gateway')!
    expect(gateway.providers[0]!.provider).toBe('qoder')
    expect(gateway.totals.inputTokens).toBe(400)
    // 全局小计 = 两条渠道之和（direct 600 + gateway 400 = 1000）
    expect(snap.totals.inputTokens).toBe(1000)
    expect(snap.totals.outputTokens).toBe(100)
  })

  it('排序：provider 与模型都按 token 合计降序（谁烧得多谁在前）', () => {
    // ⚠️ 各 provider 用**同一个模型名**（z），避免 codearts 与 aaa/bbb/ccc 跨桶混淆。
    // 同理 codearts 的两条是**不同模型**（m-small / m-big），不会并成一行。
    seed([
      { ...OK, provider: 'aaa', model: 'z', inputTokens: 10, outputTokens: 1 },
      { ...OK, provider: 'bbb', model: 'z', inputTokens: 900, outputTokens: 2 },
      { ...OK, provider: 'ccc', model: 'z', inputTokens: 500, outputTokens: 3 },
      { ...OK, model: 'm-small', inputTokens: 1, outputTokens: 1 },
      { ...OK, model: 'm-big', inputTokens: 777, outputTokens: 1 },
    ])
    const direct = readTokenLedger().channels[0]!
    // aaa=11 / bbb=902 / ccc=503 / codearts=778（m-big）+2（m-small）
    expect(direct.providers.map((p) => p.provider)).toEqual(['bbb', 'codearts', 'ccc', 'aaa'])
    const codearts = direct.providers.find((p) => p.provider === 'codearts')!
    expect(codearts.models.map((m) => m.model)).toEqual(['m-big', 'm-small'])
  })

  it('失败行/未报行计入请求数与 errors，但不污染 token 汇总', () => {
    seed([
      OK,
      { ...OK, usageReported: false, inputTokens: 999, outputTokens: 999, error: 'upstream broke' },
    ])
    const snap = readTokenLedger()
    expect(snap.totals.requests).toBe(2)
    expect(snap.totals.errors).toBe(1)
    expect(snap.totals.reportedRequests).toBe(1)
    // 未报行的 999 不得混进汇总
    expect(snap.totals.inputTokens).toBe(100)
    expect(snap.totals.outputTokens).toBe(50)
  })

  it('限流/缓存字段在树中正确累加（cache/reasoning 求和）', () => {
    seed([
      { ...OK, cacheReadTokens: 100, reasoningTokens: 5, cacheWriteTokens: 2 },
      { ...OK, cacheReadTokens: 50, reasoningTokens: 7 },
    ])
    const direct = readTokenLedger().channels[0]!
    expect(direct.totals.cacheReadTokens).toBe(150)
    expect(direct.totals.reasoningTokens).toBe(12)
    expect(direct.totals.cacheWriteTokens).toBe(2)
  })

  it('空账本：空树 + 零小计 + 空明细（不抛错）', () => {
    resetTokenLedgerForTests()
    const snap = readTokenLedger()
    expect(snap.channels).toEqual([])
    expect(snap.entries).toEqual([])
    expect(snap.totals.requests).toBe(0)
  })

  it('limit 只截明细，不截聚合树', () => {
    seed([OK, { ...OK, provider: 'b' }, { ...OK, provider: 'c' }])
    const snap = readTokenLedger({ limit: 1 })
    expect(snap.entries).toHaveLength(1)
    expect(snap.totals.requests).toBe(3)
    expect(snap.channels[0]!.totals.requests).toBe(3)
  })
})
