/**
 * Accio（阿里）Jet Hub 客户端面板的断言。
 *
 * ## 为什么这一层必须是「源码文本 + 跨文件一致性」
 *
 * 本仓库的客户端是**无构建期类型检查**的裸 `React.createElement` 调用
 * （`react` 只在 esbuild 的 `external` 里、由宿主注入，`node_modules` 里没有它），
 * 所以「引用了不存在的符号」「传错 prop 名」这类错误编译期发现不了 ——
 * 只能靠这里的文本断言 + `pnpm build:client` 的语法检查兜住
 * （与 `opencode-client-panel.spec.ts` 同一取舍）。
 *
 * ⚠️ 但**纯文本断言会假绿**：改个写法、写段注释就能喂绿。故本文件里凡是
 * 「判据本身」的断言（正向分支、桶名、不接重登录）都锚定在**跨文件真相源**上：
 * `src/provider-registry.ts` / `src/accio-credits.ts`。
 *
 * ## ⚠️ 本提交的范围（reduced scope）
 *
 * 面板**只做诚实展示**：三类积分桶 + 重置倒计时 + 发放规则说明。
 * 「刷新每日额度」按钮**刻意不做** —— 它需要宿主侧新增「重新登录既有账号」的
 * RPC（`account.create` 每次都新造账号 id），在接线之前渲染那个按钮就是一个
 * **骗人的控件**。故下面有两条断言专门锁「**没有**死控件」。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import { PROVIDER_ICONS } from '../../plugin-src/client/provider-icons.js'
import {
  CREDITS_CAPABILITIES,
  supportsCreditBalance,
  supportsDailyCheckin,
} from '../../plugin-src/client/credits-capabilities.js'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = resolve(here, '../../plugin-src/client')
const jetHub = readFileSync(resolve(CLIENT_DIR, 'jet-hub.js'), 'utf8')
const styles = readFileSync(resolve(CLIENT_DIR, 'jet-hub-styles.js'), 'utf8')
const accioCreditsSrc = readFileSync(resolve(here, '../../src/accio-credits.ts'), 'utf8')
const registrySrc = readFileSync(resolve(here, '../../src/provider-registry.ts'), 'utf8')

/**
 * 取一个**顶层函数声明**的函数体（到下一个顶层 `function ` 为止）。
 *
 * ⚠️ `indexOf` 的结果**必须先断言 `>= 0`** 再拿去切片：`-1` 会让
 * `slice(-1)` 静默切到「最后一个字符」，后续断言于是变成对一段无关文本的
 * 检查 —— 这正是本仓库记录的「找不到却全绿」形态。
 *
 * ⚠️⚠️ 找「下一个顶层 function」**必须用行尾无关的正则**，不能用
 * `indexOf('\nfunction ')`：本仓库 `core.autocrlf=true`，客户端源码在工作区是
 * **CRLF**，`'\nfunction '` 恒匹配不到 ⇒ `-1` ⇒ 回退成 `source.length` ⇒
 * 切出**整个文件尾部** ⇒ 后面的否定断言恒真（**假绿**，不是假红 —— 最坏的一种）。
 * 见 `tests/unit/source-scope.spec.ts`（issue IKJMG1）的同一形态。
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `未找到 function ${name}(`).toBeGreaterThanOrEqual(0)
  // ⚠️ `\r?\n` 兼容 CRLF 与 LF。
  const next = /\r?\nfunction /.exec(source.slice(start + 1))
  return next === null ? source.slice(start) : source.slice(start, start + 1 + next.index)
}

/**
 * 断言某个片段**确实存在**，并返回它（配合下面的「不存在」断言使用）。
 *
 * ⚠️ 非空断言的理由（本仓库的 `indexOf >= 0` 规则）：若片段找不到，
 * `expect(x).not.toContain(...)` 这类**否定**断言会**恒真** —— 一段根本不存在的
 * 文本当然不含被禁字符串。先在这里把「片段存在」断言掉，后面的否定断言才有意义。
 */
function requireFragment(source: string, fragment: string, label: string): string {
  const at = source.indexOf(fragment)
  expect(at, `未找到片段（${label}）：${fragment}`).toBeGreaterThanOrEqual(0)
  return fragment
}

