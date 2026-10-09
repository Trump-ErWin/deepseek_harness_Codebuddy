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
 * - **节流落盘**（1 秒防抖）：记账不在推理关键路径同步写盘；落盘前 flush 文件，
 *   插件正常 dispose 也会立即刷盘。进程异常崩溃最多丢最近 1 秒的计数。
 * - **跨进程互斥增量合并写**：同一账本路径通过原子创建锁目录串行化
 *   read-merge-rename；锁占用时 flush 延后重试，过期且进程退出的锁会被回收。
 *
 * ## 已知限制：「外部删除某日键 + 该日之后又有增量」⇒ 本次运行内读数偏高
 *
 * `flush()` 只写**增量**，而增量的基线是**本实例内存里的值**。若盘上某日键被
 * 外部删除（手工编辑 / 另一工作区的旧版本整体覆盖 / 从备份恢复），而该日随后
 * **又产生了新的真增量**，则只写该增量、不写被删掉的那部分：
 *
 * ```
 * 昨日记 20 落盘 → 外部删掉昨日 → 昨日又产生增量 5 → flush
 * 运行中（内存 / UI）昨日 = 25
 * 重启后（盘上）    昨日 = 5     ← 被外部删掉的 20 不会回来
 * ```
 *
 * ⚠️ **这是有意的取舍，不是缺陷**：盘上那一格是被**外部权威地删除**的，把它
 * 「复活」等于无视用户的删除意图（本仓库 `permanent-lock-store.ts` 的迁移判据
 * 「文档存在则它是唯一权威」是同款思路）。代价是**本次运行内**的读数会高于
 * 重启后的读数 —— 触发前提是外部干预；无外部删除时两者恒等。
 *
 * ⚠️ 与上一节**不同源**：那条是两进程同时写，本条是外部删除后本地继续写。
 *
 * ## 日界
 *
 * UTC+8（各渠道每日额度的结算时区），见 `utc8DayKey`。**保留天数**
 * {@link TOKEN_LEDGER_DAYS}：默认 90 天，更早的日桶在落盘时淘汰 ——
 * 用户「看看历史」的诉求远小于无限增长的文件。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveJetHubHome } from './jet-hub-store.js'
import { isValidTokenLedgerDayKey, mergeDayEntry, TPS_HISTOGRAM_BINS, type TokenLedgerDayBucket, type TokenLedgerDayMap } from './token-ledger.js'

/** 独立文档的文件名（与 state.json 同目录）。 */
export const TOKEN_LEDGER_FILE = 'token-ledger.json'

/** 日聚合保留天数（落盘时淘汰更早的日键）。 */
export const TOKEN_LEDGER_DAYS = 90

/** 落盘节流窗口（毫秒）。 */
export const TOKEN_LEDGER_FLUSH_MS = 1_000

const SCHEMA = 'dsh-codearts-auth/token-ledger/v2'
const LEDGER_LOCK_STALE_MS = 30_000
const LEDGER_LOCK_ABANDON_MS = 5 * 60_000

/** 从本地文件读数时拒绝负数、NaN 和无穷值；计数类字段再截为整数。 */
function storedNumber(value: unknown, integer = true): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return integer ? Math.trunc(number) : number
}

function isValidBucketKey(key: string): boolean {
  const parts = key.split('|')
  return parts.length === 4
    && (parts[0] === 'direct' || parts[0] === 'gateway')
    && parts[1].length > 0
    && parts[3].length > 0
}

