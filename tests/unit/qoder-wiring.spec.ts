import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { descriptorOf } from '../../src/provider-registry.js'
import { jetHubAuthsCallKeys } from '../helpers/jet-hub-auths.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(resolve(here, p), 'utf8')

/** 剔除注释行，避免注释里叙述缺陷的文字造成假阳性/假阴性。 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

describe('Qoder 宿主侧接线（src/index.ts）', () => {
  const index = read('../../src/index.ts')

  it('注册了 llm-qoder settings namespace（漏了会让模型设置页崩溃）', () => {
    // 模型设置页会用 provider id 计算 deriveKeyRef(provider)，
    // namespace 未注册时在 refFor → provider.toUpperCase 处崩溃。
    // ⚠️ 2026-10-08 改：原先扫 index.ts 源码文本找 `'llm-qoder'`。本次重构把 13 个
    //    字面量收敛成从 `PROVIDER_REGISTRY` 派生 ⇒ 文本断言变红而行为没变。
    //    改为断言声明值；「index.ts 真的按它注册了」由
    //    `provider-registry-consumers.spec.ts` 的 `apply()` 行为用例守。
    expect(descriptorOf('qoder')?.settingsNamespace).toBe('llm-qoder')
  })

  it('构造并注册了 Qoder 服务与 LLM 路由', () => {
    expect(index).toContain('new QoderAuth(')
    expect(index).toContain('registerQoderLlm(')
  })

  it('续期调度包含 qoder', () => {
    // `(pool|p)`：逐个 await 与表驱动两种写法都接受，避免重构调度器时假失败。
    expect(index).toMatch(/qoder\.refreshAll\((?:pool|p)\)/)
  })

  it('清理钩子包含 qoder.stop()', () => {
    expect(index).toContain('qoder.stop()')
  })

  it('Jet Hub RPC 传入 qoder 实例与适配器映射', () => {
    // 末尾的 `modelAdapters` 供「显示列表」取不受黑名单影响的全量目录
    // （使被关闭的模型也显示正确的展示名/倍率，而不是退化成裸 id）。
    //
    // ⚠️ 2026-10-08 改措辞：auth 实例已是**命名对象**（键是 provider id），
    // 不再是位置参数 —— 故本断言现在的含义是「`qoder` 键在 auths 对象字面量里，
    // 且该字面量位于 `modelAdapters` 之前」。新增 provider 只是**多一个键**，
    // 不再有「插队挤掉后续形参」这回事。
    // ⚠️ 这里仍不限定 `qoder` 与 `modelAdapters` 之间**具体有哪些键** ——
    // 写死整串会让每加一个 provider 都假失败
    //（加 Loomy、Raccoon、QoderCN 时各踩过一次）。
    // 「中国版紧跟国际版」这条更具体的约束由下面的 QoderCN 用例负责。
    expect(index).toMatch(
      /registerJetHubRpc\([\s\S]*?qoder,[\s\S]*?modelAdapters\)/,
    )
    expect(index, 'qoder 适配器须登记进映射').toMatch(/qoder: pruned\([^)]*,\s*qoderAdapter\)/)
  })

  it('续期调度不看 enabled（AGENTS.md 强制约定）', () => {
    // 真实缺陷：写成 `a.refreshable && a.enabled` 后，所有账号被停用时
    // 续期定时器根本不启动，凭据一路过期到 refresh_token 失效。
    // ⚠️ 原先这里还**正向**断言 `accounts.some(a => a.refreshable)` 必须存在 ——
    // 2026-10-02 那道启动门已改为「池里有账号就武装」（见 AGENTS.md
    // 「账号池的 `refreshable` 只是凭据材料的镜像」）：拿一个可能被误标的布尔
    // 决定「要不要启动修误标的机制」是循环依赖。本用例只保留真正的契约。
    const code = codeOnly(index)
    expect(code).not.toContain('a.refreshable && a.enabled')
    expect(code).not.toMatch(/some\(\s*a\s*=>\s*a\.enabled\s*\)/)
  })

  it('账号池 provider 实参用 QODER.id 而非字面量', () => {
    // 写死 'qoder' 在改名/多产品场景下会静默查不到账号
    expect(index).toContain('getAvailableAccount(QODER.id')
  })
})

describe('Qoder Jet Hub RPC 分支（src/jet-hub-rpc.ts）', () => {
  const rpc = read('../../src/jet-hub-rpc.ts')

  it('registerJetHubRpc 接受 qoder 形参', () => {
    expect(rpc).toContain('qoder: QoderAuth')
  })

  it('account.create 有 Qoder 同族的两步式分支', () => {
    const code = codeOnly(rpc)
    // 重构后分支按注册表判定，实例来自 member.auth（见下面的注册表 describe）。
    expect(code).toContain('isQoderFamily(provider)')
    expect(code).toContain('auth.startLogin({ refName })')
  })

  it('account.refresh 分派包含 qoder', () => {
    // 重构后走同族注册表：实例由 `requireQoderFamily(entry.provider).auth` 取得，
    // 两个 provider id 共用同一个 case（见下面的注册表 describe）。
    // `[^)]*` 容忍签名扩展：现在还要传 `pool` + `entry.id`，
    // 续期成功后才能把新 `expiresAt` 回写账号池（issue !IKIRTT）。
    expect(codeOnly(rpc)).toMatch(
      /requireQoderFamily\(entry\.provider\)\.auth\.refreshAccountCredential\(entry\.credentialRef[^)]*\)/,
    )
  })

  it('credits.balances 有 Qoder 同族分支（余额接口只需 Bearer，可用）', () => {
    // 实测修正：Qoder 的余额端点 `/sash/api/v2/me/usage` 只需
    // Bearer + Cosy-ClientType（**不需要** WASM 签名），故余额能力为 true。
    // 早期误判「无积分端点」是因为只按 `/api/` 前缀搜索。
    const code = codeOnly(rpc)
    const creditsStart = code.indexOf("case 'credits.balances'")
    const creditsEnd = code.indexOf("case 'model.list'")
    expect(creditsStart).toBeGreaterThan(-1)
    const creditsBlock = code.slice(creditsStart, creditsEnd)
    // 重构后按同族注册表判定（`QODER.id` 字面量只出现在注册表里，见下面的 describe）。
    expect(creditsBlock).toContain('isQoderFamily(req.provider)')
    expect(creditsBlock).toContain('fetchQoderCreditBalance')
  })

  it('credits.claimAll 含 Qoder 同族分支（2026-09-21 抓包解出领取端点）', () => {
    // ⚠️ 早期该用例断言的是**相反**的结论（「不含 qoder」），依据是
    // `/sash/api/v1/me/campaigns` 返回 `claimable:false`。真相是**那天已领** ——
    // 活动每日 10:00（UTC+8）刷新。用 keylog 解密抓包拿到：
    //   GET  /sash/api/v1/me/campaigns
    //   POST /sash/api/v1/me/campaigns/{campaignId}/claim   （body 空）
    // 幂等判据是响应体的 `replayed`（重复领取同样 HTTP 200）。
    const code = codeOnly(rpc)
    const start = code.indexOf("case 'credits.claimAll'")
    const end = code.indexOf("case 'credits.balances'")
    expect(start).toBeGreaterThan(-1)
    const branch = code.slice(start, end)
    // 重构后按同族注册表判定。
    expect(branch).toContain('isQoderFamily(req.provider)')
    expect(branch).toContain('claimQoderDailyCheckin')
    // Qoder 的领取流程自带活动列表查询 → 必须跳过外部预检，否则重复发一次 GET。
    expect(branch).toContain('precheckStatus: false')
  })
})

describe('QoderCN 宿主侧接线（src/index.ts）', () => {
  const index = read('../../src/index.ts')

  it('注册了 llm-qodercn settings namespace', () => {
    // 漏了会让模型设置页在 deriveKeyRef(provider) → provider.toUpperCase 处崩溃。
    // ⚠️ 2026-10-08 改：同上一节，源码文本断言 → registry 行为断言。
    expect(descriptorOf('qodercn')?.settingsNamespace).toBe('llm-qodercn')
  })

  it('用 QODER_CN 构造了第二个 QoderAuth 实例', () => {
    // 服务名由 `${product.id}Auth` 派生 ⇒ 自动是 qoderCnAuth，不会与国际版撞名。
    expect(index).toContain('new QoderAuth(ctx, { product: QODER_CN })')
  })

  it('注册了 CN 的 LLM 路由并传入 product: QODER_CN', () => {
    const code = codeOnly(index)
    expect(code).toContain('const qoderCnAdapter = registerQoderLlm(')
    expect(code).toContain('product: QODER_CN,')
  })

  it('CN 的账号池 provider 实参用 QODER_CN.id 而非字面量', () => {
    // 写死 'qoder' 会让中国版永远查不到自己的账号（workbuddy 踩过同类坑）。
    const code = codeOnly(index)
    expect(code).toContain('getAvailableAccount(QODER_CN.id')
    expect(code).not.toContain("getAvailableAccount('qodercn'")
  })

  it('CN 的默认凭据 ref 走 QODER_CN.defaultCredentialRef', () => {
    // 不能复用国际版的 QODER_ACCESS_TOKEN，否则两站账号会读写同一份凭据。
    const code = codeOnly(index)
    expect(code).toContain('credentialRef(QODER_CN.defaultCredentialRef)')
  })

  it('CN 的续期回写刷的是解析凭据时所用的那一个 ref', () => {
    // 与 qoder-auth 那条真实缺陷同因：刷默认单凭据 ref 会导致「刚登录却认证失败」。
    // 关键不变式是 **`qoderCn.` 前缀 + `available.entry.credentialRef`**；
    // `[^)]*` 容忍后面追加的 `pool` + `available.entry.id`（回写有效期用）。
    const code = codeOnly(index)
    expect(code).toMatch(/qoderCn\.refreshAccountCredential\(available\.entry\.credentialRef[^)]*\)/)
  })

  it('续期调度包含 qoderCn.refreshAll(pool)', () => {
    // `(pool|p)`：逐个 await 与表驱动两种写法都接受。
    expect(index).toMatch(/qoderCn\.refreshAll\((?:pool|p)\)/)
  })

  it('两处清理钩子都包含 qoderCn.stop()', () => {
    // 两处都要：scheduler 钩子与 legacy 钩子（国际版 qoder.stop() 也在两处）。
    const occurrences = (index.match(/qoderCn\.stop\(\)/g) ?? []).length
    expect(occurrences).toBe(2)
  })

  it('CN 适配器登记进 modelAdapters', () => {
    // ⚠️ 2026-10-06 复审 !66：登记项经 `pruned(...)` 包装（致命缺陷修复之一 ——
    // 否则 Jet Hub 拿到原始实例，「已失效模型」剔除对设置页不生效）。
    expect(index).toMatch(/qodercn: pruned\([^)]*,\s*qoderCnAdapter\)/)
  })

  it('registerJetHubRpc 把 qoderCn 接到 provider id `qodercn` 键上', () => {
    // ⚠️ 2026-10-08 改：原先这里断言**位置参数**的顺序
    //    `/registerJetHubRpc\(ctx, pool, service, …, qoder, qoderCn, trae, …\)/`
    //    —— 13 个形参改成**命名对象**后必然变红。
    //    ⇒ 改为断言**键约定**：键是 provider id `qodercn`，值是变量 `qoderCn`。
    //    这条比原断言更精确：原断言只能证明「qoderCn 排在 qoder 后面」，
    //    而真正的风险是「键写成变量名 ⇒ 查表查不到中国版」。
    //
    // ⚠️⚠️ **2026-10-08 复审 Finding 2：这里曾写成相邻性正则**
    //    `/qodercn:\s*qoderCn\b/` —— 它把「键」与「值」用**同一行相邻**绑死，
    //    而对象字面量里键与值的相邻关系只是书写顺序（换行/加注释/调整排版都会
    //    让它假失败）。⇒ 改为按 **AST** 取调用点第三个实参的属性名与初值：
    //    `{ qodercn: qoderCn }` 的映射关系被**结构化**地读出来。
    //    ⚠️ 键写成 `qoderCn` 这件事**类型层已经拦住**（`JetHubAuths` 没有该键
    //    ⇒ TS2561），故本用例不再重复证明拼写，只证明**接线用的是 id 键**、
    //    且值确实指向 `qoderCn` 这个实例（而不是国际版 `qoder`）。
    //
    // ⚠️ 「端到端分派真的落到中国版实例上」由行为用例守（真跑 apply +
    //    account.refresh，且**反向验证**过「两键的值互换 ⇒ 变红」）：
    //    `tests/unit/jet-hub-rpc-auth-wiring.spec.ts` 的
    //    「★ 中国版账号分派到 qodercnAuth，不碰国际版 qoderAuth」。
    const authKeys = jetHubAuthsCallKeys(index)
    expect(Object.keys(authKeys), '键必须是 provider id `qodercn`（不是变量名 qoderCn）')
      .toContain('qodercn')
    expect(authKeys.qodercn, '`qodercn` 键的值必须是 `qoderCn` 实例（不是国际版 qoder）')
      .toBe('qoderCn')
    expect(Object.keys(authKeys), '变量名 `qoderCn` 不得出现在键位上').not.toContain('qoderCn')
  })

  it('续期调度不看 enabled（对 CN 同样成立）', () => {
    // 断言对象是同一份 `src/index.ts` 的启动门，理由见国际版那条用例的注释。
    const code = codeOnly(index)
    expect(code).not.toContain('a.refreshable && a.enabled')
    expect(code).not.toMatch(/some\(\s*a\s*=>\s*a\.enabled\s*\)/)
  })
})

describe('Qoder 同族 RPC 注册表（src/jet-hub-rpc.ts）', () => {
  const rpc = read('../../src/jet-hub-rpc.ts')
  const code = codeOnly(rpc)

  it('四处分支都按注册表判定，不再各写一条平行 case', () => {
    // 加同族产品只改注册表一处。历史教训：workbuddy 的「刷新」按钮一直是坏的，
    // 根因就是新增 provider 时漏接了一个分支 —— 平行 case 越多，漏接概率越高。
    expect(code).toContain('qoderFamily')
    expect(code).toContain('isQoderFamily(')
    expect(code).toContain('requireQoderFamily(')
    // 登录分支不得再只认国际版
    expect(code).not.toContain('} else if (provider === QODER.id) {')
    // 领取与余额分支同理
    expect(code).not.toContain('if (req.provider === QODER.id) {')
  })

  it('注册表含两个产品实例', () => {
    expect(code).toContain('{ product: QODER, auth: qoder }')
    expect(code).toContain('{ product: QODER_CN, auth: qoderCn }')
  })

  it('分支内部一律用 member.product / member.auth，不出现 QODER 字面量', () => {
    // 否则中国版会拿国际版的域名与 client_id 发请求。
    const loginStart = code.indexOf('} else if (isQoderFamily(')
    expect(loginStart).toBeGreaterThan(-1)
    const loginBlock = code.slice(loginStart, code.indexOf('} else if (provider === TRAE.id)'))
    expect(loginBlock.length).toBeGreaterThan(0)
    expect(loginBlock).toContain('auth.startLogin({ refName })')
    expect(loginBlock).toContain('provider: product.id')
    expect(loginBlock).toContain('fetchQoderUserNickname(credential, product)')
    expect(loginBlock).not.toContain('fetchQoderUserNickname(credential, QODER)')
  })

  it('单账号续期分派覆盖两个 provider id', () => {
    const refreshStart = code.indexOf('switch (entry.provider)')
    const refreshBlock = code.slice(refreshStart, refreshStart + 2400)
    expect(refreshBlock).toContain('case QODER.id:')
    expect(refreshBlock).toContain('case QODER_CN.id:')
    expect(refreshBlock).toContain('requireQoderFamily(entry.provider).auth')
  })

  it('领取分支仍传 precheckStatus: false（流程自带活动查询）', () => {
    const start = code.indexOf("case 'credits.claimAll'")
    const end = code.indexOf("case 'credits.balances'")
    const branch = code.slice(start, end)
    expect(branch).toContain('isQoderFamily(req.provider)')
    expect(branch).toContain('claimQoderDailyCheckin(credential, product)')
    expect(branch).toContain('precheckStatus: false')
    // ⚠️ 不能退化成只认国际版
    expect(branch).not.toContain('claimQoderDailyCheckin(credential, QODER)')
  })

  it('余额分支按 member.product 取配置', () => {
    const start = code.indexOf("case 'credits.balances'")
    const branch = code.slice(start, start + 3000)
    expect(branch).toContain('isQoderFamily(req.provider)')
    expect(branch).toContain('fetchQoderCreditBalance(credential, product)')
  })
})
