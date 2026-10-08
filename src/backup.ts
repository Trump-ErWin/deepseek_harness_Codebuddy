import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { sanitizeAccounts, sanitizePermanentLocks } from './jet-hub-store.js'
import type { JetHubState, ModelDisableMap, PermanentLockMap } from './jet-hub-store.js'
import { OPENCODE } from './opencode-product.js'
import type { ProviderAccountEntry } from './types.js'
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupImportMode, type BackupPayload } from './types.js'

/**
 * 备份操作所需的账号池最小接口。
 *
 * 只声明实际用到的方法（结构化类型），使本模块可脱离 Cordis 上下文单测；
 * 真实的 {@link AccountPool} 结构上即满足此接口。
 */
export interface BackupPool {
  /** 读取完整状态快照（账号列表 + 模型黑名单 + Loomy 镜像字段）。 */
  getStateSnapshot(): JetHubState
  /**
   * 读取「锁定永久积分」表（权威值）。
   *
   * ⚠️ 它**不在**状态快照里：那份文档是同机多 profile 共享的，旧版本代码
   * 全量重写时不会携带自己不认识的键，所以锁定表住在独立文档
   * （`$DSH_HOME/jet-hub/permanent-locks.json`），备份时单独取。
   */
  permanentLocksSnapshot(): PermanentLockMap
  /** 整体替换账号列表、模型黑名单与各 provider 的永久积分锁定表。 */
  replaceAll(
    accounts: readonly ProviderAccountEntry[],
    disabledModels: ModelDisableMap,
    permanentLocks?: PermanentLockMap,
  ): Promise<void>
  /**
   * **只追加**账号（合并导入用）：已有的账号一律不动，返回实际新增的 id。
   *
   * ⚠️ 与 {@link replaceAll} 的语义差别是本质的：合并导入**绝不**删除或覆盖
   * 任何现有账号，也不碰模型黑名单与锁定表 —— 用户从别人的备份里挑一个账号
   * 加进来的场景下，任何"顺手覆盖"都是数据损失。
   */
  mergeAccounts(accounts: readonly ProviderAccountEntry[]): Promise<string[]>
}

/** 备份操作所需的凭据服务最小接口（`ctx.credentials` 结构上满足）。 */
export interface BackupCredentials {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  set(ref: CredentialRef, value: string): Promise<void>
}

/**
 * 导出结果。
 *
 * `accountIds` 为空数组时与未传等价：导出全部账号。
 */
export interface BackupExportOptions {
  /**
   * 只导出这些账号 id（**单账号 / 多选导出**用）。
   *
   * ⚠️ 与「导出全部」的差别刻意收窄到**只影响 accounts 与 credentials 两个
   * 字段**：模型黑名单与永久积分锁定表仍按**全量**写出。理由是这样导出的文件
   * 仍是一份**自包含的完整快照**（可以当普通全量备份做整体还原），而
   * 「只挑一个账号合并导入」由导入侧的 `mode: 'merge'` 负责 —— 让过滤只承担
   * 一种语义，两条路径就不会互相污染。
   */
  accountIds?: readonly string[]
}

/** 导出结果。 */
export interface BackupExportResult {
  payload: BackupPayload
  /** 未能读取凭据的账号 id（凭据缺失/损坏，不中断导出）。 */
  warnings: string[]
}

/** 导入结果。 */
export interface BackupImportResult {
  /** 写入的凭据条数。 */
  credentialsImported: number
  /** 写入的账号数（合并模式下 = **实际新增**的账号数）。 */
  accountsImported: number
  /**
   * 合并模式下**跳过**的账号 id：该 id 在当前池里已存在（按 id 判重）。
   *
   * ⚠️ 只在 `mode: 'merge'` 时有意义；`replace` 模式恒为空数组
   * （整体替换没有「跳过」这个概念）。
   */
  accountsSkipped: string[]
  /** 跳过的凭据 ref（非法 ref、值非字符串等）。 */
  skipped: string[]
  /**
   * 导入的账号中「凭据已过期」的条数（账号条目 `expiresAt <= 当前时刻`）。
   * 供前端提示：过期凭据若 refresh_token 仍有效会在请求时静默续期；
   * 若 refresh_token 也已失效则需重新登录。
   */
  expiredAccounts: number
  /**
   * 导入的账号中「凭据缺失」的条数：账号条目的 credentialRef 不在备份的
   * credentials 字典里。这类账号导入后无凭据，对应 provider 目录会被门控
   * 隐藏（像未登录一样），供前端提示重新登录。
   */
  missingCredentials: number
}