function readTpsHistogram(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const histogram: Record<string, number> = {}
  for (const [key, rawCount] of Object.entries(value)) {
    const bin = Number(key)
    const count = storedNumber(rawCount)
    if (Number.isInteger(bin) && bin >= 0 && bin < TPS_HISTOGRAM_BINS && count > 0) {
      histogram[String(bin)] = count
    }
  }
  return histogram
}

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
  /** 删除指定 UTC+8 日键的历史累计；同步落盘，其他日期不变。 */
  deleteDay(day: string): boolean
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

  deleteDay(day: string): boolean {
    return this.days.delete(day)
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
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('账本根节点不是对象')
      }
      const record = parsed as { days?: unknown }
      if (typeof record.days !== 'object' || record.days === null || Array.isArray(record.days)) {
        throw new Error('账本缺少有效的 days 对象')
      }
      for (const [day, rawBuckets] of Object.entries(record.days as Record<string, unknown>)) {
        if (!isValidTokenLedgerDayKey(day)) continue
        if (typeof rawBuckets !== 'object' || rawBuckets === null || Array.isArray(rawBuckets)) continue
        const bucketList = rawBuckets as Record<string, unknown>
        const target = new Map<string, TokenLedgerDayBucket>()
        for (const [key, rawBucket] of Object.entries(bucketList)) {
          if (!isValidBucketKey(key) || typeof rawBucket !== 'object' || rawBucket === null || Array.isArray(rawBucket)) continue
          const b = rawBucket as Record<string, unknown>
          // 数值字段统一校验（手工编辑/旧版本的脏数据不致命，也不能让负值污染汇总）。
          target.set(key, {
            requests: storedNumber(b.requests),
            reportedRequests: storedNumber(b.reportedRequests),
            inputTokens: storedNumber(b.inputTokens),
            outputTokens: storedNumber(b.outputTokens),
            cacheReadTokens: storedNumber(b.cacheReadTokens),
            cacheWriteTokens: storedNumber(b.cacheWriteTokens),
            reasoningTokens: storedNumber(b.reasoningTokens),
            errors: storedNumber(b.errors),
            // Σ/份数（第 3 期均值）：旧文档没这些键 → 0（等价于无样本）。
            ttftSumMs: storedNumber(b.ttftSumMs),
            ttftCount: storedNumber(b.ttftCount),
            tpsSum: storedNumber(b.tpsSum, false),
            tpsCount: storedNumber(b.tpsCount),
            tpsHistogram: readTpsHistogram(b.tpsHistogram),
          })
        }
        out.set(day, target)
      }
    } catch (error) {
      // 保留损坏原件，避免后续正常 flush 用空表覆盖，统计问题不阻断启动。
      const backupStamp = Date.now()
      let backupPath = `${this.path}.corrupt-${backupStamp}`
      for (let suffix = 1; existsSync(backupPath); suffix++) backupPath = `${this.path}.corrupt-${backupStamp}-${suffix}`
      try {
        if (existsSync(this.path)) renameSync(this.path, backupPath)
      } catch (backupError) {
        this.logger?.warn(`[jet-hub] 账本损坏且备份失败 ${this.path}: ${String(backupError)}`)
      }
      this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，已尝试保留损坏文件 ${backupPath}: ${String(error)}`)
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

  /** 跨进程互斥；竞争时由节流器稍后重试，不阻塞推理请求。 */
  private acquireWriteLock(): (() => void) | undefined {
    const lockPath = `${this.path}.lock`
    const nonce = randomUUID()
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(lockPath)
        try {
          writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() }), 'utf-8')
        } catch (error) {
          rmSync(lockPath, { recursive: true, force: true })
          throw error
        }
        return () => {
          try {
            const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf-8')) as { nonce?: unknown }
            if (owner.nonce === nonce) rmSync(lockPath, { recursive: true, force: true })
          } catch {
            // 锁已被清理或文件系统异常，不影响已完成的写入。
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!this.reclaimStaleLock(lockPath)) return undefined
      }
    }
    return undefined
  }

  /** 仅回收超时且持有进程已退出的锁；隔离目录用 rename 原子摘离旧锁。 */
  private reclaimStaleLock(lockPath: string): boolean {
    try {
      const stat = statSync(lockPath)
      if (Date.now() - stat.mtimeMs < LEDGER_LOCK_STALE_MS) return false
      let owner: { pid?: unknown; nonce?: unknown } = {}
      try {
        owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf-8')) as typeof owner
      } catch {
        // owner 文件缺失/损坏时只按过期目录处理。
      }
      const pid = Number(owner.pid)
      const lockAgeMs = Date.now() - stat.mtimeMs
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
          return false
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
        }
      } else if (lockAgeMs < LEDGER_LOCK_ABANDON_MS) {
        // owner 文件尚未写完/已损坏时，留更长宽限期，避免夺走刚创建的锁。
        return false
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`
      renameSync(lockPath, stalePath)
      const movedStat = statSync(stalePath)
      let movedOwner: { pid?: unknown; nonce?: unknown } = {}
      try {
        movedOwner = JSON.parse(readFileSync(join(stalePath, 'owner.json'), 'utf-8')) as typeof movedOwner
      } catch {
        // 缺少 owner 记录的过期锁可以清理。
      }
      if (Date.now() - movedStat.mtimeMs < LEDGER_LOCK_STALE_MS || movedOwner.nonce !== owner.nonce) {
        try { renameSync(stalePath, lockPath) } catch { /* 若有新锁占位，不覆盖它。 */ }
        return false
      }
      rmSync(stalePath, { recursive: true, force: true })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      return false
    }
  }

  /**
   * 删除单日历史。先刷入本实例的待写增量，再以磁盘最新文档为基准只移除目标日，
   * 避免覆盖其他日期或清空实时明细。写入成功后重置目标日基线，使后续新请求从零累计。
   */
  deleteDay(day: string): boolean {
    if (!this.days.has(day)) return false

    mkdirSync(join(this.path, '..'), { recursive: true })
    const releaseLock = this.acquireWriteLock()
    if (releaseLock === undefined) throw new Error('Token 历史文件正被另一个进程更新，请稍后重试')
    try {

    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.dirty = false

    mkdirSync(join(this.path, '..'), { recursive: true })
    const merged = this.readFile()
    // 保留当前进程尚未落盘的其他日期增量。
    for (const [pendingDay, buckets] of this.days) {
      if (pendingDay === day) continue
      const base = this.written.get(pendingDay)
      let target = merged.get(pendingDay)
      for (const [key, bucket] of buckets) {
        const delta = subtractBucket(bucket, base?.get(key))
        if (delta === undefined) continue
        if (target === undefined) {
          target = new Map()
          merged.set(pendingDay, target)
        }
        const existing = target.get(key)
        target.set(key, existing === undefined ? delta : addBucket(existing, delta))
      }
    }

    // 即使磁盘上该日已被外部删除，也要落下其他日期的待写增量。
    merged.delete(day)

    try {
      // 删除操作只改目标日，不借机淘汰其他日期。
      this.writeDays(merged, false)
    } catch (error) {
      this.scheduleFlush()
      throw error
    }

    // 原 Map 可能被历史读取器暂存，原地更新可确保后续读取马上看不到该日。
    this.days.clear()
    for (const [persistedDay, buckets] of merged) this.days.set(persistedDay, buckets)
    this.written = cloneDays(this.days)
    return true
    } finally {
      releaseLock()
    }
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
    let releaseLock: (() => void) | undefined
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      releaseLock = this.acquireWriteLock()
      if (releaseLock === undefined) {
        this.scheduleFlush()
        return
      }
      // ① 盘上现况（含别的实例刚写的）
      const merged = this.readFile()
      // ② 把本实例的增量并进去
      //
      // ⚠️ **必须跳过「零增量」的桶**（真实缺陷，审计发现并原样复现：R1「幽灵日」）：
      // 若盘上的某个日键被**外部删除**（手工编辑 / 另一工作区的旧版本整体覆盖 /
      // 从备份恢复），而本实例内存里仍留着它，那么「全量遍历 + delta=0 也写入」
      // 会把该日**重新建成一个全 0 桶** —— 内存里还是真值（被掩盖），**重启后
      // 变成 0 且不可恢复**。故 `subtractBucket` 对零增量返回 `undefined`，这里跳过。
      let hasDelta = false
      for (const [day, buckets] of this.days) {
        const base = this.written.get(day)
        let target = merged.get(day)
        for (const [key, bucket] of buckets) {
          const delta = subtractBucket(bucket, base?.get(key))
          if (delta === undefined) continue // 本次没有新增量 ⇒ 不碰盘上这一桶
          hasDelta = true
          if (target === undefined) {
            target = new Map()
            merged.set(day, target)
          }
          const existing = target.get(key)
          if (existing === undefined) {
            target.set(key, delta)
          } else {
            target.set(key, addBucket(existing, delta))
          }
        }
      }
      // ⚠️ 没有任何新增量 ⇒ **直接返回，不重写文件**。
      // 与 `gemini-sigstore.ts` 的 `if (!this.dirty) return` 同款脏检查：避免
      // 无谓的「全量读 + parse + stringify + 原子写」（实测 500 桶/天时该动作约
      // 132ms 同步阻塞，且这段代码跑在 setTimeout 回调里 = 阻塞事件循环）。
      if (!hasDelta) return
      // ③ 原子写（淘汰过老日键）
      this.writeDays(merged)
      // ④ 基线前移（只在写盘成功后）
      this.written = cloneDays(this.days)
    } catch (error) {
      // 落盘失败只记日志：账本还有内存兜底，不能反噬推理。
      this.logger?.warn(`[jet-hub] 写入 ${this.path} 失败（本次统计不入盘）: ${String(error)}`)
    } finally {
      releaseLock?.()
    }
  }

  /** 原子写入指定日表。 */
  private writeDays(source: TokenLedgerDayMap, applyRetention = true): void {
    const days: Record<string, Record<string, unknown>> = {}
    const retained = applyRetention ? pruneDays(source) : source
    for (const [day, buckets] of retained) days[day] = Object.fromEntries(buckets)
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, JSON.stringify({ schema: SCHEMA, days }, null, 2), 'utf-8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.path)
  }
}

