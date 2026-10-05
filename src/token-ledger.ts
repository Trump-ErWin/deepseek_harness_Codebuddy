/**
 * **Token 账本**（全 provider 的用量流水 + 渠道 × provider × 模型三维聚合）。
 *
 * ## 为什么它必须存在（issue 诉求）
 *
 * 全部适配器在流结束时都已产出 dsh-llm 的标准 `type:'usage'` chunk
 * （`TokenUsage`：`inputTokens / outputTokens / cacheReadTokens /
 * cacheWriteTokens / reasoningTokens / totalTokens`），但解析完就丢弃 ——
 * 用户无法回答「今天用了多少 token」「直连与网关各用多少」。本模块把
 * 「存下来」这一跳补上，**不改任何适配器的推理路径**。
 *
 * ## 记账点：注册收敛层（单点覆盖）
 *
 * 记账由 {@link ./llm-register-compat.ts} 的包装注册调用（每笔请求恰好一次），
 * 不碰 13 个适配器。渠道区分靠网关侧打标（`src/openai-gateway/channel.ts`）：
 * 网关请求在 `GenerateOptions` 上带 `gatewayChannelMark`，读到即 `gateway`，
 * 否则 `direct` —— **精确打标，不是差值估算**。
 *
 * ## 存储是进程内存，重启即丢（刻意，第 1 期与 cline-request-log 同决策）
 *
 * 高频写入的派生数据持久化会把每笔推理变成一次磁盘写；「本周用量」这类
 * 长周期诉求随第 2 期持久化一并做。上限 {@link TOKEN_LEDGER_LIMIT} 条，
 * 写满淘汰最旧。聚合树在读取时按需重建（条数有限，O(n) 足够快，
 * 不为省这点计算引入增量维护的双写复杂度）。
 *
 * ## ⚠️ record() **绝不抛错**：它在推理的关键路径上
 *
 * 与 `src/cline-request-log.ts` 同款约束：这里抛错会把记账失败反噬成
 * 推理失败。所有入参截断/钳制，`Object.freeze` 防止调用方修改共享对象。
 */

/** 一条请求记录。 */
export interface TokenLedgerEntry {
  /** 请求**发起**时刻（毫秒时间戳）。 */
  ts: number
  /** 流量来自哪条通道：DSH 宿主对话 = `direct`；OpenAI 兼容网关 = `gateway`。 */
  channel: 'direct' | 'gateway'
  /** provider id（如 `codearts` / `qoder`）。 */
  provider: string
  /** 模型 id（wire 上的 `model`）。 */
  model: string
  /**
   * 是否收到过 usage chunk。
   *
   * ⚠️ 与「token 为 0」**不是一回事**：没收到 usage（abort / 上游提前断开 /
   * 请求失败）时表格必须显示 `—`，给 0 会被读成「瞬间完成、没花 token」
   * （`cline-request-log` 同约定）。
   */
  usageReported: boolean
  /** 输入 token（未命中缓存的部分，dsh-llm 口径）。 */
  inputTokens: number
  /** 输出 token（含思考 token）。 */
  outputTokens: number
  /** 缓存命中的输入 token（缺失时省略）。 */
  cacheReadTokens?: number
  /** 缓存写入的 token（缺失时省略）。 */
  cacheWriteTokens?: number
  /** 思考 token（缺失时省略；已含在 outputTokens 内）。 */
  reasoningTokens?: number
  /** 全程耗时（毫秒）。 */
  durationMs: number
  /** 失败原因；成功行省略。 */
  error?: string
}

/** 渠道 → provider → 模型 三级聚合的一行（模型粒度）。 */
export interface TokenLedgerModelRow {
  model: string
  /** 请求数（含失败）。 */
  requests: number
  /** 收到过 usage 的请求数（usageReported = true 的子集）。 */
  reportedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** 失败请求数。 */
  errors: number
}

/** 一个 provider 下的聚合（模型行 + 自身小计）。 */
export interface TokenLedgerProviderRow {
  provider: string
  models: TokenLedgerModelRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
}

/** 一个渠道下的聚合（provider 行 + 自身小计）。 */
export interface TokenLedgerChannelRow {
  channel: 'direct' | 'gateway'
  providers: TokenLedgerProviderRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
}

/** 读侧返回：三维聚合树 + 全局小计 + 最近明细。 */
export interface TokenLedgerSnapshot {
  channels: TokenLedgerChannelRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
  /** 最近明细（最新在前），`entries` 的条数即 `limit`（不超上限）。 */
  entries: TokenLedgerEntry[]
}

/** 流水上限。500 条足够回溯近期活动，内存占用可忽略。 */
export const TOKEN_LEDGER_LIMIT = 500

/** 内存中的流水（最新在前）。 */
let ledger: TokenLedgerEntry[] = []