/** 备份文件格式校验失败。 */
export class BackupFormatError extends Error {}

/** 导入选项。 */
export interface BackupImportOptions {
  /**
   * 导入模式，缺省 `replace`（整体替换，保持既有行为）。
   *
   * `merge` = 只追加、按 id 跳过已存在的账号，不碰黑名单与锁定表。
   */
  mode?: BackupImportMode
}

/**
 * 账号身份字段候选表 —— 逐 provider 通读凭据形状后定下的**并集**。
 *
 * | 字段 | 写在哪些 provider 的凭据里 | 出处 |
 * |---|---|---|
 * | `user_id` | `buddy` / `workbuddy` / `lobsterai` / `raccoon` / `zcode` | 各自的登录/续期写入点 |
 * | `uid` | `qoder` / `qodercn` / `trae` | 同上 |
 * | `userid` | `loomy`（讯飞用户 id，18 位数字串） | `LoomyCredential.userid` |
 * | `account_id` | `cline`（`usr-…`）/ `minimax` | 两个 `*Credential` 接口 |
 * | `sub` | `gemini`（OIDC `sub`，21 位数字串） | `GeminiCredential.sub` |
 *
 * ⚠️ **只收「一账号一值」的稳定标识**：`access_token` / `refresh_token` 会轮换，
 * 拿它们判重会让同一个账号在续期后被判成新账号（凭据泄漏面也会变大）。
 * ⚠️ `expires_at` / `nickname` 之类更是与身份无关，不要顺手加。
 *
 * ⚠️ **gemini 只收 `sub`、不收 `email`**（两者都在 `GeminiCredential` 里）：
 * `sub` 是 OIDC 的稳定主体标识（换邮箱、改昵称都不变），上游就是拿它当账号 id
 * 用的（`gemini-auth.ts` 的 `persistLogin` 返回 `{ accountId: credential.sub }`）；
 * 而 `email` 会随用户改邮箱而变 —— 拿它当身份会让**同一个账号在改邮箱后被判成
 * 新账号**，与「轮换令牌不得当身份」是同一类错误。
 * ⚠️ **`sub` 在本仓库只有 gemini 写在凭据顶层**（minimax 那个 `sub` 是从 JWT 里
 * 解出来的，不落顶层字段），故它不会让别的 provider 误命中。
 *
 * ## 为什么必须覆盖到每个 provider（而不是只认 `user_id` / `uid`）
 *
 * 判不出身份时判重会**静默退化成纯 `id` 比对**，而 `id` 由 `shortId()` 随机生成、
 * 第三方转换器给的又是确定性哈希 —— 同一个账号因此有两套 id。漏掉一个 provider
 * 的字段，就等于那个 provider 的「同一个号我已手登过」场景**必然**多出一条重复账号。
 *
 * ⚠️ **绝不基于它做安全判定**，它只是判重键。
 */
const IDENTITY_FIELDS = ['user_id', 'uid', 'userid', 'account_id', 'sub'] as const

/**
 * 从凭据 JSON 原文里取出**账号身份**，取不到返回 undefined。
 *
 * 用途是合并导入的第二层判重（见 {@link importBackup}）：`id` 由插件随机生成，
 * 跨来源不可靠，而身份字段是账号在服务端的真实标识（候选表见
 * {@link IDENTITY_FIELDS}）。
 *
 * ⚠️ **`opencode` 必须单独处理**（见下），它没有上表里任何一个字段。
 */
function identityKey(provider: string, rawCredential: unknown): string | undefined {
  if (typeof rawCredential !== 'string' || rawCredential.length === 0) return undefined
  try {
    const parsed = JSON.parse(rawCredential) as Record<string, unknown>
    for (const key of IDENTITY_FIELDS) {
      const value = parsed[key]
      if (typeof value === 'string' && value.length > 0) return `${provider}:${value}`
    }
    // opencode 的凭据只有 `api_key`（`{api_key, nickname}`），没有上表里的任何字段，
    // 故单独认它，并单独加 `key:` 命名空间以免与上面那类值撞键。
    //
    // ⚠️ **匿名槽必须排除**：匿名通道的 api_key 恒为 `OPENCODE.anonymousKey`
    // （字面量 `public`，见 `src/opencode-auth.ts` 的 `listIdentitySlots` 注释）——
    // 全部匿名槽共用同一个值，拿它当身份会把「用户刻意加的多条匿名通道」判成
    // 同一账号而**拒绝导入**（上游明确把「多条匿名槽各走各的出口」当能力提供）。
    // 排除后匿名槽退回纯 `id` 判重 —— 它们本就无法互相区分，这是唯一正确口径。
    if (provider === OPENCODE.id) {
      const apiKey = parsed.api_key
      if (
        typeof apiKey === 'string'
        && apiKey.length > 0
        && apiKey !== OPENCODE.anonymousKey
      ) {
        return `${provider}:key:${apiKey}`
      }
    }
  } catch {
    // 凭据坏掉的条目由后面的写入环节记 skipped，这里只需判不出身份。
  }
  return undefined
}

