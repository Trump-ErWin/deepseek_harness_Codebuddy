import { describe, expect, it } from 'vitest'
import {
  channelCardTitle,
  channelLabel,
  channelOrder,
  entryTokenText,
  formatDuration,
  formatEntryTime,
  formatTokenCount,
  filterChannelsBySelection,
  hasAnyData,
  ledgerSubtitle,
  tokenSummaryText,
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
  it('hasAnyData：有明细才 true；ledgerSubtitle 说明重启清空', () => {
    expect(hasAnyData({ entries: [{ ts: 1 }] })).toBe(true)
    expect(hasAnyData({ entries: [] })).toBe(false)
    expect(hasAnyData(null)).toBe(false)
    const subtitle = ledgerSubtitle()
    expect(subtitle).toContain('重启')
  })
})
