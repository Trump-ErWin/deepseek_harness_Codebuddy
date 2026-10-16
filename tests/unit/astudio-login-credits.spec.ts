/**
 * astudio-login-credits.spec.ts —— AStudio 每日签到与微信扫码登录凭据兑换单测
 */
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'
import {
  claimAstudioDailyReward,
  claimDaily,
  extractAstudioDailyRewardPopup,
  parseAstudioPopupPoints,
  ASTUDIO_POPUP_TYPE_DAILY_REWARD,
} from '../../src/astudio-credits.js'
import {
  AstudioAuth,
  type AstudioCredentialStore,
} from '../../src/astudio-auth.js'
import {
  createAstudioWechatQrCode,
  pollAstudioWechatScan,
  bindAstudioWechatSession,
  completeAstudioLogin,
  generateAstudioWechatFd,
  ASTUDIO_WECHAT_FD_ALPHABET,
  type AstudioWechatAccount,
} from '../../src/astudio-oauth.js'
import { ASTUDIO } from '../../src/astudio-product.js'
import type { AstudioCredential } from '../../src/astudio.js'
import { createProviderCredits } from '../../src/provider-credits.js'
import { registerJetHubRpc, JET_HUB_API_PATH, type JetHubAuths } from '../../src/jet-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'

describe('AStudio 每日签到（Credits & Claim）', () => {
  describe('parseAstudioPopupPoints', () => {
    it('支持数值型积分', () => {
      expect(parseAstudioPopupPoints(100)).toBe(100)
      expect(parseAstudioPopupPoints(0)).toBe(0)
      expect(parseAstudioPopupPoints(12.8)).toBe(12)
    })

    it('支持字符串型积分', () => {
      expect(parseAstudioPopupPoints('100')).toBe(100)
      expect(parseAstudioPopupPoints(' 50 ')).toBe(50)
      expect(parseAstudioPopupPoints('0')).toBe(0)
    })

    it('支持包含 points 或 credit 键的对象', () => {
      expect(parseAstudioPopupPoints({ points: 200 })).toBe(200)
      expect(parseAstudioPopupPoints({ points: '150' })).toBe(150)
      expect(parseAstudioPopupPoints({ credit: 88 })).toBe(88)
    })

    it('非法或负数安全回退为 0', () => {
      expect(parseAstudioPopupPoints(undefined)).toBe(0)
      expect(parseAstudioPopupPoints(null)).toBe(0)
      expect(parseAstudioPopupPoints(-10)).toBe(0)
      expect(parseAstudioPopupPoints('abc')).toBe(0)
    })
  })

  describe('extractAstudioDailyRewardPopup', () => {
    it('正确识别 DAILY_REWARD_DIALOG 弹窗并提取字段', () => {
      const list = [
        { type: 'NEW_USER_DIALOG', popupId: 101 },
        {
          type: ASTUDIO_POPUP_TYPE_DAILY_REWARD,
          popupId: 202,
          instanceKey: 'key-202',
          payload: { points: '100' },
        },
      ]
      const popup = extractAstudioDailyRewardPopup(list)
      expect(popup).toBeDefined()
      expect(popup?.popupId).toBe(202)
      expect(popup?.instanceKey).toBe('key-202')
      expect(popup?.type).toBe(ASTUDIO_POPUP_TYPE_DAILY_REWARD)
      expect(popup?.payload?.points).toBe('100')
    })

    it('非数组或无目标弹窗时返回 undefined', () => {
      expect(extractAstudioDailyRewardPopup(null)).toBeUndefined()
      expect(extractAstudioDailyRewardPopup([])).toBeUndefined()
      expect(extractAstudioDailyRewardPopup([{ type: 'OTHER_DIALOG', popupId: 1 }])).toBeUndefined()
    })
  })

  describe('claimAstudioDailyReward / claimDaily', () => {
    const validCred: AstudioCredential = {
      access_token: 'fake-token',
      sso_session_id: 'sso-12345',
      account_id: '17400000000',
    }

    it('别名一致性：claimDaily 指向 claimAstudioDailyReward', () => {
      expect(claimDaily).toBe(claimAstudioDailyReward)
    })

    it('凭据无 Cookie 时直接返回 80000 终态鉴权失败', async () => {
      const outcome = await claimAstudioDailyReward({ access_token: 'foo' })
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe(80000)
        expect(outcome.message).toContain('未登录')
      }
    })

    it('pending 接口返回 code 80000 终态鉴权失败', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 80000, desc: '登录异常，请重新登录' }),
      } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe(80000)
        expect(outcome.message).toContain('需在 AStudio 客户端人工重新登录')
      }
    })

    it('pending 返回空数组时返回 already-claimed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, flag: true, data: [] }),
      } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('already-claimed')
      if (outcome.kind === 'already-claimed') {
        expect(outcome.message).toContain('今天已领取')
      }
    })

    it('pending 返回非 DAILY_REWARD_DIALOG 弹窗时返回 already-claimed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          flag: true,
          data: [{ type: 'CLIENT_DOWNLOAD_REWARD_DIALOG', popupId: 999 }],
        }),
      } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('already-claimed')
    })

    it('pending 发现待领弹窗，complete 成功领取积分', async () => {
      const mockFetch = vi.fn()
        // 1. pending
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            flag: true,
            data: [
              {
                type: ASTUDIO_POPUP_TYPE_DAILY_REWARD,
                popupId: 1234,
                instanceKey: 'inst-abc',
                payload: { points: '100' },
              },
            ],
          }),
        } as Response)
        // 2. complete
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            flag: true,
            data: { points: 100 },
          }),
        } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('claimed')
      if (outcome.kind === 'claimed') {
        expect(outcome.credit).toBe(100)
        expect(outcome.unit).toBe('credit')
      }
      expect(mockFetch).toHaveBeenCalledTimes(2)
      const completeCall = mockFetch.mock.calls[1]
      expect(completeCall[0]).toContain('/client-popups/complete')
      expect(JSON.parse(completeCall[1].body)).toEqual({ popupId: 1234, instanceKey: 'inst-abc' })
    })

    it('complete 失败时正确向外传递 failed', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            flag: true,
            data: [{ type: ASTUDIO_POPUP_TYPE_DAILY_REWARD, popupId: 555, instanceKey: 'k' }],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe(500)
      }
    })
  })
})

