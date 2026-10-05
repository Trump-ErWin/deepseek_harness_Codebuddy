import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  groupProviders,
  nextProviderOrderAfterDrop,
  providerSwitchRows,
  providerSwitchState,
  providerToggleSummary,
  sortOpenProvidersByOrder,
  summarizeProviderToggle,
} from '../../plugin-src/client/provider-toggle.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')
const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

/** 最小供应商定义（只用到 id，与真实 PROVIDERS 的结构一致）。 */
const P = (id) => ({ id, label: id })

/**
 * 取 `ProviderSwitchPanel` 组件的整段源码（到 `JetHubPage` 之前）。
 *
 * 本仓库的单测环境里没有 react，组件无法渲染 —— 结构与类名只能做源码级断言，
 * 而**判定**（谁该禁用、为什么禁用、顺序怎么排）全部在 `provider-toggle.js` 里，
 * 由下面的真实用例覆盖。两者分工不同，不是拿字符串匹配凑数。
 */
function panelBody(): string {
  const start = source.indexOf('function ProviderSwitchPanel(')
  expect(start, '找不到 ProviderSwitchPanel 组件').toBeGreaterThan(-1)
  // ⚠️ 结束锚点取「下一个顶层组件声明」，**不能**硬编码 `JetHubPage`：
  // 在两者之间插入任何组件（如 GatewayPanel），硬编码的 slice 都会把别人的
  // 源码一并吞进来，于是「本弹窗恰好一个 label / checkbox」这类计数断言会
  // 假性失败（2026-10-02 加网关弹窗时实测）。
  const rest = source.slice(start)
  const offset = rest.slice(1).search(/^(?:export )?function /m)
  return offset === -1 ? rest : rest.slice(0, offset + 1)
}

describe('groupProviders（左侧分组）', () => {
  it('按 closed 分成两组，且保持传入顺序', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    const statuses = {
      a: { closed: false },
      b: { closed: true },
      c: { closed: false },
      d: { closed: true },
    }
    const { open, closed } = groupProviders(providers, statuses)
    expect(open.map(p => p.id)).toEqual(['a', 'c'])
    expect(closed.map(p => p.id)).toEqual(['b', 'd'])
  })

  it('组内顺序就是传入顺序，不重排（用户认知顺序必须稳定）', () => {
    const providers = [P('z'), P('a'), P('m')]
    const { open } = groupProviders(providers, {})
    expect(open.map(p => p.id)).toEqual(['z', 'a', 'm'])
  })

  it('状态缺失的供应商归入「已打开」（宁多勿少，避免一次失败看成全被关）', () => {
    const providers = [P('a'), P('b')]
    const { open, closed } = groupProviders(providers, { a: { closed: true } })
    expect(open.map(p => p.id)).toEqual(['b'])
    expect(closed.map(p => p.id)).toEqual(['a'])
  })

  it('closed 只认显式 true（与黑名单「非 true 即打开」的判据一致）', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: 1 }, b: { closed: 'true' }, c: { closed: undefined } }
    expect(groupProviders(providers, statuses).open.map(p => p.id)).toEqual(['a', 'b', 'c'])
    expect(groupProviders(providers, statuses).closed).toEqual([])
  })

  it('statuses 为 null / 非对象时不抛错，全部归入已打开', () => {
    const providers = [P('a'), P('b')]
    expect(groupProviders(providers, null).open).toHaveLength(2)
    expect(groupProviders(providers, null).closed).toHaveLength(0)
    expect(groupProviders(providers, 'bogus').open).toHaveLength(2)
  })

  it('providers 非数组时返回两个空组（不抛错）', () => {
    const { open, closed } = groupProviders(null, {})
    expect(open).toEqual([])
    expect(closed).toEqual([])
  })
})

