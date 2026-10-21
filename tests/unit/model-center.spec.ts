import { describe, expect, it } from 'vitest'

import {
  centerPendingProviderIds,
  centerSectionFor,
  centerTotals,
  providerMatchesQuery,
  providerModelSummary,
  visibleCenterSections,
} from '../../plugin-src/client/model-center.js'

const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, disabled: false, ...extra })
const ready = (models: unknown[]) => ({ phase: 'ready', models })

describe('providerModelSummary（单个供应商的统计）', () => {
  it('数出总数、已关闭数、已下架数', () => {
    const models = [
      model('a'),
      model('b', { disabled: true }),
      model('c', { dead: true }),
      model('d', { disabled: true, dead: true }),
    ]
    expect(providerModelSummary(models)).toEqual({ total: 4, disabled: 2, dead: 2 })
  })

  it('非数组按空表处理，不抛错（未加载时 models 可能是 null/undefined）', () => {
    expect(providerModelSummary(null)).toEqual({ total: 0, disabled: 0, dead: 0 })
    expect(providerModelSummary(undefined)).toEqual({ total: 0, disabled: 0, dead: 0 })
    expect(providerModelSummary({ length: 3 })).toEqual({ total: 0, disabled: 0, dead: 0 })
  })

  it('数组里的 null / 非对象元素不参与计数，也不炸', () => {
    expect(providerModelSummary([null, 1, 'x', model('a', { disabled: true })])).toEqual({
      total: 4,
      disabled: 1,
      dead: 0,
    })
  })
})

describe('providerMatchesQuery（供应商名命中）', () => {
  const provider = { id: 'workbuddy', label: 'WorkBuddy (国际版)' }

  it('label 与 id 都参与匹配，不区分大小写', () => {
    expect(providerMatchesQuery(provider, 'workbuddy')).toBe(true)
    expect(providerMatchesQuery(provider, 'WORKBUDDY')).toBe(true)
    expect(providerMatchesQuery(provider, '国际版')).toBe(true)
    expect(providerMatchesQuery(provider, ' 国际版  ')).toBe(true)
  })

  it('空词恒 false —— 空搜索不能让每一家都算「名字命中」', () => {
    // 若返回 true，状态筛选会被整体跳过（名字命中不参与搜索词过滤），
    // 「已关闭」筛选就会把全部模型放进来。
    expect(providerMatchesQuery(provider, '')).toBe(false)
    expect(providerMatchesQuery(provider, '   ')).toBe(false)
    expect(providerMatchesQuery(provider, null)).toBe(false)
    expect(providerMatchesQuery(provider, undefined)).toBe(false)
  })

  it('不相关词返回 false', () => {
    expect(providerMatchesQuery(provider, 'minimax')).toBe(false)
  })
})

describe('centerSectionFor（单个分组的展示态）', () => {
  const provider = { id: 'workbuddy', label: 'WorkBuddy' }

  it('未加载：models 为空、loaded=false、hit 恒 true', () => {
    // 未加载的组必须留在列表里 —— 隐藏掉的话，用户搜索时就再也找不到
    // 自己还没展开过的那家（它根本没机会被匹配）。
    const section = centerSectionFor(provider, undefined, { query: 'zzz', status: 'all' })
    expect(section.loaded).toBe(false)
    expect(section.phase).toBe('idle')
    expect(section.models).toEqual([])
    expect(section.hit).toBe(true)
  })

  it('已加载且无筛选：全部模型都在，hit=true（0 个模型也要露出来报「没有可用模型」）', () => {
    const section = centerSectionFor(provider, ready([model('a'), model('b', { disabled: true })]), {})
    expect(section.loaded).toBe(true)
    expect(section.models.map(m => m.id)).toEqual(['a', 'b'])
    expect(section.hit).toBe(true)

    const empty = centerSectionFor(provider, ready([]), {})
    expect(empty.hit).toBe(true)
    expect(empty.summary.total).toBe(0)
  })

  it('按搜索词只留命中的模型', () => {
    const models = [model('glm-5.3'), model('deepseek-v4.1-flash')]
    const section = centerSectionFor(provider, ready(models), { query: 'glm' })
    expect(section.models.map(m => m.id)).toEqual(['glm-5.3'])
    expect(section.hit).toBe(true)
  })

  it('有筛选且一个都没命中：hit=false（整组隐藏）', () => {
    const section = centerSectionFor(provider, ready([model('glm-5.3')]), { query: 'minimax-only' })
    expect(section.models).toEqual([])
    expect(section.hit).toBe(false)
  })

  it('★ 供应商名命中时展示该家全部模型（只再按状态筛），而不是「名字里带该词的模型」', () => {
    const models = [model('glm-5.3'), model('deepseek-v4.1-flash'), model('kimi-k3', { disabled: true })]
    const section = centerSectionFor(provider, ready(models), { query: 'WorkBuddy', status: 'all' })
    expect(section.nameHit).toBe(true)
    expect(section.models.map(m => m.id)).toEqual(['glm-5.3', 'deepseek-v4.1-flash', 'kimi-k3'])

    const onlyDisabled = centerSectionFor(provider, ready(models), { query: 'WorkBuddy', status: 'disabled' })
    expect(onlyDisabled.models.map(m => m.id)).toEqual(['kimi-k3'])
  })

  it('状态筛选生效：enabled / disabled 各留一半', () => {
    const models = [model('a'), model('b', { disabled: true })]
    expect(centerSectionFor(provider, ready(models), { status: 'enabled' }).models.map(m => m.id)).toEqual(['a'])
    expect(centerSectionFor(provider, ready(models), { status: 'disabled' }).models.map(m => m.id)).toEqual(['b'])
  })

  it('error 态：把错误文案带出去，不把它当成「0 个模型」', () => {
    const section = centerSectionFor(provider, { phase: 'error', models: [], error: '上游 502' }, {})
    expect(section.loaded).toBe(false)
    expect(section.error).toBe('上游 502')
    expect(section.hit).toBe(true)
  })
})

