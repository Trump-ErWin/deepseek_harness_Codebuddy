/**
 * Token 账本**每日聚合**的持久化文档（第 2 期）。
 *
 * ## 形态与取舍
 *
 * - **只落日聚合，不落明细**：明细（每笔请求一行）在 UI 已有内存版（500 条，
 *   重启即丢是**既定行为**）；持久化要回答的是「本周/这个月用了多少」，
 *   天然粒度就是**日**。日聚合把每笔请求摊平成「UTC+8 日 × 渠道 × provider ×
 *   账号 × 模型」一格，写入量与请求量解耦（同一格只加数，不增行）。
 * - **独立文档**（`token-ledger.json`），不进 state.json —— 理由与
 *   `permanent-lock-store.ts` 完全同源：state.json 被**另一条工作区的旧代码**
 *   整体重写时会静默抹掉它不认识的键。
 * - **节流落盘**（2 秒防抖）：记账在推理关键路径上，每笔都同步写盘会把
 *   「一次推理」变成「一次磁盘写」。防抖窗口内崩溃最多丢最近 2 秒的计数 ——
 *   对统计型数据是可接受的精度损失（换取零阻塞）。
 * - **落盘是「增量合并写」，不是整体覆盖**（真实缺陷，审计发现并原样复现）：
 *   两个实例并存时（fiber 重启交错；或同机多 profile 共享同一 home——见上条
 *   与 `permanent-lock-store.ts`）各自内存视图独立，整体覆盖会**互相抹掉**。
 *   详见 `FileLedgerStore.flush` 的注释。
 *
 * ## 日界
 *
 * UTC+8（各渠道每日额度的结算时区），见 `utc8DayKey`。**保留天数**
 * {@link TOKEN_LEDGER_DAYS}：默认 90 天，更早的日桶在落盘时淘汰 ——
 * 用户「看看历史」的诉求远小于无限增长的文件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveJetHubHome } from './jet-hub-store.js'
import { mergeDayEntry, type TokenLedgerDayBucket, type TokenLedgerDayMap } from './token-ledger.js'

/** 独立文档的文件名（与 state.json 同目录）。 */
export const TOKEN_LEDGER_FILE = 'token-ledger.json'

/** 日聚合保留天数（落盘时淘汰更早的日键）。 */
export const TOKEN_LEDGER_DAYS = 90

/** 落盘节流窗口（毫秒）。 */
export const TOKEN_LEDGER_FLUSH_MS = 2_000

const SCHEMA = 'dsh-codearts-auth/token-ledger/v1'

/** 日聚合的持久化后端接口（同步读、节流异步写）。 */
export interface TokenLedgerStore {
  /**
   * 读取日聚合表 —— **纯内存读，不碰磁盘**。
   *
   * ⚠️ 磁盘**只在构造时读一次**（见 {@link FileLedgerStore} 的 `hydrate`）。
   * RPC 的历史视图会**频繁**调用本方法（每次打开弹窗、每次切窗口）。若在这里
   * 重新读盘，会把防抖窗口内**尚未落盘**的计数打回盘上的旧值，并被随后的自动
   * flush **固化到磁盘**（实测：内存 60 → 读一次 → 30 → 落盘 30）。
   */
  load(): TokenLedgerDayMap
  /** 把一笔请求并入日聚合（内存即时、落盘节流）。 */
  append(entry: import('./token-ledger.js').TokenLedgerEntry): void
  /** 立即落盘（dispose / 测试用；正常路径靠节流自动刷）。 */
  flush(): void
}

/** 淘汰过老日键后的浅拷贝（不改调用方的表）。 */
function pruneDays(days: TokenLedgerDayMap): TokenLedgerDayMap {
  const cutoff = Date.now() + 8 * 60 * 60 * 1000 - TOKEN_LEDGER_DAYS * 24 * 60 * 60 * 1000
  const pruned: TokenLedgerDayMap = new Map()
  for (const [day, buckets] of days) {
    // 日键 `YYYY-MM-DD` 的 UTC+8 当日 24:00 ≈ 该日 00:00 + 1 天；用日首 +8h 对齐比较即可。
    const dayStartUtc8 = Date.parse(`${day}T00:00:00Z`) - 8 * 60 * 60 * 1000
    if (Number.isFinite(dayStartUtc8) && dayStartUtc8 < cutoff) continue
    pruned.set(day, buckets)
  }
  return pruned
}

/** 内存后端：无法定位 home 时的显式降级（与 MemoryStore 同策）。 */
class MemoryLedgerStore implements TokenLedgerStore {
  private days: TokenLedgerDayMap = new Map()

  load(): TokenLedgerDayMap {
    return this.days
  }

  append(entry: import('./token-ledger.js').TokenLedgerEntry): void {
    mergeDayEntry(this.days, entry)
  }

  flush(): void {
    // 内存后端无盘可落。
  }
}

