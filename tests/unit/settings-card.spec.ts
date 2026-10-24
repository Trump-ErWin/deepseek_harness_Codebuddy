import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 插件详情页设置卡片（`plugin-src/client/settings-card.js`）的源码守卫。
 *
 * ⚠️ 为什么只能做源码文本断言：该模块 import 了 `react` 与
 * `@deepseek-ai/dsh-client-ui-primitives`，两者都是 esbuild 的 `external`
 * （`node_modules` 里没有），vitest 跑不起来。本仓库对客户端模块的守卫一律如此。
 *
 * 这些断言守的是**会静默失败**的几条约定：
 * 1. 最外层必须自成 column 且 `gap: 0` —— 宿主 `detailSection` 给直接子元素
 *    `gap: 12px`，不包一层的话卡片内部间距全部被那个值接管；
 * 2. 下拉必须用官方 `Menu` 且 `portal` 开 —— 卡片在滚动列里，就地展开会被裁；
 * 3. 不得出现原生 `<select>` —— 本仓库已因 Windows/Electron 点不开而整体删除。
 */

const source = readFileSync(new URL('../../plugin-src/client/settings-card.js', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { name: string }

describe('插件详情页设置卡片', () => {
  it('导出 JetHubPanelEntryCard', () => {
    expect(source).toContain('export function JetHubPanelEntryCard')
  })

  it('⚠️ 最外层容器必须 gap:0（官方 detailSection 给直接子元素 12px）', () => {
    expect(source).toContain('dim-jh-cardStack')
  })

  it('⚠️ 用官方 Menu 且必须开 portal（卡片在滚动列里，就地展开会被裁）', () => {
    expect(source).toContain("from '@deepseek-ai/dsh-client-ui-primitives'")
    expect(source).toMatch(/\bMenu\b/)
    expect(source).toMatch(/portal:\s*true/)
  })

  it('⚠️ 禁用原生 select（Windows/Electron 下点不开）', () => {
    expect(source).not.toMatch(/createElement\(\s*['"]select['"]/)
  })

  it('两个选项的字面量与设计一致', () => {
    expect(source).toContain('仅侧栏')
    expect(source).toContain('仅设置页')
    expect(source).toContain("id: 'sidebar'")
    expect(source).toContain("id: 'settings'")
  })

  it('⚠️ 写入不做乐观更新：失败要回滚到宿主的实际值', () => {
    // ⚠️ 这两条断言曾经是**恒真的**（只查 /panelEntry()/ 与 /catch/，把 setEntry
    // 改成乐观更新、把 catch 换成空壳都照样绿）—— 2026-10-24 复核 M1。改成查
    // 具体的失败路径形态。
    expect(source).toMatch(/setEntry\(currentEntry\(\)\)/)
    expect(source).toContain('catch')
    // 成功路径里不得出现「先乐观改 setEntry(next)」这种形态。
    expect(source).not.toMatch(/setEntry\(next\)/)
  })

  it('⚠️ 读失败与写失败必须是两个标记、两句文案（复核 I5）', () => {
    // 共用一个标记会让**写失败**时显示「未能读取当前设置…显示的是默认值」，
    // 既不准也把用户引向错误的排查方向。
    expect(source).toContain('readFailed')
    expect(source).toContain('writeFailed')
    expect(source).toContain('CARD_DESC_READ_FAILED')
    expect(source).toContain('CARD_DESC_WRITE_FAILED')
  })

  it('⚠️ 写入回调自带重入闸门（busy 挡不住 Menu.onSelect，复核 I4）', () => {
    expect(source).toContain('busyRef')
    expect(source).toMatch(/if\s*\(\s*busyRef\.current\s*\)\s*return/)
  })

  it('卡片自己不注册槽位，也不碰包名（key 在 index.js 里）', () => {
    expect(source).not.toContain('slots.register')
    expect(source).not.toContain(pkg.name)
  })

  it('读取失败只换文案、不禁用控件（否则一次抖动就没法自救）', () => {
    expect(source).toContain('panelEntryReadFailed')
  })

  it('⚠️ 卡片挂载时自己读一次（不依赖两处槽位 inject 是否触发）', () => {
    expect(source).toContain('loadPanelEntry')
  })
})