/**
 * 收集当前账号池里全部账号的身份（`provider:user_id`）。
 *
 * 逐条 `resolve` 凭据 —— 代价是池里账号数次的存储读取，只在合并导入时发生一次。
 * 凭据缺失/损坏的账号直接跳过：它们本就判不出身份，不该因此让导入失败。
 */
async function collectAccountIdentities(
  accounts: readonly ProviderAccountEntry[],
  credentials: BackupCredentials,
): Promise<Set<string>> {
  const identities = new Set<string>()
  for (const entry of accounts) {
    try {
      const resolved = await credentials.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) continue
      const key = identityKey(entry.provider, resolved.value)
      if (key !== undefined) identities.add(key)
    } catch {
      // 单条读不到不影响其余账号的判重。
    }
  }
  return identities
}

/**
 * 导出账号 + 凭据 + 模型黑名单。
 *
 * 逐账号读取凭据；单个账号凭据缺失/损坏只记入 {@link BackupExportResult.warnings}，
 * 不中断整体导出 —— 换版本迁移场景下宁可先导出能导出的，也不要让一个坏账号
 * 挡住整份备份。
 *
 * `options.accountIds` 给出时只打包这些账号（及其凭据），用于「单独导出某个
 * 账号」；模型黑名单与锁定表**仍是全量**（见 {@link BackupExportOptions}）。
 */
export async function exportBackup(
  pool: BackupPool,
  credentials: BackupCredentials,
  options: BackupExportOptions = {},
): Promise<BackupExportResult> {
  const state = pool.getStateSnapshot()
  const warnings: string[] = []
  // 不传 / 传空数组 = 导出全部（空数组按「没指定」处理，避免静默导出 0 个账号
  // 这种「文件看着成功、其实空的」的诱导性缺陷）。
  const selected = options.accountIds !== undefined && options.accountIds.length > 0
    ? new Set(options.accountIds)
    : undefined
  const accounts = selected === undefined
    ? state.accounts
    : state.accounts.filter((entry) => selected.has(entry.id))
  if (selected !== undefined) {
    // 请求了但池里不存在的 id 要显式告知：否则用户会拿到一个少了账号的
    // 文件却以为导出成功（账号可能刚被删除或 id 拼错）。
    const found = new Set(accounts.map((entry) => entry.id))
    for (const id of selected) {
      if (!found.has(id)) warnings.push(`${id}: 账号不存在（已跳过）`)
    }
  }
  const exported: Record<string, string> = {}
  for (const entry of accounts) {
    try {
      const resolved = await credentials.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        warnings.push(`${entry.id}: 凭据未配置`)
      } else {
        exported[entry.credentialRef] = resolved.value
      }
    } catch (error) {
      warnings.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // 锁定表从独立文档取（状态快照里没有它）。
  const locks = sanitizePermanentLocks(pool.permanentLocksSnapshot())
  return {
    payload: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      credentials: exported,
      accounts,
      disabledModels: state.disabledModels,
      // 权威表 + Loomy 兼容字段**同源**（老版本只读后者，缺了会看到
      // 「锁定悄悄失效」，而失效的后果是真把永久积分烧掉了）。
      permanentLocks: locks,
      loomyPermanentLocked: locks.loomy === true,
    },
    warnings,
  }
}

/**
 * 校验备份载荷的格式与版本；不合法时抛 {@link BackupFormatError}。
 *
 * 校验在前、写入在后：凭据与账号池都不可被错误格式的备份文件覆盖。
 */
