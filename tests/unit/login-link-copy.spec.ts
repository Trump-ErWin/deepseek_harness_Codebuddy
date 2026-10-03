/**
 * 「登录窗口被拦截」兜底块里的**复制按钮**（用户 2026-10-03 报障）。
 *
 * > 授权链接没有复制按钮 / 只有链接没有复制按钮
 *
 * ## 这条测试守什么
 *
 * 兜底块只在 `window.open` 失败时出现，用户此刻唯一的动作就是**把 URL 复制到
 * 别处**（换浏览器、发手机、贴命令行），而授权 URL 带 `client_id` / `scope` /
 * `state`，长度 300+ 字符 —— 只给一个 `<a>` 时用户只能手工框选，漏一个字符
 * 就是「授权失败」的假象。
 *
 * ⚠️ 这个块在 `jet-hub.js`（通用面板，gemini 等走它）与 `zcode-card.js`
 * （zcode 编辑卡片）里是**同一个缺陷的两个副本**：只修一处，另一个 provider
 * 的用户照样报同一个障。故本文件同时钉住两处都走共用组件。
 *
 * ## 为什么一半是真断言、一半是源码契约
 *
 * 本仓库单测环境里 **react 不在依赖内**（`node_modules/react` 不存在），组件无法
 * 渲染。故：纯逻辑（状态转移 / 文案）用 `new Function` 编译后**真实调用**断言；
 * DOM 形态只能做源码契约 —— 这类 UI 形态没有单测能真正跑起来，而它恰恰最容易
 * 被「顺手改回去」，改回去不会有任何测试失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8')
const link = read('../../plugin-src/client/login-link.js')
const panel = read('../../plugin-src/client/jet-hub.js')
const card = read('../../plugin-src/client/zcode-card.js')
const styles = read('../../plugin-src/client/jet-hub-styles.js')

/**
 * 从源码里取出一个具名函数的**完整声明**（含形参表），用 `new Function` 编译成可调用函数。
 *
 * ⚠️ 必须连形参表一起取：只取函数体会得到 `ReferenceError: ok is not defined`
 * （函数体里的 `ok` 是形参，脱离声明后无处绑定）。`account-test-panel.spec.ts`
 * 取的是函数体，那边取到的函数不带形参才可行。
 *
 * ⚠️ 花括号必须**配对**计数，不能取第一个 `}` —— 模板字符串与对象字面量里都有
 * `}`。只编译不执行，故函数体内引用的 `React` / `copyToClipboard` 一律不求值。
 */
