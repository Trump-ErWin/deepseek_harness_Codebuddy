/**
 * Qoder 账号出口代理（真实报障 2026-10-21）的行为与接线守卫。
 *
 * ## 缺陷原形
 *
 * Qoder **国际版**全部端点（`openapi.qoder.sh`：余额 `/sash/api/v2/me/usage`、
 * 推理 `/api/v1/agent_chat_generation`、原生搜索、模型目录、**以及登录的设备码端点**）
 * 在本机被 **SNI 阻断** —— DNS 正常、TCP 443 能握手（93ms），但 TLS ClientHello
 * 被丢弃 ⇒ `fetch` 恒 10.7s `UND_ERR_CONNECT_TIMEOUT`。而**中国版**
 * （`openapi.qoder.com.cn`）直连 160ms 就通。
 *
 * 在本能力之前，Qoder 是本插件里**唯一**有墙外端点却没有 per-账号代理入口的渠道
 * （opencode 有 `opencodeProxy`、Gemini 有 `geminiProxy`）⇒ 用户唯一出路是在启动
 * DSH 前导出 `HTTPS_PROXY`，而那会让**所有渠道**一起走代理，包括本来直连就够快的
 * 中国版。
 *
 * ## 本文件为什么以**行为**断言为主
 *
 * 与 `gemini-proxy.spec.ts` 同因（IKLTZ2 两次独立审计的实测结论）：源码文本断言
 * 对「**分支恒不执行**」与「**注释诱饵**」完全无感 ——
 *
 * - 把 `fetchFor: qoderFetchForAccount,` 整行删掉、只把字面量留在**注释**里；
 * - 把 `if (method.startsWith('qoder.'))` 改成 `if (globalThis.X === true && …)`
 *   （字面量完整保留在**死条件**里，连剥注释都打不掉）。
 *
 * 两种形态都能让接线判据全绿。⇒ 原则：**能用行为断言的一律用行为**；源码断言
 * 只守「接线点在不在」这一较弱不变式，且**全部先过 `stripComments`**。
 *
 * ⚠️ 残余弱点**如实登记**：剥注释解决不了「字面量在死条件里」。凡被 ④/⑤ 组
 * 行为用例覆盖的接线点（`setProxy` / `testProxy`），都**不再**只靠源码断言。
 *
 * ## 与 `gemini-proxy.spec.ts` 的一处**语义差异**（本文件 ① 组专门守）
 *
 * Gemini 的空账号 id 是「**根本不查池**」；Qoder 的空账号 id 是「**查
 * `QODER_PENDING_PROXY_KEY`**，查不到才直连」—— 因为 Qoder 的登录第一步
 * （设备码端点）就在墙外主机上，而那时**还没有账号 id**。把它抄成 Gemini 那样
 * 会让「墙外环境下新建账号」变成死锁：登录要代理，代理要按已存在的账号配。
 */

import { describe, expect, it, vi, afterEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  QODER_PENDING_PROXY_KEY,
  createQoderFetcherResolver,
  qoderFetchForAccount,
  setQoderProxyPool,
} from '../../src/qoder-proxy.js'
import { handleQoderRpc } from '../../src/qoder-rpc.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import { QODER_USAGE_PATH } from '../../src/qoder-credits.js'
import { asProxyText } from '../../src/account-pool.js'
import { closeAllProxyDispatchers } from '../../src/opencode-proxy.js'
import { stripComments } from '../helpers/strip-comments.js'

