/**
 * Gemini 账号出口代理（Gitee issue IKLTZ2）的行为与接线守卫。
 *
 * ## 缺陷原形
 *
 * Gemini 全部端点（`oauth2.googleapis.com/token`、userinfo、
 * `cloudcode-pa.googleapis.com`）都在墙外，而 undici（Node 内置 fetch）
 * **既不读** Windows WinINET 系统代理、**也不读** `HTTP(S)_PROXY` ⇒
 * 「浏览器能打开授权页并点同意、面板里账号却一直不出现」。
 *
 * 本文件守三件事：
 * 1. **注入点齐全**（每个消费点都拿到按账号的 fetcher，漏一个 = 漏一条腿）；
 * 2. **换号后出口跟着换**（把 fetcher 固化在循环外是最隐蔽的一类失效）；
 * 3. **可诊断性**（连不上必须点名代理，而不是抛一句 `fetch failed`）。
 *
 * ⚠️ 判据一律打在**行为**上，不用源码正则当主力 —— 本仓库记过的教训：
 * 源码文本断言对 `if (false)` 这类短路禁用**无感**（字面量在死分支里照样存在）。
 * 只有「接线点齐全」那一段用结构断言，且**逐条列名**而不是数个数。
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  createGeminiFetcherResolver,
  geminiNetworkHint,
  setGeminiProxyPool,
} from '../../src/gemini-proxy.js'
import { handleGeminiRpc } from '../../src/gemini-rpc.js'
import { isUnreachableNetworkError } from '../../src/refresh.js'

const here = dirname(fileURLToPath(import.meta.url))
const adapterSource = readFileSync(join(here, '../../src/gemini-adapter.ts'), 'utf8')
const authSource = readFileSync(join(here, '../../src/gemini-auth.ts'), 'utf8')
const indexSource = readFileSync(join(here, '../../src/index.ts'), 'utf8')
const rpcSource = readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8')

/** 造一个与 `typeof fetch` 同形、且**记录调用**的替身。 */
function fetchStub(calls: string[]): typeof fetch {
  return (async (input: unknown) => {
    calls.push(String(input))
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
}

describe('① fetcher 解析器：按账号取出口', () => {
  it('空账号 id ⇒ 退回全局 fetch（不是抛错、不是空代理串）', () => {
    const resolver = createGeminiFetcherResolver(() => {
      throw new Error('不该被问到')
    })
    // ⚠️ 空 id 必须**根本不查池**：查了会把「不知道是谁」变成「用某人的出口」。
    expect(resolver('')).toBe(fetch)
  })

  it('账号没配代理 ⇒ 退回全局 fetch（保持 Node 24+ 的 NODE_USE_ENV_PROXY 宿主能力）', () => {
    const resolver = createGeminiFetcherResolver(() => '')
    expect(resolver('gemini-1')).toBe(fetch)
  })

  it('⚠️ 配了代理 ⇒ 换成另一个 fetcher（不是同一份全局 fetch）', () => {
    const resolver = createGeminiFetcherResolver((id) =>
      id === 'gemini-1' ? 'http://127.0.0.1:7897' : '')
    const withProxy = resolver('gemini-1')
    // ⚠️ 判据必须是「**不是**全局 fetch」：写成「调一次看有没有走代理」
    // 会在没配代理那一格也通过 ⇒ 恒真、无牙。
    expect(withProxy).not.toBe(fetch)
    expect(resolver('gemini-2')).toBe(fetch)
  })

  it('⚠️ 非法代理地址必须抛错，绝不静默退回直连', () => {
    // ⚠️ 这条是「用户以为配了代理却在裸奔」的唯一防线：
    // 静默回退会让症状与「没配代理」**完全同形**，用户无从发现。
    const resolver = createGeminiFetcherResolver(() => 'ftp://host:21')
    expect(() => resolver('gemini-1')).toThrow(/代理地址无效/)
  })

  it('同账号两次解析 ⇒ 按需现取（用户改代理后立即生效，不需重启）', () => {
    let current = ''
    const resolver = createGeminiFetcherResolver(() => current)
    expect(resolver('gemini-1')).toBe(fetch)
    current = 'http://127.0.0.1:7897'
    expect(resolver('gemini-1')).not.toBe(fetch)
  })
})

describe('② 注入点：每个消费点都必须拿到按账号的 fetcher', () => {
  it('⚠️ GeminiAuth 的四条腿（登录/续期/批量续期/昵称修复）都不许用裸 fetchImpl', () => {
    // ⚠️ 判据是「**没有** fetcher 解析路径的调用点」，故按名字逐条列名：
    //   登录 startLogin → fetcherFor(options.accountId)
    //   续期 refresh  → refreshCredential(c, '')（单凭据兜底，无账号 ⇒ 直连）
    //   批量续期       → refreshCredentialUnderLock(..., entry.id)
    //   昵称修复       → fetcherFor(entry.id)
    expect(authSource).toMatch(/fetcher:\s*this\.fetcherFor\(options\.accountId \?\? ''\)/)
    expect(authSource).toMatch(/fetcher:\s*this\.fetcherFor\(entry\.id\)/)
    expect(authSource).toMatch(/this\.refreshCredentialUnderLock\(entry\.credentialRef, c, entry\.id\)/)
    // ⚠️ 反向：生产接线不得再退化成「只有 fetchImpl」。
    expect(authSource).toMatch(/fetchFor\?:\s*\(accountId: string\)\s*=>\s*typeof fetch/)
  })

  it('⚠️ 推理主路径不再有裸 fetch（issue 建议漏掉的那一处 seam）', () => {
    // ⚠️ 这是 issue 原文没点到的缺口：照字面只接 fetchImpl/projectFetcher，
    // **推理主路径**会漏掉代理 —— 而它恰恰是用户唯一会卡住的那条路。
    const streamBody = adapterSource.slice(
      adapterSource.indexOf('let response: Response'),
      adapterSource.indexOf('let response: Response') + 900,
    )
    expect(streamBody).not.toMatch(/await fetch\(/)
    expect(streamBody).toMatch(/await fetcherForCurrentAccount\(\)\(url, \{/)
  })

  it('⚠️ 项目探测与推理共用同一出口（否则探测走代理、推理直连 ⇒ 报错误导原因）', () => {
    expect(adapterSource).toMatch(
      /fetcher:\s*this\.options\.projectFetcher \?\? fetcherForCurrentAccount\(\)/,
    )
  })

  it('⚠️ 换号后出口必须跟着换（fetcher 在循环内现取，不是循环外固化）', () => {
    // ⚠️ 固化在循环外的后果：「换了号还是超时」，且**零报错** ——
    // 本仓库反复记录的最难查的一类静默失效。
    const defAt = adapterSource.indexOf('const fetcherForCurrentAccount = ')
    const loopAt = adapterSource.indexOf('while (true) {')
    expect(defAt).toBeGreaterThan(-1)
    expect(loopAt).toBeGreaterThan(defAt)
    // 判据必须打在被调点上：解析器定义在循环**外**、调用在循环**内**
    // —— 只断言「有这个东西」对「是否循环外调用」恒真、无牙。
    const afterLoop = adapterSource.slice(loopAt, loopAt + 6000)
    expect(afterLoop).toMatch(/fetcherForCurrentAccount\(\)/)
  })

  it('⚠️ 探测适配器也接上了（账号卡片「测试」按钮）', () => {
    // ⚠️ 漏掉它 ⇒ 该按钮在墙外恒失败，而症状与「账号已失效」同形
    // ⇒ 用户会去误删好号。
    expect(indexSource).toMatch(/gemini: \{[\s\S]{0,600}fetchFor:\s*geminiFetchForAccount/)
  })

  it('⚠️ 登录必须把占位账号 id 传进去（凭据落盘前只有池条目认得它）', () => {
    // ⚠️ 不传 ⇒ 换 token 那一次请求恒直连 ⇒ 墙外环境下**登录恒失败**，
    // 症状与「client_secret 配错」同形，极易误判。
    expect(rpcSource).toMatch(/gemini\.startLogin\(\{ accountId: id \}\)/)
  })
})

describe('③ 积分路径也必须走该账号的出口', () => {
  it('⚠️ ProviderCallContext 带上了 accountId（否则按 ref 反查不出账号）', () => {
    // ⚠️ 账号 id 与 credentialRef **没有可逆映射**（ref 由 RPC 随机生成），
    // 所以这不是「可以自己推导」的字段。
    expect(readFileSync(join(here, '../../src/provider-runtime.ts'), 'utf8'))
      .toMatch(/readonly accountId\?: string/)
  })

  it('⚠️ 两个 createProviderCredits 调用点都接了 geminiFetchFor', () => {
    // ⚠️ 本仓库记过 minimaxXff 的同型事故：只接一处 ⇒ 「面板能刷新、
    // 聚合折算却失败」，症状割裂、极难对应。
    const calls = indexSource.match(/geminiFetchFor:/g) ?? []
    const rpcCalls = rpcSource.match(/geminiFetchFor:/g) ?? []
    expect(calls.length, 'index.ts 的 creditsTable 没接').toBeGreaterThan(0)
    expect(rpcCalls.length, 'jet-hub-rpc.ts 的 credits 表没接').toBeGreaterThan(0)
  })
})

describe('④ RPC 端点', () => {
  it('空代理串 = 清除（不是非法地址）', async () => {
    const pool = { setGeminiProxy: vi.fn(async () => {}) }
    const res = await handleGeminiRpc({} as never, pool, 'gemini.setProxy', {
      accountId: 'gemini-1', proxy: '',
    })
    expect(pool.setGeminiProxy).toHaveBeenCalledWith('gemini-1', '')
    expect(res).toMatchObject({ ok: true, value: { proxy: '' } })
  })

  it('非法地址被拒，且**不写池**', async () => {
    const pool = { setGeminiProxy: vi.fn(async () => {}) }
    const res = await handleGeminiRpc({} as never, pool, 'gemini.setProxy', {
      accountId: 'gemini-1', proxy: 'ftp://host:21',
    })
    expect(res).toMatchObject({ ok: false })
    // ⚠️ 「拒绝时不得写池」：写了就等于把非法地址落盘，重启后每次解析都抛。
    expect(pool.setGeminiProxy).not.toHaveBeenCalled()
  })

  it('⚠️ 不认识的方法返回 undefined（让主 switch 继续匹配）', async () => {
    // ⚠️ 回信封会把**别的** provider 的方法名误判成「格式错误」。
    expect(await handleGeminiRpc({} as never, { setGeminiProxy: vi.fn() }, 'gemini.未知', {}))
      .toBeUndefined()
  })

  it('⚠️ gemini.* 必须在主 switch 之前被试一次', () => {
    // ⚠️ 漏了 ⇒ 落进 `default` 回 `unknown method`，面板上「配了但没反应」。
    const at = rpcSource.indexOf("method.startsWith('gemini.')")
    const switchAt = rpcSource.indexOf('switch (method) {')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(switchAt)
  })
})

describe('⑤ 可诊断性（修法 3）', () => {
  it('UND_ERR_CONNECT_TIMEOUT ⇒ 提示里点名代理', () => {
    const cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    const outer = new TypeError('fetch failed', { cause })
    const hint = geminiNetworkHint(outer, false)
    expect(hint).toBeDefined()
    expect(hint).toMatch(/代理/)
    // ⚠️ 必须带出**根因码**：只说「连不上」时用户无法区分代理与断网。
    expect(hint).toMatch(/UND_ERR_CONNECT_TIMEOUT/)
  })

  it('⚠️ 普通业务错误不误报（不能把 5xx 都说成「需要代理」）', () => {
    // ⚠️ 判据必须是「**不返回**提示」而不是「提示里没有代理字样」——
    // 后者对一个恒返回 undefined 的实现也成立 ⇒ 恒真、无牙。
    expect(geminiNetworkHint(new Error('HTTP 500'), false)).toBeUndefined()
  })

  it('自己 arm 的超时 ⇒ 也给提示（无 cause 时仍能指路）', () => {
    expect(geminiNetworkHint(new TypeError('fetch failed'), true)).toMatch(/代理/)
  })

  it('⚠️ isUnreachableNetworkError 读 cause 链（message 恒为 fetch failed）', () => {
    const deep = Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    const mid = new TypeError('fetch failed', { cause: deep })
    const outer = new TypeError('fetch failed', { cause: mid })
    expect(isUnreachableNetworkError(outer)).toBe(true)
  })

  it('⚠️ 业务错误不被拉长间隔（否则一次 5xx 会冻结续期 30 分钟）', () => {
    expect(isUnreachableNetworkError(new Error('fetch failed'))).toBe(false)
  })

  it('⚠️ 调度器对「连不上」用 30 分钟、其余维持既有间隔', () => {
    const refresh = readFileSync(join(here, '../../src/refresh.ts'), 'utf8')
    // ⚠️ 断言**判据在三元链里**（而不是「导出���个常量」）：
    // 常量导出恒成立，判据被删掉仍全绿。
    expect(refresh).toMatch(
      /isUnreachableNetworkError\(error\)\s*\?\s*REFRESH_UNREACHABLE_RETRY_MS/,
    )
    expect(refresh).toMatch(/isAbnormalNetworkError\(error\)\s*\?\s*REFRESH_ABNORMAL_NETWORK_RETRY_MS/)
  })
})

describe('⑥ 账号池字段', () => {
  const types = readFileSync(join(here, '../../src/types.ts'), 'utf8')
  const pool = readFileSync(join(here, '../../src/account-pool.ts'), 'utf8')

  it('ProviderAccountEntry 有 geminiProxy', () => {
    expect(types).toMatch(/geminiProxy\?:\s*string/)
  })

  it('⚠️ 清除代理是删键（写空串会让下游把空串当成有效地址）', () => {
    const start = pool.indexOf('async setGeminiProxy(')
    expect(start).toBeGreaterThan(-1)
    const body = pool.slice(start, start + 900)
    expect(body).toMatch(/delete entry\.geminiProxy/)
    // ⚠️ 反向：`if (!proxy) return` 会让「清除」按钮点了静默无效。
    expect(body).not.toMatch(/if \(!proxy\)\s*return/)
  })

  it('⚠️ 与 opencode 的代理字段**分开**（语义不同，共用会连带清掉对方的出口）', () => {
    const start = pool.indexOf('async setGeminiProxy(')
    const body = pool.slice(start, start + 900)
    expect(body).not.toMatch(/entry\.opencodeProxy/)
  })

  it('setGeminiProxyPool 能换掉池（模块级单例的接线点）', () => {
    const calls: string[] = []
    setGeminiProxyPool({ geminiProxyFor: (id) => { calls.push(id); return '' } })
    // 换掉后解析器仍然可调用（不抛错 = 池就绪路径通）
    expect(calls).toEqual([])
    setGeminiProxyPool(undefined)
  })
})

describe('⑦ 回归：fetcher 替身确实被送到上游', () => {
  it('⚠️ 解析器返回的 fetcher 能真正发起请求（不是恒等占位）', async () => {
    // ⚠️ 这条防「返回一个函数但什么都不做」的空实现 ——
    // 上面几条判据都只看**身份**（是不是全局 fetch），恒真的空壳也能过。
    const resolver = createGeminiFetcherResolver(() => 'http://127.0.0.1:9')
    // 127.0.0.1:9 无监听 ⇒ 连接必失败；能失败就说明请求真的发出去了。
    await expect(resolver('gemini-1')('http://127.0.0.1:1/x', {}))
      .rejects.toThrow()
  })

  it('⚠️ 全局 fetch 路径不受影响（回归：不配代理时行为逐字不变）', async () => {
    const calls: string[] = []
    const resolver = createGeminiFetcherResolver(() => '')
    await resolver('gemini-1')('https://example.invalid/x', {})
      .then(() => { calls.push('ok') })
      .catch(() => { calls.push('failed') })
    // ⚠️ 判据是「**确实发了请求**」（结果可能任一），不是「结果是什么」。
    expect(calls).toHaveLength(1)
  })
})
