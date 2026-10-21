/**
 * 「供应商 → 模型列表」统一管理页的纯判定。
 *
 * ## 为什么单独成模块
 * 本仓库的单测环境里**没有 react**，组件无法渲染 —— 分组、筛选、计数这些
 * **判定**必须落在可被真实用例驱动的纯函数里，组件只负责把结果摆出来。
 * 同目录的 `model-filter.js` / `model-groups.js` / `model-bulk.js` 都是这个分工
 * （见 `provider-toggle.spec.ts` 文件头：「判定在纯净模块里，组件只做源码级断言」）。
 *
 * ## 与 `model-filter.js` 的分工（不要重复实现）
 * 单个 provider 内部筛模型，`filterModels()` 已经够了。本模块只多出**一层**：
 * 「哪些供应商分组该出现在结果里」以及「供应商名命中搜索词时怎么处理」。
 * 模型级匹配一律转调 `filterModels()`，不另写一份 —— 写两份必然分叉
 * （`模型状态筛选` 的判据分散过两次，2026-10-08 收敛到 model-filter.js）。
 *
 * ## 为什么需要「未加载」这一态
 * 统一管理页要覆盖 20 家供应商，一次性并发拉全部目录会同时打 20+ 个上游
 * （Cline / WorkBuddy 的目录本身要访问远端），既容易触发限流，也会让界面
 * 长时间无反馈。所以**按需加载**：分组折叠时不发请求，展开才拉。
 * 于是「未加载」是一等状态，不能把它当成「0 个模型」—— 那会谎报
 * 「这家没有可关闭的模型」，用户就不会去展开它。
 */

import { filterModels, isFilterActive } from './model-filter.js'

/**
 * 单个供应商的模型统计。
 *
 * 非数组按空表处理（`state.models` 在未加载时可能是 `null` / `undefined`）；
 * 不抛错是刻意的 —— 渲染路径上抛错会让整页白屏，而这只是统计。
 *
 * `dead`（上游已下架）单独计数：它**不受用户开关控制**，关闭它没有意义，
 * 面板上要用「重新显示」而不是开关（见 `ModelToggle`）。
 */
export function providerModelSummary(models) {
  const list = Array.isArray(models) ? models : []
  let disabled = 0
  let dead = 0
  for (const model of list) {
    if (model !== null && typeof model === 'object' && model.disabled === true) disabled += 1
    if (model !== null && typeof model === 'object' && model.dead === true) dead += 1
  }
  return { total: list.length, disabled, dead }
}

/**
 * 供应商名或 id 是否命中搜索词。
 *
 * 空词恒 `false` —— 「空搜索」不该让每一家都算「名字命中」，否则下面的
 * 状态筛选会失效（名字命中会跳过搜索词过滤，空搜索就会把全部模型放进来）。
 */
export function providerMatchesQuery(provider, query) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (needle.length === 0) return false
  const label = typeof provider?.label === 'string' ? provider.label.toLowerCase() : ''
  const id = typeof provider?.id === 'string' ? provider.id.toLowerCase() : ''
  return label.includes(needle) || id.includes(needle)
}

/**
 * 计算一个供应商分组的展示态。
 *
 * @param provider `PROVIDERS` 的元素（`{ id, label, ... }`）
 * @param state `{ phase: 'idle'|'loading'|'ready'|'error', models, error }`；
 *              缺省/非对象一律视为未加载
 * @param options `{ query, status }`（与 `filterModels` 同名同义）
 *
 * 语义：
 * - **未加载**：`models` 为空、`hit` 恒 `true`（必须留在列表里，用户才知道
 *   有这家可展开；把未加载的隐藏掉，搜索时就再也找不到还没拉过的那家）。
 * - **供应商名命中**：该家全部模型参与展示，只再按状态筛 —— 用户搜
 *   「WorkBuddy」时要看到这家所有模型，而不是「名字里带 WorkBuddy 的模型」。
 * - **无筛选**：`hit` 恒 `true`（哪怕这家 0 个模型也要露出来报「没有可用模型」）。
 * - **有筛选且已加载**：只有在有模型命中时才留下。
 */
export function centerSectionFor(provider, state, options = {}) {
  const phase = typeof state?.phase === 'string' ? state.phase : 'idle'
  const loaded = phase === 'ready'
  const all = Array.isArray(state?.models) ? state.models : []
  const filtering = isFilterActive(options)
  const nameHit = providerMatchesQuery(provider, options?.query)
  const models = loaded
    ? filterModels(all, { query: nameHit ? '' : options?.query, status: options?.status })
    : []
  const hit = !filtering || !loaded ? true : models.length > 0
  return {
    id: typeof provider?.id === 'string' ? provider.id : '',
    label: typeof provider?.label === 'string' ? provider.label : '',
    phase,
    loaded,
    error: typeof state?.error === 'string' ? state.error : '',
    models,
    summary: providerModelSummary(all),
    filtering,
    nameHit,
    matched: models.length,
    hit,
  }
}

/**
 * 把 `providers` + 各自的加载态整体算成待渲染的分组列表（已过滤掉 `hit === false`）。
 *
 * `states` 是 `{ [providerId]: state }`；缺失的 provider 走未加载分支。
 * 顺序严格跟 `providers` 的声明顺序（= 用户熟悉的供应商顺序），不做任何重排。
 */
export function visibleCenterSections(providers, states, options = {}) {
  const list = Array.isArray(providers) ? providers : []
  const map = states !== null && typeof states === 'object' ? states : {}
  const out = []
  for (const provider of list) {
    const id = typeof provider?.id === 'string' ? provider.id : ''
    const section = centerSectionFor(provider, map[id], options)
    if (section.hit) out.push(section)
  }
  return out
}

/**
 * 跨分组总览。
 *
 * ⚠️ **只统计已加载的分组**。把未加载的算成 0 会谎报「共 0 个模型，全部打开」，
 * 用户会以为已经在管全部模型了。`loaded` 字段就是给界面写「已读取 3 / 20 家」用的。
 */
export function centerTotals(sections) {
  const list = Array.isArray(sections) ? sections : []
  let loaded = 0
  let total = 0
  let disabled = 0
  for (const section of list) {
    if (section?.loaded !== true) continue
    loaded += 1
    total += section.summary?.total ?? 0
    disabled += section.summary?.disabled ?? 0
  }
  return { loaded, total, disabled }
}

/**
 * 还没拉过目录的 provider id（「加载全部」只补这些，不重复打已就绪的家）。
 *
 * 失败（`phase === 'error'`）的也算进来 —— 用户点「加载全部」的意图是
 * 「把没拿到的补齐」，失败的家正是最需要重试的。
 */
export function centerPendingProviderIds(providers, states) {
  const list = Array.isArray(providers) ? providers : []
  const map = states !== null && typeof states === 'object' ? states : {}
  const out = []
  for (const provider of list) {
    const id = typeof provider?.id === 'string' ? provider.id : ''
    if (id.length === 0) continue
    const phase = typeof map[id]?.phase === 'string' ? map[id].phase : 'idle'
    if (phase !== 'ready') out.push(id)
  }
  return out
}