/** 深拷贝日聚合表（桶对象也复制，避免与基线共享引用）。 */
function cloneDays(days: TokenLedgerDayMap): TokenLedgerDayMap {
  const out: TokenLedgerDayMap = new Map()
  for (const [day, buckets] of days) {
    out.set(day, new Map([...buckets].map(([key, bucket]) => [key, {
      ...bucket,
      tpsHistogram: { ...(bucket.tpsHistogram ?? {}) },
    }])))
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
    tpsHistogram: mergeHistograms(a.tpsHistogram, b.tpsHistogram),
  }
}

function mergeHistograms(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
  subtract = false,
): Record<string, number> {
  const result = { ...(a ?? {}) }
  for (const [key, count] of Object.entries(b ?? {})) {
    const next = (result[key] ?? 0) + (subtract ? -count : count)
    if (next > 0) result[key] = next
    else delete result[key]
  }
  return result
}

/**
 * 增量 = 当前桶 − 基线桶（逐字段）。
 *
 * ⚠️ 负数一律钳到 0：手工编辑过文档、或基线比当前大时（理论上不该发生），
 * 相减会得到负数，写进账本会**倒扣**用户的历史用量 —— 宁可少记也不能倒扣。
 *
 * ⚠️ **全字段为 0 时返回 `undefined`**（而不是零值对象）：调用方据此**跳过**
 * 该桶，避免把「零增量」写回盘上 —— 否则外部删掉的日键会被**重建为全 0 桶**，
 * 造成静默数据丢失（见 `flush` 的注释与「幽灵日」回归用例）。
 */
