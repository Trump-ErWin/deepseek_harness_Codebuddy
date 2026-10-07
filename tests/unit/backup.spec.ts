import { describe, it, expect } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  BackupFormatError,
  assertBackupPayload,
  exportBackup,
  importBackup,
  type BackupCredentials,
  type BackupPool,
} from '../../src/backup.js'
import { BACKUP_FORMAT, BACKUP_VERSION } from '../../src/types.js'
import type { JetHubState } from '../../src/jet-hub-store.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/** 构造一份最小账号条目。 */
function account(partial: Partial<ProviderAccountEntry> & { id: string; provider: string; credentialRef: string }): ProviderAccountEntry {
  return {
    nickname: partial.id,
    enabled: true,
    refreshable: true,
    createdAt: 1000,
    ...partial,
  }
}

/** 内存凭据服务（与 ctx.credentials 同构的最小实现）。 */
function createCredentials(): BackupCredentials & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    resolve: async (ref) => {
      const value = store.get(String(ref))
      return value === undefined ? undefined : { value }
    },
    set: async (ref, value) => {
      store.set(String(ref), value)
    },
  }
}

/** 内存账号池（记录最后一次 replaceAll / mergeAccounts 调用）。 */
function createPool(initial?: JetHubState): BackupPool & {
  replaced: {
    accounts: ProviderAccountEntry[]
    disabledModels: Record<string, Record<string, boolean>>
    /** 第三参：`undefined` = 备份里没有锁定信息（池应保持当前值）。 */
    permanentLocks?: Record<string, boolean>
  } | null
  /** 记录每次 mergeAccounts 的入参（合并导入的「只追加」语义靠它断言）。 */
  merged: ProviderAccountEntry[][]
} {
  let state = initial ?? { accounts: [], disabledModels: {} }
  const record: { replaced: {
    accounts: ProviderAccountEntry[]
    disabledModels: Record<string, Record<string, boolean>>
    permanentLocks?: Record<string, boolean>
  } | null } = { replaced: null }
  const merged: ProviderAccountEntry[][] = []
  return {
    get replaced() { return record.replaced },
    get merged() { return merged },
    getStateSnapshot: () => ({
      accounts: [...state.accounts],
      disabledModels: { ...state.disabledModels },
      ...state.loomyPermanentLocked !== undefined ? { loomyPermanentLocked: state.loomyPermanentLocked } : {},
    }),
    // 锁定表的权威在独立文档里，备份导出单独取这一份。
    permanentLocksSnapshot: () => ({ ...(state.permanentLocks ?? {}) }),
    replaceAll: async (accounts, disabledModels, permanentLocks) => {
      state = { accounts: [...accounts], disabledModels: { ...disabledModels } }
      record.replaced = {
        accounts: [...accounts],
        disabledModels: { ...disabledModels },
        ...(permanentLocks === undefined ? {} : { permanentLocks }),
      }
      return undefined
    },
    // 「只追加」：与真实 AccountPool.mergeAccounts 同语义（按 id 跳过已存在）。
    mergeAccounts: async (accounts) => {
      merged.push([...accounts])
      const existing = new Set(state.accounts.map(a => a.id))
      const added: ProviderAccountEntry[] = []
      for (const entry of accounts) {
        if (existing.has(entry.id)) continue
        existing.add(entry.id)
        added.push(entry)
      }
      state = { ...state, accounts: [...state.accounts, ...added] }
      return added.map(a => a.id)
    },
  }
}

