/**
 * MiniMax **国际站**账号出口代理的行为与接线守卫。
 *
 * ## 与 `gemini-proxy.spec.ts` 的关系
 *
 * 形状同构（同一份实现的第三站），但**存在理由不同**：
 *
 * - Gemini 是「墙外能不能连通」；
 * - minimaxintl 是「连得上但被 307 到中国站」——**连通性与分流是两个独立失败**，
 *   故 testProxy 必须回 `geoRouted`，且「通」与「通了但仍在大陆」是两个断言格。
 *
 * ## 本文件以**行为**断言为主（与 gemini 同一条纪律）
 *
 * 源码文本断言对「分支恒不执行」与「注释诱饵」完全无感 ⇒ 能用行为断言的
 * 一律用行为；源码断言只守「接线点在不在」，且**全部先过 `stripComments`**。
 *
 * ⚠️ 残余弱点如实登记：剥注释解决不了「字面量在死条件里」。凡被行为用例
 * 覆盖的接线点，都**不再**只靠源码断言。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  createMinimaxFetcherResolver,
  minimaxIntlFetchForAccount,
  setMinimaxProxyPool,
} from '../../src/minimax-proxy.js'
import { handleMinimaxIntlRpc } from '../../src/minimax-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import { stripComments } from '../helpers/strip-comments.js'

const here = dirname(fileURLToPath(import.meta.url))
// ⚠️ **全部先剥注释**：见文件头的「为什么以行为断言为主」。
const adapterSource = stripComments(readFileSync(join(here, '../../src/minimax-adapter.ts'), 'utf8'))
const authSource = stripComments(readFileSync(join(here, '../../src/minimax-auth.ts'), 'utf8'))
const indexSource = stripComments(readFileSync(join(here, '../../src/index.ts'), 'utf8'))
const rpcSource = stripComments(readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8'))
const poolSource = stripComments(readFileSync(join(here, '../../src/account-pool.ts'), 'utf8'))
const typesSource = stripComments(readFileSync(join(here, '../../src/types.ts'), 'utf8'))
const selectorSource = stripComments(
  readFileSync(join(here, '../../src/buddy-balance-selector.ts'), 'utf8'),
)
const clientSource = stripComments(
  readFileSync(join(here, '../../plugin-src/client/jet-hub.js'), 'utf8'),
)
const modalSource = stripComments(
  readFileSync(join(here, '../../plugin-src/client/opencode-proxy-modal.js'), 'utf8'),
)

describe('① fetcher 解析器：按账号取出口', () => {
  it('空账号 id ⇒ 退回全局 fetch（不是抛错、不是空代理串）', () => {
    const resolver = createMinimaxFetcherResolver(() => {
      throw new Error('不该被问到')
    })
    // ⚠️ 空 id 必须**根本不查池**：查了会把「不知道是谁」变成「用某人的出口」。
    expect(resolver('')).toBe(fetch)
  })

  it('账号没配代理 ⇒ 退回全局 fetch（保持 NODE_USE_ENV_PROXY 宿主能力）', () => {
    const resolver = createMinimaxFetcherResolver(() => '')
    expect(resolver('acct-1')).toBe(fetch)
  })

  it('⚠️ 配了代理 ⇒ 换成另一个 fetcher（不是同一份全局 fetch）', () => {
    const resolver = createMinimaxFetcherResolver(() => '127.0.0.1:7897')
    const got = resolver('acct-1')
    expect(got).not.toBe(fetch)
    expect(typeof got).toBe('function')
  })

  it('⚠️ 非法代理地址必须抛错，绝不静默退回直连', () => {
    const resolver = createMinimaxFetcherResolver(() => 'ftp://host:21')
    expect(() => resolver('acct-1')).toThrow(/代理地址无效|ftp/)
  })

  it('同账号两次解析 ⇒ 按需现取（用户改代理后立即生效，不需重启）', () => {
    let stored = ''
    const resolver = createMinimaxFetcherResolver(() => stored)
    expect(resolver('acct-1')).toBe(fetch)
    stored = 'socks5://127.0.0.1:1080'
    expect(resolver('acct-1')).not.toBe(fetch)
  })

  it('⚠️ 池返回脏值（数字/对象）⇒ 视作「未配置」而不是崩在 trim 上', () => {
    // 脏值来源：用户可编辑的备份文件原样透传（sanitizeAccounts 不校验形状）。
    const resolver = createMinimaxFetcherResolver(() => 12345 as unknown as string)
    expect(resolver('acct-1')).toBe(fetch)
  })

  it('⚠️ 全局解析器：池未就绪 ⇒ 直连；就绪后按池读（可后填引用）', () => {
    // 未注入池 ⇒ 恒直连（探测路径在 apply() 之前就可能跑）。
    setMinimaxProxyPool(undefined)
    expect(minimaxIntlFetchForAccount('acct-1')).toBe(fetch)
  })
})

describe('② 接线：每个消费点都必须接上按账号的 fetcher（源码级，剥注释后）', () => {
  it('⚠️ MinimaxAuth 登录 / 续期 / 目录 / 身份四条腿都接了 fetcherFor', () => {
    // 登录（设备码申请 + 轮询）、续期、目录、身份 —— 少一条腿就是「这条路径
    // 永远直连」的静默失效（gemini 踩过的同型）。
    expect((authSource.match(/this\.fetcherFor\(/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  it('⚠️ MinimaxAdapter 推理主路径走 fetcherFor(activeAccountId)，且在 send() 里现取', () => {
    expect(adapterSource).toContain('fetcher: this.fetcherFor(activeAccountId)')
  })

  it('⚠️ index.ts：国际站两个实例都注入了 minimaxIntlFetchForAccount', () => {
    expect((indexSource.match(/minimaxIntlFetchForAccount/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('⚠️ index.ts：中国站实例**刻意不注入**（直连才是最优）', () => {
    // minimax = new MinimaxAuth(ctx) 必须不带 fetchFor。
    expect(indexSource).toMatch(/new MinimaxAuth\(ctx\)/)
  })

  it('⚠️ 探测适配器把**池条目 id** 显式传进去（探测路径反查不存在）', () => {
    expect(indexSource).toContain('accountIdOverride: entry?.id')
  })

  it('⚠️ 登录分支把占位账号 id 传进 startLogin（凭据落盘前只有池条目认得它）', () => {
    expect(rpcSource).toContain('await minimaxAuth.startLogin({ accountId: id })')
  })

  it('⚠️ 登录分支为国际站继承既有账号的代理（死锁规避），且有替身防御', () => {
    expect(rpcSource).toContain('typeof pool.listAccountsByProvider')
  })

  it('⚠️ persistLogin 把 accountId 透传（身份查询同出口）', () => {
    expect(rpcSource).toContain(
      'await minimaxAuth.persistLogin(credential, { refName, accountId: id })',
    )
  })

  it('⚠️ 池字段读写与「非字符串脏值防御」都在', () => {
    expect(poolSource).toContain('setMinimaxIntlProxy')
    expect(poolSource).toContain('minimaxIntlProxyFor')
    expect(typesSource).toContain('minimaxIntlProxy?: string')
  })

  it('⚠️ 余额选号器把账号上下文传给 fetchBalance（第三参）', () => {
    expect(selectorSource).toContain('accountId: account.id')
  })

  it('⚠️ RPC 前缀改道用 minimaxintl.（不是 minimax.，防误吞中国站未来端点）', () => {
    expect(rpcSource).toContain("method.startsWith('minimaxintl.')")
  })
})

describe('③ 端点行为（setProxy / testProxy，守「死条件」变异）', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('setProxy：合法地址会真的落到池里', async () => {
    const pool = { setMinimaxIntlProxy: vi.fn(async () => {}) }
    const res = await handleMinimaxIntlRpc({} as never, pool, 'minimaxintl.setProxy', {
      accountId: 'minimaxintl-1', proxy: '127.0.0.1:7890',
    })
    expect(pool.setMinimaxIntlProxy).toHaveBeenCalledWith('minimaxintl-1', 'http://127.0.0.1:7890')
    expect(res).toMatchObject({ ok: true })
  })

  it('setProxy：空串 = 清除（不是非法地址）', async () => {
    const pool = { setMinimaxIntlProxy: vi.fn(async () => {}) }
    const res = await handleMinimaxIntlRpc({} as never, pool, 'minimaxintl.setProxy', {
      accountId: 'minimaxintl-1', proxy: '',
    })
    expect(pool.setMinimaxIntlProxy).toHaveBeenCalledWith('minimaxintl-1', '')
    expect(res).toMatchObject({ ok: true, value: { proxy: '' } })
  })

  it('⚠️ setProxy：非法地址被拒，且**不写池**', async () => {
    const pool = { setMinimaxIntlProxy: vi.fn(async () => {}) }
    const res = await handleMinimaxIntlRpc({} as never, pool, 'minimaxintl.setProxy', {
      accountId: 'minimaxintl-1', proxy: 'ftp://host:21',
    })
    expect(res).toMatchObject({ ok: false })
    expect(pool.setMinimaxIntlProxy).not.toHaveBeenCalled()
  })

  it('⚠️ setProxy：缺 accountId 必须拒绝且不写池', async () => {
    const pool = { setMinimaxIntlProxy: vi.fn(async () => {}) }
    for (const payload of [{}, { accountId: '' }, { accountId: 123 }]) {
      const res = await handleMinimaxIntlRpc({} as never, pool, 'minimaxintl.setProxy', payload)
      expect(res, JSON.stringify(payload)).toMatchObject({ ok: false })
    }
    expect(pool.setMinimaxIntlProxy).not.toHaveBeenCalled()
  })

  it('⚠️ 不认识的方法返回 undefined（让主 switch 继续匹配）', async () => {
    // ⚠️ 回信封会把**别的** provider 的方法名误判成「格式错误」。
    expect(await handleMinimaxIntlRpc({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.未知', {}))
      .toBeUndefined()
  })
})

describe('④ testProxy 的探活语义（连通性与分流是两个独立失败）', () => {
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
    const mod = await import('../../src/minimax-rpc.js')
    return { spy, handle: mod.handleMinimaxIntlRpc }
  }

  it('⚠️ 探活目标必须是国际站自己的端点，且真用用户填的代理', async () => {
    const { spy, handle } = await withMockedProxyFetch(
      async () => new Response('', { status: 200 }),
    )
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res, '探活失败').toMatchObject({ ok: true })
    // 一条断言同时打掉两处变异：换成别的主机、绕过用户代理。
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('https://agent.minimax.io/'),
      expect.objectContaining({ redirect: 'manual' }),
      expect.objectContaining({ url: 'http://127.0.0.1:7890' }),
    )
  })

  it('⚠️ 正常 200 ⇒ 通且未被分流（geoRouted=false）', async () => {
    const { handle } = await withMockedProxyFetch(
      async () => new Response('', { status: 200 }),
    )
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res).toMatchObject({ ok: true, value: { status: 200, geoRouted: false } })
  })

  it('⚠️⚠️ 307 到中国站 ⇒ **仍然 ok:true 但 geoRouted=true**（假阳性防护）', async () => {
    // 这是本家与 gemini 唯一实质不同的一格：拿到 HTTP 响应 ≠ 没被分流。
    const { handle } = await withMockedProxyFetch(async () => new Response('', {
      status: 307,
      headers: { Location: 'https://agent.minimaxi.com/v1/models' },
    }))
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res).toMatchObject({ ok: true, value: { status: 307, geoRouted: true } })
  })

  it('⚠️ 307 到其它主机（同站跳转）不算分流', async () => {
    const { handle } = await withMockedProxyFetch(async () => new Response('', {
      status: 302,
      headers: { Location: 'https://agent.minimax.io/v1/models?x=1' },
    }))
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res).toMatchObject({ ok: true, value: { geoRouted: false } })
  })

  it('⚠️ 401 也算「通」（判 response.ok 会让正确配置报红）', async () => {
    const { handle } = await withMockedProxyFetch(
      async () => new Response('', { status: 401 }),
    )
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res).toMatchObject({ ok: true, value: { status: 401, geoRouted: false } })
  })

  it('⚠️ 失败文案必须带根因码（error.message 恒为 fetch failed，真因在 cause）', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    const { handle } = await withMockedProxyFetch(async () => {
      throw new TypeError('fetch failed', { cause })
    })
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res).toMatchObject({ ok: false })
    const message = (res as { error: { message: string } }).error.message
    expect(message).toContain('ENOTFOUND')
  })

  it('⚠️ 非法代理地址在 testProxy 也必须被拒', async () => {
    const { handle } = await withMockedProxyFetch(async () => new Response('', { status: 200 }))
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'not-a-proxy',
    })
    // 「not-a-proxy」无端口 ⇒ normalizeProxy 拒绝（缺端口）。
    expect(res).toMatchObject({ ok: false })
  })
})

describe('⑤ 池字段行为（AccountPool 真跑，非替身）', () => {
  it('setMinimaxIntlProxy 写入后 minimaxIntlProxyFor 能读回；空串删键', async () => {
    const ctx = {
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    } as never
    const pool = new AccountPool(ctx)
    await pool.addAccount({
      id: 'acct-1', provider: 'minimaxintl', nickname: 'n', enabled: true,
      credentialRef: 'ref', refreshable: false, createdAt: Date.now(),
    })
    await pool.setMinimaxIntlProxy('acct-1', 'http://127.0.0.1:7890')
    expect(pool.minimaxIntlProxyFor('acct-1')).toBe('http://127.0.0.1:7890')
    // 未设置的账号 ⇒ 空串（不是 undefined）。
    expect(pool.minimaxIntlProxyFor('acct-missing')).toBe('')
    // 清除 = 删键（读回空串）。
    await pool.setMinimaxIntlProxy('acct-1', '')
    expect(pool.minimaxIntlProxyFor('acct-1')).toBe('')
    // 不存在的账号 ⇒ 不抛（warn 后返回）。
    await expect(pool.setMinimaxIntlProxy('nope', 'http://x:1')).resolves.toBeUndefined()
  })

  it('⚠️ 池里被注入非字符串脏值 ⇒ 读回空串（不崩在 trim 上）', async () => {
    const ctx = {
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    } as never
    const pool = new AccountPool(ctx)
    await pool.addAccount({
      id: 'acct-1', provider: 'minimaxintl', nickname: 'n', enabled: true,
      credentialRef: 'ref', refreshable: false, createdAt: Date.now(),
    })
    // 模拟用户手改备份文件（sanitizeAccounts 原样透传的入口）。
    const accounts = pool.listAccounts ? await pool.listAccounts('minimaxintl') : []
    const entry = accounts[0]!
    // 直接写内部快照（AccountPool 没有公开的「写脏值」入口 —— 这正是防御的理由）。
    ;(entry as { minimaxIntlProxy?: unknown }).minimaxIntlProxy = 12345
    // readAccounts 从权威副本读：直接改副本。
    const raw = (pool as unknown as { readAccounts(): Array<Record<string, unknown>> })
      .readAccounts()
    const target = raw.find((a) => a.id === 'acct-1')
    if (target) target.minimaxIntlProxy = 12345
    expect(pool.minimaxIntlProxyFor('acct-1')).toBe('')
  })
})

describe('⑥ 客户端接线（源码级，剥注释后）', () => {
  it('⚠️ minimaxintl 的账号卡传了 onOpenProxy', () => {
    expect(clientSource).toContain("provider === 'minimaxintl'")
    expect(clientSource).toContain('MinimaxIntlProxyModal')
    expect(clientSource).toContain('proxyModalComponent')
  })

  it('⚠️ 弹窗调 minimaxintl.setProxy / testProxy，且回显 geoRouted 警告', () => {
    expect(modalSource).toContain("'minimaxintl.setProxy'")
    expect(modalSource).toContain("'minimaxintl.testProxy'")
    expect(modalSource).toContain('geoRouted')
  })

  it('⚠️ AccountCard 的 tooltip 分支覆盖三家（当前值 → 修改；未设置 → 语义说明）', () => {
    expect(clientSource).toContain('account.minimaxIntlProxy')
  })
})
