import { describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import http from 'node:http'
import {
  AUTOCLAW_CHAT_PATH,
  AUTOCLAW_MODEL_CONFIG_PATH,
  AUTOCLAW_REFRESH_PATH,
  AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX,
  AUTOCLAW_SYSTEM_PROMPT_DELIMITER,
  calculateAutoclawSign,
  cleanBearerToken,
  normalizeAutoclawModel,
  prepareAutoclawMessages,
  buildAutoclawHeaders,
  parseAutoclawCredential,
  isAutoclawRefreshable,
  isAutoclawTokenExpired,
  autoclawDisplayNickname,
  type AutoclawCredential,
  type ChatMessage,
} from '../../src/autoclaw.js'
import { AUTOCLAW } from '../../src/autoclaw-product.js'
import { AutoclawAdapter } from '../../src/autoclaw-adapter.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  sendAutoclawVerificationCode,
  loginAutoclawWithCode,
  probeAutoclawLocalCredential,
  AUTOCLAW_SEND_CODE_PATH,
  AUTOCLAW_LOGIN_PATH,
} from '../../src/autoclaw-oauth.js'

describe('AutoClaw 纯函数与核心协议', () => {
  describe('calculateAutoclawSign - MD5 签名计算', () => {
    it('正确计算 MD5(appId + & + timestamp + & + appKey)', () => {
      const appId = 'autoclaw_web_app'
      const timestamp = '1729000000'
      const appKey = 'secret_key_123456'

      const expected = crypto
        .createHash('md5')
        .update(`${appId}&${timestamp}&${appKey}`)
        .digest('hex')

      const actual = calculateAutoclawSign(appId, timestamp, appKey)
      expect(actual).toBe(expected)
      expect(actual).toMatch(/^[0-9a-f]{32}$/)
    })

    it('使用生产默认配置计算签名', () => {
      const ts = '1720000000'
      const actual = calculateAutoclawSign(AUTOCLAW.appId, ts, AUTOCLAW.appKey)
      const expected = crypto
        .createHash('md5')
        .update(`${AUTOCLAW.appId}&${ts}&${AUTOCLAW.appKey}`)
        .digest('hex')
      expect(actual).toBe(expected)
    })
  })

  describe('cleanBearerToken - 凭据清洗', () => {
    it('去除 Bearer 前缀并 trim', () => {
      expect(cleanBearerToken('Bearer eyJhbGciOi...')).toBe('eyJhbGciOi...')
      expect(cleanBearerToken('bearer eyJhbGciOi...')).toBe('eyJhbGciOi...')
      expect(cleanBearerToken('  Bearer   token_123   ')).toBe('token_123')
    })

    it('未带 Bearer 前缀时正常保留', () => {
      expect(cleanBearerToken('eyJhbGciOi...')).toBe('eyJhbGciOi...')
      expect(cleanBearerToken('   token_abc   ')).toBe('token_abc')
    })

    it('非法或空值返回空字符串', () => {
      expect(cleanBearerToken('')).toBe('')
      expect(cleanBearerToken(undefined as unknown as string)).toBe('')
      expect(cleanBearerToken(null as unknown as string)).toBe('')
    })
  })

  describe('normalizeAutoclawModel - 模型名称规范化', () => {
    it('默认或空值映射到 zai_glm-5.3-flash', () => {
      expect(normalizeAutoclawModel()).toBe('zai_glm-5.3-flash')
      expect(normalizeAutoclawModel('')).toBe('zai_glm-5.3-flash')
      expect(normalizeAutoclawModel('   ')).toBe('zai_glm-5.3-flash')
    })

    it('映射常用模型别名', () => {
      expect(normalizeAutoclawModel('glm-5.3-flash')).toBe('zai_glm-5.3-flash')
      expect(normalizeAutoclawModel('glm-5.3')).toBe('zaicoding_glm-5.3')
      expect(normalizeAutoclawModel('glm-5.3-coding')).toBe('zaicoding_glm-5.3')
      expect(normalizeAutoclawModel('auto')).toBe('zai_auto')
    })

    it('保留已有合规前缀', () => {
      expect(normalizeAutoclawModel('zai_glm-5.3-flash')).toBe('zai_glm-5.3-flash')
      expect(normalizeAutoclawModel('zaicoding_glm-5.3')).toBe('zaicoding_glm-5.3')
      expect(normalizeAutoclawModel('zai_auto')).toBe('zai_auto')
    })

    it('其他未知模型自动附加 zai_ 前缀', () => {
      expect(normalizeAutoclawModel('custom-model')).toBe('zai_custom-model')
    })
  })

  describe('prepareAutoclawMessages - 406 拦截绕过之 System Prompt 前缀注入', () => {
    it('空消息列表自动生成包含合规 System Prompt 的单条消息', () => {
      const result = prepareAutoclawMessages([])
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        role: 'system',
        content: AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX,
      })
    })

    it('首条不是 system 消息时在头部插入合规 system 消息', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '你好，请帮我写一段代码' },
      ]
      const result = prepareAutoclawMessages(messages)
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        role: 'system',
        content: AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX,
      })
      expect(result[1]).toEqual(messages[0])
    })

    it('首条是 system 但缺少前缀时自动分离为白名单过检项与原生指示', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: '自定义指示：你是一个严谨的工程师。' },
        { role: 'user', content: '测试' },
      ]
      const result = prepareAutoclawMessages(messages)
      expect(result).toHaveLength(3)
      expect(result[0]).toEqual({
        role: 'system',
        content: AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX,
      })
      expect(result[1]).toEqual({
        role: 'system',
        content: '自定义指示：你是一个严谨的工程师。',
      })
      expect(result[2]).toEqual(messages[1])
    })

    it('首条是 system 且已包含前缀时剥离前缀并保持分离', () => {
      const alreadyValid = `${AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX}. 额外说明`
      const messages: ChatMessage[] = [
        { role: 'system', content: alreadyValid },
        { role: 'user', content: '测试' },
      ]
      const result = prepareAutoclawMessages(messages)
      expect(result).toHaveLength(3)
      expect(result[0].content).toBe(AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX)
      expect(result[1].content).toBe('额外说明')
    })
  })

  describe('buildAutoclawHeaders - 请求头构造', () => {
    it('构造标准鉴权与协议头', () => {
      const headers = buildAutoclawHeaders({
        product: AUTOCLAW,
        accessToken: 'Bearer test_access_token_123',
        modelId: 'zai_glm-5.3-flash',
        timestamp: '1720000000',
      })

      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['X-Auth-Appid']).toBe(AUTOCLAW.appId)
      expect(headers['X-Auth-TimeStamp']).toBe('1720000000')
      expect(headers['X-Authorization']).toBe('Bearer test_access_token_123')
      expect(headers['X-Request-Model']).toBe('zai_glm-5.3-flash')
      expect(headers['X-Product']).toBe(AUTOCLAW.product)
      expect(headers['X-Auth-Sign']).toBe(
        calculateAutoclawSign(AUTOCLAW.appId, '1720000000', AUTOCLAW.appKey),
      )
      expect(headers['Accept']).toBeUndefined()
    })

    it('stream=true 时附带 Accept: text/event-stream', () => {
      const headers = buildAutoclawHeaders({
        product: AUTOCLAW,
        accessToken: 'test_token',
        modelId: 'zai_glm-5.3-flash',
        stream: true,
        timestamp: '1720000000',
      })
      expect(headers['Accept']).toBe('text/event-stream')
    })
  })

  describe('parseAutoclawCredential 与凭据状态判断', () => {
    it('解析标准 credential 结构', () => {
      const raw = {
        access_token: 'Bearer AT_VAL',
        refresh_token: 'RT_VAL',
        expires_at: 1800000000000,
        user_id: 'user_001',
        device_id: 'dev_001',
      }
      const cred = parseAutoclawCredential(raw)
      expect(cred).not.toBeUndefined()
      expect(cred?.access_token).toBe('AT_VAL')
      expect(cred?.refresh_token).toBe('RT_VAL')
      expect(cred?.expires_at).toBe(1800000000000)
      expect(cred?.user_id).toBe('user_001')
      expect(cred?.device_id).toBe('dev_001')
    })

    it('缺少 access_token 或 refresh_token 时返回 undefined', () => {
      expect(parseAutoclawCredential({ access_token: 'ONLY_ACCESS' })).toBeUndefined()
      expect(parseAutoclawCredential({ refresh_token: 'ONLY_REFRESH' })).toBeUndefined()
      expect(parseAutoclawCredential(null)).toBeUndefined()
    })

    it('isAutoclawRefreshable 判断', () => {
      expect(isAutoclawRefreshable({ access_token: 'a', refresh_token: 'r' })).toBe(true)
      expect(isAutoclawRefreshable({ access_token: 'a', refresh_token: '' })).toBe(false)
      expect(isAutoclawRefreshable({ access_token: 'a', refresh_token: '   ' })).toBe(false)
    })

    it('isAutoclawTokenExpired 判断', () => {
      const now = Date.now()
      expect(isAutoclawTokenExpired({ access_token: 'a', refresh_token: 'r', expires_at: now - 1000 })).toBe(true)
      expect(isAutoclawTokenExpired({ access_token: 'a', refresh_token: 'r', expires_at: now + 30_000 }, 60_000)).toBe(true)
      expect(isAutoclawTokenExpired({ access_token: 'a', refresh_token: 'r', expires_at: now + 300_000 }, 60_000)).toBe(false)
      expect(isAutoclawTokenExpired({ access_token: 'a', refresh_token: 'r' })).toBe(false)
    })

    it('autoclawDisplayNickname 格式化手机号与昵称', () => {
      // ⚠️ 用例里的号码是**编造的假号**（`13800000000` 属工信部测试号段），
      //    切勿换成真号 —— 测试断言与代码注释都会把它带进仓库历史。
      expect(autoclawDisplayNickname({ access_token: 'a', refresh_token: 'r', user_phone: '13800000000' })).toBe('138****0000')
      expect(autoclawDisplayNickname({ access_token: 'a', refresh_token: 'r', user_phone: '138****0000' })).toBe('138****0000')
      expect(autoclawDisplayNickname({ access_token: 'a', refresh_token: 'r', user_name: '张三' })).toBe('张三')
      expect(autoclawDisplayNickname({ access_token: 'a', refresh_token: 'r', user_id: 878541 })).toBe('用户878541')
      expect(autoclawDisplayNickname(undefined, 'fallback_id')).toBe('fallback_id')
    })
  })
})

