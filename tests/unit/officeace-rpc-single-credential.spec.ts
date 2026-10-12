/**
 * `officeace-rpc-single-credential.spec.ts` —— OfficeAce **单凭据渠道**契约守卫。
 *
 * ## 为什么单独一个文件
 *
 * OfficeAce 与其余 13 家渠道有一处**结构性差异**：凭据是**单一文件**
 * `~/.dsh-officeace/session.json`（华为云 OAuth 单账号流程），而不是
 * 「每卡片一个 credentialRef」。其余渠道的守卫（zcode / gemini / buddy）
 * 全部假设「多账号 = 多份独立凭据」，在那个假设下「允许建第二张卡片」是
 * 正确的，故**不能**把它们改写成通用规则 —— 只有 OfficeAce 需要这条反向约束。
 *
 * ## 守的三条不变量（每条都对应一个真实后果，不是笔误级检查）
 *
 * | # | 不变量 | 违反的后果（实测） |
 * |---|--------|------------------|
 * | 1 | 已有条目时 `account.create` **拒绝**新建 | 第二次登录直接覆盖 session.json ⇒ 第一条的凭据被静默冲掉（数据损坏） |
 * | 2 | 拒绝时**不占位**、不启动登录 | 留下幽灵条目，且白跑一次华为云 state 申请 |
 * | 3 | 删掉旧条目后**允许**重新登录 | 拦截过严 ⇒ 用户换号时卡死，唯一出路变成手删文件 |
 *
 * 第 3 条尤其重要：它防止第 1 条被「修过头」（一刀切禁止登录会让渠道变砖）。
 *
 * ⚠️ 本文件**不发真实网络**：`startLogin` 用桩替代，只验证分派与拦截语义。
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'

/**
 * 造一个能注册 RPC 的最小 ctx。
 *
 * ⚠️ 抄自 `zcode-rpc-login.spec.ts`（那里有逐条踩坑注释），两处要点：
 *   1. `settings.register` **必须返回可用 scope**，否则 `createJetHubStore`
 *      会崩在 `Cannot read properties of undefined (reading 'get')`；
 *   2. `connection.fetch.register` 必须**按 path 过滤**（本模块除 RPC 的 POST
 *      端点外还注册了载体页 GET 路由）——“谁最后注册记谁”会把用例全打到载体页。
 */
function makeCtx(): { ctx: Context; handler: () => ((req: Request) => Promise<Response>) | undefined } {
  const ctx = new Context()
  ctx.provide('credentials', {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
    unset: async () => {},
  } as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() {
      return { get: () => state.value, replace: (v: unknown) => { state.value = v } }
    },
    describe() { return [] },
  } as never)
  let handler: ((req: Request) => Promise<Response>) | undefined
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_deps: string[], cb: (c: unknown) => void) => cb(ctx)
  return { ctx, handler: () => handler }
}

/** 桩 `officeace` auth：只提供 `account.create` 分支需要的 `startLogin`。 */
function makeOfficeAceStub(overrides: Record<string, unknown> = {}) {
  return {
    startLogin: async () => ({
      authorizeUrl: 'https://auth.huaweicloud.com/stub',
      state: 'stub-state',
      _internal: {
        codeVerifier: 'stub-verifier',
        dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      },
    }),
    ...overrides,
  }
}

function makeRpc(officeace: Record<string, unknown>) {
  const { ctx, handler } = makeCtx()
  const pool = new AccountPool(ctx)
  registerJetHubRpc(
    ctx, pool,
    {
      codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
      lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
      trae: {} as never, cline: {} as never, loomy: {} as never,
      raccoon: {} as never, minimax: {} as never, zcode: {} as never,
      gemini: {} as never,
      officeace: officeace as never,
    } as never,
    undefined,
  )
  const h = handler()
  if (h === undefined) throw new Error('handler 未注册')
  const call = async (method: string, payload: unknown) => {
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    // ⚠️ 括号**不可省**：`x as T['result']` 会被解析成「断言成索引访问类型」，
    //    并不会取属性 ⇒ 返回整个 body，`.ok` 恒为 undefined（实测踩过）。
    const body = (await res.json()) as {
      result: { ok: boolean; value?: any; error?: { code: string; message: string } }
    }
    return body.result
  }
  return { call, pool }
}