describe('AStudio 微信扫码登录与凭据交换（Wechat Scan & completeLogin）', () => {
  it('generateAstudioWechatFd 生成合法的 8 字符随机串', () => {
    const fd = generateAstudioWechatFd()
    expect(fd).toHaveLength(8)
    for (const ch of fd) {
      expect(ASTUDIO_WECHAT_FD_ALPHABET).toContain(ch)
    }
  })

  it('createAstudioWechatQrCode 成功返回二维码 URL 与 fd', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        flag: true,
        data: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=fake-ticket',
      }),
    } as Response)

    const qr = await createAstudioWechatQrCode({ fetcher: mockFetch, fd: 'testfd88' })
    expect(qr.fd).toBe('testfd88')
    expect(qr.qrUrl).toContain('showqrcode?ticket=fake-ticket')
    expect(qr.expiresInMs).toBe(300_000)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/SSOService/wx/scanlogin/qrcode?fd=testfd88'),
      expect.anything(),
    )
  })

  it('pollAstudioWechatScan 未扫码时返回 pending', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: -1,
        desc: '未扫码',
      }),
    } as Response)

    const res = await pollAstudioWechatScan('testfd', { fetcher: mockFetch })
    expect(res.status).toBe('pending')
    if (res.status === 'pending') {
      expect(res.message).toBe('未扫码')
    }
  })

  it('pollAstudioWechatScan 扫码成功时返回 scanned 与账号列表', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: [
          { uid: '17469144703', ssoSessionId: 'sso-val-123', username: 'TestUser' },
        ],
      }),
    } as Response)

    const res = await pollAstudioWechatScan('testfd', { fetcher: mockFetch })
    expect(res.status).toBe('scanned')
    if (res.status === 'scanned') {
      expect(res.account.uid).toBe('17469144703')
      expect(res.account.ssoSessionId).toBe('sso-val-123')
      expect(res.account.username).toBe('TestUser')
      expect(res.accounts).toHaveLength(1)
    }
  })

  it('bindAstudioWechatSession 发送表单完成会话绑定', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, flag: true }),
    } as Response)

    const account: AstudioWechatAccount = {
      uid: '17469144703',
      ssoSessionId: 'sso-bind-token',
    }
    const bindRes = await bindAstudioWechatSession('fd123456', account, { fetcher: mockFetch })
    expect(bindRes.ok).toBe(true)
    const callArgs = mockFetch.mock.calls[0]
    expect(callArgs[0]).toContain('/SSOService/wx/scanlogin/bind')
    expect(callArgs[1].body).toContain('accountId=17469144703')
    expect(callArgs[1].body).toContain('ssoSessionId=sso-bind-token')
  })

  it('completeAstudioLogin 兑换完整凭据（init-app + userInfo + configs）', async () => {
    const mockFetch = vi.fn()
      // 1. init-app
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0 }),
      } as Response)
      // 2. userInfo
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: { nickname: 'AstronDev', mobile: '17469144703' },
        }),
      } as Response)
      // 3. bot/models/configs
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: [
            {
              model: 'xopglm52',
              api_key: 'model-bearer-token-12345',
              is_default: true,
            },
          ],
        }),
      } as Response)

    const account: AstudioWechatAccount = {
      uid: '17469144703',
      ssoSessionId: 'sso-exchange-token',
      username: 'InitUser',
    }

    const cred = await completeAstudioLogin(account, { fetcher: mockFetch })
    expect(cred.access_token).toBe('model-bearer-token-12345')
    expect(cred.account_id).toBe('17469144703')
    expect(cred.uid).toBe('17469144703')
    expect(cred.nickname).toBe('AstronDev')
    expect(cred.sso_session_id).toBe('sso-exchange-token')
    expect(cred.login_method).toBe('wechat')
    expect(cred.source).toBe('account-backend')
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('AstudioAuth.completeLogin 集成兑换并写入凭据库', async () => {
    class FakeStore implements AstudioCredentialStore {
      readonly map = new Map<string, string>()
      async resolve(ref: unknown) {
        const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
        const val = this.map.get(key)
        return val !== undefined ? { value: val } : undefined
      }
      async set(ref: unknown, value: string) {
        const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
        this.map.set(key, value)
      }
      async unset(ref: unknown) {
        const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
        this.map.delete(key)
      }
    }
    const fakeStore = new FakeStore()

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { nickname: 'AuthUser' } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: [{ model: 'xopglm52', api_key: 'stored-api-key', is_default: true }],
        }),
      } as Response)

    const ctx = new Context()
    const auth = new AstudioAuth(ctx, {
      store: fakeStore,
      fetcher: mockFetch,
      env: { DSH_ASTUDIO_SESSION_FILE: 'F:/project/ARTEX/data/tasks/4/not-exist.json' },
    })

    const account: AstudioWechatAccount = {
      uid: '17488888888',
      ssoSessionId: 'sso-session-store',
    }

    const saved = await auth.completeLogin(account)
    expect(saved.access_token).toBe('stored-api-key')
    expect(saved.uid).toBe('17488888888')

    // 验证写入凭据库
    const resolved = await fakeStore.resolve(credentialRef(ASTUDIO.defaultCredentialRef))
    const storedVal = resolved?.value
    expect(storedVal).toBeDefined()
    const parsed = JSON.parse(storedVal!)
    expect(parsed.access_token).toBe('stored-api-key')
  })
})

