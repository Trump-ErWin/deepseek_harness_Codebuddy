/**
 * 「Token 账本日聚合持久化」的单测（第 2 期）。
 *
 * ⚠️ 用**内存后端的等价物**（临时目录里的 FileLedgerStore）跑真实读写，
 * 而不是 mock 掉 fs —— 落盘格式（`{schema, days}`）与载入钳制才是本文件
 * 要锁的契约。
 */
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTokenLedgerStore } from '../../src/token-ledger-store.js'
import type { TokenLedgerEntry } from '../../src/token-ledger.js'

function makeEntry(over: Partial<Omit<TokenLedgerEntry, 'ts'>> = {}): Omit<TokenLedgerEntry, 'ts'> {
  return {
    channel: 'direct',
    provider: 'codearts',
    model: 'GLM-5.2',
    usageReported: true,
    inputTokens: 10,
    outputTokens: 5,
    durationMs: 100,
    ...over,
  }
}

describe('createTokenLedgerStore（文件后端）', () => {
  it('append 后 flush 落盘；新实例 load 读回一致', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-store-'))
    const store = createTokenLedgerStore({ logger: undefined, get: () => undefined } as never)
    // ⚠️ createTokenLedgerStore 走 resolveJetHubHome(ctx)：无 profileContext 时
    // 落 ~/.dsh —— 绝不能让测试写真实用户目录。这里用 env 隔离（与全局 setup 同理）。
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const store2 = createTokenLedgerStore({ logger: undefined } as never)
      store2.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry() })
      store2.flush()
      const file = join(home, 'jet-hub', 'token-ledger.json')
      expect(existsSync(file)).toBe(true)
      // 落盘格式带 schema 标记
      const doc = JSON.parse(readFileSync(file, 'utf-8')) as { schema?: string; days?: unknown }
      expect(doc.schema).toContain('token-ledger/v1')

      // 新实例读回：累计值一致
      const store3 = createTokenLedgerStore({ logger: undefined } as never)
      const days = store3.load()
      const buckets = days.get('2026-10-05')!
      expect(buckets.get('direct|codearts||GLM-5.2')!.inputTokens).toBe(10)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
    void store
  })

  it('append 持续合并到同一日桶（多次 append 不增行）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-store-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const store = createTokenLedgerStore({ logger: undefined } as never)
      for (let i = 0; i < 5; i++) {
        store.append({ ts: Date.UTC(2026, 9, 5, 3, i, 0), ...makeEntry({ inputTokens: 1 }) })
      }
      store.flush()
      const days = store.load()
      const bucket = days.get('2026-10-05')!.get('direct|codearts||GLM-5.2')!
      expect(bucket.requests).toBe(5)
      expect(bucket.inputTokens).toBe(5)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  it('文档损坏按空表处理（不抛错、不阻断启动）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-store-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      mkdirSync(join(home, 'jet-hub'), { recursive: true })
      writeFileSync(join(home, 'jet-hub', 'token-ledger.json'), '{broken json', 'utf-8')
      const store = createTokenLedgerStore({ logger: { warn: () => {} } } as never)
      expect(store.load().size).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  it('account 维度进入桶键（第 2 期）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-store-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry({ accountId: 'acct-9' }) })
      store.append({ ts: Date.UTC(2026, 9, 5, 2, 1, 0), ...makeEntry({ accountId: 'acct-9', inputTokens: 3 }) })
      const bucket = store.load().get('2026-10-05')!.get('direct|codearts|acct-9|GLM-5.2')!
      expect(bucket.requests).toBe(2)
      expect(bucket.inputTokens).toBe(13)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })
})

afterEach(() => {
  // 每条用例后不再有共享状态（store 按用例新建，env 在用例内恢复）。
})