const here = dirname(fileURLToPath(import.meta.url))
// ⚠️ **全部先剥注释**：见文件头的「为什么以行为断言为主」。
const indexSource = stripComments(readFileSync(join(here, '../../src/index.ts'), 'utf8'))
const rpcSource = stripComments(readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8'))
const adapterSource = stripComments(readFileSync(join(here, '../../src/qoder-adapter.ts'), 'utf8'))
const authSource = stripComments(readFileSync(join(here, '../../src/qoder-auth.ts'), 'utf8'))
const poolSource = stripComments(readFileSync(join(here, '../../src/account-pool.ts'), 'utf8'))
const typesSource = stripComments(readFileSync(join(here, '../../src/types.ts'), 'utf8'))
const proxySource = stripComments(readFileSync(join(here, '../../src/qoder-proxy.ts'), 'utf8'))

/** 取某个 `export interface X {` 的接口体（切到下一个顶层 `export`）。 */
function interfaceBody(source: string, name: string): string {
  const at = source.indexOf(`export interface ${name} `)
  expect(at, `未找到 interface ${name}`).toBeGreaterThan(-1)
  const end = source.indexOf('\nexport ', at + 1)
  return source.slice(at, end === -1 ? source.length : end)
}

describe('① fetcher 解析器：按账号取出口', () => {
  it('⚠️ 空账号 id ⇒ 查的是「登录预置」那条（不是空串，也不抛错）', () => {
    // ⚠️ 本组是**与 Gemini 的语义差异点**：Gemini 空 id 根本不查池，
    //    Qoder 必须查 `QODER_PENDING_PROXY_KEY` —— 登录第一步就打设备码端点，
    //    那时还没有账号 id，不查 pending 就等于「墙外环境下永远登录不上」。
    const asked: string[] = []
    const resolver = createQoderFetcherResolver((id) => {
      asked.push(id)
      return ''
    })
    expect(resolver('')).toBe(fetch)
    expect(asked).toEqual([QODER_PENDING_PROXY_KEY])
  })

  it('⚠️ 有账号 id 时**绝不**回落 pending 键（否则真实账号莫名走另一份出口）', () => {
    const asked: string[] = []
    const resolver = createQoderFetcherResolver((id) => {
      asked.push(id)
      return id === QODER_PENDING_PROXY_KEY ? 'http://127.0.0.1:7897' : ''
    })
    // 注册了 pending 代理，但问的是一个**真实账号** ⇒ 必须按该账号（未配置=直连）。
    expect(resolver('qoder-1')).toBe(fetch)
    expect(asked).toEqual(['qoder-1'])
    // 反向确认「pending 那条确实存在」：否则上面那条会因为恒空而恒真。
    expect(resolver('')).not.toBe(fetch)
  })

  it('账号没配代理 ⇒ 退回全局 fetch（保住 Node 24+ 的 NODE_USE_ENV_PROXY 宿主能力）', () => {
    const resolver = createQoderFetcherResolver(() => '')
    expect(resolver('qoder-1')).toBe(fetch)
  })

  it('⚠️ 配了代理 ⇒ 换成另一个 fetcher（不是同一份全局 fetch）', () => {
    const resolver = createQoderFetcherResolver((id) =>
      id === 'qoder-1' ? 'http://127.0.0.1:7897' : '')
    // ⚠️ 判据必须是「**不是**全局 fetch」：写成「调一次看有没有走代理」
    //    会在没配代理那一格也通过 ⇒ 恒真、无牙。
    expect(resolver('qoder-1')).not.toBe(fetch)
    expect(resolver('qoder-2')).toBe(fetch)
  })

  it('裸 host:port 也认（本地代理客户端最常见的填法）', () => {
    const resolver = createQoderFetcherResolver(() => '127.0.0.1:7897')
    expect(resolver('qoder-1')).not.toBe(fetch)
  })

  it('⚠️ 非法代理地址必须抛错，绝不静默退回直连', () => {
    // ⚠️ 这条是「用户以为配了代理却在裸奔」的唯一防线：
    //    静默回退会让症状与「没配代理」**完全同形**，用户无从发现。
    const resolver = createQoderFetcherResolver(() => 'ftp://host:21')
    expect(() => resolver('qoder-1')).toThrow(/代理地址无效/)
  })

  it('⚠️ 抛错信息必须点名是哪个账号（多账号下否则无从定位）', () => {
    const resolver = createQoderFetcherResolver(() => 'ftp://host:21')
    expect(() => resolver('qoder-1')).toThrow(/qoder-1/)
    // 空 id 时点名 pending 键：报「账号 的代理无效」会让用户找不到是哪条配置。
    expect(() => resolver('')).toThrow(new RegExp(QODER_PENDING_PROXY_KEY))
  })

  it('同账号两次解析 ⇒ 按需现取（用户改代理后立即生效，不需重启）', () => {
    let current = ''
    const resolver = createQoderFetcherResolver(() => current)
    expect(resolver('qoder-1')).toBe(fetch)
    current = 'http://127.0.0.1:7897'
    expect(resolver('qoder-1')).not.toBe(fetch)
  })

  it('⚠️ 池返回脏值（数字/对象）⇒ 视作「未配置」而不是崩在 trim 上', () => {
    // ⚠️ 该字段来自**用户可编辑的备份文件**，而 `sanitizeAccounts` 只做
    //    `{...candidate}` 原样透传、不校验形状（实测：`12345` 原样进池）。
    //    下游 `normalizeProxy` 第一句是 `input.trim()` ⇒ 非字符串会抛
    //    `TypeError: raw.trim is not a function`，该账号**永久不可用且无自愈**。
    for (const dirty of [12345, {}, [], true, null]) {
      const resolver = createQoderFetcherResolver(() => dirty as never)
      expect(resolver('qoder-1'), `脏值 ${JSON.stringify(dirty)} 应降级为直连`).toBe(fetch)
    }
  })
})

describe('② 单例与池注入（`qoderFetchForAccount` 必须住 qoder-proxy.ts）', () => {
  afterEach(() => { setQoderProxyPool(undefined) })

  it('未注入池 ⇒ 恒直连（`apply()` 之前探测就可能跑）', () => {
    setQoderProxyPool(undefined)
    expect(qoderFetchForAccount('qoder-1')).toBe(fetch)
    expect(qoderFetchForAccount('')).toBe(fetch)
  })

  it('⚠️ 注入池后按账号取出口（删掉 `setQoderProxyPool(pool)` 那行会让四腿全静默直连）', () => {
    setQoderProxyPool({
      qoderProxyFor: (id) => (id === 'qoder-1' ? 'http://127.0.0.1:7897' : ''),
    })
    expect(qoderFetchForAccount('qoder-1'), '注入池后必须走代理').not.toBe(fetch)
    expect(qoderFetchForAccount('qoder-2'), '别的账号未配代理 ⇒ 直连').toBe(fetch)
    expect(qoderFetchForAccount(''), '空 id 且 pending 未配 ⇒ 直连').toBe(fetch)
  })

  it('⚠️ `setQoderProxyPool(undefined)` 能复位（否则测试间互相污染）', () => {
    setQoderProxyPool({ qoderProxyFor: () => 'http://127.0.0.1:7897' })
    expect(qoderFetchForAccount('qoder-1')).not.toBe(fetch)
    setQoderProxyPool(undefined)
    expect(qoderFetchForAccount('qoder-1')).toBe(fetch)
  })

  it('⚠️ 单例必须定义在 qoder-proxy.ts（放 index.ts 会成 import 环 ⇒ ESM TDZ ⇒ 静默恒直连）', () => {
    // ⚠️ 这条不是风格洁癖：`index.ts` 本来就 import `jet-hub-rpc.ts`，
    //    若实例住 `index.ts` 而 `jet-hub-rpc.ts` 反向 import 它，就形成
    //    `index → jet-hub-rpc → index` 的环 ⇒ 拿到 `undefined` 并**静默恒直连**。
    expect(proxySource).toMatch(/export const qoderFetchForAccount\s*:\s*QoderFetcherResolver\s*=/)
    expect(proxySource).toMatch(/let qoderPoolRef\s*:\s*QoderProxyPoolLike\s*\|\s*undefined/)
    // 反向：index.ts **不得**自己造一份（造了就有两个池引用，注入一半）
    expect(indexSource).not.toMatch(/export const qoderFetchForAccount\s*=/)
  })
})

describe('③ 注入点：四个消费点都必须拿到按账号的 fetcher', () => {
  it('⚠️ 适配器取号函数在换号循环**内**现取（固化会让换号后仍走旧出口）', () => {
    expect(adapterSource).toMatch(/const fetcherForCurrentAccount = \(\): typeof fetch => \{/)
    expect(adapterSource).toMatch(/return this\.fetchFor\(activeAccountId \?\? ''\)/)
    // ⚠️ 判据锚在**发送那一行**：函数定义了却没用它发请求，等于没接。
    expect(adapterSource).toMatch(
      /await this\.sendEncrypted\(await buildRequest\(credential\), options, fetcherForCurrentAccount\(\)\)/,
    )
  })

  it('⚠️ 推理主路径没有裸 await fetch（该块里必须走 fetcher）', () => {
    const at = adapterSource.indexOf('const label = this.product.id')
    expect(at, '未找到推理块').toBeGreaterThan(-1)
    const block = adapterSource.slice(at, at + 600)
    expect(block).not.toMatch(/await fetch\(/)
    expect(block).toMatch(/fetcherForCurrentAccount\(\)/)
  })

  it('⚠️ 原生搜索是独立一次调用 ⇒ 走 `currentAccountId()`（它不在换号循环里）', () => {
    // ⚠️ 该端点 host 是 `encryptedInferBase`，与国际版推理**同一个墙外域**。
    //    漏接的症状是「聊天通了、联网搜索恒 10.7s 超时」—— 看着像搜索坏了。
    const at = adapterSource.indexOf('const searchFetcher =')
    expect(at, '未找到 searchFetcher').toBeGreaterThan(-1)
    const block = adapterSource.slice(at, at + 400)
    expect(block).toMatch(/this\.fetchFor\(this\.options\.currentAccountId\?\.\(\) \?\? ''\)/)
  })

  it('⚠️ 两条腿的优先级必须同口径：`fetchImpl`（注入）> `fetchFor` > 全局', () => {
    // ⚠️ 这是**注释与实现相反**的一类缺陷（本轮真实发生）：推理主路径原先写成
    //    `fetchFor === undefined ? fetchImpl : fetchFor(...)`，即生产代理压过单测替身，
    //    与它自己上方注释「`fetchImpl`（单测替身）> `fetchFor`（生产代理）」相反。
    //    两处判序不同还会让「推理走了代理、搜索没走」这类**半接状态**无从察觉。
    // ⚠️ 判「是否注入」必须靠独立判据（见 `hasInjectedFetchImpl` 的注释）：
    //    `this.fetchImpl !== undefined` 恒真（构造期已被 `?? fetch` 填满），
    //    而构造期布尔 `options.fetchImpl !== undefined` 会漏掉「构造后直接赋值」
    //    的既有用例（`ratelimit-misreport-behavior.spec.ts` 就是这么塞替身的）。
    //    唯一同时覆盖两种注入形态的判据是「`fetchImpl` 是否偏离全局 `fetch`」。
    // ⚠️ 判「是否注入」必须靠独立判据：`this.fetchImpl !== undefined` 恒真
    //    （构造期已被 `?? fetch` 填满）⇒ 那是「调序不加标志」的等价错误形态。
    //    ⚠️ 也**不能**用构造期布尔 `options.fetchImpl !== undefined`：
    //    `ratelimit-misreport-behavior.spec.ts` 这类既有用例是**构造后直接
    //    `adapter.fetchImpl = 替身`** 的，构造期布尔对它恒 false ⇒ 会真发网络。
    //    故只认「`fetchImpl` 是否偏离全局 `fetch`」这一判据。
    expect(adapterSource).toMatch(/private get hasInjectedFetchImpl\(\): boolean \{/)
    expect(adapterSource).toMatch(/return this\.fetchImpl !== fetch/)
    // 推理主路径
    const inferenceAt = adapterSource.indexOf('const fetcherForCurrentAccount =')
    expect(inferenceAt, '未找到 fetcherForCurrentAccount').toBeGreaterThan(-1)
    const inference = adapterSource.slice(inferenceAt, inferenceAt + 700)
    expect(inference, '推理主路径必须先判 hasInjectedFetchImpl')
      .toMatch(/if \(this\.hasInjectedFetchImpl\) return this\.fetchImpl/)
    // 原生搜索
    const searchAt = adapterSource.indexOf('const searchFetcher =')
    const search = adapterSource.slice(searchAt, searchAt + 400)
    expect(search, '原生搜索也必须先判 hasInjectedFetchImpl')
      .toMatch(/this\.hasInjectedFetchImpl/)
  })

  it('⚠️ 适配器两个字段都在（`fetchFor` 出口 + `currentAccountId` 取号权威）', () => {
    const body = interfaceBody(adapterSource, 'QoderAdapterOptions')
    expect(body).toMatch(/fetchFor\?:\s*\(accountId: string\)\s*=>\s*typeof fetch/)
    expect(body).toMatch(/currentAccountId\?:\s*\(\)\s*=>\s*string \| undefined/)
  })

  it('⚠️ QoderAuth 的优先级：`fetcher`（单测替身）> `fetchFor`（生产代理）> 全局 fetch', () => {
    expect(authSource).toMatch(/fetchFor\?:\s*\(accountId: string\)\s*=>\s*typeof fetch/)
    const at = authSource.indexOf('private fetcherForAccount(accountId?: string): typeof fetch {')
    expect(at, '未找到 fetcherForAccount').toBeGreaterThan(-1)
    const body = authSource.slice(at, at + 400)
    // ⚠️ 顺序断言：把 `fetchFor` 提到 `fetcher` 之前会让所有单测替身失效。
    expect(body.indexOf('this.options.fetcher !== undefined'))
      .toBeLessThan(body.indexOf('this.options.fetchFor !== undefined'))
    expect(body).toMatch(/this\.options\.fetchFor\(accountId \?\? ''\)/)
  })

  it('⚠️ QoderAuth 的四条腿都按账号取出口', () => {
    // ① 登录（两步式与阻塞式各一处）
    expect(authSource.match(/const loginFetcher = this\.fetcherForAccountOrUndefined\(flowOptions\.accountId\)/g))
      .toHaveLength(2)
    // ② 续期：`refreshCredential` 用传进来的 accountId
    expect(authSource).toMatch(/response = await this\.fetcherForAccount\(accountId\)\(/)
    // ③ 批量续期：把池条目的 id 传下去
    expect(authSource).toMatch(/refresh: \(c\) => this\.refreshCredential\(c, entry\.id\)/)
    // ④ 远端模型目录：端点同样在墙外主机上
    expect(authSource).toMatch(/const modelFetcher = this\.fetcherForAccountOrUndefined\(accountId\)/)
  })

  it('⚠️ `index.ts` 的 `setQoderProxyPool(pool)` 必须在建 QoderAuth **之前**', () => {
    // ⚠️ 顺序错了不会报错，只会让 `apply()` 期间那几秒的解析恒直连。
    const atPool = indexSource.indexOf('setQoderProxyPool(pool)')
    const atAuth = indexSource.indexOf('new QoderAuth(ctx, { fetchFor: qoderFetchForAccount })')
    expect(atPool).toBeGreaterThan(-1)
    expect(atAuth).toBeGreaterThan(-1)
    expect(atPool).toBeLessThan(atAuth)
    // 中国版实例同样要接（两站共用同一个适配器/认证类，只差 product）。
    expect(indexSource).toMatch(/new QoderAuth\(ctx, \{ product: QODER_CN, fetchFor: qoderFetchForAccount \}\)/)
  })

  it('⚠️ 两个 `registerQoderLlm` 都传了 `fetchFor`（推理通道也要走该账号出口）', () => {
    // ⚠️ 只接余额不接推理 ⇒ 面板显示正常但一发请求就超时。
    expect(indexSource.match(/^ {4}fetchFor: qoderFetchForAccount,$/gm)).toHaveLength(2)
  })

  it('⚠️ `probeById` 两家都把池条目 id 显式传进去（探测路径没有 accountPool）', () => {
    // ⚠️ 探测路径**刻意不传 `accountPool`**（`account-probe.ts` 的既定语义：
    //    只测这一个账号、且不写标记）⇒ 适配器内「按凭据反查账号 id」那条路
    //    **根本不存在** ⇒ 没有 `entry.id` 时出口解析器拿空 id ⇒ **该账号配的
    //    代理被完全绕过**，症状与「账号已失效」在 UI 上完全同形 ⇒ 用户会误删好号。
    const probeStart = indexSource.indexOf('export const probeById')
    expect(probeStart, '未找到 probeById').toBeGreaterThan(-1)
    const probeEnd = indexSource.indexOf('\nexport const ', probeStart + 10)
    const probeBlock = indexSource.slice(probeStart, probeEnd === -1 ? undefined : probeEnd)

    const atQoder = probeBlock.indexOf('qoder: {')
    const atCn = probeBlock.indexOf('qodercn: {')
    expect(atQoder).toBeGreaterThan(-1)
    expect(atCn).toBeGreaterThan(atQoder)
    // ⚠️ 中国版那一条必须切到**它自己条目的结束**（`\n  },`）而不是文件尾：
    //    切到 `export` 会把后面 cline / trae 等家的两形参写法一并圈进来，
    //    「不得退回两形参」那条判据就会对**别人的**代码生效 ⇒ 假红。
    const atCnEnd = probeBlock.indexOf('\n  },', atCn)
    expect(atCnEnd, '未找到 qodercn 条目结束').toBeGreaterThan(atCn)

    for (const [name, block] of [
      ['qoder', probeBlock.slice(atQoder, atCn)],
      ['qodercn', probeBlock.slice(atCn, atCnEnd)],
    ] as const) {
      expect(block, `${name} 的探测必须接下第三个形参 entry`)
        .toMatch(/createProbeAdapter: \(ref, credential, entry\) => new QoderAdapter\(\{/)
      // 反向：两形参写法会把 entry 直接丢弃（gemini 审计 P1-1 的原形）。
      expect(block, `${name} 不得退回两形参写法`)
        .not.toMatch(/createProbeAdapter: \(ref, credential\) =>/)
      expect(block, `${name} 没接 fetchFor`).toMatch(/fetchFor: qoderFetchForAccount,/)
      expect(block, `${name} 没把 entry.id 交给取号回调`)
        .toMatch(/currentAccountId: \(\) => entry\?\.id \?\? ''/)
    }
  })

  it('⚠️ 两个 `BuddyBalanceSelector` 的**两条腿**都按账号取出口', () => {
    // ⚠️ 只接 `fetchBalance`（分档器）不接 `fetchBalanceDetailed`（锁定报错的原因）
    //    ⇒ 面板查得到余额、锁定报错却说不出为什么 —— 同一语义两套判据。
    const at = indexSource.indexOf('const qoderBalanceSelector = new BuddyBalanceSelector({')
    expect(at, '未找到 qoderBalanceSelector').toBeGreaterThan(-1)
    const block = indexSource.slice(at, indexSource.indexOf('const activeQoderAccountId'))
    expect(block, '只建了一个选择器（两站各一个，合并会串台）')
      .toMatch(/const qoderCnBalanceSelector = new BuddyBalanceSelector\(/)
    expect(block.match(/fetchBalance: async \(credential, product\) =>/g))
      .toHaveLength(2)
    expect(block.match(/fetchBalanceDetailed: async \(credential, product\) =>/g))
      .toHaveLength(2)
    // ⚠️ 余额两条腿都必须经 `fetcherForQoderCredential`（按 access_token 反查账号）。
    expect(block.match(/await fetcherForQoderCredential\(credential\)/g)).toHaveLength(4)
  })

  it('⚠️ `account.create` 的顺序：先入库（带代理）→ 再 startLogin', () => {
    // ⚠️ 原实现是**先 startLogin、后 addAccount** —— 那时池里没有这个账号，
    //    解析器只能拿空 id 去查 pending 键；用户没配 pending 就恒直连 ⇒
    //    墙外环境下登录**恒失败**，报的还是 `UND_ERR_CONNECT_TIMEOUT`
    //    （与「凭据失效」在 UI 上完全同形 ⇒ 用户只会反复重登）。
    const start = rpcSource.indexOf('const existingQoderProxies')
    expect(start, '未找到 account.create 的 qoder 分支').toBeGreaterThan(-1)
    const block = rpcSource.slice(start, rpcSource.indexOf('started.result.then', start))
    const atAdd = block.indexOf('await pool.addAccount({')
    const atProxy = block.indexOf('await pool.setQoderProxy(id, qoderProxyInput)')
    const atLogin = block.indexOf('await auth.startLogin({ refName, accountId: id })')
    expect(atAdd, '没登记占位条目').toBeGreaterThan(-1)
    expect(atProxy, '没预置代理').toBeGreaterThan(-1)
    expect(atLogin, '没传占位 accountId').toBeGreaterThan(-1)
    expect(atAdd, 'addAccount 必须在 startLogin 之前').toBeLessThan(atLogin)
    expect(atProxy, 'setQoderProxy 必须在 startLogin 之前').toBeLessThan(atLogin)
  })

  it('⚠️ 登录后的 userinfo 与三条 RPC 腿都带 fetcher', () => {
    // userinfo 漏接的症状最具误导性：登录**成功了**，昵称却永远 `qoder-xxxx`
    //（`fetchQoderUserNickname` 失败返回 `undefined`，安静吞掉）。
    expect(rpcSource).toMatch(/fetchQoderUserNickname\(credential, product, qoderFetchForAccount\(id\)\)/)
    // 每日领取 / 面板余额：「刷新积分」按钮没有别的出口可走。
    expect(rpcSource).toMatch(/claimQoderDailyCheckin\(credential, product, qoderFetchForAccount\(entry\.id\)\)/)
    // ⚠️ 允许换行：该调用点跨了多行（写成单行正则会对**当前**实现假红，
    //    而对「删掉 fetcher 那行」的变异仍然通过 —— 两种形态都不该出现）。
    expect(rpcSource).toMatch(
      /fetchQoderBalanceDetailed\(credential, product, \{\s*fetcher: qoderFetchForAccount\(account\.id\),?\s*\}\)/,
    )
  })

  it('⚠️ `qoder.*` 必须在主 switch **之前**试一次（否则回 unknown method）', () => {
    const at = rpcSource.indexOf('await handleQoderRpc(ctx, pool, method, payload)')
    expect(at, '主分发里没有 handleQoderRpc').toBeGreaterThan(-1)
    // 前缀分流的判据：它出现在 `switch (method)` 之前。
    const atSwitch = rpcSource.indexOf('switch (method)')
    expect(atSwitch).toBeGreaterThan(-1)
    expect(at).toBeLessThan(atSwitch)
  })
})

describe('④ 端点行为：setProxy（守「死条件」那类变异）', () => {
  // ⚠️ `if (method.startsWith('qoder.'))` 被改成
  //    `if (globalThis.X === true && …)`（字面量完整保留在死条件里）时，
  //    纯源码断言**全部全绿**（gemini 审计 M29 实测）。本组用真调端点来守。

  afterEach(() => { vi.restoreAllMocks() })

  it('setProxy：合法地址会真的落到池里（并归一化）', async () => {
    const pool = { setQoderProxy: vi.fn(async () => {}) }
    const res = await handleQoderRpc({} as never, pool, 'qoder.setProxy', {
      accountId: 'qoder-1', proxy: '127.0.0.1:7897',
    })
    expect(pool.setQoderProxy).toHaveBeenCalledWith('qoder-1', 'http://127.0.0.1:7897')
    expect(res).toMatchObject({ ok: true })
  })

  it('setProxy：socks5 也认，且 `socks5h://` 归一为 `socks5://`', async () => {
    const pool = { setQoderProxy: vi.fn(async () => {}) }
    await handleQoderRpc({} as never, pool, 'qoder.setProxy', {
      accountId: 'qoder-1', proxy: 'socks5h://127.0.0.1:1080',
    })
    expect(pool.setQoderProxy).toHaveBeenCalledWith('qoder-1', 'socks5://127.0.0.1:1080')
  })

  it('setProxy：空串 = 清除（回到直连，不是非法地址）', async () => {
    const pool = { setQoderProxy: vi.fn(async () => {}) }
    const res = await handleQoderRpc({} as never, pool, 'qoder.setProxy', {
      accountId: 'qoder-1', proxy: '',
    })
    expect(pool.setQoderProxy).toHaveBeenCalledWith('qoder-1', '')
    expect(res).toMatchObject({ ok: true, value: { proxy: '' } })
    // 文案要让用户知道「现在是直连」—— 回显空串在面板上会像「没生效」。
    expect(res).toMatchObject({ value: { label: expect.stringContaining('直连') } })
  })

  it('⚠️ setProxy：非法地址被拒，且**不写池**', async () => {
    const pool = { setQoderProxy: vi.fn(async () => {}) }
    const res = await handleQoderRpc({} as never, pool, 'qoder.setProxy', {
      accountId: 'qoder-1', proxy: 'ftp://host:21',
    })
    expect(res).toMatchObject({ ok: false })
    // ⚠️ 「拒绝时不得写池」：写了就等于把非法地址落盘，重启后每次解析都抛。
    expect(pool.setQoderProxy).not.toHaveBeenCalled()
  })

  it('⚠️ setProxy：缺 / 空 / 非字符串 accountId 必须拒绝且不写池', async () => {
    const pool = { setQoderProxy: vi.fn(async () => {}) }
    for (const payload of [{}, { accountId: '' }, { accountId: 123 }, { proxy: '127.0.0.1:1' }]) {
      const res = await handleQoderRpc({} as never, pool, 'qoder.setProxy', payload)
      expect(res, JSON.stringify(payload)).toMatchObject({ ok: false })
    }
    expect(pool.setQoderProxy).not.toHaveBeenCalled()
  })

  it('⚠️ 不认识的方法返回 undefined（让主 switch 继续匹配）', async () => {
    // ⚠️ 回信封会把**别的** provider 的方法名误判成「格式错误」。
    expect(await handleQoderRpc({} as never, { setQoderProxy: vi.fn() }, 'qoder.未知', {}))
      .toBeUndefined()
    // 反向：连前缀都不沾的方法同样要让路。
    expect(await handleQoderRpc({} as never, { setQoderProxy: vi.fn() }, 'gemini.setProxy', {}))
      .toBeUndefined()
  })
})

describe('⑤ testProxy 的探活语义', () => {
  // ⚠️ 模块头花了十几行论证「为什么打 Qoder 自己的余额端点而不是 ip-api」
  //    （ip-api 能通但 Qoder 仍被拒 = 假阳性）。那条论证必须被验证。

  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('../../src/opencode-proxy.js')
  })

  /** 装一个 mock 版 opencode-proxy，返回可断言的 spy。 */
  async function withMockedProxyFetch(impl: () => Promise<Response>) {
    const spy = vi.fn(impl)
    vi.resetModules()
    vi.doMock('../../src/opencode-proxy.js', () => ({
      proxyFetch: spy,
      buildProxyDispatcher: () => ({}),
      closeAllProxyDispatchers: async () => {},
      proxyCacheSize: () => 0,
      resolveConnectPort: () => 443,
      buildSocks5Handshake: () => new Uint8Array(),
    }))
    const mod = await import('../../src/qoder-rpc.js')
    return { spy, handle: mod.handleQoderRpc }
  }

  it('⚠️ 探活目标必须是 Qoder 自己的余额端点，且真用用户填的代理', async () => {
    const { spy, handle } = await withMockedProxyFetch(async () => new Response('', { status: 401 }))
    const res = await handle({} as never, { setQoderProxy: vi.fn() }, 'qoder.testProxy', {
      proxy: 'http://127.0.0.1:7897',
    })
    expect(res, '探活失败').toMatchObject({ ok: true })
    // ⚠️ 一条断言同时打掉两处变异：换成别的域名、绕过用户代理。
    expect(spy).toHaveBeenCalledWith(
      `${QODER.openApiBase}${QODER_USAGE_PATH}`,
      expect.anything(),
      expect.objectContaining({ url: 'http://127.0.0.1:7897' }),
    )
  })

  it('⚠️ `provider: qodercn` 必须探测中国版主机（只探国际版会让中国版用户看到「连不上」）', async () => {
    const { spy, handle } = await withMockedProxyFetch(async () => new Response('', { status: 401 }))
    const res = await handle({} as never, { setQoderProxy: vi.fn() }, 'qoder.testProxy', {
      proxy: '127.0.0.1:7897', provider: QODER_CN.id,
    })
    expect(res).toMatchObject({ ok: true, value: { host: QODER_CN.openApiBase } })
    expect(spy).toHaveBeenCalledWith(
      `${QODER_CN.openApiBase}${QODER_USAGE_PATH}`,
      expect.anything(),
      expect.anything(),
    )
    // 两站主机必须不同（相同的话上面那条会恒真）。
    expect(QODER_CN.openApiBase).not.toBe(QODER.openApiBase)
  })

  it('⚠️ 未知 provider 退国际版而**不抛错**（「测试连接」按钮不该报 bad request）', async () => {
    const { handle } = await withMockedProxyFetch(async () => new Response('', { status: 401 }))
    const res = await handle({} as never, { setQoderProxy: vi.fn() }, 'qoder.testProxy', {
      proxy: '127.0.0.1:7897', provider: 'qoder-拼错了',
    })
    expect(res).toMatchObject({ ok: true, value: { host: QODER.openApiBase } })
  })

  it('⚠️ HTTP 401 也算「通」（判 response.ok 会让正确配置报红）', async () => {
    // ⚠️ 探活请求**不带 Token**，401 是正常结果 —— 它已经证明 TCP + TLS + 代理
    //    握手全通，且目标一定是用户真正要访问的那台主机。
    const { handle } = await withMockedProxyFetch(async () => new Response('', { status: 401 }))
    const res = await handle({} as never, { setQoderProxy: vi.fn() }, 'qoder.testProxy', {
      proxy: '127.0.0.1:7897',
    })
    expect(res).toMatchObject({ ok: true, value: { status: 401 } })
  })

  it('⚠️ 非法代理地址不发起请求（先归一化再联网）', async () => {
    const { spy, handle } = await withMockedProxyFetch(async () => new Response('', { status: 401 }))
    const res = await handle({} as never, { setQoderProxy: vi.fn() }, 'qoder.testProxy', {
      proxy: 'ftp://host:21',
    })
    expect(res).toMatchObject({ ok: false })
    expect(spy).not.toHaveBeenCalled()
  })

  it('⚠️ 失败文案必须带根因码与**分站**提示', async () => {
    const cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    const { handle } = await withMockedProxyFetch(async () => {
      throw new TypeError('fetch failed', { cause })
    })

    const intl = await handle({} as never, { setQoderProxy: vi.fn() }, 'qoder.testProxy', {
      proxy: '127.0.0.1:7897',
    })
    const intlMsg = (intl as { error: { message: string } }).error.message
    // ⚠️ 三条都断：根因码 / 探测目标主机 / SNI 阻断的解释。
    //    只断「含根因码」会放过「丢掉 describeFetchError 但手工拼了码」的半吊子。
    expect(intlMsg).toContain('UND_ERR_CONNECT_TIMEOUT')
    expect(intlMsg).toContain(QODER.openApiBase)
    expect(intlMsg).toMatch(/SNI/)

    const cn = await handle({} as never, { setQoderProxy: vi.fn() }, 'qoder.testProxy', {
      proxy: '127.0.0.1:7897', provider: QODER_CN.id,
    })
    const cnMsg = (cn as { error: { message: string } }).error.message
    expect(cnMsg).toContain(QODER_CN.openApiBase)
    // ⚠️ 中国版**不得**出现 SNI 阻断的提示：它直连就通，那句话只会误导用户
    //    去怀疑网络，而真实原因是这条代理本身不通。
    expect(cnMsg).not.toMatch(/SNI/)
    expect(cnMsg).toMatch(/直连/)
  })
})

describe('⑥ 池字段与类型收口', () => {
  it('`ProviderAccountEntry` 有 `qoderProxy`（`account.list` 靠它透传）', () => {
    expect(interfaceBody(typesSource, 'ProviderAccountEntry'))
      .toMatch(/qoderProxy\?:\s*string/)
  })

  it('登录载荷 `RpcCreateAccountRequest` 也有 `qoderProxy`', () => {
    expect(interfaceBody(typesSource, 'RpcCreateAccountRequest'))
      .toMatch(/qoderProxy\?:\s*string/)
  })

  it('⚠️ 清除代理是**删键**（写空串会让下游把空串当成有效地址）', () => {
    const at = poolSource.indexOf('async setQoderProxy(')
    expect(at, '未找到 setQoderProxy').toBeGreaterThan(-1)
    const body = poolSource.slice(at, at + 900)
    expect(body).toMatch(/delete entry\.qoderProxy/)
    // ⚠️ 反向：`if (!proxy) return` 会让「清除」按钮点了静默无效。
    expect(body).not.toMatch(/if \(!proxy\)\s*return/)
  })

  it('⚠️ `qoderProxyFor` 过 `asProxyText`（备份脏值会把该账号永久打挂）', () => {
    const at = poolSource.indexOf('qoderProxyFor(accountId: string): string {')
    expect(at, '未找到 qoderProxyFor').toBeGreaterThan(-1)
    const body = poolSource.slice(at, at + 300)
    expect(body).toMatch(/asProxyText\(/)
    expect(body).not.toMatch(/\?\? ''/)
  })

  it('⚠️ 三个代理字段**各取各的**（串台时写入侧完全看不出来）', () => {
    // ⚠️ 只查 `setQoderProxy` 的函数体不够 —— 那是「改了一半」的形态：
    //    读取侧串成 `opencodeProxy` 时，写入侧一字不改。
    for (const [method, field] of [
      ['qoderProxyFor', 'qoderProxy'],
      ['opencodeProxyFor', 'opencodeProxy'],
      ['geminiProxyFor', 'geminiProxy'],
    ] as const) {
      const at = poolSource.indexOf(`${method}(accountId: string): string {`)
      expect(at, `未找到 ${method}`).toBeGreaterThan(-1)
      expect(poolSource.slice(at, at + 300), `${method} 读错了字段`)
        .toMatch(new RegExp(`asProxyText\\(entry\\?\\.${field}\\)`))
    }
  })

  it('`asProxyText`：只放行字符串，其余一律降级为空串（直连）', () => {
    expect(asProxyText('http://h:1')).toBe('http://h:1')
    for (const dirty of [12345, {}, [], true, null, undefined]) {
      expect(asProxyText(dirty), JSON.stringify(dirty)).toBe('')
    }
  })
})

describe('⑦ 回归：解析器返回的 fetcher 真的能发请求', () => {
  afterAll(async () => { await closeAllProxyDispatchers() })

  it('⚠️ 代理指向无监听端口 ⇒ 请求**真的失败了**（不是恒等占位）', async () => {
    const resolver = createQoderFetcherResolver(() => 'http://127.0.0.1:9')
    // 127.0.0.1:9 上无监听 ⇒ 连接必失败；能失败就说明请求真的发出去了。
    await expect(resolver('qoder-1')('http://127.0.0.1:1/x', {})).rejects.toThrow()
  })
})
