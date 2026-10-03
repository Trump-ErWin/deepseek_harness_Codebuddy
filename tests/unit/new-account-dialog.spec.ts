/**
 * Gitee issue IKJLK3：「+ 新建账号」这条链路的分支判定与入参构造。
 *
 * ## 本 issue 的实际修复面（评审后与提单人共识的部分）
 *
 * | 组 | 结论 | 本文件的角色 |
 * |---|---|---|
 * | **A1/A2/A3** 弹窗对 provider 零分支 | ✅ 属实，**同源**，一并修 | A 组（纯函数真跑 + 接线源码锁） |
 * | **A4** 默认选中项是 codearts | ❌ **不是缺陷** —— 设置页默认停在第一个 provider 是正常设计，issue 里自己也只说它「放大了迷惑性」。**不改** | — |
 * | **B** 登录重入静默 return | ✅ 属实（低频但可感），补提示 | B 组 |
 * | **C** 两处 `zcodeProvider` 各自独立 | ❌ **有意为之**（提单人自己认同），仅信息性 | — |
 * | **D** 完整 loginUrl 打进 console | ✅ 属实，OAuth state 会被一起外泄 | D 组 |
 * | **E1** `account.create` 未校验 provider | ⚠️ **提单人判断有误**：链尾已有兜底 `else { return unknown provider }`（`jet-hub-rpc.ts`，本 issue 修前即存在），且 `id` 只在分支内使用，未知 provider **不会**写进账号池。**不加重复校验** | — |
 * | **E2** `zcodeProvider` 无白名单 | ✅ 属实，RPC 载荷无 schema 校验 | E 组 |
 * | **F1** 无测试覆盖 | ✅ 属实 | 本文件 |
 * | **F2** 顺序型注释 | ✅ 属实 | 已改（不在单测范围） |
 *
 * ## ⚠ 为什么 A 组一半靠源码断言 —— 请先读这段再改
 *
 * 判据本身（`newAccountAsksChannel` / `buildCreateAccountPayload`）抽在
 * `plugin-src/client/new-account.js` 里**真跑**：单测环境是 `node`，`react`
 * 不在依赖内，`jet-hub.js` 根本 import 不了，组件无法渲染。
 *
 * 但**接线**（按钮点了走哪条路、弹窗渲染处有没有判据）只能锁源码。照本仓库
 * 既有的告誡（见 `zcode-carrier-client-wiring.spec.ts` 的 `stripComments`），
 * 这些断言**一律对剥掉注释的代码文本做** —— 否则文件头为了记录旧实现写下的
 * 那行字就能把断言喂绿（本轮修的正是「登录渠道选择」这件事，注释里必然
 * 会提到它）。下面每条源码断言的变异结果都记在文件末尾，做过反向验证。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { buildCreateAccountPayload, newAccountAsksChannel } from '../../plugin-src/client/new-account.js'
import { normalizeZcodeLoginProvider } from '../../src/jet-hub-rpc.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const jetHubSource = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')

/** 剥掉注释，只留**可执行代码**（源码级断言一律用它，别被注释喂绿）。 */
function stripComments (source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const jetHubCode = stripComments(jetHubSource)

/** PROVIDERS 里此刻存在的全部 provider id（用它当「遍历全部面板」的样本源）。 */
const PROVIDER_IDS = [
  'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
  'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'opencode',
] as const

describe('A. 「+ 新建账号」必须按 provider 分支（IKJLK3 A1/A2/A3）', () => {
  it('★ 只有 zcode 需要先问登录渠道，其余 provider 点按钮即登录', () => {
    expect(newAccountAsksChannel('zcode')).toBe(true)
    // ⚠ 这条对**全部** provider 取一遍：A1 的形态是「弹窗对 provider 零分支」，
    //   只抽查两三个 provider 的话，新增一个 provider 漏判就会静默溜过去。
    for (const id of PROVIDER_IDS) {
      if (id === 'zcode') continue
      expect(newAccountAsksChannel(id), `${id} 不该弹 zCode 的渠道窗`).toBe(false)
    }
  })

  it('★ opencode 也不弹（它的登录入口是 API key 表单，不是渠道下拉）', () => {
    // A3 的核心：opencode 原先要点「+ 新建账号」先过一遍 ZCode 弹窗，
    // 点「确定」才看到自己的 API key 输入框。判据必须把它一起排除。
    expect(newAccountAsksChannel('opencode')).toBe(false)
  })

  it('未知/空 provider 走默认路径（不弹窗）—— 失败方向是安全的', () => {
    // 新增 provider 时若忘了改这里，后果是「少问一次」而不是「弹错窗」。
    expect(newAccountAsksChannel('some-new-provider')).toBe(false)
    expect(newAccountAsksChannel('')).toBe(false)
    expect(newAccountAsksChannel(undefined as unknown as string)).toBe(false)
  })

  it('★ 非 zcode 的载荷里**不许**出现 zcodeProvider（A2：选择被静默丢弃）', () => {
    for (const id of PROVIDER_IDS) {
      if (id === 'zcode') continue
      const payload = buildCreateAccountPayload(id, 'zai')
      expect(payload).toEqual({ provider: id })
      expect(Object.prototype.hasOwnProperty.call(payload, 'zcodeProvider')).toBe(false)
    }
  })

  it('★ zcode 的载荷带上渠道（这是它唯一一次选择的落点）', () => {
    expect(buildCreateAccountPayload('zcode', 'zai')).toEqual({ provider: 'zcode', zcodeProvider: 'zai' })
    expect(buildCreateAccountPayload('zcode', 'bigmodel')).toEqual({ provider: 'zcode', zcodeProvider: 'bigmodel' })
  })

  it('★ 接线：按钮的 onClick 走判据，弹窗渲染处也有防御判据', () => {
    // 光有纯函数不够 —— 有人把按钮改回 `() => setPendingLogin(false)`，
    // 判据还在但没人调用，缺陷原样复现。这条就是守「接上了」。
    const click = jetHubCode.match(/onClick: \(\) => \{\s*if \(newAccountAsksChannel\(provider\)\)[^}]*\}/)
    expect(click, '新建账号按钮必须先问 newAccountAsksChannel').not.toBeNull()
    // 弹窗渲染处的防御判据（正常路径走不到，但状态是活的）。
    expect(jetHubCode).toMatch(/!newAccountAsksChannel\(provider\)\s*\?\s*null\s*:\s*React\.createElement/)
  })

  it('★ account.create 的载荷由纯函数构造（不是就地拼的三元）', () => {
    expect(jetHubCode).toContain("rpcCall('account.create', buildCreateAccountPayload(")
  })
})