export function assertBackupPayload(value: unknown): asserts value is BackupPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BackupFormatError('备份内容不是对象')
  }
  const record = value as Record<string, unknown>
  if (record.format !== BACKUP_FORMAT) {
    throw new BackupFormatError(`不是 ${BACKUP_FORMAT} 备份文件（format=${String(record.format)}）`)
  }
  if (record.version !== BACKUP_VERSION) {
    throw new BackupFormatError(`不支持的备份版本：${String(record.version)}（当前支持 v${BACKUP_VERSION}）`)
  }
  if (typeof record.exportedAt !== 'string') {
    throw new BackupFormatError('备份缺少 exportedAt 字段')
  }
  if (typeof record.credentials !== 'object' || record.credentials === null || Array.isArray(record.credentials)) {
    throw new BackupFormatError('备份 credentials 字段无效')
  }
  if (!Array.isArray(record.accounts)) {
    throw new BackupFormatError('备份 accounts 字段无效')
  }
  if (typeof record.disabledModels !== 'object' || record.disabledModels === null || Array.isArray(record.disabledModels)) {
    throw new BackupFormatError('备份 disabledModels 字段无效')
  }
  // 可选字段：存在时必须是对象（老备份没有它）。数组要单独判 ——
  // `typeof [] === 'object'`，只判 object 会放过一份形状错误的锁定表。
  if (record.permanentLocks !== undefined
    && (typeof record.permanentLocks !== 'object' || Array.isArray(record.permanentLocks))) {
    throw new BackupFormatError('备份 permanentLocks 字段无效')
  }
}

/**
 * 从备份载荷里取出锁定表，并兼容**只有老字段**的备份。
 *
 * 三种情形必须区分清楚（判错会让用户「以为锁着、其实没锁」）：
 *
 * | 备份来源 | 返回 | 效果 |
 * |---|---|---|
 * | 有 `permanentLocks`（新版导出） | 该表（已过滤脏值） | 整体替换当前锁定状态 |
 * | 只有 `loomyPermanentLocked`（老版导出） | `{ loomy: true }` 或 `{}` | 恢复 Loomy 那一项；buddy 无从得知 → 空 |
 * | 两个都没有（更早的备份） | `undefined` | **保持当前值**，不误解锁 |
 *
 * ⚠️ 老字段为 `false` 时**也**返回 `{}`（而不是 `undefined`）：既然这份备份
 * 明确表达了「Loomy 未锁定」，导入后就该解锁 —— 与「无从得知」不同。
 */
function locksFromPayload(payload: BackupPayload): PermanentLockMap | undefined {
  if (payload.permanentLocks !== undefined) {
    const locks = sanitizePermanentLocks(payload.permanentLocks)
    // 老字段是唯一权威时也要并进表：存在一份「只写了 loomyPermanentLocked
    // 却漏了表」的历史导出（本次改动上线前的版本），不能因为表为空就丢掉它。
    if (locks.loomy === undefined && payload.loomyPermanentLocked === true) locks.loomy = true
    return locks
  }
  if (typeof payload.loomyPermanentLocked === 'boolean') {
    return payload.loomyPermanentLocked ? { loomy: true } : {}
  }
  return undefined
}

/**
 * 导入备份。
 *
 * ## 两种模式（`options.mode`）
 *
 * | 模式 | 语义 | 用于 |
 * |---|---|---|
 * | `replace`（默认） | **整体替换**账号池与模型黑名单，还原快照 | 「恢复」按钮，换 DSH 版本后整体迁移 |
 * | `merge` | **只追加**：按 id 判重，已存在的账号一律跳过；**不碰**模型黑名单与锁定表 | 「单独导入一个账号」，从别人的备份里挑账号加进来 |
 *
 * ## 与写入顺序有关的约定
 *
 * - **先写凭据、后写账号池**：账号池写入成功后门控（`hasLoggedInAccount`）
 *   与黑名单立即反映新状态；凭据写入中途失败（非法 ref 等）只跳过该条、
 *   不中断整体。
 * - ⚠️ **`merge` 模式只写「确实要新增的账号」所引用的凭据**。它绝不回写
 *   备份里其余凭据（含各 provider 的默认单凭据 ref）—— 那些 ref 可能已被
 *   当前机器上的账号使用，回写等于**覆盖现有账号的凭据**，与「只增加」矛盾。
 * - 非法/值类型错误的凭据 ref 会被跳过并记录 —— `credentialRef()` 对非法
 *   POSIX 标识符抛错，`set` 也可能因存储后端拒绝而失败，都不应中断整体导入。
 * - 账号条目由 `replaceAll` / `mergeAccounts` 内部归一化（丢弃坏条目），
 *   保证坏数据不会进池。
 */