describe('AStudio Provider Credits & Jet Hub RPC 接线验证', () => {
  it('createProviderCredits 正确为 astudio 注册 claimDaily 与 balanceDetailed', async () => {
    const table = createProviderCredits()
    expect(table.astudio).toBeDefined()
    expect(typeof table.astudio?.fetchBalanceDetailed).toBe('function')
    expect(typeof table.astudio?.claim).toBe('function')
    expect(table.astudio?.precheckStatus).toBe(false)
  })

  function makeTestRpc(mockFetch: typeof fetch) {
    const credentialsMap = new Map<string, string>()
    let handler: ((req: Request) => Promise<Response>) | undefined

    const ctx = {
      get: (key: string) => key === 'connection'
        ? {
            fetch: {
              register: (config: { path: string; fetch: (req: Request) => Promise<Response> }) => {
                if (config.path === JET_HUB_API_PATH) handler = config.fetch
              },
            },
          }
        : undefined,
      inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      credentials: {
        resolve: async (ref: unknown) => {
          const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
          const val = credentialsMap.get(key)
          return val !== undefined ? { value: val } : undefined
        },
        set: async (ref: unknown, value: string) => {
          const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
          credentialsMap.set(key, value)
        },
        unset: async (ref: unknown) => {
          const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
          credentialsMap.delete(key)
        },
      },
      connection: {
        fetch: {
          register: (config: { path: string; fetch: (req: Request) => Promise<Response> }) => {
            if (config.path === JET_HUB_API_PATH) handler = config.fetch
          },
        },
      },
    }

    const authCtx = new Context()
    const pool = new AccountPool(authCtx as never)

    const fakeStore = {
      resolve: ctx.credentials.resolve.bind(ctx.credentials),
      set: ctx.credentials.set.bind(ctx.credentials),
      unset: ctx.credentials.unset.bind(ctx.credentials),
    }
    const astudioAuth = new AstudioAuth(authCtx, {
      store: fakeStore,
      fetcher: mockFetch,
      env: { DSH_ASTUDIO_SESSION_FILE: 'F:/project/ARTEX/data/tasks/4/non-existent.json' },
    })

    const blank = () => ({} as never)
    const auths: JetHubAuths = {
      codearts: blank(),
      buddy: blank(),
      workbuddy: blank(),
      lobsterai: blank(),
      qoder: blank(),
      qodercn: blank(),
      trae: blank(),
      cline: blank(),
      loomy: blank(),
      raccoon: blank(),
      minimax: blank(),
      zcode: blank(),
      gemini: blank(),
      officeace: blank(),
      accio: blank(),
      astudio: astudioAuth,
    }

    registerJetHubRpc(ctx as never, pool, auths)

    const callRpc = async (method: string, payload: unknown) => {
      if (!handler) throw new Error('endpoint handler was not registered')
      const req = new Request(`http://localhost${JET_HUB_API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-test',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      })
      const res = await handler(req)
      const body = await res.json() as { result: { ok: boolean; value?: any; error?: any } }
      return body.result
    }

    return { callRpc, pool, credentialsMap, astudioAuth }
  }

  it('account.create 在无本地会话时自动生成微信扫码登录二维码 loginUrl', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        flag: true,
        data: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=ticket-rpc-test',
      }),
    } as Response)

    const { callRpc } = makeTestRpc(mockFetch)

    const createRes = await callRpc('account.create', { provider: 'astudio' })
    expect(createRes.ok).toBe(true)
    expect(createRes.value?.loginUrl).toContain('showqrcode?ticket=ticket-rpc-test')
    expect(createRes.value?.accountId).toMatch(/^astudio-/)
  })

  it('login.poll 扫码成功时自动完成绑定并换取凭据落库', async () => {
    const mockFetch = vi.fn()
      // 1. qrcode 生成
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: 'https://mp.weixin.qq.com/qrcode' }),
      } as Response)
      // 2. poll scan -> scanned
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: [{ uid: '17499999999', ssoSessionId: 'sso-poll-val', username: 'PollDev' }],
        }),
      } as Response)
      // 3. bind session
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0 }),
      } as Response)
      // 4. init-app
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0 }),
      } as Response)
      // 5. userInfo
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { nickname: 'PollDev', mobile: '17499999999' } }),
      } as Response)
      // 6. bot/models/configs
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: [{ model: 'xopglm52', api_key: 'poll-exchange-token', is_default: true }],
        }),
      } as Response)

    const { callRpc, pool } = makeTestRpc(mockFetch)

    const createRes = await callRpc('account.create', { provider: 'astudio' })
    const accountId = createRes.value.accountId

    const pollRes = await callRpc('login.poll', { accountId })
    expect(pollRes.ok).toBe(true)
    expect(pollRes.value?.done).toBe(true)
    expect(pollRes.value?.success).toBe(true)

    // 账号在池中已就绪
    const accountEntry = await pool.findAccount(accountId)
    expect(accountEntry).toBeDefined()
    expect(accountEntry?.nickname).toBe('PollDev')
  })
})
