import { describe, expect, it } from 'vitest'
import {
  accountLabel,
  avgPerfText,
  barHeightPercent,
  channelCardTitle,
  channelLabel,
  channelOrder,
  entryTokenText,
  formatDuration,
  formatEntryTime,
  formatTps,
  formatTtft,
  formatTokenCount,
  filterChannelsBySelection,
  hasAnyData,
  historyTitle,
  HISTORY_RANGES,
  ledgerSubtitle,
  rangeDaysOf,
  tokenSummaryText,
  todayDayKey,
  trendBars,
} from '../../plugin-src/client/token-ledger-panel.js'

describe('formatTokenCount', () => {
  it('千分位：<10K 精确显示', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1234)).toBe('1,234')
    expect(formatTokenCount(9999)).toBe('9,999')
  })

  it('K / M 单位：大数紧凑，去尾随 0', () => {
    expect(formatTokenCount(10_000)).toBe('10K')
    expect(formatTokenCount(12_345)).toBe('12.35K')
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(94_540_000)).toBe('94.54M')
  })

  it('垃圾值按 0 处理（负数/NaN/非数）', () => {
    expect(formatTokenCount(-5)).toBe('0')
    expect(formatTokenCount(Number.NaN)).toBe('0')
    expect(formatTokenCount(undefined as never)).toBe('0')
  })
})

describe('tokenSummaryText / entryTokenText', () => {
  it('汇总：↓↑ 恒显，缓存/推理 >0 才显示', () => {
    expect(tokenSummaryText({ inputTokens: 1200, outputTokens: 340 })).toBe('↓1,200 ↑340')
    expect(tokenSummaryText({ inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, reasoningTokens: 56 }))
      .toBe('↓1,200 ↑340 ⚡800 🧠56')
    expect(tokenSummaryText({ inputTokens: 1200, outputTokens: 340, cacheWriteTokens: 9 }))
      .toBe('↓1,200 ↑340 ✎9')
    // 0 值段省略（不渲染恒 0 的装饰数字）
    expect(tokenSummaryText({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 }))
      .toBe('↓1 ↑2')
  })

  it('明细行：未收到 usage 显示 —，与「用了 0」严格区分', () => {
    expect(entryTokenText({ usageReported: false, inputTokens: 0, outputTokens: 0 })).toBe('—')
    expect(entryTokenText({ usageReported: true, inputTokens: 0, outputTokens: 0 })).toBe('↓0 ↑0')
    expect(entryTokenText(null)).toBe('—')
    expect(entryTokenText(undefined)).toBe('—')
  })
})

describe('formatDuration / formatEntryTime', () => {
  it('耗时：0/负数 → —，<1s 毫秒，≥1s 一位小数', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(320)).toBe('320ms')
    expect(formatDuration(4200)).toBe('4.2s')
  })

  it('时间：HH:MM:SS；垃圾时间戳 → —', () => {
    const d = new Date(2026, 9, 5, 8, 7, 9)
    expect(formatEntryTime(d.getTime())).toBe('08:07:09')
    expect(formatEntryTime(Number.NaN)).toBe('—')
  })
})

describe('渠道维度', () => {
  it('channelLabel / channelOrder：直连在前', () => {
    expect(channelLabel('direct')).toBe('直连')
    expect(channelLabel('gateway')).toBe('网关')
    expect(channelOrder('direct', 'gateway')).toBeLessThan(0)
    expect(channelOrder('gateway', 'direct')).toBeGreaterThan(0)
    expect(channelOrder('direct', 'direct')).toBe(0)
  })

  it('channelCardTitle：渠道名 + 请求数', () => {
    expect(channelCardTitle({ channel: 'gateway', totals: { requests: 7 } })).toBe('网关 · 7 次请求')
    expect(channelCardTitle(null)).toBe('直连 · 0 次请求')
  })

  it('filterChannelsBySelection：null = 全部；否则按渠道', () => {
    const channels = [
      { channel: 'direct', totals: { requests: 1 } },
      { channel: 'gateway', totals: { requests: 2 } },
    ]
    expect(filterChannelsBySelection(channels, null)).toHaveLength(2)
    expect(filterChannelsBySelection(channels, 'gateway')[0]!.channel).toBe('gateway')
    expect(filterChannelsBySelection(channels, 'direct')[0]!.channel).toBe('direct')
    expect(filterChannelsBySelection(undefined, null)).toEqual([])
  })
})

