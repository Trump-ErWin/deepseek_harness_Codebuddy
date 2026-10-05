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
 */
const GONE_PATTERNS: readonly RegExp[] = [
  /model\s+not\s+found/i,
  /model\b[^.!?]{0,24}\bnot\s+(?:found|exist|available|supported)/i,
  /(?:unknown|no\s+such|nonexistent)\s+model/i,
  /model[^.!?]{0,16}(?:does\s*not|doesn'?t)\s+exist/i,
  // ⚠️ 窗口要够宽：`模型 deepseek-v4.1-flash-x 不存在` 里，「模型」与「不存在」
  // 之间隔着一整个 id（实测 12+ 字符）。
  // ⚠️ **不收 `不可用`**：账号/额度类报错也这么说（「所有账号均不可用」），
  // 收它会把账号问题误记成模型下架。
  /模型[^，。；;!?]{0,32}(?:不存在|未找到|未上线|已下线|已下架)/,
  /model[^.!?]{0,24}(?:不存在|未找到|已下线|已下架)/,
]

/**
 * 「与模型无关」的排除词：命中则**不记**。
 *
 * 限流 / 额度 / 认证失败都可能带 `model` 字样（例如「该模型额度已用尽」），
 * 但它们说明的是**账号**状态，不是模型下架 —— 记错了会把可用模型藏起来。
 */
const NOT_GONE_PATTERNS: readonly RegExp[] = [
  /rate\s*-?\s*limit/i,
  /too\s+many\s+requests/i,
  /quota/i,
  /insufficient/i,
  /unauthor|forbidden|expired|invalid\s+(?:token|api\s*key|credential)/i,
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

function ensureStore(): DeadModelStore {
  if (store !== undefined) return store
  // 不给 ctx：`resolveJetHubHome` 会依次回落到 `DSH_JET_HUB_STATE_DIR` /
  // `$DSH_HOME` / `~/.dsh`，在真实运行环境里足够定位。
  const home = resolveJetHubHome(undefined)
  if (home === undefined) {
    logger?.warn('[jet-hub] 无法定位 DSH home，已失效模型记录仅存在于内存中')
    store = new MemoryDeadModelStore()
  } else {
    store = new FileDeadModelStore(join(home, 'jet-hub', DEAD_MODELS_FILE), logger)
  }
  return store
}

/**
 * 注入 ctx（可选）。
 *
 * 只为了**把日志接进 DSH 的 logger** 以及复用同一份 home 解析；不调用也能工作
 * （退化为环境变量解析 + 不记日志）。`index.ts` 的 apply 里调用一次即可。
 */
export function configureDeadModelStore(ctx: Context): void {
  logger = ctx.logger
  // home 可能与懒解析结果不同（`profileContext.home` 优先于 `DSH_HOME`），
  // 故允许重解析；已加载的内存镜像随之丢弃，下次读盘重建。
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
 * 清空记录（排查用）。
 *
 * @param provider - 省略则全清。
 */
export function clearDeadModels(provider?: string): void {
  const records = loadRecords()
  if (provider === undefined) {
    for (const key of Object.keys(records)) delete records[key]
  } else {
    delete records[provider]
  }
  persist()
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

/** 适配器里本模块需要包装的三个成员（其余原样透传）。 */
interface PrunableAdapter {
  listModels?: (...args: unknown[]) => unknown
  listAllModels?: (...args: unknown[]) => unknown
  stream?: (options: { model?: unknown }) => unknown
}

/**
 * 用「已失效模型」剔除包装一个适配器。
 *
 * 包装三处（其余原样透传）：
 *
 * - `listModels` —— 异步，等结果后过滤；
 * - `listAllModels` —— **必须保持同步**（`jet-hub-rpc` 的 `ModelCatalogSource`
 *   契约要求同步且消费者不 await，改成 async 会抛 `all is not iterable`）；
 * - `stream` —— 异步生成器；捕获迭代中抛出的错误，判定后记录，**再原样抛出**
 *   （不吞错误：调用方仍要看到失败，且 harness 的重试分类依赖原始错误码）。
 *
 * ⚠️ 包装失败不阻断注册：调用方（`llm-register-compat.ts`）在异常时回退到原适配器。
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

  return new Proxy(adapter, {
    get(obj, prop, receiver) {
      if (prop === 'listModels' && typeof target.listModels === 'function') {
        return async (...args: unknown[]): Promise<unknown> =>
          filterList(ids, await target.listModels!.apply(obj, args))
      }
      if (prop === 'listAllModels' && typeof target.listAllModels === 'function') {
        return (...args: unknown[]): unknown =>
          filterList(ids, target.listAllModels!.apply(obj, args))
      }
      if (prop === 'stream' && typeof target.stream === 'function') {
        return (options: { model?: unknown }): unknown => {
          const inner = target.stream!.apply(obj, [options]) as AsyncIterable<unknown>
          const modelId = options?.model
          return (async function* tracked(): AsyncGenerator<unknown> {
            try {
              yield* inner
            } catch (error) {
              if (typeof modelId === 'string' && isModelGoneError(error)) {
                recordDeadModel(ids[0]!, modelId, (error as { message?: string }).message)
              }
              throw error
            }
          })()
        }
      }
      // 其余成员原样透传；方法需绑定原对象作为 this。
      // 缓存绑定结果：每次访问返回同一个函数，避免下游比较函数身份时失配。
      const value = Reflect.get(obj, prop, receiver) as unknown
      if (typeof value !== 'function') return value
      if (!bound.has(prop)) bound.set(prop, value.bind(obj))
      return bound.get(prop)
    },
  })
}