describe('★ 图标', () => {
  it('accio 有图标', () => {
    expect(PROVIDER_ICONS.accio).toBeTruthy()
  })

  it('⚠️ registry 的 id 集合与图标表**逐一相等**（新增 provider 忘加图标会红）', () => {
    // ⚠️ 写成 `toEqual` 而不是「registry ⊆ icons」：后者漏掉「图标表多了一条
    // registry 没有的孤儿」这一侧。集合相等才对得上 provider-icons.js 文件头
    // 那句「条数 = registry 的 id 数」。
    const registryIds = PROVIDER_REGISTRY.map((d) => d.id).sort()
    const iconIds = Object.keys(PROVIDER_ICONS).sort()
    expect(iconIds).toEqual(registryIds)
  })

  it('accio 的 logoClass 与 registry 一致，且样式表给了白底容器', () => {
    expect(descriptorOf('accio')?.logoClass).toBe('accio')
    expect(styles).toMatch(/\.dim-jh-providerIcon\.accio\s*\{/)
  })
})

describe('★ 能力登记（从 registry 派生，不得手抄）', () => {
  it('balance: true、dailyCheckin: false', () => {
    expect(CREDITS_CAPABILITIES.accio).toEqual({ balance: true, dailyCheckin: false })
    expect(supportsCreditBalance('accio')).toBe(true)
    expect(supportsDailyCheckin('accio')).toBe(false)
  })

  it('⚠️ 因此通用「一键领取积分」对 accio 必然不渲染（dailyCheckin 是唯一闸门）', () => {
    expect(supportsDailyCheckin('accio')).toBe(false)
    // 宿主侧如实登记：Accio 没有签到端点。
    expect(accioCreditsSrc).toMatch(/没有签到端点/)
  })

  it('⚠️ registry 的注释**不得**再声称面板已有「刷新每日额度」入口', () => {
    // 那条承诺在本提交里**未兑现**（需要宿主 RPC）。注释若继续那么写，
    // 下一个读代码的人会去面板里找一个不存在的按钮。
    const start = registrySrc.indexOf("id: 'accio'")
    expect(start, '未找到 registry 的 accio 条目').toBeGreaterThanOrEqual(0)
    const entry = registrySrc.slice(start, registrySrc.indexOf("id: 'aggregate'", start))
    expect(entry, '未找到 accio 条目正文').not.toBe('')
    // 必须如实写明「尚未实现」，并保留 dailyCheckin 的理由。
    expect(entry).toMatch(/尚未实现|未实现|未接线/)
    expect(entry).toMatch(/没有签到端点/)
    // 「登录时发放」这个事实必须仍在（它是 dailyCheckin: false 的理由）。
    expect(entry).toMatch(/登录/)
  })
})

describe('★ accio 面板', () => {
  it('⚠️ 按 provider **正向**分支（本仓库明确反对排除法/else 链）', () => {
    expect(jetHub).toMatch(/provider === 'accio'/)
    // 排除法形态必须不存在：`provider !== 'accio'` 会让「将来新增 provider
    // 时忘了登记」落进 accio 分支（或反之），且失败方向不可预测。
    expect(jetHub).not.toMatch(/provider !== 'accio'/)
  })

  it('⚠️ 面板由 ProviderPanel 以 createElement 挂载（不是直接函数调用）', () => {
    // 直接 `AccioDailyPanel({...})` 会把它的 hook 算进 ProviderPanel ——
    // 本组件当前无 hook，但保持同款写法，免得将来加 state 时踩 React #310。
    expect(jetHub).toMatch(/React\.createElement\(AccioDailyPanel,/)
    expect(jetHub).not.toMatch(/renderAccioDailyPanel\(/)
  })

  it('⚠️ 必须写明「登录时发放」「24 小时」「不累积」', () => {
    // 三条缺一不可：少了「登录时」用户会去找领取按钮；
    // 少了「24 小时 / 不累积」用户会以为可以攒着。
    expect(jetHub).toMatch(/登录时/)
    expect(jetHub).toMatch(/24 小时/)
    expect(jetHub).toMatch(/不累积/)
  })

  it('⚠️ 必须给出**今天真的可用**的手动路径：删除账号后重新登录', () => {
    const panel = functionBody(jetHub, 'AccioDailyPanel')
    // ⚠️ 先断言片段存在，再做否定断言（否则否定断言恒真）。
    requireFragment(panel, 'ACCIO_DAILY_REWARD_NOTE', '面板必须渲染诚实说明常量')
    const note = jetHub.slice(jetHub.indexOf('const ACCIO_DAILY_REWARD_NOTE'))
    expect(note, '说明里必须给出「删除该账号后重新登录」这条手动路径')
      .toMatch(/删除该账号后重新登录|删除.*重新登录/)
    // 它不得被写成「一键领取」这种误导性措辞 —— 那描述的是一个不存在的操作。
    expect(jetHub).not.toMatch(/一键领取每日/)
  })

  it('⚠️ 面板必须真的渲染说明文案（而不是只定义了常量不用）', () => {
    const panel = functionBody(jetHub, 'AccioDailyPanel')
    expect(panel).toContain('ACCIO_DAILY_REWARD_NOTE')
  })

  it('⚠️ **不得**渲染「刷新每日额度」死控件，也不得接 account.create 重登录', () => {
    // ── 这条是本提交 reduced scope 的核心闸门 ──
    // 现有 RPC 面上没有「重新登录**既有**账号」的出口：`account.create` 每次
    // 都用 `${provider}-${shortId()}` 现造 id 与 ref。接上它 = 多一条幽灵账号
    // 且原账号额度一点没刷新 ⇒ 宁可没有控件，也不做一个骗人的控件。
    //
    // ⚠️ 先把「面板确实存在」断言掉：否则下面所有否定断言在一段**不存在**的
    //    文本上都恒真（本仓库的「找不到却全绿」形态）。
    const panel = functionBody(jetHub, 'AccioDailyPanel')
    requireFragment(panel, 'dim-jh-accioPanel', '面板根节点类名')
    expect(panel).toMatch(/dim-jh-accioBuckets/)
    // ① 面板体内**不得有按钮**（文案与确认弹窗都不许有）。
    //    ⚠️ 断言范围收在**面板函数体**内，而不是整份 jet-hub.js：别处的注释
    //    会解释「为什么不做这个按钮」，那是诚实记录、不是控件。
    expect(panel, '面板体内不得渲染任何按钮').not.toMatch(/createElement\('button'/)
    // ⚠️ 判据是**按钮文案**形态（引号开头），不是裸子串：倒计时那一行的 tooltip
    //    里合法地写着「距服务端刷新每日额度还剩的时间」，裸子串会假失败。
    expect(panel, '面板不得把「刷新每日额度」渲染成文案').not.toMatch(/'刷新每日额度/)
    // 旧实现的按钮文案（带金额）必须彻底消失。
    expect(jetHub, '旧按钮文案必须已删除').not.toMatch(/刷新每日额度（200 积分）/)
    expect(jetHub, '确认弹窗必须已删除').not.toMatch(/AccioDailyRefreshDialog/)
    expect(jetHub, '不得保留重登录的执行函数').not.toMatch(/accioDailyRefresh/)
    // ② 面板不得为这个 provider 走 `account.create`（重登录）。
    expect(panel, '面板不得调用 account.create').not.toMatch(/account\.create/)
    expect(panel, '面板不得调用 credits.claim').not.toMatch(/credits\.claim/)
    // ③ 面板是**纯展示**：不得持有重登录所需的请求状态。
    expect(panel, '面板不得持有 busy/confirm 状态').not.toMatch(/React\.useState/)
  })

  it('⚠️ 三类积分桶**逐桶渲染**，且桶名锚定宿主真相源', () => {
    const panel = functionBody(jetHub, 'AccioDailyPanel')
    expect(panel, '逐桶渲染必须遍历 packages').toMatch(/packages/)
    expect(panel, '必须真的 map 出每一桶，而不是只显示总额').toMatch(/\.map\(/)
    // 每日桶按**池名**定位（不是下标）算重置倒计时 —— 池名必须与宿主逐字一致，
    // 否则倒计时那一行会永远不出现（静默失效）。
    const dailyLabel = /\{ key: 'daily', label: '([^']+)' \}/.exec(accioCreditsSrc)?.[1]
    expect(dailyLabel, '未从 src/accio-credits.ts 读到 daily 桶的展示名').toBe('每日积分')
    expect(jetHub).toContain(`'${dailyLabel}'`)
  })

  it('⚠️ 每日额度重置倒计时由 cycleEndTime 现算（不写死 86400）', () => {
    const body = functionBody(jetHub, 'accioResetSeconds')
    expect(body, '倒计时必须读后端下发的 cycleEndTime').toMatch(/cycleEndTime/)
    // ⚠️ 不得把 86400 写死进客户端：它是**实测读数**，上游改刷新周期后
    // 写死的倒计时会与真实重置时刻脱节，而且没有任何报错。
    // ⚠️ 断言范围收在 accio 自己的两个函数体内，而不是整份 jet-hub.js ——
    //    别处有**既有**的 `86400000`（毫秒/天的换算，与 accio 无关），
    //    对整份文件断言会假失败。
    expect(body).not.toMatch(/86400/)
    const panel = functionBody(jetHub, 'AccioDailyPanel')
    requireFragment(panel, 'dim-jh-accioPanel', '面板根节点类名')
    expect(panel, '面板不得写死 86400').not.toMatch(/86400/)
  })

  it('⚠️ 倒计时不可读时整行不渲染（不编造一个倒计时）', () => {
    const body = functionBody(jetHub, 'accioResetSeconds')
    // 取不到每日桶 / 时刻不可解析时必须返回 null，而不是 0 或某个默认值。
    expect(body).toMatch(/return null/)
    const fmt = functionBody(jetHub, 'formatAccioResetCountdown')
    expect(fmt, '不可读的秒数必须返回 null').toMatch(/return null/)
  })

  it('⚠️ 字面说明「有效期 24 小时，次日刷新、不累积」', () => {
    expect(jetHub).toMatch(/有效期 24 小时，次日刷新、不累积/)
  })

  it('⚠️ 通用积分行对 accio 必须关掉（否则同一份余额显示两遍）', () => {
    const normalized = jetHub.replace(/\r\n/g, '\n')
    expect(normalized, 'showCredits 必须排除 accioPanel')
      .toMatch(/showCredits:\s*canLoadCredits\s*&&\s*!accioPanel/)
  })
})

describe('★ 样式', () => {
  it('⚠️ 注入的 <style> 必须署名 data-plugin（否则被别的插件认领后连带删除，IKK764）', () => {
    expect(styles).toMatch(/style\.dataset\.plugin = PLUGIN_ID/)
    expect(styles).toMatch(/style\.dataset\.pluginCss = STYLE_TAG_ID/)
  })

  it('⚠️ 模板字符串反引号恰好 2 个（注释里写反引号会提前闭合 STYLES）', () => {
    // STYLES 是模板字符串：注释里写字面反引号会提前闭合它，esbuild 报的错
    // 却指向注释那一行，看起来像 CSS 写错。整份文件只允许首尾那两个。
    const count = (styles.match(/`/g) ?? []).length
    expect(count, 'STYLES 之外多了一对反引号（大概率在注释里）').toBe(2)
  })

  it('accio 面板用到的每个类名都在样式表里定义（且面板真的在用）', () => {
    // ⚠️ 先把面板本身断言存在，否则下面的 `toContain` 会指向一段不存在的文本。
    const panel = functionBody(jetHub, 'AccioDailyPanel')
    requireFragment(panel, 'dim-jh-accioPanel', '面板根节点')
    for (const cls of [
      'dim-jh-accioPanel',
      'dim-jh-accioHead',
      'dim-jh-accioTitle',
      'dim-jh-accioNote',
      'dim-jh-accioAccount',
      'dim-jh-accioAccountHead',
      'dim-jh-accioAccountName',
      'dim-jh-accioAccountTier',
      'dim-jh-accioCountdown',
      'dim-jh-accioBuckets',
      'dim-jh-accioBucket',
      'dim-jh-accioBucketName',
      'dim-jh-accioBucketValue',
      'dim-jh-accioBucketUsed',
    ]) {
      expect(styles, `样式表缺 .${cls}`).toMatch(new RegExp(`\\.${cls}\\b`))
      expect(panel, `面板没有用到 ${cls}`).toContain(cls)
    }
  })
})