/** 文件后端：`$DSH_HOME/jet-hub/token-ledger.json`（原子写 + 节流）。 */
class FileLedgerStore implements TokenLedgerStore {
  private days: TokenLedgerDayMap = new Map()
  /**
   * **已落盘基线**：上次成功写盘时各桶的快照。
   *
   * `flush()` 只把「相对本基线新增的增量」合并进**盘上当前内容**（见 flush 的
   * 注释）。基线在每次成功写盘后前移。
   */
  private written: TokenLedgerDayMap = new Map()
  /** 防抖计时器（Node 返回值带 unref，浏览器/测试环境可能没有）。 */
  private timer: ReturnType<typeof setTimeout> | undefined
  /** 节流窗口内又发生了写入时，flush 后需要再排一次。 */
  private dirty = false

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {
    // ⚠️ **构造时读一次盘**（`days` 与 `written` 同时初始化）。
    //
    // 缺陷（复审实测）：原先从不读盘 ⇒ 新进程的 `days` 是空表，首次 `flush()`
    // 用**空表整体覆盖**文档 ⇒ 每次重启 DSH 历史日聚合归零（与 README 的
    // 「重启保留 90 天」相反）。构造时读盘让内存成为盘上数据的**超集**。
    //
    // ⚠️ 但**光靠这一点不够**（审计发现，已原样复现）：内存是超集只在**单实例**
    // 下成立。两个实例并存时（fiber 重启交错、或同机多 profile 共享 home），
    // 各自的内存视图独立，整体覆盖会互相抹掉。故 `flush()` 必须是**增量合并写**。
    this.days = this.readFile()
    this.written = cloneDays(this.days)
  }