export async function importBackup(
  credentials: BackupCredentials,
  pool: BackupPool,
  raw: unknown,
  options: BackupImportOptions = {},
): Promise<BackupImportResult> {
  assertBackupPayload(raw)
  const payload = raw
  const mode: BackupImportMode = options.mode ?? 'replace'

  // 决定「本次真正要落地的账号」与「跳过的账号」。
  // merge 的三层判重：① 池里已有的 **id**；② 池里已有的**身份**（凭据里的
  // `user_id` / `uid` / `userid` / `account_id`，opencode 另有 `api_key`，
  // 见 {@link IDENTITY_FIELDS}）；③ 备份文件内部重复的 id（同一份文件手工
  // 编辑后可能出现两条同 id，只应新增一次，否则池里出现重复条目）。
  let importedAccounts: readonly ProviderAccountEntry[] = payload.accounts
  const accountsSkipped: string[] = []
  if (mode === 'merge') {
    const state = pool.getStateSnapshot()
    const existingIds = new Set(state.accounts.map((entry) => entry.id))
    // ⚠️ **仅按 id 判重是不够的**：插件自己登录时 `id` 由 `shortId()` **随机**
    // 生成（`buddy-a1b2c3d4`），而第三方转换来的 id 是**确定性哈希**。同一个人
    // 因此有两套 id，只比 id 会把他重复加进池里 —— 用户在「从别人的备份里挑
    // 账号」时，最常见的情形恰恰是「这个号我已经手登过了」。
    // 故再按凭据里的身份字段判重（它才是账号的真实身份）。
    const existingIdentities = await collectAccountIdentities(state.accounts, credentials)
    const accepted: ProviderAccountEntry[] = []
    for (const entry of sanitizeAccounts(payload.accounts)) {
      if (existingIds.has(entry.id)) {
        accountsSkipped.push(entry.id)
        continue
      }
      const identity = identityKey(entry.provider, payload.credentials[entry.credentialRef])
      if (identity !== undefined && existingIdentities.has(identity)) {
        accountsSkipped.push(entry.id)
        continue
      }
      existingIds.add(entry.id)
      if (identity !== undefined) existingIdentities.add(identity)
      accepted.push(entry)
    }
    importedAccounts = accepted
  }

  // merge 下只写被采纳账号的凭据；replace 下按字典逐条写（备份文件里可能含
  // 账号池之外的独立凭据 ref，如各 provider 的默认单凭据 ref，导出时一并纳入，
  // 导入时同样还原）。
  const credentialsToWrite: Record<string, unknown> = mode === 'merge'
    ? Object.fromEntries(
        importedAccounts
          .map((entry) => [entry.credentialRef, payload.credentials[entry.credentialRef]] as const)
          .filter((pair) => pair[1] !== undefined),
      )
    : payload.credentials

  const skipped: string[] = []
  let credentialsImported = 0
  for (const [refName, value] of Object.entries(credentialsToWrite)) {
    if (typeof value !== 'string') {
      skipped.push(refName)
      continue
    }
    try {
      await credentials.set(credentialRef(refName), value)
      credentialsImported++
    } catch (error) {
      skipped.push(refName)
    }
  }

  if (mode === 'merge') {
    // 只追加：不传黑名单与锁定表，池会保持当前值。
    await pool.mergeAccounts(importedAccounts)
  } else {
    await pool.replaceAll(payload.accounts, payload.disabledModels, locksFromPayload(payload))
  }

  // 统计已过期账号：expiresAt 是毫秒时间戳，缺失或 NaN 视为「未知」不算过期。
  // ⚠️ 只统计**真正落地**的账号：merge 下把被跳过的账号也算进来会让提示虚高，
  // 而它们的凭据根本没被写。
  const now = Date.now()
  const expiredAccounts = importedAccounts.filter((entry) =>
    typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) && entry.expiresAt <= now,
  ).length
  // 统计凭据缺失账号：账号条目存在但其 credentialRef 不在 credentials 字典。
  // 注意导入时被 skipped 的 ref 也算「缺失」——它们确实没写进凭据存储。
  const skippedSet = new Set(skipped)
  const missingCredentials = importedAccounts.filter((entry) =>
    !Object.prototype.hasOwnProperty.call(payload.credentials, entry.credentialRef)
    || skippedSet.has(entry.credentialRef),
  ).length
  return {
    credentialsImported,
    // replace 保留既有口径（备份里的条目数，含非法条目），避免改变既有行为；
    // merge 报**实际新增**数，因为这才是用户关心的「加了几个」。
    accountsImported: mode === 'merge' ? importedAccounts.length : payload.accounts.length,
    accountsSkipped,
    skipped,
    expiredAccounts,
    missingCredentials,
  }
}