function subtractBucket(
  current: TokenLedgerDayBucket,
  base: TokenLedgerDayBucket | undefined,
): TokenLedgerDayBucket | undefined {
  if (base === undefined) {
    // 基线里没有（本实例新建的桶）：整体就是增量，但若它本身全 0 也无意义。
    return isZeroBucket(current) ? undefined : { ...current }
  }
  const diff = (a: number, b: number): number => Math.max(0, a - b)
  const delta: TokenLedgerDayBucket = {
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
    tpsHistogram: mergeHistograms(current.tpsHistogram, base.tpsHistogram, true),
  }
  return isZeroBucket(delta) ? undefined : delta
}

/** 桶的所有字段是否都为 0（= 没有任何增量）。 */
function isZeroBucket(bucket: TokenLedgerDayBucket): boolean {
  return bucket.requests === 0 && bucket.reportedRequests === 0
    && bucket.inputTokens === 0 && bucket.outputTokens === 0
    && bucket.cacheReadTokens === 0 && bucket.cacheWriteTokens === 0
    && bucket.reasoningTokens === 0 && bucket.errors === 0
    && bucket.ttftSumMs === 0 && bucket.ttftCount === 0
    && bucket.tpsSum === 0 && bucket.tpsCount === 0
    && Object.values(bucket.tpsHistogram ?? {}).every((count) => count === 0)
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
