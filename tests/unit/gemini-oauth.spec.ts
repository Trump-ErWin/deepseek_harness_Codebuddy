/**
 * Gemini OAuth 单测。
 *
 * 守的是原版踩过的三个坑：
 * 1. token 端点**必须**带 `client_secret`（否则 `invalid_request`，症状是
 *    「浏览器授权成功但账号不出现」）；
 * 2. `state` 不匹配的回调必须拒绝；
 * 3. 续期响应里给了新 `refresh_token` 必须回写（Google 偶尔轮换）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GEMINI_AUTH_ENDPOINT,
  GEMINI_CALLBACK_PATH,
  GEMINI_DEFAULT_CLIENT_ID,
  GEMINI_SCOPES,
  GeminiLoginCancelledError,
  buildGeminiAuthUrl,
  credentialFromGeminiGrant,
  exchangeGeminiCode,
  fetchGeminiUserInfo,
  geminiExpiryFrom,
  parseGeminiTokenGrant,
  refreshGeminiCredential,
  revokeGeminiToken,
  startGeminiOAuthFlow,
} from '../../src/gemini-oauth.js'
import { parseGeminiCredential } from '../../src/gemini.js'

const previousId = process.env.CMDC_PAK_GOOGLE_CLIENT_ID
const previousSecret = process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET

afterEach(() => {
  if (previousId === undefined) delete process.env.CMDC_PAK_GOOGLE_CLIENT_ID
  else process.env.CMDC_PAK_GOOGLE_CLIENT_ID = previousId
  if (previousSecret === undefined) delete process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET
  else process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET = previousSecret
  vi.restoreAllMocks()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 抓取 fetch 的调用参数（工厂按调用序号产出响应）。 */
function captureFetch(response: Response | ((callIndex: number) => Response)) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const index = calls.length
    calls.push({ url: String(url), init: init ?? {} })
    return typeof response === 'function' ? response(index) : response
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

describe('授权 URL', () => {
  it('六项 scope + 离线访问 + consent', () => {
    const url = new URL(buildGeminiAuthUrl({ state: 'STATE', redirectUri: 'http://localhost:1234/oauth-callback' }))
    expect(`${url.origin}${url.pathname}`).toBe(GEMINI_AUTH_ENDPOINT)
    expect(url.searchParams.get('client_id')).toBe(GEMINI_DEFAULT_CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1234/oauth-callback')
    expect(url.searchParams.get('state')).toBe('STATE')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('include_granted_scopes')).toBe('true')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...GEMINI_SCOPES])
    // ⚠️ 原版带 client_secret，故**没有** PKCE。
    expect(url.searchParams.get('code_challenge')).toBeNull()
  })

  it('env 可覆盖 client_id', () => {
    process.env.CMDC_PAK_GOOGLE_CLIENT_ID = 'custom-client'
    const url = new URL(buildGeminiAuthUrl({ state: 'S', redirectUri: 'http://localhost:1/x' }))
    expect(url.searchParams.get('client_id')).toBe('custom-client')
  })
})

describe('令牌解析', () => {
  it('正常响应', () => {
    expect(parseGeminiTokenGrant({
      access_token: 'AT',
      refresh_token: 'RT',
      token_type: 'Bearer',
      expires_in: 3599,
      scope: 'openid',
    })).toEqual({
      access_token: 'AT',
      refresh_token: 'RT',
      token_type: 'Bearer',
      expires_in: 3599,
      scope: 'openid',
    })
  })

  it('缺 refresh_token 时沿用旧值（续期响应常不带）', () => {
    expect(parseGeminiTokenGrant({ access_token: 'AT2', expires_in: 3600 }, 'RT_OLD').refresh_token)
      .toBe('RT_OLD')
  })

  it('error 字段 → 带描述的异常', () => {
    expect(() => parseGeminiTokenGrant({ error: 'invalid_grant', error_description: 'expired' }))
      .toThrowError('invalid_grant: expired')
    expect(() => parseGeminiTokenGrant({ error: 'invalid_request' })).toThrowError('invalid_request')
  })

  it('缺 access_token → 明确报错', () => {
    expect(() => parseGeminiTokenGrant({ expires_in: 3600 })).toThrowError(/未返回 access_token/)
    expect(() => parseGeminiTokenGrant('nope')).toThrowError(/无法解析/)
  })

  it('token_type 缺省补 Bearer，expires_in 非法时用 3600', () => {
    const grant = parseGeminiTokenGrant({ access_token: 'AT', expires_in: -5 })
    expect(grant.token_type).toBe('Bearer')
    expect(grant.expires_in).toBe(3600)
  })
})

