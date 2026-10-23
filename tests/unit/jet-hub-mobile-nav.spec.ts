import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
const stylesSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

/**
 * 移动端「供应商列表」抽屉（2026-10-24，用户报障：移动端设置页常驻左栏
 * 太占竖向空间，账号列表被挤成「划来划去」）。
 *
 * 四条诉求（用户原话归纳）：
 * 1. 左上角按钮呼出；
 * 2. 靠左布局的竖向列表；
 * 3. 自动收起；
 * 4. 桌面端行为不变。
 *
 * ⚠️ 本文件沿用 client-ui.md 的两条测试纪律：
 * - 源码文本断言必须锚定片段且对**同型多现**的形态按计数断言（防锚点漂移）；
 * - 判据要能抓住「常量假条件」类短路 —— 这里断言的每个 handler 都核对了
 *   它出现在**无条件**的 createElement 实参位置（不是 if(false) 分支）。
 */
describe('移动端供应商抽屉：JS 侧', () => {
  it('JetHubPage 有且仅有一个 mobileNavOpen 状态声明', () => {
    const decls = clientSource.match(/const \[mobileNavOpen, setMobileNavOpen\] = React\.useState\(false\)/g)
    expect(decls, 'mobileNavOpen 状态声明应恰好出现一次').toHaveLength(1)
  })

  it('selectProvider 里收起抽屉（自动收起的第一条路径）', () => {
    // 锚定在 selectProvider 函数体内（而非文件里任意位置）
    const fn = /const selectProvider = \(id\) => \{[\s\S]*?\};/.exec(clientSource)
    expect(fn, '未找到 selectProvider 函数').not.toBeNull()
    expect(fn?.[0]).toContain('setMobileNavOpen(false)')
  })

  it('Escape 关闭挂在 document 上（焦点可在右侧面板任意控件）', () => {
    const effect = /React\.useEffect\(\(\) => \{\s*if \(!mobileNavOpen\) return;[\s\S]*?document\.addEventListener\('keydown', onKeyDown\);[\s\S]*?\}, \[mobileNavOpen\]\);/.exec(clientSource)
    expect(effect, '未找到 mobileNavOpen 的 Escape effect').not.toBeNull()
    expect(effect?.[0]).toContain("event.key === 'Escape'")
  })

  it('页头呼出按钮存在且带 aria-expanded/aria-controls', () => {
    expect(clientSource).toContain("className: 'dim-jh-mobileNavBtn'")
    expect(clientSource).toContain("'aria-controls': 'dim-jh-mobileNav'")
    expect(clientSource).toContain("'aria-expanded': mobileNavOpen ? 'true' : 'false'")
    // 按钮必须挂在 header 里（「左上角按钮」的落点）
    const header = /React\.createElement\('header', \{ className: 'dim-jh-header' \}[\s\S]{0,600}/.exec(clientSource)
    expect(header?.[0]).toContain("dim-jh-mobileNavBtn")
  })

  it('抽屉容器关闭即不挂载，且 scrim 点击收起', () => {
    // 关闭即不挂载：mobileNavOpen ? createElement : null
    expect(clientSource).toMatch(/mobileNavOpen\s*\?\s*React\.createElement\('div', \{\s*className: 'dim-jh-mobileNavWrap'/)
    const scrim = /className: 'dim-jh-mobileNavScrim',\s*onClick: \(\) => setMobileNavOpen\(false\)/.exec(clientSource)
    expect(scrim, 'scrim 必须有点击收起 handler').not.toBeNull()
  })

  it('抽屉与常驻 rail 是两个节点（桌面 rail 不受抽屉影响）', () => {
    // 布局里必须同时保留常驻 rail（桌面端）与抽屉（移动端）
    const layout = /React\.createElement\('div', \{ className: 'dim-jh-layout' \}[\s\S]{0,1200}/.exec(clientSource)
    expect(layout?.[0]).toContain("className: 'dim-jh-rail'")
    // 常驻 rail 的渲染调用不变（桌面回归保障）：抽屉里的 rail 是多行对象字面量，
    // 常驻 rail 是单行 —— 两种形态各计一次。
    expect(clientSource.match(/className: 'dim-jh-rail', role: 'tablist', 'aria-label': 'Provider 导航'/g)).toHaveLength(1)
    expect(clientSource.match(/^\s+className: 'dim-jh-rail',$/gm)).toHaveLength(1)
  })
})

describe('移动端供应商抽屉：样式侧', () => {
  it('断点为 768px，桌面/移动双向都有规则', () => {
    expect(stylesSource).toContain('@media (max-width: 768px)')
    expect(stylesSource).toContain('@media (min-width: 769px)')
  })

  it('移动端：呼出按钮可见、常驻 rail 隐藏（display: none）', () => {
    const mobile = /@media \(max-width: 768px\) \{[\s\S]*?\.dim-jh-mobileNavBtn \{ display: inline-flex; \}[\s\S]*?\.dim-jh-layout > \.dim-jh-rail \{ display: none; \}/.exec(stylesSource)
    expect(mobile, '移动端块应同时含「按钮显示」与「常驻 rail 隐藏」').not.toBeNull()
  })

  it('桌面端：呼出按钮与抽屉容器一律隐藏', () => {
    const desktop = /@media \(min-width: 769px\) \{[\s\S]*?\}\s*`/.exec(stylesSource)
    expect(desktop?.[0]).toContain('.dim-jh-mobileNavBtn { display: none; }')
    expect(desktop?.[0]).toContain('.dim-jh-mobileNavWrap { display: none; }')
  })

  it('抽屉本体靠左（left: 0）且有竖向滚动（overflow-y 继承 rail）', () => {
    const drawer = /\.dim-jh-mobileNavWrap \.dim-jh-rail \{[\s\S]*?\}/.exec(stylesSource)
    expect(drawer?.[0]).toContain('left: 0')
    // rail 基础规则自带 overflow-y: auto，抽屉只重定义几何 —— 确认基础规则仍在
    expect(stylesSource).toMatch(/\.dim-jh-rail \{ width: 228px;[^}]*overflow-y: auto;/)
  })

  it('安全区 padding 与触控目标 44px 存在', () => {
    expect(stylesSource).toContain('env(safe-area-inset-top, 0px)')
    expect(stylesSource).toContain('env(safe-area-inset-bottom, 0px)')
    expect(stylesSource).toContain('.dim-jh-mobileNavWrap .dim-jh-provider { width: 100%; min-height: 44px; }')
  })

  it('抽屉逐项压过 720px 窄屏横向条规则（真实回归：2026-10-24 截图实测）', () => {
    // 上游 720px 块把 rail 改横向 + 分组展平 —— 抽屉复用 .dim-jh-rail 类名，
    // 不显式恢复就会出现「横向排 + 分组标题消失」的混合态。
    const drawer = /\.dim-jh-mobileNavWrap \.dim-jh-rail \{[\s\S]*?\}/.exec(stylesSource)
    expect(drawer?.[0]).toContain('display: grid')
    expect(drawer?.[0]).toContain('overflow-y: auto')
    expect(drawer?.[0]).toContain('flex-direction: initial')
    expect(stylesSource).toContain('.dim-jh-mobileNavWrap .dim-jh-railGroup { display: grid; gap: 8px; }')
    expect(stylesSource).toContain('.dim-jh-mobileNavWrap .dim-jh-railGroupTitle { display: block; }')
  })
})