describe('AutoclawAdapter 流式映射与端到端模拟', () => {
  function sseResponse(lines: string[]): Response {
    const body = lines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  function makeMockAdapter(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return responder(String(url), init)
    }) as unknown as typeof fetch

    const fakeCred: AutoclawCredential = {
      access_token: 'mock_token',
      refresh_token: 'mock_refresh',
      expires_at: Date.now() + 3600_000,
    }

    const adapter = new AutoclawAdapter({
      resolveCredential: async () => fakeCred,
      probeCredential: async () => fakeCred,
      fetchImpl: fetcher,
      product: AUTOCLAW,
    })

    return { adapter, calls, fetcher }
  }

  it('流式生成请求正确组装 URL、Headers、Body 与前缀并映射 text-delta', async () => {
    let capturedBody: any = null
    const { adapter, calls } = makeMockAdapter((url, init) => {
      capturedBody = JSON.parse(String(init?.body))
      return sseResponse([
        JSON.stringify({
          id: 'chunk_1',
          choices: [{ delta: { content: 'Hello' } }],
        }),
        JSON.stringify({
          id: 'chunk_2',
          choices: [{ delta: { content: ' world!' } }],
        }),
      ])
    })

    const options: GenerateOptions = {
      provider: 'autoclaw',
      model: 'glm-5.3-flash',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Hi' }],
          source: { kind: 'user' },
        }),
      ],
      temperature: 0.7,
      maxTokens: 100,
    }

    const receivedChunks: string[] = []
    for await (const chunk of adapter.stream(options)) {
      if (chunk.type === 'text-delta') {
        receivedChunks.push((chunk as any).delta ?? (chunk as any).text)
      }
    }

    // 验证请求 URL
    expect(calls[0].url).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_CHAT_PATH}`)
    expect(calls[0].init?.method).toBe('POST')

    // 验证请求 Headers
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers['X-Request-Model']).toBe('zai_glm-5.3-flash')
    expect(headers['X-Authorization']).toBe('Bearer mock_token')
    expect(headers['Accept']).toBe('text/event-stream')
    expect(headers['X-Auth-Sign']).toBeDefined()

    // 验证 Body 规范化
    expect(capturedBody.model).toBe('zai_glm-5.3-flash')
    expect(capturedBody.stream).toBe(true)
    expect(capturedBody.temperature).toBe(0.7)
    // 智谱 AutoClaw 网关对 max_tokens < 10000 会直接 406 拦截，故自动下限防护为 >= 16384
    expect(capturedBody.max_tokens).toBe(16384)
    // 验证自动注入了 406 前缀
    expect(capturedBody.messages[0].role).toBe('system')
    expect(capturedBody.messages[0].content).toBe(AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX)
    expect(capturedBody.messages[1].role).toBe('user')

    // 验证流式文本聚合结果
    expect(receivedChunks.join('')).toBe('Hello world!')
  })

  it('上游返回非 200 错误码（如 406）时抛出异常', async () => {
    const { adapter } = makeMockAdapter(() => {
      return new Response('Not Acceptable: missing required prefix', {
        status: 406,
        statusText: 'Not Acceptable',
      })
    })

    const options: GenerateOptions = {
      provider: 'autoclaw',
      model: 'glm-5.3-flash',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Test' }],
          source: { kind: 'user' },
        }),
      ],
    }

    await expect(async () => {
      for await (const _ of adapter.stream(options)) {
        // no-op
      }
    }).rejects.toThrow(/AutoClaw 请求失败 \[406 Not Acceptable\]/)
  })

  it('listAllModels 返回 fallbackModels 列表并标记免费模型', () => {
    const { adapter } = makeMockAdapter(() => {
      return new Response(JSON.stringify({ code: 200 }), { status: 200 })
    })

    const allModels = adapter.listAllModels()
    expect(allModels.length).toBeGreaterThan(0)
    const flashModel = allModels.find((m) => m.id === 'zai_glm-5.3-flash')
    expect(flashModel).toBeDefined()
    expect(flashModel?.isFree).toBe(true)
  })

  it('listModels 探测连通性后返回模型列表', async () => {
    const { adapter, calls } = makeMockAdapter(() => {
      return new Response(JSON.stringify({ code: 200 }), { status: 200 })
    })

    const models = await adapter.listModels('autoclaw')
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_MODEL_CONFIG_PATH}`)
    expect(models.length).toBeGreaterThan(0)
    const flash = models.find((m) => m.id === 'zai_glm-5.3-flash')
    expect(flash).toBeDefined()
    expect(flash?.isFree).toBe(true)
  })

  it('resolveModel 正确声明思考强度 (Reasoning Effort) 档位与 1M 上下文规格', async () => {
    const { adapter } = makeMockAdapter()
    const resolved = await adapter.resolveModel('autoclaw', 'zai_glm-5.3-flash')
    expect(resolved.id).toBe('zai_glm-5.3-flash')
    expect(resolved.context?.contextWindow).toBe(1048576)
    expect(resolved.context?.maxOutputTokens).toBe(131072)
    expect(resolved.reasoning).toBeDefined()
    expect(resolved.reasoning?.defaultEffort).toBe('high')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'high', 'max'])
  })

  describe('AutoClaw 短信验证码快速登录与凭据兑换', () => {
    it('sendAutoclawVerificationCode 校验非法手机号并拒绝发送', async () => {
      const res1 = await sendAutoclawVerificationCode('12345')
      expect(res1.ok).toBe(false)
      expect(res1.error).toContain('手机号格式不正确')

      const res2 = await sendAutoclawVerificationCode('abc13800138000')
      expect(res2.ok).toBe(false)
    })

    it('sendAutoclawVerificationCode 正确构造请求头、签名并下发验证码', async () => {
      let capturedUrl = ''
      let capturedInit: RequestInit | undefined
      const mockFetch = vi.fn().mockImplementation((url, init) => {
        capturedUrl = String(url)
        capturedInit = init
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: 0,
              msg: 'SUCCESS',
              data: {},
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      })

      const res = await sendAutoclawVerificationCode('13800138000', {
        fetchImpl: mockFetch as any,
        deviceId: 'test_dev_001',
      })

      expect(res.ok).toBe(true)
      expect(res.msgid).toBe('autoclaw-sms')
      expect(capturedUrl).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_SEND_CODE_PATH}`)
      expect(capturedInit?.method).toBe('POST')

      const headers = capturedInit?.headers as Record<string, string>
      expect(headers['X-Auth-Appid']).toBe(AUTOCLAW.appId)
      expect(headers['X-Auth-Sign']).toBeDefined()
      expect(headers['X-Lang']).toBe('zh-CN')

      const body = JSON.parse(String(capturedInit?.body))
      expect(body.phone).toBe('13800138000')
      expect(body.source_id).toBe('autoclaw')
      expect(body.device_id).toBe('test_dev_001')
    })

    it('sendAutoclawVerificationCode 上游返回业务错误时返回失败', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: 10002,
              msg: '验证码发送频繁，请稍后再试',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      )

      const res = await sendAutoclawVerificationCode('13800138000', { fetchImpl: mockFetch as any })
      expect(res.ok).toBe(false)
      expect(res.error).toBe('验证码发送频繁，请稍后再试')
    })

    it('loginAutoclawWithCode 参数不合法时校验拦截', async () => {
      const res1 = await loginAutoclawWithCode('13800', '123456')
      expect(res1.ok).toBe(false)
      expect(res1.error).toContain('手机号格式不正确')

      const res2 = await loginAutoclawWithCode('13800138000', '   ')
      expect(res2.ok).toBe(false)
      expect(res2.error).toContain('验证码不能为空')
    })

    it('loginAutoclawWithCode 成功兑换 AutoClaw 凭据并规范解析', async () => {
      let capturedUrl = ''
      let capturedInit: RequestInit | undefined
      const mockFetch = vi.fn().mockImplementation((url, init) => {
        capturedUrl = String(url)
        capturedInit = init
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: 0,
              msg: 'SUCCESS',
              data: {
                user_id: 'user_9988',
                user_name: 'AutoClawUser',
                user_phone: '13800138000',
                access_token: 'Bearer at_secret_token_123',
                refresh_token: 'rt_secret_token_456',
                expires_in: 86400,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      })

      const res = await loginAutoclawWithCode('13800138000', '654321', {
        fetchImpl: mockFetch as any,
        deviceId: 'test_dev_002',
      })

      expect(res.ok).toBe(true)
      expect(res.credential).toBeDefined()
      expect(capturedUrl).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_LOGIN_PATH}`)

      const cred = res.credential!
      expect(cred.access_token).toBe('at_secret_token_123') // 自动剥离 Bearer
      expect(cred.refresh_token).toBe('rt_secret_token_456')
      expect(cred.user_id).toBe('user_9988')
      expect(cred.user_name).toBe('AutoClawUser')
      expect(cred.user_phone).toBe('13800138000')
      expect(cred.device_id).toBe('test_dev_002')
      expect(cred.expires_at).toBeGreaterThan(Date.now())
    })

    it('loginAutoclawWithCode 验证码错误时返回错误信息', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: 10001,
              msg: '验证码错误或已过期',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      )

      const res = await loginAutoclawWithCode('13800138000', '000000', { fetchImpl: mockFetch as any })
      expect(res.ok).toBe(false)
      expect(res.error).toBe('验证码错误或已过期')
    })

    it('probeAutoclawLocalCredential 在不存在配置目录时安全返回 undefined', async () => {
      const cred = await probeAutoclawLocalCredential({
        customAppData: 'F:/non_existent_path_test',
      })
      expect(cred).toBeUndefined()
    })
  })
})
