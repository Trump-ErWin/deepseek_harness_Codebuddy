/**
 * **存量同账号自愈**（`AccountPool.dedupeByCredentialField`）守卫。
 *
 * ## 真机报障（2026-10-19）
 *
 * 用户面板里**同一个手机号出现 3 次**，积分被重复累加：
 *
 * ```
 * 合计 62416 积分
 *   187****9406  20838
 *   187****9406  20789
 *   187****9406  20789
 * ```
 *
 * 根因：AutoClaw 的 `access_token` 是 JWT、**每次登录/续期都轮换**，
 * 而旧实现拿它当身份判据 ⇒ 同一账号每续一次就被当成新账号。
 *
 * 判据侧已修（`autoclawIdentityOf` 改用稳定 `user_id`），但**池里已有的重复
 * 条目不会自己消失** —— 用户仍看到 62416。本文件钉住那一次性清理。
 *
 * ## ⚠️ 必须隔离 dsh home（与 account-pool.spec.ts 同因）
 *
 * 账号池后端定位 home 的顺序是
 * `DSH_JET_HUB_STATE_DIR` → profileContext → `DSH_HOME` → `~/.dsh`。
 * 不隔离就会读写**用户真实的** `~/.dsh/jet-hub/`。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/account-pool.js'

let isolatedHome: string | undefined
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env.DSH_JET_HUB_STATE_DIR
  isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-dedupe-'))
  process.env.DSH_JET_HUB_STATE_DIR = isolatedHome
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = previousHome
  if (isolatedHome !== undefined) rmSync(isolatedHome, { recursive: true, force: true })
})

/** 每个用例独立的凭据表（避免跨用例污染）。 */
let credentials: Map<string, string>

/** 造一个只实现「账号池真正用到的那几个成员」的 ctx。 */
function createCtx(): { logger: { warn: () => void; info: () => void }; credentials: unknown } {
  return {
    logger: { warn: () => {}, info: () => {} },
    credentials: {
      describe: async (ref: unknown) => ({
        configured: credentials.has(String(ref)),
        source: 'test' as const,
        writable: true,
      }),
      resolve: async (ref: unknown) => {
        const value = credentials.get(String(ref))
        return value === undefined ? undefined : { value, source: 'test' as const }
      },
      set: async (ref: unknown, value: string) => {
        credentials.set(String(ref), value)
      },
      unset: async (ref: unknown) => {
        credentials.delete(String(ref))
      },
    },
  }
}

function makeAccount(overrides: Partial<ProviderAccountEntry>): ProviderAccountEntry {
  return {
    id: 'acc-1',
    provider: 'autoclaw',
    nickname: 'u',
    enabled: true,
    credentialRef: 'REF-1',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    refreshable: true,
    ...overrides,
  }
}

/**
 * 造一个池：先经 `addAccount` 写入（这样落盘与进程内副本都是真实路径），
 * 再返回 pool。凭据 JSON 写进 `credentials`。
 */
async function makePool(specs: Array<{
  id: string
  ref: string
  userId?: string | number
  expiresAt?: number
  provider?: string
}>): Promise<AccountPool> {
  const ctx = createCtx()
  const pool = new AccountPool(ctx as never)
  for (const s of specs) {
    credentials.set(s.ref, JSON.stringify({
      access_token: `tok-${s.id}`,
      refresh_token: 'r',
      ...s.userId === undefined ? {} : { user_id: s.userId },
    }))
    await pool.addAccount(makeAccount({
      id: s.id,
      credentialRef: s.ref,
      provider: s.provider ?? 'autoclaw',
      ...s.expiresAt === undefined ? {} : { expiresAt: s.expiresAt },
    }))
  }
  return pool
}

beforeEach(() => {
  credentials = new Map()
  // 每个用例换一个全新 home，避免上一个用例的 state.json 被读进来。
  if (isolatedHome !== undefined) {
    rmSync(join(isolatedHome, 'jet-hub'), { recursive: true, force: true })
  }
})