describe('providerSwitchState（开关三形态）', () => {
  it('有模型且未全关 → 已打开（checked=true），可点击', () => {
    const s = providerSwitchState({ models: { total: 30, disabled: 13 }, closed: false })
    expect(s).toEqual({ checked: true, disabled: false, reason: null })
  })

  it('全部模型已关闭 → checked=false（开关呈关闭态），仍可点击以重新打开', () => {
    const s = providerSwitchState({ models: { total: 17, disabled: 17 }, closed: true })
    expect(s.checked).toBe(false)
    expect(s.disabled).toBe(false)
  })

  it('① 没有任何模型 → 禁用并给出原因（「不关闭模型就不关闭供应商」）', () => {
    const s = providerSwitchState({ models: { total: 0, disabled: 0 }, closed: false })
    expect(s.disabled).toBe(true)
    expect(s.checked).toBe(true)
    expect(s.reason).toContain('没有可关闭的模型')
  })

  it('② 状态未知（undefined）→ 禁用并说明原因', () => {
    const s = providerSwitchState(undefined)
    expect(s.disabled).toBe(true)
    expect(s.reason).toBeTruthy()
  })

  it('③ 状态非对象（异常输入）→ 禁用而不是抛错', () => {
    expect(providerSwitchState(null).disabled).toBe(true)
    expect(providerSwitchState('bogus').disabled).toBe(true)
  })

  it('models 字段缺失时视为 0 → 禁用（不误判为可操作）', () => {
    expect(providerSwitchState({ accounts: { total: 1 } }).disabled).toBe(true)
  })

  it('total 为负数等非法值 → 禁用（不给用户一个无效的操作入口）', () => {
    expect(providerSwitchState({ models: { total: -5 } }).disabled).toBe(true)
  })
})

describe('summarizeProviderToggle（结果文案）', () => {
  it('关闭：报告实际关闭的模型与停用的账号数', () => {
    expect(summarizeProviderToggle(false, { models: 17, accounts: 1 }))
      .toBe('已关闭 17 个模型，已停用 1 个账号')
  })

  it('打开：报告实际打开的模型与启用的账号数', () => {
    expect(summarizeProviderToggle(true, { models: 17, accounts: 2 }))
      .toBe('已打开 17 个模型，已启用 2 个账号')
  })

  it('⚠️ 变更数为 0 时不得谎报「已停用 N 个」（幂等操作要照实说）', () => {
    expect(summarizeProviderToggle(false, { models: 5, accounts: 0 }))
      .toBe('已关闭 5 个模型，没有账号需要停用')
  })

  it('两侧都为 0 时如实说明无事可做', () => {
    expect(summarizeProviderToggle(true, { models: 0, accounts: 0 }))
      .toBe('模型本就全部打开，账号本就全部启用')
  })

  it('res 缺失 / 字段非数字时不抛错，按 0 处理', () => {
    expect(summarizeProviderToggle(false, null)).toBe('没有模型需要关闭，没有账号需要停用')
    expect(summarizeProviderToggle(false, { models: 'x', accounts: null }))
      .toBe('没有模型需要关闭，没有账号需要停用')
  })
})

/**
 * 「供应商开关」弹窗的行数据。
 *
 * 弹窗要渲染的是「供应商定义 × 状态表」的拼接结果（顺序、勾选态、禁用态与原因、
 * 影响面计数），这些判定必须在纯逻辑层，不能留在渲染层 —— 否则左侧分组与弹窗
 * 两处各写一遍，迟早出现「左侧说它关了、弹窗里它还是开的」。
 */
describe('providerSwitchRows（弹窗行数据）', () => {
  it('⚠️ 已打开在前、已关闭在后，与左侧分组同一判据', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    const statuses = {
      a: { closed: false, models: { total: 3, disabled: 0 } },
      b: { closed: true, models: { total: 2, disabled: 2 } },
      c: { closed: false, models: { total: 1, disabled: 0 } },
      d: { closed: true, models: { total: 4, disabled: 4 } },
    }
    const rows = providerSwitchRows(providers, statuses)
    expect(rows.map(r => r.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(rows.map(r => r.checked)).toEqual([true, true, false, false])
  })

  it('每行带出影响面计数，供界面显示「模型 N（已关 M）· 账号 X（启用 Y）」', () => {
    const rows = providerSwitchRows([P('a')], {
      a: { closed: false, models: { total: 12, disabled: 3 }, accounts: { total: 5, enabled: 2 } },
    })
    expect(rows[0].models).toEqual({ total: 12, disabled: 3 })
    expect(rows[0].accounts).toEqual({ total: 5, enabled: 2 })
  })

  it('⚠️ 状态缺失时计数是 null 而不是 0（「不知道」与「确实是 0」必须能区分）', () => {
    const rows = providerSwitchRows([P('a')], {})
    expect(rows[0].models).toBeNull()
    expect(rows[0].accounts).toBeNull()
    expect(rows[0].disabled).toBe(true)
    expect(rows[0].reason).toBe('状态尚未读取')
  })

  it('没有可关闭模型的供应商被禁用并给出原因（服务端也会拒绝这个动作）', () => {
    const rows = providerSwitchRows([P('a')], { a: { models: { total: 0, disabled: 0 } } })
    expect(rows[0].disabled).toBe(true)
    expect(rows[0].reason).toBe('该供应商没有可关闭的模型')
    // 仍然显示为「打开」：未知/无事可做的东西不该被画成被关闭。
    expect(rows[0].checked).toBe(true)
  })

  it('label 缺失时回退到 id（界面上不会出现空行）', () => {
    const rows = providerSwitchRows([{ id: 'codearts' }], { codearts: { models: { total: 1 } } })
    expect(rows[0].label).toBe('codearts')
  })

  it('statuses 为 null / 非对象、providers 非数组时都不抛错', () => {
    expect(providerSwitchRows([P('a')], null).map(r => r.disabled)).toEqual([true])
    expect(providerSwitchRows([P('a')], 'bogus')[0].reason).toBe('状态尚未读取')
    expect(providerSwitchRows(null, {})).toEqual([])
  })

  it('⚠️ 与 groupProviders 的结论必须一致（两处判据不能漂移）', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: true, models: { total: 2 } }, b: { models: { total: 2 } } }
    const { open, closed } = groupProviders(providers, statuses)
    const rows = providerSwitchRows(providers, statuses)
    expect(rows.filter(r => r.checked).map(r => r.id)).toEqual(open.map(p => p.id))
    expect(rows.filter(r => !r.checked).map(r => r.id)).toEqual(closed.map(p => p.id))
  })
})

