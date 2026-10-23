import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 插件详情页槽位的**接线守卫**（`index.js` / `package.json` / `build.mjs`）。
 *
 * ⚠️ 这三处是「单测查不出、真机才炸」的典型：`plugins.bundle.config` 的 key
 * 不匹配时宿主**整段不渲染且无任何报错**；`dsh.client.inject` 少声明一个包会让
 * 本 bundle 先于它到达、`inject` 永远等不到服务；`external` 漏一项会把整个
 * UI 库打进产物再与平台模块表冲突。
 *
 * 断言形态是源码文本 / JSON 读取（本仓库对构建配置的守卫一贯如此，
 * 见 `client-registration-id.spec.ts`）。
 */

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const indexSource = read('plugin-src/client/index.js')
const buildSource = read('plugin-src/client/build.mjs')
const pkg = JSON.parse(read('package.json')) as {
  name: string
  dsh: { client: { inject: string[], external?: string[] } }
}

describe('插件详情页槽位接线', () => {
  it('⚠️ 注册 plugins.bundle.config，且 key 逐字等于包名（不匹配 = 静默不渲染）', () => {
    expect(indexSource).toContain("'plugins.bundle.config'")
    expect(indexSource).toContain(`key: '${pkg.name}'`)
  })

  it('卡片通过 inject 拿 rpcCall（与 settings.section 同构）', () => {
    expect(indexSource).toMatch(/JetHubPanelEntryCard/)
    expect(indexSource).toContain('inject: () => ({ rpcCall })')
  })

  it('⚠️ settings.section 不再在 apply 里无条件注册（改由注册器按枚举增删）', () => {
    expect(indexSource).not.toMatch(/ctx\.slots\.inject\('settings\.section'/)
  })

  it('⚠️ dsh.client.inject 必须声明 plugin-manager，否则本 bundle 可能先到 → 卡片永不出现', () => {
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-plugin-manager')
  })

  it('⚠️ ui-primitives 必须 external（平台模块，不得打进 bundle）', () => {
    expect(buildSource).toMatch(/external:\s*\[[^\]]*'@deepseek-ai\/dsh-client-ui-primitives'/)
  })

  it('⚠️ 平台模块不得写进 dsh.client.external（那是基座之外才用的）', () => {
    // `packages/client/AGENTS.md`：PLATFORM_MODULES 是隐式 external 基座，
    // 重复声明会造成「同一模块有两个提供方」。
    expect(pkg.dsh.client.external ?? []).not.toContain('@deepseek-ai/dsh-client-ui-primitives')
  })
})
