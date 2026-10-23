import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `plugin-src/client/panel-entry.js` 的源码守卫。
 *
 * ⚠️ 为什么只能做源码文本断言：该模块 import 了 `react` 与 `jet-hub.js`，
 * 而 `react` 在 esbuild 的 `external` 里、由宿主注入（`node_modules` 里没有），
 * 所以 vitest 里 import 不到它。本仓库对客户端模块的守卫一律是这个形态。
 *
 * 这些断言守的是**三条会静默失败的约定**：
 * 1. `main` key 必须无条件注册 —— 少了它宿主 `layout.selectPanel('jet-hub')` 会抛错；
 * 2. `settings.section` 必须按枚举增删 —— 无条件注册就等于两个入口同时存在，
 *    选项语义被破坏；
 * 3. 注销侧栏行时必须撤销选中 —— 否则布局里留着没有入口的 `activePanelId`。
 */

const source = readFileSync(new URL('../../plugin-src/client/panel-entry.js', import.meta.url), 'utf8')

describe('panel-entry 注册器', () => {
  it('导出 registerJetHubPanelEntries', () => {
    expect(source).toContain('export function registerJetHubPanelEntries')
  })

  it('⚠️ main key 无条件注册（关掉入口后宿主 selectPanel 仍会命中它）', () => {
    const start = source.indexOf("ctx.slots.inject('main'")
    expect(start, 'missing main slot injection').toBeGreaterThan(-1)
    const block = source.slice(start, start + 400)
    // 该注入块里不得出现条件判断：它必须读一次值就注册。
    expect(block).not.toMatch(/\bif\s*\(/)
  })

  it('两个入口槽位都存在', () => {
    expect(source).toContain("'sidebar.panellist'")
    expect(source).toContain("'settings.section'")
  })

  it('两处槽位都按枚举增删（不是无条件注册）', () => {
    expect(source).toContain('panelEntryShowsSidebar()')
    expect(source).toContain('panelEntryShowsSettings()')
  })

  it('⚠️ 注销侧栏行时必须撤销选中（否则布局留着没有入口的 activePanelId）', () => {
    expect(source).toContain('deselectIfActive')
  })

  it('模块级不再持有旧名字的导出', () => {
    expect(source).not.toContain('registerJetHubSidebarEntry')
    expect(source).not.toContain('sidebar-entry-store.js')
    expect(source).not.toContain('sidebarEntryVisible')
  })
})