describe('B. 登录重入不许静默 return（IKJLK3 B）', () => {
  it('★ 早退分支必须给提示，且提示在 return 之前', () => {
    // ⚠ 必须**先定位到 createAccount**：文件里有 3 处 `pollRef.current !== 0`，
    //   另外两处在 `stopPoll` 里（`{ clearInterval(...); pollRef.current = 0 }`）。
    //   只按字面量找第一个会命中清理逻辑，得到一条与本判据无关的红。
    const createAccount = jetHubCode.indexOf('const createAccount = async () => {')
    expect(createAccount, 'createAccount 应仍是 async 函数').toBeGreaterThan(-1)
    const gate = jetHubCode.indexOf('if (pollRef.current !== 0) {', createAccount)
    expect(gate, '重入闸门应仍在 createAccount 内').toBeGreaterThan(-1)
    const untilReturn = jetHubCode.slice(gate, jetHubCode.indexOf('return', gate))
    // 修前是 `if (pollRef.current !== 0) return;` —— 视觉上「点了没反应」。
    expect(untilReturn).toContain('setProbeNotice')
  })
})

describe('D. 完整响应（含 loginUrl / OAuth state）不许打进 console（IKJLK3 D）', () => {
  it('★ 任何 console.* 的参数里都不许出现 account.create 的响应对象', () => {
    // 修前是 `console.log('[jet-hub] account.create response =', res)`。
    // loginUrl 由服务端 fetchAuthState 生成、**携带 OAuth state**，
    // 用户截图求助时会一起外泄，且在登录窗口内可被重放。
    expect(jetHubCode).not.toMatch(/console\.(log|info|warn|debug|error)\([^)]*\bres\b/)
  })

  it('日志里保留可定位的字段（provider 与本地生成的 accountId）', () => {
    expect(jetHubCode).toContain('[jet-hub] account.create ok, provider =')
  })
})

