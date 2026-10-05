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
import { mergeDayEntry, type TokenLedgerDayMap } from './token-ledger.js'

/** 独立文档的文件名（与 state.json 同目录）。 */
export const TOKEN_LEDGER_FILE = 'token-ledger.json'

/** 日聚合保留天数（落盘时淘汰更早的日键）。 */
export const TOKEN_LEDGER_DAYS = 90

/** 落盘节流窗口（毫秒）。 */
export const TOKEN_LEDGER_FLUSH_MS = 2_000

const SCHEMA = 'dsh-codearts-auth/token-ledger/v1'

/** 日聚合的持久化后端接口（同步读、节流异步写）。 */
export interface TokenLedgerStore {
  /** 启动时载入历史日聚合（文档不存在 = 空表）。 */
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
  /** 防抖计时器（Node 返回值带 unref，浏览器/测试环境可能没有）。 */
  private timer: ReturnType<typeof setTimeout> | undefined
  /** 节流窗口内又发生了写入时，flush 后需要再排一次。 */
  private dirty = false

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): TokenLedgerDayMap {
    try {
      if (!existsSync(this.path)) return this.days
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as { days?: unknown }
        if (typeof record.days === 'object' && record.days !== null && !Array.isArray(record.days)) {
          for (const [day, rawBuckets] of Object.entries(record.days as Record<string, unknown>)) {
            if (typeof rawBuckets !== 'object' || rawBuckets === null || Array.isArray(rawBuckets)) continue
            const bucketList = rawBuckets as Record<string, unknown>
            let target = this.days.get(day)
            if (target === undefined) {
              target = new Map()
              this.days.set(day, target)
            }
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
          }
        }
      }
    } catch (error) {
      // 损坏按空表处理（统计型数据不值得阻断启动）。
      this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，历史用量按空表处理: ${String(error)}`)
    }
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

  flush(): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      const days: Record<string, Record<string, unknown>> = {}
      for (const [day, buckets] of pruneDays(this.days)) {
        days[day] = Object.fromEntries(buckets)
      }
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, days }, null, 2), 'utf-8')
      renameSync(tmp, this.path)
    } catch (error) {
      // 落盘失败只记日志：账本还有内存兜底，不能反噬推理。
      this.logger?.warn(`[jet-hub] 写入 ${this.path} 失败（本次统计不入盘）: ${String(error)}`)
    }
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
