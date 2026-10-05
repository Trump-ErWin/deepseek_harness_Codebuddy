/**
 * 「已失效模型」的**运行时实证**记录与剔除。
 *
 * ## 解决什么（真实报障，2026-10-05）
 *
 * 用户在 Jet Hub 选中 cline 的 `cline-free/deepseek-v4.1-flash`，每轮都失败：
 *
 * ```
 * cline: model not found HTTP_404
 * ```
 *
 * 账号、余额、网络都正常。该模型**已被 Cline 从 `free` 数组移除**，但模型列表里
 * 仍然显示它、并且仍然标着「免费」—— 用户拿到的是一个看着可用、一点就 404 的条目。
 *
 * 根因是各 provider 的**兜底模型表**（`product.fallbackModels` 等）是**编译期快照**，
 * 上游下架模型时它不会自己跟着变。
 *
 * ## ⚠️ 为什么不能用「远端目录里没有 ⇒ 已下架」来剔除
 *
 * 那个判据只在**远端完整权威**的 provider 上成立。本仓库的实际情况分三类：
 *
 * | Provider | 远端目录 | 目录比对是否可用 |
 * |---|---|---|
 * | cline | `recommended-models` 的 `free` 数组完整权威 | ✅ 可用（已在 `cline-models.ts` 修） |
 * | buddy / codebuddy / workbuddy | **已知残缺** | ❌ **会删掉可用模型** |
 * | qoder / qoder-cn | 无（端点需 WASM 签名） | ❌ 无数据可比对 |
 *
 * buddy 那一类是刻意反过来设计的：`reconcileWithFallback` **以兜底表为准**，
 * 因为插件 CLI token 只拿到 13 个内部别名、而 IDE 是 20 个（见 `buddy-adapter.ts`）。
 * 在那里做目录比对会把「你有权用、只是 CLI token 看不到」的模型删掉 ——
 * 作者已为此踩过一次（`product.ts` 里 `hy4-preview` 的补录注释）。
 *
 * ⇒ 唯一**跨 provider 安全**的判据是**阳性证据**：这个模型**真的**请求失败并返回
 * 「模型不存在」时，才把它记为失效。**不从残缺目录反推。**
 *
 * ## 行为
 *
 * 1. **记录**：适配器的 `stream()` 抛出的错误被判定为「模型已失效」时，
 *    按 `provider + modelId` 落盘到 `$DSH_HOME/jet-hub/dead-models.json`。
 * 2. **剔除**：此后该 provider 的 `listModels()` / `listAllModels()` 不再播报它。
 * 3. **过期**：记录带 TTL（默认 30 天）。上游若把模型重新上架，最多 30 天后自动
 *    回到列表 —— 因为已被剔除的模型用户**选不到**，不可能靠「再成功一次」自愈，
 *    只能靠过期回收。TTL 可用 `DSH_DEAD_MODEL_TTL_DAYS` 覆盖（0 = 永不过期）。
 *
 * ## 判据为什么必须保守
 *
 * 误判（把可用模型记成失效）会把一个好模型从列表里藏起来，且**用户无法自行恢复**
 * （见上：选不到 ⇒ 不可能再成功 ⇒ 记录不会清）。故：
 *
 * - 只认明确的「模型不存在」文案；
 * - 出现限流 / 额度 / 认证类关键词时**一律不记**（那些是账号问题，不是模型问题）；
 * - 错误码为 AUTH / QUOTA_EXCEEDED / RATE_LIMIT / MISSING_CREDENTIAL /
 *   PERMISSION_DENIED 时一律不记。
 *
 * ## 为什么落独立文档，而不是并进 `state.json`
 *
 * 同 `permanent-lock-store.ts` 记录的那类风险：`state.json` 是 **dsh home 级、
 * 全局共享**的（同机多个 profile 共用一份），而本插件的存储是**整体替换**语义 ——
 * 旧版本代码整体重写时会静默抹掉它不认识的字段。独立文档则无人争抢。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveJetHubHome } from './jet-hub-store.js'

/** 独立文档的文件名（与 state.json 同目录）。 */
export const DEAD_MODELS_FILE = 'dead-models.json'