describe('凭据构造', () => {
  it('expires_in → RFC3339 expiry', () => {
    const expiry = geminiExpiryFrom(3600, 1_790_868_102_000)
    expect(Date.parse(expiry) - 1_790_868_102_000).toBe(3_600_000)
    // 非法 expires_in 退化为 3600（不编造过期时刻）。
    expect(Date.parse(geminiExpiryFrom(0, 0))).toBe(3_600_000)
  })

  it('保留既有 sub/email/project，不因续期丢身份', () => {
    const credential = credentialFromGeminiGrant(
      { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 },
      { refresh_token: 'RT_OLD', sub: 'sub-1', email: 'a@b.c', cloudaicompanionProject: 'proj' },
    )
    expect(credential).toMatchObject({
      access_token: 'AT',
      refresh_token: 'RT_OLD',
      sub: 'sub-1',
      email: 'a@b.c',
      cloudaicompanionProject: 'proj',
    })
    // 落盘再解析仍等价（凭据必须能被 parseGeminiCredential 读回）。
    expect(parseGeminiCredential(JSON.stringify(credential))).toEqual(credential)
  })
})

describe('令牌交换与续期', () => {
  it('交换**必须**带 client_secret 与 redirect_uri（否则 invalid_request）', async () => {
    const { calls, fetcher } = captureFetch(json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }))
    await exchangeGeminiCode('CODE', 'http://localhost:1234/oauth-callback', { fetcher })
    const body = new URLSearchParams(String(calls[0]?.init.body))
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('CODE')
    expect(body.get('redirect_uri')).toBe('http://localhost:1234/oauth-callback')
    expect(body.get('client_secret')).toBeTruthy()
    expect(body.get('code_verifier')).toBeNull()
    // ⚠️ 令牌端点**不伪装** UA（伪装只用在 Cloud Code 端点）。
    expect((calls[0]?.init.headers as Record<string, string>)['User-Agent']).toBeUndefined()
    expect((calls[0]?.init.headers as Record<string, string>)['Content-Type'])
      .toBe('application/x-www-form-urlencoded')
  })

  it('续期用 refresh_token grant，并把旧值带进解析', async () => {
    const { calls, fetcher } = captureFetch(json({ access_token: 'AT2', expires_in: 3600 }))
    const grant = await refreshGeminiCredential('RT_OLD', { fetcher })
    const body = new URLSearchParams(String(calls[0]?.init.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT_OLD')
    expect(grant.refresh_token).toBe('RT_OLD')
  })

  it('空 refresh_token 直接报错，不发请求', async () => {
    const { calls, fetcher } = captureFetch(json({}))
    await expect(refreshGeminiCredential('', { fetcher })).rejects.toThrowError(/需要重新授权/)
    expect(calls).toHaveLength(0)
  })

  it('HTTP 非 2xx 时把 error/description 带出来', async () => {
    const { fetcher } = captureFetch(json({ error: 'invalid_client', error_description: 'bad secret' }, 401))
    await expect(exchangeGeminiCode('C', 'http://localhost:1/x', { fetcher }))
      .rejects.toThrowError('invalid_client: bad secret')
  })

  it('非 JSON 响应给出可定位的文案', async () => {
    const fetcher = (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch
    await expect(exchangeGeminiCode('C', 'http://localhost:1/x', { fetcher }))
      .rejects.toThrowError(/无法解析（HTTP 502）/)
  })
})

describe('userinfo 与撤销', () => {
  it('取 id/email（id 就是 OIDC 的 sub）', async () => {
    const { calls, fetcher } = captureFetch(json({ id: 'sub-1', email: 'a@b.c' }))
    expect(await fetchGeminiUserInfo('AT', { fetcher })).toEqual({ sub: 'sub-1', email: 'a@b.c' })
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer AT')
  })

  it('userinfo 失败返回空对象（身份只是展示信息，不该让授权失败）', async () => {
    const fetcher = (async () => json({ error: 'x' }, 401)) as unknown as typeof fetch
    expect(await fetchGeminiUserInfo('AT', { fetcher })).toEqual({})
    const boom = (async () => { throw new Error('network') }) as unknown as typeof fetch
    expect(await fetchGeminiUserInfo('AT', { fetcher: boom })).toEqual({})
  })

  it('撤销失败不上抛（登出不能被网络问题卡住）', async () => {
    const boom = (async () => { throw new Error('network') }) as unknown as typeof fetch
    await expect(revokeGeminiToken('AT', { fetcher: boom })).resolves.toBeUndefined()
    await expect(revokeGeminiToken('', { fetcher: boom })).resolves.toBeUndefined()
  })
})

describe('两步式授权流程', () => {
  it('立即返回 loginUrl，回调携带正确 state 时完成交换', async () => {
    const { fetcher } = captureFetch((index) => {
      // 第 0 次是 token 交换，第 1 次是 userinfo。
      return index === 0
        ? json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
        : json({ id: 'sub-9', email: 'u@example.com' })
    })
    const started = await startGeminiOAuthFlow({ fetcher, callbackPort: 0 })
    try {
      const url = new URL(started.loginUrl)
      const state = url.searchParams.get('state') ?? ''
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      expect(redirect.pathname).toBe(GEMINI_CALLBACK_PATH)
      expect(state).toMatch(/^[0-9a-f]{32}$/)

      const callback = await fetch(
        `http://127.0.0.1:${redirect.port}${GEMINI_CALLBACK_PATH}?code=CODE&state=${state}`,
      )
      expect(callback.status).toBe(200)
      expect(await callback.text()).toContain('授权已完成')

      const credential = await started.result
      expect(credential.access_token).toBe('AT')
      expect(credential.refresh_token).toBe('RT')
      expect(credential.sub).toBe('sub-9')
      expect(credential.email).toBe('u@example.com')
      expect(credential.expiry).toBeDefined()
    } finally {
      await started.close()
      await started.close() // 幂等
    }
  })

  it('state 不匹配的回调被拒（防伪造回调）', async () => {
    const { fetcher } = captureFetch(json({ access_token: 'AT' }))
    const started = await startGeminiOAuthFlow({ fetcher, callbackPort: 0 })
    try {
      const redirect = new URL(new URL(started.loginUrl).searchParams.get('redirect_uri') ?? '')
      const callback = await fetch(
        `http://127.0.0.1:${redirect.port}${GEMINI_CALLBACK_PATH}?code=CODE&state=WRONG`,
      )
      expect(callback.status).toBe(400)
      await expect(started.result).rejects.toThrowError(/state 校验失败/)
    } finally {
      await started.close()
    }
  })

  it('用户在浏览器点取消 → 抛取消异常（面板应显示「已取消」而非「失败」）', async () => {
    const { fetcher } = captureFetch(json({}))
    const started = await startGeminiOAuthFlow({ fetcher, callbackPort: 0 })
    try {
      const url = new URL(started.loginUrl)
      const state = url.searchParams.get('state') ?? ''
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      const callback = await fetch(
        `http://127.0.0.1:${redirect.port}${GEMINI_CALLBACK_PATH}?error=access_denied&state=${state}`,
      )
      expect(callback.status).toBe(400)
      await expect(started.result).rejects.toBeInstanceOf(GeminiLoginCancelledError)
    } finally {
      await started.close()
    }
  })

  it('回调路径之外返回 404', async () => {
    const { fetcher } = captureFetch(json({}))
    const started = await startGeminiOAuthFlow({ fetcher, callbackPort: 0 })
    try {
      const redirect = new URL(new URL(started.loginUrl).searchParams.get('redirect_uri') ?? '')
      const callback = await fetch(`http://127.0.0.1:${redirect.port}/other`)
      expect(callback.status).toBe(404)
    } finally {
      await started.close()
    }
  })
})