describe('空状态', () => {
  it('hasAnyData：有明细才 true；ledgerSubtitle 说明明细与存盘的差别', () => {
    expect(hasAnyData({ entries: [{ ts: 1 }] })).toBe(true)
    expect(hasAnyData({ entries: [] })).toBe(false)
    expect(hasAnyData(null)).toBe(false)
    const subtitle = ledgerSubtitle()
    // 第 2 期：明细重启清空，但日累计已落盘 —— 两者都要说清。
    expect(subtitle).toContain('重启')
    expect(subtitle).toContain('存盘')
  })
})

describe('账号维度（第 2 期）', () => {
  it('accountLabel：空串给「未归属」，其余原样', () => {
    expect(accountLabel('')).toBe('未归属')
    expect(accountLabel(undefined)).toBe('未归属')
    expect(accountLabel('qoder-bb211a53')).toBe('qoder-bb211a53')
  })
})

describe('首字用时与速率（第 3 期）', () => {
  it('formatTtft：缺失/0 → —；有值按耗时格式化', () => {
    expect(formatTtft(undefined)).toBe('—')
    expect(formatTtft({})).toBe('—')
    expect(formatTtft({ ttftMs: 0 })).toBe('—')
    expect(formatTtft({ ttftMs: 850 })).toBe('850ms')
    expect(formatTtft({ ttftMs: 2900 })).toBe('2.9s')
  })

  it('formatTps：缺失/非正 → —；有值带单位', () => {
    expect(formatTps(undefined)).toBe('—')
    expect(formatTps({ tps: 0 })).toBe('—')
    expect(formatTps({ tps: 52.3 })).toBe('52.3 tok/s')
    expect(formatTps({ tps: 100 })).toBe('100 tok/s')
  })

  it('avgPerfText：两边都无 → —；单边有值时另一边占位', () => {
    expect(avgPerfText(undefined)).toBe('—')
    expect(avgPerfText({})).toBe('—')
    expect(avgPerfText({ avgTtftMs: 850 })).toBe('首字 850ms · —')
    expect(avgPerfText({ avgTps: 48.2 })).toBe('首字 — · 48.2 tok/s')
    expect(avgPerfText({ avgTtftMs: 1200, avgTps: 51.5 })).toBe('首字 1.2s · 51.5 tok/s')
  })
})

describe('历史视图（第 4 期）', () => {
  it('HISTORY_RANGES / rangeDaysOf：窗口 key → 天数；未知 key 回退全部(0)', () => {
    expect(HISTORY_RANGES.map((r) => r.key)).toEqual(['today', '7d', '30d', 'all'])
    expect(rangeDaysOf('today')).toBe(1)
    expect(rangeDaysOf('7d')).toBe(7)
    expect(rangeDaysOf('30d')).toBe(30)
    expect(rangeDaysOf('all')).toBe(0)
    expect(rangeDaysOf('bogus')).toBe(0)
  })

  it('todayDayKey：与服务端 utc8DayKey 同形（YYYY-MM-DD）', () => {
    expect(todayDayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('trendBars：取前 N 根、标记今天、token 合计 = 输入+输出', () => {
    const history = [
      { day: todayDayKey(), totals: { requests: 3, inputTokens: 100, outputTokens: 50 } },
      { day: '2026-10-04', totals: { requests: 1, inputTokens: 10, outputTokens: 5 } },
      { day: '2026-10-03', totals: { requests: 0, inputTokens: 0, outputTokens: 0 } },
    ]
    const bars = trendBars(history)
    expect(bars).toHaveLength(3)
    expect(bars[0]!.isToday).toBe(true)
    expect(bars[0]!.tokens).toBe(150)
    expect(bars[2]!.tokens).toBe(0)
    // maxBars 截断
    expect(trendBars(history, 2)).toHaveLength(2)
    expect(trendBars(undefined)).toEqual([])
  })

  it('barHeightPercent：按最大值等比；保底 4%；零值/无数据为 0', () => {
    expect(barHeightPercent(150, 300)).toBe(50)
    expect(barHeightPercent(3, 300)).toBe(4) // 保底可见
    expect(barHeightPercent(0, 300)).toBe(0)
    expect(barHeightPercent(150, 0)).toBe(0)
  })

  it('historyTitle：窗口 key → 标题；未知回退「全部」', () => {
    expect(historyTitle('7d')).toBe('历史用量 · 近 7 天')
    expect(historyTitle('bogus')).toBe('历史用量 · 全部')
  })
})