/** 文档 schema 标记（与本仓库其它状态文档同惯例）。 */
const SCHEMA = 'dsh-codearts-auth/dead-models/v1'

/** 默认保留天数；可用 `DSH_DEAD_MODEL_TTL_DAYS` 覆盖（0 = 永不过期）。 */
const DEFAULT_TTL_DAYS = 30

/** 单条记录：何时、因何判为失效。 */
interface DeadModelRecord {
  /** ISO 时间戳。 */
  at: string
  /** 判据命中的错误文案（排查用）。 */
  reason?: string
}

/** `provider → modelId → 记录`。 */
type DeadModelRecords = Record<string, Record<string, DeadModelRecord>>

/**
 * 「模型已失效」的文案判据。
 *
 * ⚠️ 全部要求「model」与「不存在」语义**同现**，不接受泛词：
 * `unsupported` / `invalid` 单独出现**不算**（可能是参数错而非模型下架）。
 *
 * ## ⚠️⚠️ 窗口字符类**不能排除点号**（真实缺陷，2026-10-06 复审 !66 实测）
 *
 * 初版四条英文正则都用 `[^.!?]{0,N}` 做窗口，而**本仓库几乎所有模型 id 都带
 * 小数点**（`deepseek-v4.1-flash` / `gpt-5.6-astra` / `muse-spark-1.3-contributor`）
 * —— 点号直接截断窗口，导致**英文路径对带点 id 全部漏判**：
 *
 * ```
 * model deepseek-v4.1-flash 不存在        → 初版 false（应为 true）
 * The model gpt-5.6-astra does not exist   → 初版 false（应为 true）
 * model deepseekv41flash does not exist    → 初版 true （无点才命中）
 * ```
 *
 * ⇒ 现在英文窗口只排除**句子终止符**（`!?` 与换行），**保留点号**。
 * 窗口也从 24/16 放宽到 64：初版英文窗口的**实测有效上限只有 17 字符**
 * （18 即漏判），而本仓库最长模型 id `cline-free/muse-spark-1.3-contributor`
 * 有 **37 字符**（`cline-product.ts`）。
 *
 * ## ⚠️ `not supported` / `not available` **不是**下架证据（同一轮复审实测）
 *
 * 初版把 `available` / `supported` 与 `found`/`exist` 并列，于是这 6 条
 * **换套餐 / 换地域 / 换端点就能恢复**的文案被误判成「模型已下架」：
 *
 * ```
 * cline: model not supported in this plan      → 初版 true ★误判
 * model not available in your region           → 初版 true ★误判
 * the selected model is not available for reasoning → 初版 true ★误判
 * ```
 *
 * 误判代价极高（被藏 30 天且用户无法自愈），故**只认 `found` / `exist`** ——
 * 这与本文件头「`unsupported` 单独出现不算」的既有口径一致。
 */