describe('AccountPool.dedupeByCredentialField（存量同账号自愈）', () => {
  it('★ 同 user_id 的 3 条 ⇒ 只留 1 条（保留 expiresAt 最大者）', async () => {
    const pool = await makePool([
      { id: 'a1', ref: 'REF_A1', userId: '839684', expiresAt: 1000 },
      { id: 'a2', ref: 'REF_A2', userId: '839684', expiresAt: 3000 },
      { id: 'a3', ref: 'REF_A3', userId: '839684', expiresAt: 2000 },
    ])
    expect(pool.listAccountsByProvider('autoclaw')).toHaveLength(3)

    const removed = await pool.dedupeByCredentialField('autoclaw', 'user_id')
    expect(removed, '★ 应删掉 2 条重复').toBe(2)

    const left = pool.listAccountsByProvider('autoclaw')
    expect(left, '★ 只剩 1 条').toHaveLength(1)
    expect(left[0]!.id, '★ 保留 expiresAt 最大的那条（它才是能续期的）').toBe('a2')
  })

  it('★ 不同 user_id 不得合并（不能过度去重）', async () => {
    const pool = await makePool([
      { id: 'b1', ref: 'REF_B1', userId: '111' },
      { id: 'b2', ref: 'REF_B2', userId: '222' },
    ])
    expect(await pool.dedupeByCredentialField('autoclaw', 'user_id')).toBe(0)
    expect(pool.listAccountsByProvider('autoclaw')).toHaveLength(2)
  })

  it('★ 缺 user_id 的条目跳过（无法判断，绝不误删）', async () => {
    const pool = await makePool([
      { id: 'c1', ref: 'REF_C1' },
      { id: 'c2', ref: 'REF_C2' },
      { id: 'c3', ref: 'REF_C3', userId: '839684' },
    ])
    expect(
      await pool.dedupeByCredentialField('autoclaw', 'user_id'),
      '★ 缺字段的两条不能因为「都是空」而被当成同账号',
    ).toBe(0)
    expect(pool.listAccountsByProvider('autoclaw')).toHaveLength(3)
  })

  it('★ 只处理指定 provider（不跨渠道合并）', async () => {
    const pool = await makePool([
      { id: 'd1', ref: 'REF_D1', userId: '839684' },
      { id: 'd2', ref: 'REF_D2', userId: '839684' },
      { id: 'd3', ref: 'REF_D3', userId: '839684', provider: 'buddy' },
    ])
    await pool.dedupeByCredentialField('autoclaw', 'user_id')
    expect(pool.listAccountsByProvider('autoclaw')).toHaveLength(1)
    expect(pool.listAccountsByProvider('buddy'), '★ 别的渠道不能被牵连').toHaveLength(1)
  })

  it('★ 删掉的条目要一并清凭据（不留孤儿凭据）', async () => {
    const pool = await makePool([
      { id: 'e1', ref: 'REF_E1', userId: '839684', expiresAt: 1000 },
      { id: 'e2', ref: 'REF_E2', userId: '839684', expiresAt: 9000 },
    ])
    await pool.dedupeByCredentialField('autoclaw', 'user_id')
    expect(credentials.has('REF_E1'), '★ 被删条目的凭据应被 unset').toBe(false)
    expect(credentials.has('REF_E2'), '保留条目的凭据必须在').toBe(true)
  })

  it('★ 只有 1 条时不做任何事（零开销快路径）', async () => {
    const pool = await makePool([{ id: 'f1', ref: 'REF_F1', userId: '839684' }])
    expect(await pool.dedupeByCredentialField('autoclaw', 'user_id')).toBe(0)
    expect(credentials.has('REF_F1')).toBe(true)
  })

  it('★ 数字型 user_id 也要能识别（上游可能下发 number）', async () => {
    const pool = await makePool([
      { id: 'g1', ref: 'R1', userId: '839684', expiresAt: 1000 },
      { id: 'g2', ref: 'R2', userId: 839684, expiresAt: 5000 },
    ])
    expect(
      await pool.dedupeByCredentialField('autoclaw', 'user_id'),
      '★ string 与 number 形态的同一 user_id 必须判为同一账号',
    ).toBe(1)
    expect(pool.listAccountsByProvider('autoclaw')[0]!.id).toBe('g2')
  })
})