describe('visibleCenterSections（整页分组）', () => {
  const providers = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
  ]

  it('保持 providers 的声明顺序，不做重排', () => {
    const states = { a: ready([model('x')]), b: ready([model('y')]), c: ready([model('z')]) }
    expect(visibleCenterSections(providers, states, {}).map(s => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('未加载的组即使有搜索词也保留（用户要知道还有哪家可展开）', () => {
    const states = { a: ready([model('glm')]) }
    const out = visibleCenterSections(providers, states, { query: 'glm' })
    // a 命中、b/c 未加载 ⇒ 都留下（未加载无法判断，隐藏了就再也「搜不到」）
    expect(out.map(s => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('已加载但一个都没命中的组隐藏；顺序仍是 providers 的声明顺序', () => {
    // c 已加载且 0 个模型 —— 有筛选时没有东西可展示，隐藏是合理的。
    const states = { b: ready([model('glm')]), c: ready([]) }
    const out = visibleCenterSections(providers, states, { query: 'glm' })
    expect(out.map(s => s.id)).toEqual(['a', 'b'])
  })

  it('states 传 null / 非对象时全部当未加载，不抛错', () => {
    expect(visibleCenterSections(providers, null, {}).map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect(visibleCenterSections(providers, 'oops', {}).map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect(visibleCenterSections(null, {}, {})).toEqual([])
  })
})

describe('centerTotals（跨分组总览）', () => {
  const section = (loaded: boolean, total: number, disabled: number) => ({
    loaded,
    summary: { total, disabled, dead: 0 },
  })

  it('只统计已加载的组', () => {
    const totals = centerTotals([section(true, 10, 3), section(false, 999, 999), section(true, 5, 1)])
    expect(totals).toEqual({ loaded: 2, total: 15, disabled: 4 })
  })

  it('一个都没加载时是 0/0/0 —— 界面据此写「已读取 0 / N 家」，不能谎报「全部已打开」', () => {
    expect(centerTotals([section(false, 100, 50)])).toEqual({ loaded: 0, total: 0, disabled: 0 })
  })

  it('非数组与缺字段都安全', () => {
    expect(centerTotals(null)).toEqual({ loaded: 0, total: 0, disabled: 0 })
    expect(centerTotals([{}, { loaded: true }])).toEqual({ loaded: 1, total: 0, disabled: 0 })
  })
})

describe('centerPendingProviderIds（加载全部时补哪些）', () => {
  const providers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

  it('idle / loading / error 都要补，ready 跳过', () => {
    const states = { a: ready([]), b: { phase: 'error' }, c: { phase: 'loading' } }
    expect(centerPendingProviderIds(providers, states)).toEqual(['b', 'c', 'd'])
  })

  it('空 id 不参与（PROVIDERS 元素缺 id 时不该发出无效 provider 参数）', () => {
    expect(centerPendingProviderIds([{ id: '' }, { id: 'a' }], {})).toEqual(['a'])
  })

  it('states 传 null 时全部待加载', () => {
    expect(centerPendingProviderIds(providers, null)).toEqual(['a', 'b', 'c', 'd'])
  })
})