describe('backup export', () => {
  it('收集全部账号的凭据原文与黑名单', async () => {
    const credentials = createCredentials()
    const codeartsCredential = JSON.stringify({ access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST' })
    await credentials.set(credentialRef('CODEARTS_ACCOUNT_A1B2'), codeartsCredential)
    const pool = createPool({
      accounts: [
        account({ id: 'codearts-a1', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_A1B2' }),
      ],
      disabledModels: { buddy: { 'glm-5.2': true } },
    })

    const result = await exportBackup(pool, credentials)

    expect(result.warnings).toEqual([])
    expect(result.payload.format).toBe('dsh-codearts-auth/backup')
    expect(result.payload.version).toBe(1)
    expect(typeof result.payload.exportedAt).toBe('string')
    // 凭据以**原文**保存（与 ctx.credentials 存储形态一致），不做任何改写
    expect(result.payload.credentials['CODEARTS_ACCOUNT_A1B2']).toBe(codeartsCredential)
    expect(result.payload.accounts).toHaveLength(1)
    expect(result.payload.accounts[0]!.id).toBe('codearts-a1')
    expect(result.payload.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
  })

  it('凭据缺失/损坏只记 warnings，不中断整体导出', async () => {
    const credentials = createCredentials()
    // 只给第二个账号配凭据；第一个账号的凭据缺失
    await credentials.set(credentialRef('BUDDY_ACCOUNT_B2C3'), '{"access_token":"t"}')
    const pool = createPool({
      accounts: [
        account({ id: 'buddy-b1', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_B1' }),
        account({ id: 'buddy-b2', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_B2C3' }),
      ],
      disabledModels: {},
    })

    const result = await exportBackup(pool, credentials)

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('buddy-b1')
    expect(Object.keys(result.payload.credentials)).toEqual(['BUDDY_ACCOUNT_B2C3'])
    // 坏账号不影响其余账号与整体导出
    expect(result.payload.accounts).toHaveLength(2)
  })
})

describe('backup format validation', () => {
  it('非对象输入抛 BackupFormatError', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    await expect(importBackup(credentials, pool, null)).rejects.toBeInstanceOf(BackupFormatError)
    await expect(importBackup(credentials, pool, 'string')).rejects.toBeInstanceOf(BackupFormatError)
    await expect(importBackup(credentials, pool, [1])).rejects.toBeInstanceOf(BackupFormatError)
  })

  it('format 不符抛 BackupFormatError', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    await expect(importBackup(credentials, pool, {
      format: 'other/format',
      version: 1,
      exportedAt: new Date().toISOString(),
      credentials: {},
      accounts: [],
      disabledModels: {},
    })).rejects.toBeInstanceOf(BackupFormatError)
  })

  it('版本不符抛 BackupFormatError', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    await expect(importBackup(credentials, pool, {
      format: 'dsh-codearts-auth/backup',
      version: 99,
      exportedAt: new Date().toISOString(),
      credentials: {},
      accounts: [],
      disabledModels: {},
    })).rejects.toBeInstanceOf(BackupFormatError)
  })

  it('字段缺失/类型错误抛 BackupFormatError', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    const base = {
      format: 'dsh-codearts-auth/backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      credentials: {},
      accounts: [],
      disabledModels: {},
    }
    await expect(importBackup(credentials, pool, { ...base, credentials: 'nope' })).rejects.toBeInstanceOf(BackupFormatError)
    await expect(importBackup(credentials, pool, { ...base, accounts: 'nope' })).rejects.toBeInstanceOf(BackupFormatError)
    await expect(importBackup(credentials, pool, { ...base, disabledModels: null })).rejects.toBeInstanceOf(BackupFormatError)
  })
})

describe('backup import', () => {
  it('先写凭据再整体替换账号池', async () => {
    const credentials = createCredentials()
    const pool = createPool({ accounts: [{ id: 'old', provider: 'buddy', nickname: 'old', enabled: true, refreshable: false, credentialRef: 'OLD_REF', createdAt: 1 }], disabledModels: {} })
    const payload = {
      format: 'dsh-codearts-auth/backup' as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      credentials: {
        'CODEARTS_ACCOUNT_A1B2': JSON.stringify({ access_key_id: 'AK' }),
        'BUDDY_ACCOUNT_B2C3': JSON.stringify({ access_token: 't' }),
      },
      accounts: [
        account({ id: 'codearts-a1', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_A1B2' }),
      ],
      disabledModels: { trae: { 'qwen3.8-flash': true } },
    }

    const result = await importBackup(credentials, pool, payload)

    expect(result.credentialsImported).toBe(2)
    expect(result.accountsImported).toBe(1)
    expect(result.skipped).toEqual([])
    // 凭据已写入
    expect((await credentials.resolve(credentialRef('CODEARTS_ACCOUNT_A1B2')))?.value).toContain('"access_key_id":"AK"')
    expect((await credentials.resolve(credentialRef('BUDDY_ACCOUNT_B2C3')))?.value).toContain('"access_token":"t"')
    // 账号池整体替换（旧账号被清掉）
    expect(pool.replaced).not.toBeNull()
    expect(pool.replaced!.accounts.map(a => a.id)).toEqual(['codearts-a1'])
    expect(pool.replaced!.disabledModels).toEqual({ trae: { 'qwen3.8-flash': true } })
  })

  it('值非字符串的凭据条目被跳过并记录', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    const payload = {
      format: 'dsh-codearts-auth/backup' as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      credentials: {
        'BUDDY_ACCOUNT_B1': { access_token: 'not-a-string' },
        'BUDDY_ACCOUNT_B2': '{"access_token":"ok"}',
      },
      accounts: [],
      disabledModels: {},
    }

    const result = await importBackup(credentials, pool, payload)

    expect(result.credentialsImported).toBe(1)
    expect(result.skipped).toEqual(['BUDDY_ACCOUNT_B1'])
  })

  it('非法凭据 ref 被跳过，不中断整体导入', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    const payload = {
      format: 'dsh-codearts-auth/backup' as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      credentials: {
        '': '{"x":1}', // 空 ref：credentialRef 校验必失败
        'BUDDY_ACCOUNT_B2': '{"access_token":"ok"}',
      },
      accounts: [],
      disabledModels: {},
    }

    const result = await importBackup(credentials, pool, payload)

    expect(result.credentialsImported).toBe(1)
    expect(result.skipped).toContain('')
    // 合法条目不受影响
    expect((await credentials.resolve(credentialRef('BUDDY_ACCOUNT_B2')))?.value).toContain('"access_token":"ok"')
  })

  it('统计已过期账号（expiresAt <= now），缺失/非法 expiresAt 不算过期', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    const now = Date.now()
    const payload = {
      format: 'dsh-codearts-auth/backup' as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      credentials: {},
      accounts: [
        // 已过期
        account({ id: 'buddy-expired', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_E1', expiresAt: now - 1000 }),
        // 未来（未过期）
        account({ id: 'buddy-future', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_F1', expiresAt: now + 3600000 }),
        // 无有效期（自动恢复产物，不算"已过期"）
        account({ id: 'buddy-unknown', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_U1' }),
        // 非法 expiresAt（NaN，不算过期）
        account({ id: 'buddy-nan', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_N1', expiresAt: Number.NaN }),
      ],
      disabledModels: {},
    }

    const result = await importBackup(credentials, pool, payload)

    expect(result.expiredAccounts).toBe(1)
    expect(result.accountsImported).toBe(4)
  })

  it('统计凭据缺失账号（credentialRef 不在字典 / 被 skipped）', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    const payload = {
      format: 'dsh-codearts-auth/backup' as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      credentials: {
        'BUDDY_ACCOUNT_1': '{"access_token":"ok"}',
        'BUDDY_ACCOUNT_2': '{"access_token":"also-ok"}',
      },
      accounts: [
        // 凭据存在（不缺失）
        account({ id: 'buddy-1', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_1' }),
        // credentialRef 不在 credentials 字典（缺失）
        account({ id: 'buddy-2', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_MISSING' }),
        // credentialRef 在字典但值非字符串 → 被 skipped（也算缺失）
        account({ id: 'buddy-3', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_2' }),
      ],
      disabledModels: {},
    }
    // BUDDY_ACCOUNT_2 的值是对象（非字符串）→ 会被 skipped
    payload.credentials['BUDDY_ACCOUNT_2'] = { access_token: 'not-a-string' } as unknown as string

    const result = await importBackup(credentials, pool, payload)

    expect(result.credentialsImported).toBe(1)
    expect(result.skipped).toEqual(['BUDDY_ACCOUNT_2'])
    // buddy-2（缺 ref）与 buddy-3（ref 被 skipped）都算凭据缺失
    expect(result.missingCredentials).toBe(2)
    expect(result.accountsImported).toBe(3)
  })
})

describe('backup round-trip', () => {
  it('导出 → 导入可还原全部账号与凭据', async () => {
    // 源侧
    const sourceCredentials = createCredentials()
    await sourceCredentials.set(credentialRef('CODEARTS_ACCOUNT_A1B2'), '{"access_key_id":"AK"}')
    await sourceCredentials.set(credentialRef('BUDDY_ACCOUNT_B2C3'), '{"access_token":"t","refresh_token":"r"}')
    const sourcePool = createPool({
      accounts: [
        account({ id: 'codearts-a1', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_A1B2' }),
        account({ id: 'buddy-b2', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_B2C3' }),
      ],
      disabledModels: { qoder: { 'qfmodel': true } },
    })

    const exported = await exportBackup(sourcePool, sourceCredentials)
    expect(exported.warnings).toEqual([])

    // 目标侧（全新空状态）
    const targetCredentials = createCredentials()
    const targetPool = createPool()
    const result = await importBackup(targetCredentials, targetPool, exported.payload)

    expect(result.credentialsImported).toBe(2)
    expect(result.accountsImported).toBe(2)
    expect(result.skipped).toEqual([])
    // 备份里的账号未带 expiresAt（未知），不算已过期
    expect(result.expiredAccounts).toBe(0)
    // 凭据原文逐条还原
    expect((await targetCredentials.resolve(credentialRef('CODEARTS_ACCOUNT_A1B2')))?.value).toBe('{"access_key_id":"AK"}')
    expect((await targetCredentials.resolve(credentialRef('BUDDY_ACCOUNT_B2C3')))?.value).toBe('{"access_token":"t","refresh_token":"r"}')
    // 账号与黑名单还原
    expect(targetPool.replaced!.accounts.map(a => a.id)).toEqual(['codearts-a1', 'buddy-b2'])
    expect(targetPool.replaced!.disabledModels).toEqual({ qoder: { qfmodel: true } })
  })
})

/**
 * ⚠️ **永久积分锁定表**的导出 / 导入（CodeBuddy 与 WorkBuddy 加入后新增）。
 *
 * 这件事的风险与其他字段不同：**误解锁的后果是用户真的把永久积分烧掉**，
 * 不可撤回。所以「备份里没说」与「备份里说不锁」必须区分开。
 */
describe('永久积分锁定表', () => {
  /** 造一份合法载荷（只关心锁定相关字段）。 */
  function payloadOf(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: '2026-09-29T00:00:00.000Z',
      credentials: {},
      accounts: [],
      disabledModels: {},
      ...extra,
    }
  }

  it('导出同时写新表与 Loomy 兼容副本（同源）', async () => {
    const pool = createPool({
      accounts: [],
      disabledModels: {},
      permanentLocks: { buddy: true, loomy: true },
    })
    const { payload } = await exportBackup(pool, createCredentials())
    expect(payload.permanentLocks).toEqual({ buddy: true, loomy: true })
    expect(payload.loomyPermanentLocked).toBe(true)
  })

  it('导出时表为空 → 兼容副本必须是 false（不能让 Loomy 跟着 buddy 一起锁上）', async () => {
    const pool = createPool({ accounts: [], disabledModels: {}, permanentLocks: { buddy: true } })
    const { payload } = await exportBackup(pool, createCredentials())
    expect(payload.permanentLocks).toEqual({ buddy: true })
    expect(payload.loomyPermanentLocked).toBe(false)
  })

  it('导入新表 → 整体替换（buddy 的锁定不丢，未记录的 provider 被解锁）', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf({
      permanentLocks: { buddy: true, workbuddy: true },
    }))
    expect(pool.replaced!.permanentLocks).toEqual({ buddy: true, workbuddy: true })
  })

  /**
   * ⚠️ 老备份（本次改动之前导出的）只有 `loomyPermanentLocked` 一个字段。
   * 不认它 = 导入老备份后 Loomy 的锁定悄悄失效；
   * 把它当「无从得知」= 用户明明在备份里说过「锁着」却解了。
   */
  it('导入只有老字段且为 true 的老备份 → 恢复 Loomy 那一项', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf({ loomyPermanentLocked: true }))
    expect(pool.replaced!.permanentLocks).toEqual({ loomy: true })
  })

  /** 老字段为 false 是**明确的「不锁」**，与「没有这个字段」不同。 */
  it('导入只有老字段且为 false 的老备份 → 明确解锁（传空表，不是 undefined）', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf({ loomyPermanentLocked: false }))
    expect(pool.replaced!.permanentLocks).toEqual({})
  })

  /**
   * ⚠️ 两个字段都没有（更早的备份）→ 必须传 `undefined`，
   * 让池**保持当前值**；传空表会把用户的锁定静默清空。
   */
  it('两个字段都没有时传 undefined（保持当前锁定状态）', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf())
    expect(pool.replaced).not.toBeNull()
    expect(pool.replaced!.permanentLocks).toBeUndefined()
  })

  it('新表存在时仍以老字段补齐表里没有的 Loomy 项（两处口径不分裂）', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf({
      permanentLocks: { buddy: true },
      loomyPermanentLocked: true,
    }))
    expect(pool.replaced!.permanentLocks).toEqual({ buddy: true, loomy: true })
  })

  it('表里的脏值被过滤（只认显式 true）', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf({
      permanentLocks: { buddy: 'yes', workbuddy: true, loomy: false },
    }))
    expect(pool.replaced!.permanentLocks).toEqual({ workbuddy: true })
  })

  it('permanentLocks 是数组时拒绝整份备份（typeof [] 也是 object，必须单独判）', async () => {
    const pool = createPool()
    expect(() => assertBackupPayload(payloadOf({ permanentLocks: ['buddy'] })))
      .toThrowError(BackupFormatError)
  })

  it('round-trip 锁定状态不丢', async () => {
    const source = createPool({
      accounts: [],
      disabledModels: {},
      permanentLocks: { buddy: true, workbuddy: true },
    })
    const { payload } = await exportBackup(source, createCredentials())
    const target = createPool()
    await importBackup(createCredentials(), target, payload)
    expect(target.replaced!.permanentLocks).toEqual({ buddy: true, workbuddy: true })
  })
})

/**
 * ⚠️ **单独导出某个账号**（`options.accountIds`）。
 *
 * 这是「把 A 机器上的一个账号搬到 B 机器」的第一步。要点是：过滤只作用于
 * accounts / credentials，黑名单与锁定表仍是全量 —— 产物始终自包含。
 */
describe('选择性导出（accountIds）', () => {
  /** 两个账号的池 + 各自的凭据。 */
  async function twoAccountFixture() {
    const credentials = createCredentials()
    await credentials.set(credentialRef('BUDDY_ACCOUNT_B1'), '{"access_token":"t1"}')
    await credentials.set(credentialRef('BUDDY_ACCOUNT_B2'), '{"access_token":"t2"}')
    const pool = createPool({
      accounts: [
        account({ id: 'buddy-b1', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_B1' }),
        account({ id: 'buddy-b2', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_B2' }),
      ],
      disabledModels: { buddy: { 'glm-5.2': true } },
      permanentLocks: { buddy: true },
    })
    return { credentials, pool }
  }

  it('只导出选中账号及其凭据，其余账号不出现在文件里', async () => {
    const { credentials, pool } = await twoAccountFixture()

    const result = await exportBackup(pool, credentials, { accountIds: ['buddy-b2'] })

    expect(result.payload.accounts.map(a => a.id)).toEqual(['buddy-b2'])
    // ⚠️ 只带选中账号的凭据：带上另一个账号的凭据 = 文件里多出一份没被要求的密钥。
    expect(Object.keys(result.payload.credentials)).toEqual(['BUDDY_ACCOUNT_B2'])
    expect(result.warnings).toEqual([])
  })

  it('模型黑名单与锁定表仍按全量写出（产物保持可整体还原）', async () => {
    const { credentials, pool } = await twoAccountFixture()

    const { payload } = await exportBackup(pool, credentials, { accountIds: ['buddy-b1'] })

    expect(payload.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
    expect(payload.permanentLocks).toEqual({ buddy: true })
    // 依旧是合法备份（可整体还原），不是「残缺文件」
    expect(() => assertBackupPayload(payload)).not.toThrow()
  })

  it('不传 / 传空数组 = 导出全部（空数组不能静默变成 0 个账号）', async () => {
    const { credentials, pool } = await twoAccountFixture()

    const omitted = await exportBackup(pool, credentials)
    const empty = await exportBackup(pool, credentials, { accountIds: [] })

    expect(omitted.payload.accounts).toHaveLength(2)
    // ⚠️ 空数组按「没指定」处理：否则会导出一份「看着成功、其实空的」文件。
    expect(empty.payload.accounts).toHaveLength(2)
  })

  it('选中不存在的账号 id → 记 warning，不静默导出少一个账号的文件', async () => {
    const { credentials, pool } = await twoAccountFixture()

    const result = await exportBackup(pool, credentials, { accountIds: ['buddy-b1', 'buddy-ghost'] })

    expect(result.payload.accounts.map(a => a.id)).toEqual(['buddy-b1'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('buddy-ghost')
  })
})

/**
 * ⚠️ **合并导入**（`mode: 'merge'`）—— 「单独导入一个账号」的核心语义。
 *
 * 与整体还原的差别必须被逐条锁住，因为任何一条退化成「覆盖」都是
 * **不可逆的数据损失**（用户的现有账号与凭据被别人的备份顶掉）。
 */
describe('合并导入（mode: merge）', () => {
  /** 造一份合法载荷。 */
  function payloadOf(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: '2026-09-29T00:00:00.000Z',
      credentials: {},
      accounts: [],
      disabledModels: {},
      ...extra,
    }
  }

  it('只追加：现有账号一个都不少，新账号被加进来', async () => {
    const pool = createPool({
      accounts: [account({ id: 'buddy-existing', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_E1' })],
      disabledModels: {},
    })
    const credentials = createCredentials()

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: { BUDDY_ACCOUNT_N1: '{"access_token":"new"}' },
      accounts: [account({ id: 'buddy-new', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_N1' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(1)
    expect(result.accountsSkipped).toEqual([])
    expect(result.credentialsImported).toBe(1)
    // ⚠️ **绝不允许走 replaceAll** —— 那会把现有账号清空。
    expect(pool.replaced).toBeNull()
    expect(pool.merged).toHaveLength(1)
    expect((await credentials.resolve(credentialRef('BUDDY_ACCOUNT_N1')))?.value).toBe('{"access_token":"new"}')
  })

  it('同 id 已存在 → 跳过且**不覆盖**凭据（用户选定的冲突策略）', async () => {
    const pool = createPool({
      accounts: [account({ id: 'buddy-dup', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_D1' })],
      disabledModels: {},
    })
    const credentials = createCredentials()
    await credentials.set(credentialRef('BUDDY_ACCOUNT_D1'), '{"access_token":"ORIGINAL"}')

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: { BUDDY_ACCOUNT_D1: '{"access_token":"FROM_BACKUP"}' },
      accounts: [account({ id: 'buddy-dup', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_D1' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(0)
    expect(result.accountsSkipped).toEqual(['buddy-dup'])
    // ⚠️ 这是整个特性最关键的一条断言：被跳过的账号，其凭据**必须原样不动**。
    expect((await credentials.resolve(credentialRef('BUDDY_ACCOUNT_D1')))?.value).toBe('{"access_token":"ORIGINAL"}')
    expect(result.credentialsImported).toBe(0)
    expect(pool.merged).toEqual([[]])
  })

  it('只写被采纳账号的凭据，不碰备份里的其余凭据 ref', async () => {
    const pool = createPool({ accounts: [], disabledModels: {} })
    const credentials = createCredentials()
    // 现有账号占用的 ref，恰好也出现在备份里（另一台机器上的同名默认 ref）。
    await credentials.set(credentialRef('BUDDY_ACCESS_TOKEN'), '{"access_token":"LOCAL"}')

    await importBackup(credentials, pool, payloadOf({
      credentials: {
        BUDDY_ACCESS_TOKEN: '{"access_token":"FROM_BACKUP"}',
        BUDDY_ACCOUNT_X1: '{"access_token":"x"}',
      },
      accounts: [account({ id: 'buddy-x', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_X1' })],
    }), { mode: 'merge' })

    // 被采纳账号的凭据写入了
    expect((await credentials.resolve(credentialRef('BUDDY_ACCOUNT_X1')))?.value).toBe('{"access_token":"x"}')
    // ⚠️ 未被任何采纳账号引用的 ref 不得回写：回写就是覆盖本机现有凭据。
    expect((await credentials.resolve(credentialRef('BUDDY_ACCESS_TOKEN')))?.value).toBe('{"access_token":"LOCAL"}')
  })

  it('不碰模型黑名单与永久积分锁定表（传当前值，不传备份值）', async () => {
    const pool = createPool({
      accounts: [],
      disabledModels: { buddy: { 'glm-5.2': true } },
      permanentLocks: { buddy: true },
    })

    await importBackup(createCredentials(), pool, payloadOf({
      accounts: [account({ id: 'buddy-n', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_N1' })],
      disabledModels: { qoder: { qfmodel: true } },
      permanentLocks: { loomy: true },
    }), { mode: 'merge' })

    // 合并模式**不**调用 replaceAll，所以黑名单与锁定表根本不会被写入。
    expect(pool.replaced).toBeNull()
  })

  it('缺省 mode = 整体替换（老客户端行为不变）', async () => {
    const pool = createPool({
      accounts: [account({ id: 'buddy-old', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_O1' })],
      disabledModels: {},
    })

    const result = await importBackup(createCredentials(), pool, payloadOf({
      accounts: [account({ id: 'buddy-new', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_N1' })],
    }))

    // 未传 mode 时仍是「还原快照」：旧账号被替换掉。
    expect(pool.merged).toEqual([])
    expect(pool.replaced!.accounts.map(a => a.id)).toEqual(['buddy-new'])
    expect(result.accountsSkipped).toEqual([])
  })

  it('备份文件内部重复 id 只新增一次（手工编辑过的文件）', async () => {
    const pool = createPool({ accounts: [], disabledModels: {} })

    const result = await importBackup(createCredentials(), pool, payloadOf({
      accounts: [
        account({ id: 'buddy-dup', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_D1' }),
        account({ id: 'buddy-dup', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_D1' }),
      ],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(1)
    expect(result.accountsSkipped).toEqual(['buddy-dup'])
  })

  it('replace 模式下 accountsSkipped 恒为空', async () => {
    const pool = createPool()
    const result = await importBackup(createCredentials(), pool, payloadOf(), { mode: 'replace' })
    expect(result.accountsSkipped).toEqual([])
  })

  /**
   * ⚠️ **按身份（user_id）判重** —— 这是第三方文件导入时最关键的一层。
   *
   * 插件自己登录时 `id` 由 `shortId()` **随机**生成，而第三方转换来的 id 是
   * **确定性哈希**，同一个人因此有两套 id。只按 id 比会把他重复加进池里，
   * 而「这个号我已经手登过了」恰恰是最常见的情形。
   */
  it('id 不同但 user_id 相同 → 判为同一账号并跳过（不产生重复）', async () => {
    const credentials = createCredentials()
    // 本机已登录的账号：随机 id + 真实身份
    await credentials.set(
      credentialRef('BUDDY_ACCOUNT_D9F00004'),
      '{"access_token":"a","refresh_token":"r","user_id":"30317387-39ee-4130-a01c-ee58f9f3c46a"}',
    )
    const pool = createPool({
      accounts: [account({ id: 'buddy-ef28b488', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_D9F00004' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      // 第三方转换来的：id 是哈希出来的，与上面的随机 id 不同，但身份相同
      credentials: {
        BUDDY_ACCOUNT_AB12CD34: '{"access_token":"b","refresh_token":"r2","user_id":"30317387-39ee-4130-a01c-ee58f9f3c46a"}',
      },
      accounts: [account({ id: 'buddy-ab12cd34', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_AB12CD34' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(0)
    expect(result.accountsSkipped).toEqual(['buddy-ab12cd34'])
    // 本机那个账号的凭据必须原样不动（跳过 = 一点都不改）
    expect((await credentials.resolve(credentialRef('BUDDY_ACCOUNT_D9F00004')))?.value)
      .toContain('"access_token":"a"')
    expect(pool.merged).toEqual([[]])
  })

  it('身份判重与 id 判重配合：身份不同的新账号照常追加', async () => {
    const credentials = createCredentials()
    await credentials.set(
      credentialRef('BUDDY_ACCOUNT_E1'),
      '{"access_token":"a","refresh_token":"r","user_id":"uid-existing"}',
    )
    const pool = createPool({
      accounts: [account({ id: 'buddy-existing', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_E1' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: {
        BUDDY_ACCOUNT_N1: '{"access_token":"b","refresh_token":"r2","user_id":"uid-brand-new"}',
      },
      accounts: [account({ id: 'buddy-new', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_N1' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(1)
    expect(result.accountsSkipped).toEqual([])
  })

  it('不同 provider 的同名 user_id 不算同一账号（provider 计入身份键）', async () => {
    const credentials = createCredentials()
    await credentials.set(
      credentialRef('BUDDY_ACCOUNT_E1'),
      '{"access_token":"a","refresh_token":"r","user_id":"shared-uid"}',
    )
    const pool = createPool({
      accounts: [account({ id: 'buddy-e1', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_E1' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: {
        WORKBUDDY_ACCOUNT_W1: '{"access_token":"b","refresh_token":"r2","user_id":"shared-uid"}',
      },
      accounts: [account({ id: 'workbuddy-w1', provider: 'workbuddy', credentialRef: 'WORKBUDDY_ACCOUNT_W1' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(1)
  })

  it('凭据里没有身份字段时退回纯 id 判重（不误判为重复）', async () => {
    const credentials = createCredentials()
    const pool = createPool({
      accounts: [account({ id: 'buddy-existing', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_E1' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: { BUDDY_ACCOUNT_N1: '{"access_token":"b","refresh_token":"r2"}' },
      accounts: [account({ id: 'buddy-new', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_N1' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(1)
  })

  it('cline 的 account_id 参与身份判重（只认 user_id/uid 会漏掉一半 provider）', async () => {
    const credentials = createCredentials()
    await credentials.set(
      credentialRef('CLINE_ACCOUNT_E1'),
      '{"access_token":"a","refresh_token":"r","account_id":"usr-01M3BCV4FYCGJKAWD3MJG3DBQM"}',
    )
    const pool = createPool({
      accounts: [account({ id: 'cline-existing', provider: 'cline', credentialRef: 'CLINE_ACCOUNT_E1' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: {
        CLINE_ACCOUNT_N1: '{"access_token":"b","refresh_token":"r2","account_id":"usr-01M3BCV4FYCGJKAWD3MJG3DBQM"}',
      },
      accounts: [account({ id: 'cline-new', provider: 'cline', credentialRef: 'CLINE_ACCOUNT_N1' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(0)
    expect(result.accountsSkipped).toEqual(['cline-new'])
  })

  it('loomy 的 userid 参与身份判重（字段名既不是 user_id 也不是 uid）', async () => {
    const credentials = createCredentials()
    await credentials.set(
      credentialRef('LOOMY_ACCOUNT_E1'),
      '{"access_token":"a","userid":"123456789012345678","phone":"13000000000"}',
    )
    const pool = createPool({
      accounts: [account({ id: 'loomy-existing', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_E1' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: {
        LOOMY_ACCOUNT_N1: '{"access_token":"b","userid":"123456789012345678","phone":"13000000000"}',
      },
      accounts: [account({ id: 'loomy-new', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_N1' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(0)
    expect(result.accountsSkipped).toEqual(['loomy-new'])
  })

  it('gemini 的 OIDC sub 参与身份判重（该 provider 凭据里没有 user_id/uid/account_id）', async () => {
    const credentials = createCredentials()
    await credentials.set(
      credentialRef('GEMINI_ACCOUNT_E1'),
      '{"access_token":"a","refresh_token":"r","sub":"105005201234567890123","email":"a@example.com"}',
    )
    const pool = createPool({
      accounts: [account({ id: 'gemini-existing', provider: 'gemini', credentialRef: 'GEMINI_ACCOUNT_E1' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: {
        // 令牌与邮箱都不同，只有 sub 相同 —— 必须是同一个账号。
        GEMINI_ACCOUNT_N1: '{"access_token":"b","refresh_token":"r2","sub":"105005201234567890123","email":"b@example.com"}',
      },
      accounts: [account({ id: 'gemini-new', provider: 'gemini', credentialRef: 'GEMINI_ACCOUNT_N1' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(0)
    expect(result.accountsSkipped).toEqual(['gemini-new'])
  })

  it('gemini 的 email 不得当身份（改邮箱后会被判成新账号）', async () => {
    // 与「轮换令牌不得当身份」同型：email 会随用户改邮箱而变，拿它判重会让
    // 同一个账号在改邮箱后多出一条重复账号。凭据里只给 email、不给 sub，
    // 用于证明身份**不是**从 email 得来的。
    const credentials = createCredentials()
    await credentials.set(
      credentialRef('GEMINI_ACCOUNT_E2'),
      '{"access_token":"a","refresh_token":"r","email":"same@example.com"}',
    )
    const pool = createPool({
      accounts: [account({ id: 'gemini-existing-2', provider: 'gemini', credentialRef: 'GEMINI_ACCOUNT_E2' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: {
        GEMINI_ACCOUNT_N2: '{"access_token":"b","refresh_token":"r2","email":"same@example.com"}',
      },
      accounts: [account({ id: 'gemini-new-2', provider: 'gemini', credentialRef: 'GEMINI_ACCOUNT_N2' })],
    }), { mode: 'merge' })

    // email 相同但判不出身份 ⇒ 按 id 追加（不是被误判成同一账号）。
    expect(result.accountsImported).toBe(1)
    expect(result.accountsSkipped).toEqual([])
  })

  it('opencode 账号槽按 api_key 判重（该 provider 的凭据只有 api_key）', async () => {
    const credentials = createCredentials()
    await credentials.set(
      credentialRef('OPENCODE_ACCOUNT_E1'),
      '{"api_key":"sk-zen-existing","nickname":"账号"}',
    )
    const pool = createPool({
      accounts: [account({ id: 'opencode-existing', provider: 'opencode', credentialRef: 'OPENCODE_ACCOUNT_E1' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: {
        OPENCODE_ACCOUNT_N1: '{"api_key":"sk-zen-existing","nickname":"账号"}',
      },
      accounts: [account({ id: 'opencode-new', provider: 'opencode', credentialRef: 'OPENCODE_ACCOUNT_N1' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(0)
    expect(result.accountsSkipped).toEqual(['opencode-new'])
  })

  it('opencode 匿名槽（api_key=public）不产生身份：多条匿名通道必须能共存', async () => {
    // 匿名槽的 api_key 恒为字面量 `public`（上游 OPENCODE.anonymousKey）。若拿它
    // 当身份，第二条匿名通道会被判成「已存在」而拒绝导入 —— 而「多条匿名通道各走
    // 各的出口」正是上游明确提供的能力，故这里必须退回纯 id 判重。
    const credentials = createCredentials()
    await credentials.set(
      credentialRef('OPENCODE_ANON_E1'),
      '{"api_key":"public","nickname":"匿名通道"}',
    )
    const pool = createPool({
      accounts: [account({ id: 'opencode-anon-e1', provider: 'opencode', credentialRef: 'OPENCODE_ANON_E1' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: {
        OPENCODE_ANON_N1: '{"api_key":"public","nickname":"匿名通道"}',
      },
      accounts: [account({ id: 'opencode-anon-n1', provider: 'opencode', credentialRef: 'OPENCODE_ANON_N1' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(1)
    expect(result.accountsSkipped).toEqual([])
    expect(pool.merged[0].map(a => a.id)).toEqual(['opencode-anon-n1'])
  })

  it('轮换令牌（access_token / refresh_token）不得当身份 —— 续期后会被判成新账号', async () => {
    const credentials = createCredentials()
    await credentials.set(
      credentialRef('BUDDY_ACCOUNT_E1'),
      '{"access_token":"token-a","refresh_token":"refresh-a"}',
    )
    const pool = createPool({
      accounts: [account({ id: 'buddy-existing', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_E1' })],
      disabledModels: {},
    })

    // 令牌一字不差地相同，但凭据里没有任何身份字段 ⇒ 判不出身份，按 id 追加。
    const result = await importBackup(credentials, pool, payloadOf({
      credentials: {
        BUDDY_ACCOUNT_N1: '{"access_token":"token-a","refresh_token":"refresh-a"}',
      },
      accounts: [account({ id: 'buddy-new', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_N1' })],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(1)
  })

  it('replace 模式不做身份判重（整体替换本就该照单全收）', async () => {
    const credentials = createCredentials()
    await credentials.set(
      credentialRef('BUDDY_ACCOUNT_E1'),
      '{"access_token":"a","refresh_token":"r","user_id":"same-uid"}',
    )
    const pool = createPool({
      accounts: [account({ id: 'buddy-existing', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_E1' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      credentials: {
        BUDDY_ACCOUNT_N1: '{"access_token":"b","refresh_token":"r2","user_id":"same-uid"}',
      },
      accounts: [account({ id: 'buddy-new', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_N1' })],
    }))

    expect(result.accountsImported).toBe(1)
    expect(pool.replaced!.accounts.map(a => a.id)).toEqual(['buddy-new'])
  })

  it('merge 的统计口径只算真正落地的账号（跳过的不算过期/缺失）', async () => {
    const credentials = createCredentials()
    const pool = createPool({
      accounts: [account({ id: 'buddy-dup', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_D1' })],
      disabledModels: {},
    })

    const result = await importBackup(credentials, pool, payloadOf({
      accounts: [
        // 已存在 → 会被跳过。它没有凭据、且已过期，但**不该**进统计
        account({ id: 'buddy-dup', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_MISSING', expiresAt: 1 }),
        // 真正新增，且已过期
        account({ id: 'buddy-new', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_MISSING', expiresAt: 1 }),
      ],
    }), { mode: 'merge' })

    expect(result.accountsImported).toBe(1)
    // 只有被采纳的那一条计入；把跳过的那条也算进来会让提示虚高。
    expect(result.expiredAccounts).toBe(1)
    expect(result.missingCredentials).toBe(1)
  })
})
