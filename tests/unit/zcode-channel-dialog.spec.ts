/**
 * 渠道选择的**位置**契约（用户 2026-10-03 明确要求）。
 *
 * > 登录渠道gui流程应该在新建账号出来后的窗口中选择然后再弹出国际版国内版不同的认证页面。
 *
 * ## 这条测试守什么
 *
 * PR #38 把渠道 `<select>` 放在「+ 新建账号」按钮**旁边**。那是**两个入口共用的
 * 一个开关** —— 改了它，也不知道会不会影响正在跑的那一轮登录（授权页已经开了，
 * 改渠道也没用）。
 *
 * ⇒ 搬进「点按钮后弹出的对话框」后，「选渠道」与「发起登录」是**同一个原子动作**。
 *
 * ⚠ 纯源码契约：这类 UI 位置没有单测能真正跑起来（要起 React 树），
 *   而它恰恰是最容易被"顺手改回去"的地方 —— 改回去不会有任何测试失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dir = dirname(fileURLToPath(import.meta.url))
const panel = readFileSync(resolve(dir, '../../plugin-src/client/jet-hub.js'), 'utf8')
const card = readFileSync(resolve(dir, '../../plugin-src/client/zcode-card.js'), 'utf8')
const styles = readFileSync(resolve(dir, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

describe('★ 渠道选择在「新建账号弹窗」里，不在按钮旁', () => {
  it('★ 两个入口都改为「点按钮 → 开弹窗」（不再直接调 createAccount）', () => {
    expect(panel, 'jet-hub.js 按钮应开弹窗').toContain('onClick: () => setPendingLogin(false)')
    expect(card, 'zcode-card.js 按钮应开弹窗').toContain("btn('create', '添加账号', '登录中…', () => setPendingLogin(false))")
  })

  it('★ 两个入口都有 pendingLogin 状态（弹窗开着 + 要 forceNew 不可能不同步）', () => {
    expect(panel).toMatch(/const \[pendingLogin, setPendingLogin\] = React\.useState\(undefined\)/)
    expect(card).toMatch(/const \[pendingLogin, setPendingLogin\] = React\.useState\(undefined\)/)
  })

  it('★ 两个入口的弹窗都含渠道选择与两个选项', () => {
    for (const [name, src] of [['jet-hub.js', panel], ['zcode-card.js', card]] as const) {
      expect(src, `${name} 缺弹窗遮罩`).toContain('dim-jh-zcDialogMask')
      expect(src, `${name} 缺国内选项`).toContain("value: 'bigmodel'")
      expect(src, `${name} 缺国际选项`).toContain("value: 'zai'")
    }
  })


  it('★ ★ 渠道不再渲染在按钮旁（按钮的 onClick 里不得直接调 createAccount）', () => {
    // 这是本次改动的**核心**：按钮直接调 createAccount ⇒ 渠道无处可选
    expect(panel, 'jet-hub.js 按钮仍在直接调 createAccount').not.toMatch(
      /onClick: \(\) => void createAccount\(false\)/,
    )
    expect(card, 'zcode-card.js 按钮仍在直接调 createAccount').not.toMatch(
      /btn\('create',[^\n]*\(\) => createAccount\(false\)\)/,
    )
  })

  it('★ 渠道仍随 account.create 发出（搬位置不改数据通路）', () => {
    // ⚠ 这是 PR #38 已打通的通路，本次只改 UI 位置，**不得**弄丢
    expect(panel).toMatch(/\{ provider, zcodeProvider/)
    // ⚠ 断言的是 `account.create` 的**载荷里真的带它**，不是「文件里出现过这个词」——
    //   后者会在载荷被删、而弹窗里还留着同名 state 时误判为通过（反向验证抓到过）。
    expect(card).toMatch(/await call\('account\.create',[\s\S]{0,200}?zcodeProvider/)
  })

  it('★ ★ 弹窗是**条件渲染**的（不是常驻），且条件是 pendingLogin', () => {
    // ⚠ 只查「有没有 zcDialogMask」不够：把条件写成 `false` 后文本仍在，
    //   弹窗却永远不渲染（反向验证的变异 2 就是这样溜过去的）。
    for (const [name, src] of [['jet-hub.js', panel], ['zcode-card.js', card]] as const) {
      expect(src, `${name} 弹窗未挂在 pendingLogin 条件上`)
        .toMatch(/pendingLogin === undefined \? null : (React\.createElement|h)\(/)
    }
  })

  it('★ 两个入口的国际选项文案保留（删了就只剩国内）', () => {
    for (const [name, src] of [['jet-hub.js', panel], ['zcode-card.js', card]] as const) {
      expect(src, `${name} 国际选项文案缺失`).toContain('z.ai（chat.z.ai，国际版）')
    }
  })

  it('★ 「确定」才发起登录（点确定 → createAccount()，无参）', () => {
    // ⚠ 撤掉「登录其他账号」后 createAccount 不再收 forceNew（用户 2026-10-02）
    for (const src of [panel, card]) {
      expect(src, '确定回调不得再传 forceNew').not.toMatch(/createAccount\(forceNew\)/)
    }
  })

  it('★ 弹窗样式齐备（否则弹出来是透明的无边框块）', () => {
    for (const cls of [
      'dim-jh-zcDialogMask',
      'dim-jh-zcDialog ',
      'dim-jh-zcDialogTitle',
      'dim-jh-zcDialogHint',
      'dim-jh-zcDialogActions',
    ]) {
      expect(styles, `缺样式 ${cls.trim()}`).toContain(`.${cls.trim()}`)
    }
  })

  it('★ styles 是模板字符串：反引号数必须恰为 2（多了会提前闭合）', () => {
    // AGENTS.md 红线：CSS 注释内出现反引号会「提前闭合模板」，
    // 报错看起来像 CSS 写错、实际是 JS 语法问题。
    const ticks = (styles.match(/`/g) ?? []).length
    expect(ticks, 'styles 反引号数不为 2，模板字符串可能被破坏').toBe(2)
  })
})