describe('E2. zcodeProvider 必须过白名单（IKJLK3 E2）', () => {
  it('两个已登记渠道原样通过', () => {
    expect(normalizeZcodeLoginProvider('bigmodel')).toBe('bigmodel')
    expect(normalizeZcodeLoginProvider('zai')).toBe('zai')
  })

  it('★ 未登记值回落到缺省渠道（原行为是原样下发 ⇒ 打到不存在的授权端点）', () => {
    // RPC 载荷没有 schema 校验，运行时任何字符串都能进到这里。
    expect(normalizeZcodeLoginProvider('ZAI')).toBe('bigmodel')   // 大小写不同也算未登记
    expect(normalizeZcodeLoginProvider('zhihu')).toBe('bigmodel')
    expect(normalizeZcodeLoginProvider('')).toBe('bigmodel')
    expect(normalizeZcodeLoginProvider('bigmodel ')).toBe('bigmodel')  // 多一个尾随空格也回落
  })

  it('缺省（老客户端不传该字段）仍是 bigmodel，既有行为不变', () => {
    expect(normalizeZcodeLoginProvider(undefined)).toBe('bigmodel')
  })

  it('★ account.create 调用点走的是归一函数，不是 `?? \'bigmodel\'`', () => {
    const rpcSource = readFileSync(resolve(HERE, '../../src/jet-hub-rpc.ts'), 'utf8')
    const code = stripComments(rpcSource)
    expect(code).toContain('provider: normalizeZcodeLoginProvider(req.zcodeProvider)')
    expect(code).not.toMatch(/provider: req\.zcodeProvider \?\? 'bigmodel'/)
  })
})

/**
 * ## 反向验证（本轮逐条改坏后**实跑**的结果）
 *
 * | 变异 | 变红 | 说明 |
 * |---|---|---|
 * | ① `newAccountAsksChannel` 改成 `return true`（退回「弹窗对 provider 零分支」） | A 组「只有 zcode 需要先问」+「opencode 也不弹」+「未知/空 provider」共 **3 条** | 只改纯函数就能抓住 A1/A3 的语义，不必动组件 |
 * | ② `buildCreateAccountPayload` 去掉 `provider !== 'zcode'` 早退 | A 组「非 zcode 的载荷」**1 条** | A2 |
 * | ③ 按钮 `onClick` 改回 `() => setPendingLogin(false)` | A 组「接线」**1 条** | 判据还在但没人调用 —— 这条就是守这个 |
 * | ④ 弹窗渲染处去掉 `!newAccountAsksChannel(provider) &&` | A 组「接线」**1 条** | ③ ④ 共用一条断言：任一处退化都会红 |
 * | ⑤ 重入闸门改回 `if (pollRef.current !== 0) return;` | B 组**1 条** | |
 * | ⑥ 恢复 `console.log(..., res)` | D 组**2 条** | 第 2 条（保留可定位字段）一并红 |
 * | ⑦ `normalizeZcodeLoginProvider` 直接 `return raw as ZcodeLoginProvider` | E2 组「未登记值回落」+「缺省仍是 bigmodel」共 **2 条** | ⚠ 红的第二组是「缺省」而非「已登记值」：透传后连 `undefined` 都不再回落成 `bigmodel`，这才是去掉白名单的真正后果 |
 * | ⑧ 调用点改回 `provider: req.zcodeProvider ?? 'bigmodel'` | E2 组「调用点走归一函数」**1 条** | |
 *
 * ⚠ 变异 ① 只红 3 条而非更多是**预期的**：接线那条锁的是「判据被调用」，
 *   而非「判据返回什么」—— 后者由变异 ① 覆盖，两条各管一面。
 */