const GONE_PATTERNS: readonly RegExp[] = [
  /model\s+not\s+found/i,
  // ⚠️ 窗口只排除 `!?` 与换行：**点号必须留在窗口内**（模型 id 普遍带小数点）。
  /model\b[^!?\n]{0,64}?\bnot\s+(?:found|exist)/i,
  /(?:unknown|no\s+such|nonexistent)\s+model/i,
  /model[^!?\n]{0,64}?(?:does\s*not|doesn'?t)\s+exist/i,
  // ⚠️ OpenAI 标准的 `model_not_found` / `model-not-found` 形态。
  // 安全性依据：它必然是**模型**主语 + **不存在**语义，不会误伤能力/套餐类文案。
  /\bmodel[_\-]not[_\-]found\b/i,
  // ⚠️ 窗口要够宽：`模型 deepseek-v4.1-flash-x 不存在` 里，「模型」与「不存在」
  // 之间隔着一整个 id（实测 12+ 字符）。同理中文 id 也可能含英文标点，
  // 故这里只排除中文句读与换行，**保留 `.`。
  // ⚠️ **不收 `不可用`**：账号/额度类报错也这么说（「所有账号均不可用」），
  // 收它会把账号问题误记成模型下架。同理不收 `不支持` / `不支持的工具`。
  /模型[^，。！？!?\n]{0,64}(?:不存在|未找到|未上线|已下线|已下架)/,
  /model[^!?\n]{0,64}(?:不存在|未找到|已下线|已下架)/,
]

/**
 * 「与模型无关」的排除词：命中则**不记**。
 *
 * 限流 / 额度 / 认证失败都可能带 `model` 字样（例如「该模型额度已用尽」），
 * 但它们说明的是**账号**状态，不是模型下架 —— 记错了会把可用模型藏起来。
 *
 * ⚠️ 英文几个词**必须加 `\b` 词边界**（2026-10-06 复审 !66 实测）：无边界时
 * `quota` / `insufficient` 会命中 `model-quota-v2 does not exist` 这类
 * **正常的下架文案**，把它误杀成「不记」。`expired` 更是必须**带主语**
 * （见下），因为「模型租约到期」也是下架的一种说法。
 *
 * ⚠️ 中文排除词（额度 / 积分 / 余额 / 凭据 …）**不要**收紧：它们的方向是
 * **宁可漏判不可误伤**，与本文件「误判代价不对称」的总原则一致。实测
 * 「模型 qfmodel 已下架，积分不予退还」判 false（漏判）—— 这是**正确**的取舍。
 */
const NOT_GONE_PATTERNS: readonly RegExp[] = [
  /\brate\s*-?\s*limit\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\bquota\b/i,
  /\binsufficient\b/i,
  /\bunauthor|\bforbidden\b|\binvalid\s+(?:token|api\s*key|credential)/i,
  // ⚠️ `expired` 必须**带主语**才算认证失败（`token expired` / `session expired`），
  // 否则会误杀正常的下架文案：`model expired-v3 does not exist`、
  // `the model lease expired`（模型租约到期也是下架的一种说法）。
  /\b(?:token|session|credential|key|auth|lease)\s+(?:has\s+|hasn'?t\s+|is\s+|was\s+)?expired\b/i,
  /\bexpired\s+(?:token|session|credential|key|auth)\b/i,
  /限流|限速|额度|余额|积分|排队|繁忙|未登录|认证|鉴权|凭据/,
]

/** 这些错误码明确与「模型是否存在」无关。 */
const IGNORED_CODES: ReadonlySet<string> = new Set([
  'AUTH',
  'QUOTA_EXCEEDED',
  'RATE_LIMIT',
  'MISSING_CREDENTIAL',
  'PERMISSION_DENIED',
])

/**
 * 判断一个错误是否构成「该模型已失效」的**阳性证据**。
 *
 * @param error - 适配器抛出的错误。
 * @returns true 仅当能确认模型本身不可用（而非账号 / 网络 / 参数问题）。
 */
export function isModelGoneError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && IGNORED_CODES.has(code)) return false
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string' || message.length === 0) return false
  if (NOT_GONE_PATTERNS.some((pattern) => pattern.test(message))) return false
  return GONE_PATTERNS.some((pattern) => pattern.test(message))
}

/** TTL（毫秒）；0 表示不过期。 */
function ttlMs(): number {
  const raw = process.env.DSH_DEAD_MODEL_TTL_DAYS
  if (raw !== undefined && raw.trim().length > 0) {
    const days = Number(raw.trim())
    if (Number.isFinite(days) && days >= 0) return days * 24 * 60 * 60 * 1000
  }
  return DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000
}