describe('providerToggleSummary（页头与弹窗的计数）', () => {
  it('给出 open / closed / total 与 known', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: true }, b: { closed: false }, c: { closed: true } }
    expect(providerToggleSummary(providers, statuses))
      .toEqual({ open: 1, closed: 2, total: 3, known: true })
  })

  it('⚠️ 状态没读回来时 known=false 且计数为 0 —— 界面据此**不显示**计数', () => {
    // 「已打开 0、已关闭 0」会被读成「一个供应商都没有」，而真实原因只是
    // provider.status 还没回来（或失败了）。
    expect(providerToggleSummary([P('a'), P('b')], null)).toEqual({
      open: 2, closed: 0, total: 2, known: false,
    })
    expect(providerToggleSummary([P('a')], undefined).known).toBe(false)
  })

  it('closed 只认显式 true（与分组、行数据三处同一口径）', () => {
    const providers = [P('a'), P('b')]
    const statuses = { a: { closed: 'true' }, b: { closed: 1 } }
    expect(providerToggleSummary(providers, statuses)).toMatchObject({ open: 2, closed: 0 })
  })

  it('providers 非数组时 total 为 0 且不抛错', () => {
    expect(providerToggleSummary(null, {})).toEqual({ open: 0, closed: 0, total: 0, known: true })
  })
})