describe('OfficeAce 单凭据渠道：禁止重复登录', () => {
  it('① 已有条目时 account.create 拒绝新建（否则覆盖凭据且余额重复计数）', async () => {
    const stub = makeOfficeAceStub()
    const { call, pool } = makeRpc(stub as unknown as Record<string, unknown>)

    const first = await call('account.create', { provider: 'officeace' })
    expect(first.ok, '首次登录应当成功').toBe(true)

    const second = await call('account.create', { provider: 'officeace' })
    expect(second.ok, '已有条目时仍放行 ⇒ 凭据会被覆盖、余额显示 13000').toBe(false)
    expect(second.error?.code).toBe('bad-request')
    // ⚠️ 报错要能指导用户下一步，而不是甩一句「创建失败」。
    expect(second.error?.message).toMatch(/单凭据|先删除|覆盖/)

    // 池里仍然只有一条：拦截发生在 addAccount 之前，没留下幽灵条目。
    expect(await pool.listAccounts('officeace')).toHaveLength(1)
  })

  it('② 拒绝时**不启动登录**（不白跑华为云 state 申请）', async () => {
    let startLoginCalls = 0
    const stub = makeOfficeAceStub({
      startLogin: async () => {
        startLoginCalls += 1
        return {
          authorizeUrl: 'https://auth.huaweicloud.com/stub',
          state: 'stub-state',
          _internal: {
            codeVerifier: 'v',
            dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
          },
        }
      },
    })
    const { call } = makeRpc(stub as unknown as Record<string, unknown>)

    await call('account.create', { provider: 'officeace' })
    expect(startLoginCalls, '首次登录应当真的启动').toBe(1)

    await call('account.create', { provider: 'officeace' })
    expect(startLoginCalls, '第二次被拦截了却仍调了 startLogin ⇒ 拦截加在了 addAccount 之后').toBe(1)
  })

  it('③ 删除旧条目后允许重新登录（防止第①条被修过头导致换号卡死）', async () => {
    const { call, pool } = makeRpc(makeOfficeAceStub() as unknown as Record<string, unknown>)

    const first = await call('account.create', { provider: 'officeace' })
    const accountId = first.value?.accountId as string
    expect(accountId).toBeTruthy()

    // 模拟用户在面板上点了删除。
    await pool.removeAccount(accountId)
    expect(await pool.listAccounts('officeace')).toHaveLength(0)

    const second = await call('account.create', { provider: 'officeace' })
    expect(second.ok, '删掉旧条目后应当能重新登录 —— 否则换号只能用文件管理器手删').toBe(true)
    expect(await pool.listAccounts('officeace')).toHaveLength(1)
  })

  it('④ 其余多凭据渠道**不**受此约束（buddy 可建多条）', async () => {
    // ⚠️ 反向对照：证明这条规则是 OfficeAce 专属，不是全局误伤。
    //    buddy 走 CodeBuddy 系两步式（每条卡片一份独立凭据），允许多条是**正确**的。
    const { call, pool } = makeRpc(makeOfficeAceStub() as unknown as Record<string, unknown>)
    // buddy 的 create 分支会真的去 fetchAuthState 发网络；这里只断言
    // 「没被单凭据规则拦掉」—— 即错误码不是 officeace 那条文案。
    const res = await call('account.create', { provider: 'buddy' }).catch(() => undefined)
    if (res !== undefined && res.ok === false) {
      expect(res.error?.message, 'buddy 被 OfficeAce 的单凭据规则误伤了').not.toMatch(/单凭据|先删除/)
    }
    expect(await pool.listAccounts('officeace')).toHaveLength(0)
  })
})