/** 把磁盘内容归一成 {@link DeadModelRecords}（任何形状异常都退化为空表）。 */
function sanitize(parsed: unknown): DeadModelRecords {
  const out: DeadModelRecords = {}
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
  const providers = (parsed as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return out
  for (const [provider, entries] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) continue
    const keep: Record<string, DeadModelRecord> = {}
    for (const [modelId, meta] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof meta !== 'object' || meta === null) continue
      const at = (meta as { at?: unknown }).at
      if (typeof at !== 'string') continue
      const reason = (meta as { reason?: unknown }).reason
      keep[modelId] = {
        at,
        ...typeof reason === 'string' ? { reason } : {},
      }
    }
    if (Object.keys(keep).length > 0) out[provider] = keep
  }
  return out
}

/** 存储后端。 */
interface DeadModelStore {
  readonly kind: 'file' | 'memory'
  load(): DeadModelRecords
  save(records: DeadModelRecords): void
}

/** 仅内存后端：无法定位 dsh home 时的显式降级（与 `MemoryLockStore` 同策）。 */
class MemoryDeadModelStore implements DeadModelStore {
  readonly kind = 'memory' as const
  private records: DeadModelRecords = {}

  load(): DeadModelRecords {
    return this.records
  }

  save(records: DeadModelRecords): void {
    this.records = records
  }
}