function extractDeclaration(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`)
  expect(start, `源码里找不到 export function ${name}`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', source.indexOf(')', start))
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1).replace(/^export /, '')
    }
  }
  throw new Error(`函数 ${name} 的花括号没有闭合`)
}

function loadFunction<T>(source: string, name: string, scope: Record<string, unknown> = {}): T {
  const decl = extractDeclaration(source, name)
  const keys = Object.keys(scope)
  return new Function(...keys, `return (${decl})`)(...keys.map((key) => scope[key])) as T
}

// ⚠️ 取出的是 `export const …` 整行，`new Function` 不认 `export`，必须剥掉前缀。
const CONSTANTS = new Function(
  `${(/export const LOGIN_LINK_COPY_STATE = .*$/m.exec(link)?.[0] ?? '').replace(/^export /, '')}\nreturn LOGIN_LINK_COPY_STATE`,
)() as Readonly<{ idle: string; copied: string; failed: string }>

const nextState = loadFunction<(ok: boolean) => string>(link, 'nextLoginLinkCopyState', {
  LOGIN_LINK_COPY_STATE: CONSTANTS,
})
const copyView = loadFunction<(state: string) => { label: string; title: string }>(
  link,
  'loginLinkCopyView',
  { LOGIN_LINK_COPY_STATE: CONSTANTS },
)

describe('★ 复制按钮的三态（真实调用纯函数）', () => {
  it('复制成功 → copied，失败 → failed（绝不把「点击」当成功）', () => {
    expect(nextState(true)).toBe('copied')
    expect(nextState(false)).toBe('failed')
    // ⚠️ 判据只能是 copyToClipboard 的返回值：浏览器拒绝写入时同步路径不抛错，
    //    若按「点击了就算成功」写，用户会看到「已复制 ✓」而剪贴板是空的。
    expect(CONSTANTS.idle).toBe('idle')
  })

  it('★ 失败态必须给出**替代动作**，不能只说「失败」', () => {
    const failed = copyView('failed')
    expect(failed.label).toContain('手动选中')
    // 只说「复制失败」用户只会重复点同一个按钮。
    expect(failed.title).toContain('Ctrl+C')
    expect(failed.title).toContain('全选')
  })

  it('成功态与初始态的文案互不混淆', () => {
    expect(copyView('copied').label).toBe('已复制 ✓')
    expect(copyView('idle').label).toBe('复制链接')
    expect(copyView('idle').title).toContain('剪贴板')
  })
})

describe('★ 两个副本共用同一个组件（只改一处 = 另一个 provider 照旧报障）', () => {
  it('★ jet-hub.js 渲染的是 LoginFallbackNotice，不再是裸 <a>', () => {
    expect(panel).toContain('React.createElement(LoginFallbackNotice, {')
    expect(panel, 'jet-hub.js 又写回了裸链接').not.toMatch(
      /React\.createElement\('a',\s*\{\s*className:\s*'dim-jh-loginLink'/,
    )
  })

  it('★ zcode-card.js 渲染的是 LoginFallbackNotice，不再是裸 <a>', () => {
    expect(card).toContain('h(LoginFallbackNotice, {')
    expect(card, 'zcode-card.js 又写回了裸链接').not.toMatch(
      /h\('a',\s*\{\s*className:\s*'dim-jh-zcLink'/,
    )
  })

  it('★ 两处都传了链接 URL（漏传就是渲染出一个没有 href 的空链接）', () => {
    expect(panel).toMatch(/React\.createElement\(LoginFallbackNotice,\s*\{\s*url:\s*loginUrlForManual/)
    expect(card).toMatch(/h\(LoginFallbackNotice,\s*\{\s*url:\s*manualLoginUrl/)
  })

  it('★ 两处各自的皮肤类名都保留（否则一处样式全丢）', () => {
    expect(panel).toContain("noticeClassName: 'dim-jh-probeNotice'")
    expect(panel).toContain("linkClassName: 'dim-jh-loginLink'")
    expect(card).toContain("noticeClassName: 'dim-jh-zcNotice'")
    expect(card).toContain("linkClassName: 'dim-jh-zcLink'")
    // ⚠️ 按钮类名必须各自匹配：zcode 卡片用 `.dim-jh-zcBtn`，用 `.dim-jh-btn`
    //    会在官方编辑卡片里显得比周围控件大一圈。
    expect(card).toContain("buttonClassName: 'dim-jh-zcBtn'")
  })

  it('组件本体只此一份（两处各自实现过一次，正是本缺陷的成因）', () => {
    expect((link.match(/export function LoginFallbackNotice\(/g) ?? []).length).toBe(1)
    expect(panel).not.toContain('function LoginFallbackNotice')
    expect(card).not.toContain('function LoginFallbackNotice')
  })
})

describe('★ 组件源码里的两条硬约束', () => {
  it('★ 按钮必须写 type="button"（zcode 走 portal 进官方编辑卡片，可能是 form 的子节点）', () => {
    // 不写 type 时默认 submit，点一下会连带提交官方那张表单。
    expect(link).toContain("type: 'button'")
  })

  it('★ 链接换新必须复位复制态（换账号重登会给出另一个 state 的 URL）', () => {
    // 残留的「已复制 ✓」会让用户以为**新**链接已经在剪贴板里，粘出来是旧链接。
    expect(link).toMatch(/React\.useEffect\(\(\) => \{\s*setCopyState\(LOGIN_LINK_COPY_STATE\.idle\);\s*\}, \[url\]\)/)
  })

  it('★ 失败回退靠 data-copy-state 暴露给 CSS（组件自己不写内联样式）', () => {
    expect(link).toContain("'data-copy-state': copyState")
  })
})

describe('★ 样式：长 URL 不能把复制按钮挤出可视区', () => {
  it('★ 链接行有 flex 布局容器', () => {
    expect(styles).toMatch(/\.dim-jh-loginLinkRow \{[^}]*display: flex/)
  })

  it('★ 两个链接类名都必须能收缩（min-width: 0 + break-all）', () => {
    // ⚠️ 此前 `.dim-jh-loginLink` **全文零规则**，链接继承提示块样式；
    //    只给 flex: 1 不给 min-width: 0，flex 项的最小尺寸是内容宽度 ⇒ 长 URL
    //    仍然会把按钮顶出去。
    expect(styles).toMatch(/\.dim-jh-loginLink \{[^}]*min-width: 0/)
    expect(styles).toMatch(/\.dim-jh-zcLink \{[^}]*min-width: 0/)
    expect(styles).toMatch(/\.dim-jh-loginLink \{[^}]*word-break: break-all/)
  })

  it('★ ★ 失败态的回退规则必须同时覆盖两个链接类名', () => {
    // 只写一个类名 ⇒ 一半用户（另一个 provider）拿不到「点一下全选」的补救。
    const rule = /\.dim-jh-loginLinkRow\[data-copy-state="failed"\][\s\S]{0,200}?\{[^}]*user-select: all/
    expect(styles, '失败回退规则缺失').toMatch(rule)
    const block = rule.exec(styles)?.[0] ?? ''
    expect(block, '回退规则漏了 .dim-jh-loginLink').toContain('.dim-jh-loginLink')
    expect(block, '回退规则漏了 .dim-jh-zcLink').toContain('.dim-jh-zcLink')
  })

  it('★ styles 仍是模板字符串：反引号数必须恰为 2（多了会提前闭合）', () => {
    // AGENTS.md 红线：CSS 注释内出现反引号会「提前闭合模板」，报错看起来像
    // CSS 写错、实际是 JS 语法问题。
    expect((styles.match(/`/g) ?? []).length).toBe(2)
  })
})