/** 数值字段的统一钳制：非有限值/负数 → 0，截断小数。 */
function clampCount(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

/**
 * 记录一笔请求。
 *
 * ⚠️ **本函数绝不抛错**（见模块头）。字段全部截断/钳制，写满即淘汰最旧。
 */
export function recordTokenUsage(entry: Omit<TokenLedgerEntry, 'ts'>): void {
  try {
    const usageReported = entry.usageReported === true
    const cacheRead = clampCount(entry.cacheReadTokens)
    const cacheWrite = clampCount(entry.cacheWriteTokens)
    const reasoning = clampCount(entry.reasoningTokens)
    ledger.unshift(Object.freeze({
      ts: Date.now(),
      // channel 只认两个合法值，垃圾值一律落回 `direct`（保守缺省）。
      channel: entry.channel === 'gateway' ? 'gateway' : 'direct',
      provider: String(entry.provider ?? '').slice(0, 64),
      model: String(entry.model ?? '').slice(0, 160),
      usageReported,
      inputTokens: clampCount(entry.inputTokens),
      outputTokens: clampCount(entry.outputTokens),
      // ⚠️ 0 / 缺失一律**省略字段**而不是写 0：与接口注释一致，
      // 「没有缓存命中」与「命中 0 个」无从区分时，缺省是更诚实的表示。
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
      ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
      durationMs: clampCount(entry.durationMs),
      ...(typeof entry.error === 'string' && entry.error.length > 0
        ? { error: entry.error.slice(0, 200) }
        : {}),
    }) as TokenLedgerEntry)
    if (ledger.length > TOKEN_LEDGER_LIMIT) ledger.length = TOKEN_LEDGER_LIMIT
  } catch {
    // 记账失败绝不反噬推理（见函数注释）。
  }
}

/** 空聚合行（防重复初始化代码）。 */
function emptyTotals(): Omit<TokenLedgerModelRow, 'model'> {
  return {
    requests: 0,
    reportedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    errors: 0,
  }
}

/** 把一条记录累加进聚合行。 */
function accumulate(totals: Omit<TokenLedgerModelRow, 'model'>, entry: TokenLedgerEntry): void {
  totals.requests += 1
  if (entry.usageReported) totals.reportedRequests += 1
  if (entry.error !== undefined) totals.errors += 1
  // ⚠️ 只有 usageReported 的行才计入 token 汇总：失败行/未报行写 0 会把
  // 「没收到用量」混进「真的用了 0」，摊薄均值类读数。
  if (!entry.usageReported) return
  totals.inputTokens += entry.inputTokens
  totals.outputTokens += entry.outputTokens
  totals.cacheReadTokens += entry.cacheReadTokens ?? 0
  totals.cacheWriteTokens += entry.cacheWriteTokens ?? 0
  totals.reasoningTokens += entry.reasoningTokens ?? 0
}

/** 排序键：token 合计降序（谁烧得多谁在前），纯读取层约定。 */
function sumTokens(t: Omit<TokenLedgerModelRow, 'model'>): number {
  return t.inputTokens + t.outputTokens
}

/**
 * 读取账本快照（聚合树 + 全局小计 + 最近明细）。
 *
 * 纯读取、不改状态；每次按需重建聚合树（见模块头「不为 O(n) 引入双写」）。
 * 聚合与明细都来自同一份 `ledger`，**天然同源**——不存在「树与小计各算一遍」
 * 的口径漂移。各级排序：渠道按 `direct → gateway`、provider/模型按 token
 * 合计降序（谁烧得多谁在前）。
 */
export function readTokenLedger(options: { limit?: number } = {}): TokenLedgerSnapshot {
  const limit = Math.max(0, Math.min(options.limit ?? TOKEN_LEDGER_LIMIT, TOKEN_LEDGER_LIMIT))

  // ── 第一遍：逐条累加进三级聚合（全局小计顺路算出）──
  const totals = emptyTotals()
  /** channel → provider → model → 聚合行 */
  const channelMap = new Map<TokenLedgerEntry['channel'], Map<string, Map<string, Omit<TokenLedgerModelRow, 'model'>>>>()
  for (const entry of ledger) {
    accumulate(totals, entry)
    let providers = channelMap.get(entry.channel)
    if (providers === undefined) {
      providers = new Map()
      channelMap.set(entry.channel, providers)
    }
    let models = providers.get(entry.provider)
    if (models === undefined) {
      models = new Map()
      providers.set(entry.provider, models)
    }
    let row = models.get(entry.model)
    if (row === undefined) {
      row = emptyTotals()
      models.set(entry.model, row)
    }
    accumulate(row, entry)
  }

  // ── 第二遍：把 Map 树落成数组并逐级求小计（父级 = 子级之和）──
  const channels: TokenLedgerChannelRow[] = [...channelMap.entries()]
    .sort(([a], [b]) => (a === 'direct' ? -1 : 1) - (b === 'direct' ? -1 : 1))
    .map(([channel, providers]) => {
      const channelTotals = emptyTotals()
      const providerRows: TokenLedgerProviderRow[] = [...providers.entries()].map(([provider, models]) => {
        const providerTotals = emptyTotals()
        const modelRows: TokenLedgerModelRow[] = [...models.entries()].map(([model, row]) => {
          // provider 小计 = 其各模型行之和
          for (const key of Object.keys(row) as (keyof typeof row)[]) {
            providerTotals[key] += row[key]
          }
          return { model, ...row }
        }).sort((a, b) => sumTokens(b) - sumTokens(a))
        // 渠道小计 = 其各 provider 之和
        for (const key of Object.keys(providerTotals) as (keyof typeof providerTotals)[]) {
          channelTotals[key] += providerTotals[key]
        }
        return { provider, models: modelRows, totals: providerTotals }
      }).sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
      return { channel, providers: providerRows, totals: channelTotals }
    })

  return {
    channels,
    totals,
    entries: ledger.slice(0, limit),
  }
}

/**
 * 测试与 dispose 专用：清空账本。
 *
 * ⚠️ 不导出给 RPC/UI —— 正常运行时账本不该被外部清空（用户看到「突然归零」
 * 会以为丢了数据）；只有单测需要隔离状态。
 */
export function resetTokenLedgerForTests(): void {
  ledger = []
}

/** 当前保留的流水条数（诊断用）。 */
export function tokenLedgerSize(): number {
  return ledger.length
}