/** 文件后端：`$DSH_HOME/jet-hub/dead-models.json`（原子写：tmp + rename）。 */
class FileDeadModelStore implements DeadModelStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): DeadModelRecords {
    try {
      if (!existsSync(this.path)) return {}
      return sanitize(JSON.parse(readFileSync(this.path, 'utf-8')) as unknown)
    } catch (error) {
      // 损坏时按**空表**处理：宁可多显示一个失效模型，也不要因为解析失败
      // 把整张表当成「全部失效」而藏掉可用模型。
      this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，按无失效记录处理: ${String(error)}`)
      return {}
    }
  }

  save(records: DeadModelRecords): void {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, providers: records }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

/** 进程级后端；`configureDeadModelStore` 可注入（注入前按环境变量懒解析）。 */
let store: DeadModelStore | undefined
/** 内存镜像，避免每次列模型都读盘。 */
let cache: DeadModelRecords | undefined

/** 记日志用的 logger（由 {@link configureDeadModelStore} 注入）。 */
let logger: { warn(message: string): void } | undefined
/**
 * 注入的 ctx（由 {@link configureDeadModelStore} 注入）。
 *
 * ⚠️ **必须用它解析 home**（2026-10-06 复审 !66 实测）：全仓库其余 5 处
 * `resolveJetHubHome` 调用（`jet-hub-store` / `permanent-lock-store` /
 * `badge-preferences` / `auto-checkin` / `gemini-sigstore`）**全部传真 ctx**，
 * 而 `resolveJetHubHome` 的第二优先级是 `profileContext.home`、第三才是
 * `$DSH_HOME` ⇒ 传 `undefined` 会**跳过 profile home**，在 profile home 与
 * `$DSH_HOME` 不相等时把本文档写到**另一个目录**，造成
 * 「账号池在 A、失效表在 B」的分裂 —— 正是 `permanent-lock-store.ts:129-133`
 * 明确警告过、必须避免的那类问题。
 * ⚠️ 未注入时（只有单测会这样）退化用空对象：`resolveJetHubHome` 的
 * `readService` 接受 `unknown`，读不到 `profileContext` 就自然落到
 * `DSH_JET_HUB_STATE_DIR` / `$DSH_HOME` / `~/.dsh` —— 单测正是靠第一个来源隔离。
 */
let injectedCtx: Context | undefined

function ensureStore(): DeadModelStore {
  if (store !== undefined) return store
  // ⚠️ 传 `injectedCtx`（可能为 undefined，那时才退化到环境变量 / `~/.dsh`）。
  // 不能裸传 `undefined`：那样会永远丢掉 `profileContext.home`。
  // 未注入时（只有单测会这样）用空对象：`readService` 接受 `unknown`，读不到
  // `profileContext` 就自然落到 `DSH_JET_HUB_STATE_DIR` —— 单测靠它隔离。
  const home = resolveJetHubHome(injectedCtx ?? ({} as Context))
  if (home === undefined) {
    logger?.warn('[jet-hub] 无法定位 DSH home，已失效模型记录仅存在于内存中')
    store = new MemoryDeadModelStore()
  } else {
    store = new FileDeadModelStore(join(home, 'jet-hub', DEAD_MODELS_FILE), logger)
  }
  return store
}

/**
 * 注入 ctx。
 *
 * 两个用途：**把日志接进 DSH 的 logger**，以及**复用同一份 home 解析**。
 * 不调用也能工作（退化为环境变量解析 + 不记日志），`index.ts` 的 apply 里
 * 调用一次即可 —— 且**必须在任何 `registerXxxLlm` 之前**。
 */
export function configureDeadModelStore(ctx: Context): void {
  logger = ctx.logger
  injectedCtx = ctx
  // home 取决于注入的 ctx，故丢弃既有后端与内存镜像，下次访问时按新 ctx 重建。
  store = undefined
  cache = undefined
}

/** 写回（失败只记日志，不影响调用方）。 */
function persist(prunedCount = 0): void {
  try {
    ensureStore().save(cache ?? {})
    if (prunedCount > 0) {
      logger?.warn(`[jet-hub] 已失效模型记录清理 ${prunedCount} 条（超过 TTL）`)
    }
  } catch (error) {
    logger?.warn(`[jet-hub] 已失效模型记录写入失败: ${String(error)}`)
  }
}

/** 读入并做 TTL 剪枝（结果缓存）。 */
function loadRecords(): DeadModelRecords {
  if (cache !== undefined) return cache
  const raw = ensureStore().load()
  const ttl = ttlMs()
  const now = Date.now()
  const out: DeadModelRecords = {}
  let pruned = 0
  for (const [provider, entries] of Object.entries(raw)) {
    const keep: Record<string, DeadModelRecord> = {}
    for (const [modelId, meta] of Object.entries(entries)) {
      if (ttl > 0) {
        const at = Date.parse(meta.at)
        if (!Number.isFinite(at) || now - at > ttl) {
          pruned++
          continue
        }
      }
      keep[modelId] = meta
    }
    if (Object.keys(keep).length > 0) out[provider] = keep
  }
  cache = out
  if (pruned > 0) persist(pruned)
  return out
}

/**
 * 记录一个「已失效」模型。
 *
 * @param provider - provider id（`product.id`）。
 * @param modelId - 裸模型 id。
 * @param reason - 判据命中的错误文案（排查用）。
 * @returns true 表示这是**新**记录（此前未记过）。
 */
export function recordDeadModel(provider: string, modelId: string, reason?: string): boolean {
  if (provider.length === 0 || modelId.length === 0) return false
  const records = loadRecords()
  const bucket = records[provider] ?? (records[provider] = {})
  if (bucket[modelId] !== undefined) return false
  bucket[modelId] = {
    at: new Date().toISOString(),
    ...reason === undefined ? {} : { reason },
  }
  persist()
  logger?.warn(
    `[jet-hub] 模型 ${provider}/${modelId} 已被判为失效（${reason ?? 'model not found'}），`
    + '此后不再列入模型列表',
  )
  return true
}

/** 取某 provider 的已失效模型 id 集合。 */
export function deadModelIdsFor(provider: string): ReadonlySet<string> {
  const bucket = loadRecords()[provider]
  return bucket === undefined ? new Set<string>() : new Set(Object.keys(bucket))
}

/**
 * 移除失效记录 —— 这是用户**唯一的**自愈路径（`model.clearDead` 端点）。
 *
 * ⚠️ 不清理黑名单：`disabledModels` 是用户的**主动选择**，失效记录是系统推断，
 * 两者语义不同、必须分开清除（否则「重新显示」会顺带把用户特意关着的模型打开）。
 *
 * @param provider - 目标 provider。
 * @param modelId - 指定模型；省略则清空该 provider 的全部失效记录。
 * @returns 实际移除的条目数（0 = 本来就没有记录，属幂等）。
 */
export function clearDeadModels(provider: string, modelId?: string): number {
  if (provider.length === 0) return 0
  const records = loadRecords()
  const bucket = records[provider]
  if (bucket === undefined) return 0
  let removed = 0
  if (modelId === undefined) {
    removed = Object.keys(bucket).length
    delete records[provider]
  } else if (modelId.length > 0 && bucket[modelId] !== undefined) {
    delete bucket[modelId]
    removed = 1
    // 空桶不留痕：否则设置页会多出一个没有模型的下拉组。
    if (Object.keys(bucket).length === 0) delete records[provider]
  }
  if (removed > 0) {
    persist()
    logger?.warn(
      `[jet-hub] 已恢复 ${removed} 个失效模型（${provider}${modelId === undefined ? '' : `/${modelId}`}），`
      + '它们将重新出现在模型列表中',
    )
  }
  return removed
}

/** 清空**全部** provider 的失效记录（排查 / 「全部重新显示」用）。 */
export function clearAllDeadModels(): number {
  const records = loadRecords()
  let removed = 0
  for (const entries of Object.values(records)) removed += Object.keys(entries).length
  for (const key of Object.keys(records)) delete records[key]
  if (removed > 0) persist()
  return removed
}

/** 从列表里剔除此 provider 的已失效模型（非数组 / 无 id 的条目原样保留）。 */
function filterList(providers: readonly string[], list: unknown): unknown {
  if (!Array.isArray(list) || list.length === 0) return list
  const dead = new Set<string>()
  for (const provider of providers) {
    for (const id of deadModelIdsFor(provider)) dead.add(id)
  }
  if (dead.size === 0) return list
  const kept = list.filter((item) => {
    if (item === null || typeof item !== 'object') return true
    const id = (item as { id?: unknown }).id
    return !(typeof id === 'string' && dead.has(id))
  })
  return kept.length === list.length ? list : kept
}

/** 适配器里本模块需要包装的成员（其余原样透传）。 */
interface PrunableAdapter {
  listModels?: (...args: unknown[]) => unknown
  listAllModels?: (...args: unknown[]) => unknown
  stream?: (options: { model?: unknown }) => unknown
  prepareCall?: (...args: unknown[]) => unknown
}

/** `prepareCall` 的返回值形状（dsh-llm 的 `PreparedAdapterCall`）。 */
interface PreparedAdapterCall {
  model: unknown
  stream: (options: { model?: unknown }) => AsyncIterable<unknown>
  [key: string]: unknown
}

/**
 * 包装一个异步可迭代流：迭代中抛出的错误若判定为「模型已失效」则记录，
 * **再原样抛出**（不吞错误 —— 调用方仍要看到失败，且 harness 的重试分类
 * 依赖原始错误码）。
 *
 * @param provider - 记录时归属的 provider id。
 * @param inner - 原适配器产出的流。
 * @param modelId - 本次请求的模型 id（用于写进失效表）。
 */
function trackStream(
  provider: string,
  inner: AsyncIterable<unknown>,
  modelId: unknown,
): AsyncGenerator<unknown> {
  return (async function* tracked(): AsyncGenerator<unknown> {
    try {
      yield* inner
    } catch (error) {
      if (typeof modelId === 'string' && isModelGoneError(error)) {
        recordDeadModel(provider, modelId, (error as { message?: string }).message)
      }
      throw error
    }
  })()
}

/**
 * 用「已失效模型」剔除包装一个适配器。
 *
 * 包装四处（其余原样透传）：
 *
 * - `listModels` —— 异步，等结果后过滤；
 * - `listAllModels` —— **必须保持同步**（`jet-hub-rpc` 的 `ModelCatalogSource`
 *   契约要求同步且消费者不 await，改成 async 会抛 `all is not iterable`）；
 * - `stream` —— 捕获迭代中抛出的错误，判定后记录，再原样抛出；
 * - **`prepareCall`** —— ⚠️ **这是生产环境唯一真正会走到的路径**（见下）。
 *
 * ## ⚠️⚠️ 为什么必须包 `prepareCall`（致命缺陷，2026-10-06 复审 !66 实测）
 *
 * 本仓库全部 14 个适配器的 `prepareCall` 都是这个形状：
 *
 * ```ts
 * async prepareCall(provider, model, signal) {
 *   return { model: await this.resolveModel(...), stream: (options) => this.stream(options) }
 * }
 * ```
 *
 * `prepareCall` 被 `bind` 到**原始对象**，故 `this` 是原对象，`this.stream` 拿到的是
 * **原始 stream** —— 完全绕过 Proxy 的 `stream` 拦截。而 dsh-llm 的两条运行时路径
 * **只走 prepareCall**：
 *
 * - `node_modules/@deepseek-ai/dsh-llm/lib/index.js:1597` → `adapterCall.stream(options)`
 * - 同文件 `:1667` → `dispatch = (options) => adapterCall.stream(options)`
 *
 * ⇒ 只包 `stream` 时，**失效模型永远不会被记录**（实测确认）。
 *
 * ⚠️ **只包 `prepareCall` 本身也不够**：真实错误发生在 `call.stream(options)` 的
 * **迭代过程中**（dsh-llm `:1691` `iterator = dispatch(...)[Symbol.asyncIterator]()`，
 * `:1701` `iterator.next()`），不是 `prepareCall` 自己抛的。故必须包装
 * **返回的那个 `call.stream`**。
 *
 * @param providers - 该适配器注册的 provider id 列表。
 * @param adapter - 适配器实例。
 */
export function withDeadModelPruning<T extends object>(
  providers: readonly string[],
  adapter: T,
): T {
  const ids = providers.filter((id) => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) return adapter

  const target = adapter as PrunableAdapter & object
  const bound = new Map<PropertyKey, unknown>()
  /** 记录归属的 provider：一个实例注册多路由时取第一个（当前 14 处注册都是单元素）。 */
  const owner = ids[0]!
  /** 懒建一次并缓存，保证每次访问返回同一个函数（下游按函数身份缓存时不会失配）。 */
  const wrapOnce = <K extends PropertyKey>(key: K, make: () => unknown): unknown => {
    if (!bound.has(key)) bound.set(key, make())
    return bound.get(key)
  }

  return new Proxy(adapter, {
    get(obj, prop, receiver) {
      if (prop === 'listModels' && typeof target.listModels === 'function') {
        return wrapOnce(prop, () => async (...args: unknown[]): Promise<unknown> =>
          filterList(ids, await target.listModels!.apply(obj, args)))
      }
      if (prop === 'listAllModels' && typeof target.listAllModels === 'function') {
        return wrapOnce(prop, () => (...args: unknown[]): unknown =>
          filterList(ids, target.listAllModels!.apply(obj, args)))
      }
      if (prop === 'stream' && typeof target.stream === 'function') {
        return wrapOnce(prop, () => (options: { model?: unknown }): unknown =>
          trackStream(owner, target.stream!.apply(obj, [options]) as AsyncIterable<unknown>, options?.model))
      }
      if (prop === 'prepareCall' && typeof target.prepareCall === 'function') {
        return wrapOnce(prop, () => async (...args: unknown[]): Promise<unknown> => {
          const call = await target.prepareCall!.apply(obj, args) as PreparedAdapterCall
          if (call === null || typeof call !== 'object' || typeof call.stream !== 'function') return call
          // ⚠️ 关键：包装的是**返回的 call.stream**，不是 prepareCall 自身。
          return {
            ...call,
            stream: (options: { model?: unknown }): AsyncIterable<unknown> =>
              trackStream(owner, call.stream(options), options?.model),
          }
        })
      }
      // 其余成员原样透传；方法需绑定原对象作为 this。
      // 缓存绑定结果：每次访问返回同一个函数，避免下游比较函数身份时失配。
      const value = Reflect.get(obj, prop, receiver) as unknown
      if (typeof value !== 'function') return value
      return wrapOnce(prop, () => value.bind(obj))
    },
  })
}