describe('供应商开关的接线（源码级回归）', () => {
  it('引用了纯逻辑模块，而不是在本文件里另写一份判定', () => {
    expect(source).toContain("from './provider-toggle.js'")
    expect(source).toContain('groupProviders(')
    expect(source).toContain('providerSwitchRows(')
    expect(source).toContain('providerToggleSummary(')
  })

  it('rail 渲染出两个分组标题并带计数', () => {
    expect(source).toContain('dim-jh-railGroup')
    expect(source).toContain('dim-jh-railGroupTitle')
    expect(source).toContain('`已打开 (${open.length})`')
    expect(source).toContain('`已关闭 (${closed.length})`')
  })

  /**
   * ⚠️ 这条锁的是本次改动的**核心要求**：开关不得再挂在左侧供应商行尾。
   * 它曾与「选择要看哪个供应商」这个高频无害动作挤在同一行 —— 一个破坏性批量
   * 操作挂在导航栏上，既容易误点，也让窄栏长出了控件。
   */
  it('⚠️ 左侧供应商行里不再有开关（只剩一个 tab 按钮）', () => {
    const start = source.indexOf('const renderProviderRow = (p) => {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('const renderRail = () =>'))
    expect(body).not.toContain("React.createElement('input'")
    expect(body).not.toContain("type: 'checkbox'")
    expect(body).toContain("role: 'tab'")
    // 行容器仍不挂 onClick：点击只属于 tab 按钮。
    expect(body).toContain("className: 'dim-jh-providerRow'")
    expect(body).not.toMatch(/dim-jh-providerRow'[^}]*onClick/)
  })

  it('开关搬进弹窗：页头按钮点开，关闭即不挂载', () => {
    // ⚠️ 按钮文字是「供应商」而不是「供应商开关」：页头要排成一排，
    // 5 个字会把「关闭」挤到第二行。完整语义由 tooltip 与弹窗标题承担。
    expect(source).toContain("}, '供应商')")
    expect(source).toContain('title: (providerSummary.known')
    expect(source).toContain('setShowProviderSwitches(true)')
    // ⚠️ 不跨行断言：源文件是 CRLF，含 `\n` 的字面量匹配不上。
    expect(source).toContain('? React.createElement(ProviderSwitchPanel')
    expect(source).toContain('onClose: () => setShowProviderSwitches(false)')
  })

  it('两个全屏弹窗互斥：点开一个必须先关掉另一个', () => {
    // 供应商开关与网关都是 position:fixed 的全屏覆盖层，同时打开会叠在一起，
    // 而 ESC 只关掉后挂载的那个 —— 剩下一个关不掉的弹窗挡住整个设置页。
    // ⚠️ 取块方向是**向前**：`setShowGateway(false)` 写在
    // `setShowProviderSwitches(true)` 之前（先关对方、再开自己），从后往前找会漏。
    const supplierEnd = source.indexOf("}, '供应商')")
    const gatewayEnd = source.indexOf('}, gatewayButtonLabel(gatewayStatus))')
    expect(supplierEnd).toBeGreaterThan(-1)
    expect(gatewayEnd).toBeGreaterThan(-1)
    expect(source.slice(supplierEnd - 600, supplierEnd)).toContain('setShowGateway(false)')
    expect(source.slice(gatewayEnd - 600, gatewayEnd)).toContain('setShowProviderSwitches(false)')
  })

  it('弹窗行是 <label> + **恰好一个** checkbox（第二个会让「点行名」激活错控件）', () => {
    const body = panelBody()
    expect(body.match(/React\.createElement\('label'/g) ?? []).toHaveLength(1)
    expect(body.match(/type: 'checkbox'/g) ?? []).toHaveLength(1)
    expect(body).toContain("role: 'switch'")
    expect(body).toContain('checked: row.checked')
    expect(body).toContain('disabled: row.disabled || busy')
  })

  it('弹窗复用模型列表那套结构与类名，不另起一套', () => {
    const body = panelBody()
    for (const cls of [
      'dim-jh-modalOverlay', 'dim-jh-modalHead', 'dim-jh-modalHint',
      'dim-jh-modalBody', 'dim-jh-modelList', 'dim-jh-modelRow',
      'dim-jh-modelInfo', 'dim-jh-modelName', 'dim-jh-modelId', 'dim-jh-switch',
    ]) {
      expect(body, `弹窗缺少与模型列表共用的类名 ${cls}`).toContain(cls)
    }
    // ESC 关闭挂在 document 上：焦点可能落在任意一个开关上。
    expect(body).toContain("document.addEventListener('keydown', onKeyDown)")
  })

  it('已关闭的行整行淡出（data-disabled 表达「已关闭」，点不动才用 input disabled）', () => {
    expect(panelBody()).toContain("'data-disabled': row.checked ? 'false' : 'true'")
  })

  it('状态没读回来时不显示计数，也不谎报「已打开 0」', () => {
    expect(source).toContain('providerSummary.known')
    const body = panelBody()
    expect(body).toContain('summary.known')
    expect(body).toContain('statusFailed ?')
  })

  it('状态未就绪时退化为不分组平铺（不阻断账号管理）', () => {
    expect(source).toContain('if (providerStatuses === null)')
  })

  it('关闭前必须确认，且文案给出影响面', () => {
    expect(source).toContain('确认关闭「${label}」？')
    expect(source).toContain('取消则不做任何变更')
  })
})

describe('供应商开关的样式约束（源码级回归）', () => {
  /**
   * ⚠️ 这条锁的是用户报障「去掉开关后右边有片空白」。
   *
   * !25 时代这里是 `minmax(0, 1fr) auto` 两列（第二列放行尾开关）。开关搬到弹窗后，
   * 那列虽然 0 宽，**8px 的列间距却照样计入** —— 卡片右侧就多出一条看着像
   * 「rail 没铺满」的空白。所以这里断言「只有一列」，而不是「首列是 1fr」。
   * 首列仍必须是 `minmax(0, 1fr)`（不能是裸 `1fr`）：grid 项 min-width 默认 auto，
   * 长供应商名会把行撑宽、撑出 rail。
   */
  it('⚠️ .dim-jh-providerRow 只有**一列**（开关搬走后不得留下空列与列间距）', () => {
    expect(styles).toMatch(/\.dim-jh-providerRow \{[^}]*grid-template-columns: minmax\(0, 1fr\);/)
    expect(styles).not.toMatch(/\.dim-jh-providerRow \{[^}]*grid-template-columns:[^;]*auto/)
  })

  it('.dim-jh-providerRow 内的 .dim-jh-provider 允许收缩（min-width: 0）', () => {
    expect(styles).toMatch(/\.dim-jh-providerRow \.dim-jh-provider \{[^}]*min-width: 0/)
  })

  /**
   * 228px 是「给右侧让位」与「最长行不出省略号」的交点（用户先要收窄、
   * 随后报障「workbuddy国际版有省略号」—— 两个诉求在这条宽度上才同时成立）：
   * 可用文字宽 = 228 − 12(rail padding) − 2(边框) − 20(按钮 padding) − 30(图标)
   *                  − 8(图标间距) − 15(滚动条) = **143px**
   * 最长行 WorkBuddy (国际版) 实测要 141px（!25 实测表：200px + 开关时标签剩 77px、
   * 该行超宽 64px ⇒ 77 + 64 = 141）。
   * ⚠️ 再往回收就会截断；要更窄只能改短 label，而那会与 RaccoonProduct 等
   * displayName 的跨文件一致性断言冲突（见 raccoon-client-panel.spec.ts）。
   */
  it('rail 228px：省出开关那 8px 空列后，仍刚好不截断最长行', () => {
    expect(styles).toMatch(/\.dim-jh-rail \{ width: 228px;/)
    // 图标间距与按钮 padding 各收窄 2px 是「用开销换文字宽度」的一部分，别改回去。
    expect(styles).toMatch(/\.dim-jh-provider \{[^}]*gap: 8px; padding: 8px 10px/)
  })

  it('弹窗里的开关保持 flex: none（目标控件不参与收缩）', () => {
    expect(styles).toMatch(/\.dim-jh-switch \{[^}]*flex: none/)
  })

  /**
   * ⚠️ 页头按钮必须排成一排（用户报障：加了开关入口之后「关闭」掉到第二行）。
   * 三处配合缺一不可：brand 让出宽度、副标题单行省略、按钮组不参与收缩。
   */
  it('页头按钮排成一排：brand 可收缩 + 副标题单行省略 + 按钮组不收缩', () => {
    expect(styles).toMatch(/\.dim-jh-brand \{[^}]*min-width: 0/)
    expect(styles).toMatch(/\.dim-jh-brandDesc \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/)
    expect(styles).toMatch(/\.dim-jh-headerActions \{[^}]*flex: none/)
    // 极窄窗口的兜底仍在：换行好过溢出到窗口外点不到。
    expect(styles).toMatch(/\.dim-jh-headerActions \{[^}]*flex-wrap: wrap/)
  })
})

describe('供应商弹窗的自定义排序（2026-10-06 拖拽需求）', () => {
  describe('sortOpenProvidersByOrder（已打开组重排）', () => {
    it('order 内的按数组序排前，未列出的按声明顺序稳定补后', () => {
      const open = [P('a'), P('b'), P('c'), P('d')]
      expect(sortOpenProvidersByOrder(open, ['c', 'a']).map(p => p.id))
        .toEqual(['c', 'a', 'b', 'd'])
      expect(sortOpenProvidersByOrder(open, ['d', 'c', 'b', 'a']).map(p => p.id))
        .toEqual(['d', 'c', 'b', 'a'])
    })

    it('order 为 null / 空 / 未定义 → 完全保持声明顺序（未自定义的语义）', () => {
      const open = [P('z'), P('a'), P('m')]
      expect(sortOpenProvidersByOrder(open, null).map(p => p.id)).toEqual(['z', 'a', 'm'])
      expect(sortOpenProvidersByOrder(open, []).map(p => p.id)).toEqual(['z', 'a', 'm'])
      expect(sortOpenProvidersByOrder(open, undefined).map(p => p.id)).toEqual(['z', 'a', 'm'])
    })

    it('order 里的已关闭 / 未知 id 被跳过（不产生空洞，也不抛错）', () => {
      // 'x' 不在已打开组里（可能已关闭或来自旧版本），跳过即可。
      expect(sortOpenProvidersByOrder([P('a'), P('b'), P('c')], ['x', 'b', 'a']).map(p => p.id))
        .toEqual(['b', 'a', 'c'])
      expect(sortOpenProvidersByOrder([P('a'), P('b')], ['x', 'y']).map(p => p.id))
        .toEqual(['a', 'b'])
    })

    it('不修改入参数组（组件层依赖纯函数语义）', () => {
      const open = [P('a'), P('b'), P('c')]
      sortOpenProvidersByOrder(open, ['c', 'a'])
      expect(open.map(p => p.id)).toEqual(['a', 'b', 'c'])
    })
  })

  describe('nextProviderOrderAfterDrop（拖拽落点 → 完整顺序）', () => {
    it('before / after 两个方向都生效（由指针落点决定，与账号拖拽一致）', () => {
      // 把 a 拖到 b 之后：b 的位置放 a
      expect(nextProviderOrderAfterDrop(['a', 'b', 'c'], ['d'], 'a', 'b', 'after'))
        .toEqual(['b', 'a', 'c', 'd'])
      // 把 c 拖到 a 之前
      expect(nextProviderOrderAfterDrop(['a', 'b', 'c'], ['d'], 'c', 'a', 'before'))
        .toEqual(['c', 'a', 'b', 'd'])
    })

    it('已关闭组按声明顺序缀尾（展示侧只读 open 段，尾段是 reopen 定位的占位）', () => {
      expect(nextProviderOrderAfterDrop(['a', 'c'], ['b', 'e', 'd'], 'c', 'a', 'after'))
        .toEqual(['a', 'c', 'b', 'e', 'd'])
    })

    it('源与目标相同 → null（无需变更，调用方不提交）', () => {
      expect(nextProviderOrderAfterDrop(['a', 'b'], ['c'], 'a', 'a', 'before')).toBeNull()
    })
  })

  describe('providerSwitchRows 的 order 参数（弹窗行数据）', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    // ⚠️ closed 供应商必须带 models.total：providerSwitchState 先判
    // 「没有可关闭的模型 → 禁用且 checked=true」，走不到 closed 判定
    // （真实 provider.status 恒带模型计数，测试数据必须同形）。
    const statuses = { c: { closed: true, models: { total: 3 }, accounts: { total: 1 } } }

    it('已打开组按 order 重排，已关闭组恒按声明顺序沉底（用户口径：逻辑不变）', () => {
      const rows = providerSwitchRows(providers, statuses, ['d', 'a'])
      expect(rows.map(r => r.id)).toEqual(['d', 'a', 'b', 'c'])
      // 关闭组的位置在最后，且开关呈现仍是「已关闭」
      expect(rows[3]!.checked).toBe(false)
    })

    it('order 未指定时与既有行为完全一致（向后兼容，rail 同源）', () => {
      expect(providerSwitchRows(providers, statuses).map(r => r.id))
        .toEqual(['a', 'b', 'd', 'c'])
      expect(providerSwitchRows(providers, statuses, null).map(r => r.id))
        .toEqual(providerSwitchRows(providers, statuses).map(r => r.id))
    })
  })

  describe('弹窗拖拽的接线（源码级回归）', () => {
    it('面板消费 order / onCommitOrder，并经 nextProviderOrderAfterDrop 提交', () => {
      const body = panelBody()
      expect(body).toContain('providerSwitchRows(providers, statuses, order)')
      expect(body).toContain('nextProviderOrderAfterDrop(')
      expect(body).toContain('onCommitOrder(next)')
      // ⚠️ 已关闭的行不得可拖：它恒按默认顺序沉底，能拖而不能落只会误导。
      expect(body).toContain('if (!row.checked || !dragEnabled) return { enabled: false };')
    })

    it('页面层走 provider.getOrder / provider.setOrder（宿主持久化）', () => {
      expect(source).toContain("rpcCall('provider.getOrder', {})")
      expect(source).toContain("rpcCall('provider.setOrder', { order: next })")
      // 顺序状态必须住宿主侧：客户端没有也不该有 localStorage（与既有架构一致）。
      expect(source).not.toContain('localStorage')
    })

    it('拖拽提交失败时不做乐观更新（回读保持与服务端一致）', () => {
      expect(source).toContain('await loadProviderOrder();')
    })

    it('行拖拽的视觉状态与账号卡片同款（淡出 + 插入线）', () => {
      expect(styles).toContain('.dim-jh-modelRow[data-dragging="true"]')
      expect(styles).toContain('.dim-jh-modelRow[data-dropBefore="true"]::before')
      expect(styles).toContain('.dim-jh-modelRow[data-dropAfter="true"]::after')
      // 插入线是 absolute 定位，行必须有 relative 锚点。
      expect(styles).toMatch(/\.dim-jh-modelRow \{ position: relative; \}/)
    })
  })
})