  /** 从磁盘读日聚合（构造时用；返回**空表**表示无盘/损坏）。 */
  private readFile(): TokenLedgerDayMap {
    const out: TokenLedgerDayMap = new Map()
    try {
      if (!existsSync(this.path)) return out
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
      const record = parsed as { days?: unknown }
      if (typeof record.days !== 'object' || record.days === null || Array.isArray(record.days)) return out
      for (const [day, rawBuckets] of Object.entries(record.days as Record<string, unknown>)) {
        if (typeof rawBuckets !== 'object' || rawBuckets === null || Array.isArray(rawBuckets)) continue
        const bucketList = rawBuckets as Record<string, unknown>
        const target = new Map<string, TokenLedgerDayBucket>()
        for (const [key, rawBucket] of Object.entries(bucketList)) {
          if (typeof rawBucket !== 'object' || rawBucket === null) continue
          const b = rawBucket as Record<string, unknown>
          // 数值字段全部钳制（手工编辑/旧版本的脏数据不致命，但也不能 NaN）。
          target.set(key, {
            requests: Number(b.requests) || 0,
            reportedRequests: Number(b.reportedRequests) || 0,
            inputTokens: Number(b.inputTokens) || 0,
            outputTokens: Number(b.outputTokens) || 0,
            cacheReadTokens: Number(b.cacheReadTokens) || 0,
            cacheWriteTokens: Number(b.cacheWriteTokens) || 0,
            reasoningTokens: Number(b.reasoningTokens) || 0,
            errors: Number(b.errors) || 0,
            // Σ/份数（第 3 期均值）：旧文档没这些键 → 0（等价于无样本）。
            ttftSumMs: Number(b.ttftSumMs) || 0,
            ttftCount: Number(b.ttftCount) || 0,
            tpsSum: Number(b.tpsSum) || 0,
            tpsCount: Number(b.tpsCount) || 0,
          })
        }
        out.set(day, target)
      }
    } catch (error) {
      // 损坏按空表处理（统计型数据不值得阻断启动）。
      this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，历史用量按空表处理: ${String(error)}`)
      return new Map()
    }
    return out
  }

  /** 纯内存读（不碰磁盘）—— 见接口注释。 */
  load(): TokenLedgerDayMap {
    return this.days
  }

  append(entry: import('./token-ledger.js').TokenLedgerEntry): void {
    mergeDayEntry(this.days, entry)
    this.scheduleFlush()
  }

  /** 节流落盘：窗口内首笔启动计时器，到点刷盘；期间新写入标记 dirty 再刷一轮。 */
  private scheduleFlush(): void {
    if (this.timer !== undefined) {
      this.dirty = true
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      try {
        this.flush()
      } finally {
        if (this.dirty) {
          this.dirty = false
          this.scheduleFlush()
        }
      }
    }, TOKEN_LEDGER_FLUSH_MS)
    // unref：落盘不该拖住进程退出（守卫：非 Node 环境没有 unref）。
    this.timer.unref?.()
  }

  /**
   * **增量合并写**（不是整体覆盖）。
   *
   * ## 为什么必须合并（真实缺陷，审计发现并已复现）
   *
   * 整体覆盖只在**单实例**下安全。两个实例并存时（fiber 重启交错期间新旧两个
   * store 都在；或同机多 profile 共享同一个 home —— `permanent-lock-store.ts`
   * 开篇与本文档模块头都明载这一点），各自的内存视图独立，**谁后写谁抹掉对方**：
   *
   * ```
   * O 记 100（未 flush）        : 盘 = 0
   * N（新实例）记 1 并 flush    : 盘 = 1
   * O.flush()（旧 fiber dispose）: 盘 = 100   ← N 的 1 被抹掉
   * N 再记 5 并 flush           : 盘 = 6     ← O 的 100 也丢了（双向丢失，期望 106）
   * ```
   *
   * ⚠️ 修「构造时读盘」只解决**顺序**场景（新实例读到旧数据），解决不了**并存**
   * 场景 —— 后者必须靠合并。
   *
   * ## 算法
   *
   * 1. 重读盘上**当前**内容（别的实例可能刚写过）；
   * 2. 只把「相对本实例上次写盘基线 {@link written} 的**增量**」逐桶累加上去；
   * 3. 原子写（tmp + rename），成功后基线前移。
   *
   * 增量 = 当前内存值 − 上次落盘时的值（逐字段相减，负数钳到 0 防手工编辑倒挂）。
   */
  flush(): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      // ① 盘上现况（含别的实例刚写的）
      const merged = this.readFile()
      // ② 把本实例的增量并进去
      for (const [day, buckets] of this.days) {
        let target = merged.get(day)
        if (target === undefined) {
          target = new Map()
          merged.set(day, target)
        }
        const base = this.written.get(day)
        for (const [key, bucket] of buckets) {
          const before = base?.get(key)
          const delta = subtractBucket(bucket, before)
          const existing = target.get(key)
          if (existing === undefined) {
            target.set(key, delta)
          } else {
            target.set(key, addBucket(existing, delta))
          }
        }
      }
      // ③ 原子写（淘汰过老日键）
      const days: Record<string, Record<string, unknown>> = {}
      for (const [day, buckets] of pruneDays(merged)) {
        days[day] = Object.fromEntries(buckets)
      }
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, days }, null, 2), 'utf-8')
      renameSync(tmp, this.path)
      // ④ 基线前移（只在写盘成功后）
      this.written = cloneDays(this.days)
    } catch (error) {
      // 落盘失败只记日志：账本还有内存兜底，不能反噬推理。
      this.logger?.warn(`[jet-hub] 写入 ${this.path} 失败（本次统计不入盘）: ${String(error)}`)
    }
  }
}

/** 深拷贝日聚合表（桶对象也复制，避免与基线共享引用）。 */
function cloneDays(days: TokenLedgerDayMap): TokenLedgerDayMap {
  const out: TokenLedgerDayMap = new Map()
  for (const [day, buckets] of days) {
    out.set(day, new Map([...buckets].map(([key, bucket]) => [key, { ...bucket }])))
  }
  return out
}

/** 逐字段相加（两个桶合并）。 */
function addBucket(
  a: TokenLedgerDayBucket,
  b: TokenLedgerDayBucket,
): TokenLedgerDayBucket {
  return {
    requests: a.requests + b.requests,
    reportedRequests: a.reportedRequests + b.reportedRequests,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    errors: a.errors + b.errors,
    ttftSumMs: a.ttftSumMs + b.ttftSumMs,
    ttftCount: a.ttftCount + b.ttftCount,
    tpsSum: a.tpsSum + b.tpsSum,
    tpsCount: a.tpsCount + b.tpsCount,
  }
}

/**
 * 增量 = 当前桶 − 基线桶（逐字段）。
 *
 * ⚠️ 负数一律钳到 0：手工编辑过文档、或基线比当前大时（理论上不该发生），
 * 相减会得到负数，写进账本会**倒扣**用户的历史用量 —— 宁可少记也不能倒扣。
 */
function subtractBucket(
  current: TokenLedgerDayBucket,
  base: TokenLedgerDayBucket | undefined,
): TokenLedgerDayBucket {
  if (base === undefined) return { ...current }
  const diff = (a: number, b: number): number => Math.max(0, a - b)
  return {
    requests: diff(current.requests, base.requests),
    reportedRequests: diff(current.reportedRequests, base.reportedRequests),
    inputTokens: diff(current.inputTokens, base.inputTokens),
    outputTokens: diff(current.outputTokens, base.outputTokens),
    cacheReadTokens: diff(current.cacheReadTokens, base.cacheReadTokens),
    cacheWriteTokens: diff(current.cacheWriteTokens, base.cacheWriteTokens),
    reasoningTokens: diff(current.reasoningTokens, base.reasoningTokens),
    errors: diff(current.errors, base.errors),
    ttftSumMs: diff(current.ttftSumMs, base.ttftSumMs),
    ttftCount: diff(current.ttftCount, base.ttftCount),
    tpsSum: diff(current.tpsSum, base.tpsSum),
    tpsCount: diff(current.tpsCount, base.tpsCount),
  }
}

/**
 * 创建日聚合后端。
 *
 * home 解析与账号池**同一个函数**（`resolveJetHubHome`），保证文档落在同一目录
 * —— 否则会出现「账号池在 A 处、用量在 B 处」的分裂。
 */
export function createTokenLedgerStore(ctx: Context): TokenLedgerStore {
  const home = resolveJetHubHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，Token 用量历史仅存在于内存中')
    return new MemoryLedgerStore()
  }
  return new FileLedgerStore(join(home, 'jet-hub', TOKEN_LEDGER_FILE), ctx.logger)
}
