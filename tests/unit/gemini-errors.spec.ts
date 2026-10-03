/**
 * Gemini 适配器的**错误归类**单测。
 *
 * ## 守的是什么
 *
 * `classifyFailure` 是用户唯一能看到的「为什么失败」。归类错的后果不是
 * 文案不好看，而是**把用户引向无效的补救动作**：
 *
 * | 上游 | 归类 | 若归错 |
 * |---|---|---|
 * | 403 / 404 | `SERVER` | 归 AUTH → 用户去点「重新登录」，白折腾 |
 * | 429 | `RATE_LIMIT` | 归 SERVER → harness 不退避，疯狂重试 |
 * | 400 + quota 文案 | `QUOTA_EXCEEDED` | 归 INVALID_REQUEST → 用户以为自己的请求有问题 |
 * | 401 | `AUTH` | 归 SERVER → 用户不知道要重新登录 |
 *
 * ⚠️ `QUOTA_EXCEEDED` **刻意不在** `DEFAULT_RETRYABLE_CODES` 里（计划 §3.1）：
 * 额度耗尽时重试没有意义，只会刷屏。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { GeminiAdapter, isGeminiSignatureError } from '../../src/gemini-adapter.js'
import { GEMINI, type GeminiCredential } from '../../src/gemini.js'

function options(): GenerateOptions {
  return {
    provider: GEMINI.id,
    model: 'gemini-3.8-flash',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  }
}

function adapter(): GeminiAdapter {
  const credential: GeminiCredential = {
    access_token: 'AT',
    refresh_token: 'RT',
    expiry: '2099-01-01T00:00:00Z',
  }
  return new GeminiAdapter({
    credentialRef: credentialRef('GEMINI_ACCOUNT_TEST'),
    resolveCredential: async () => credential,
    refresh: async () => {},
    product: GEMINI,
  })
}

/** 让上游恒返回同一个失败响应，返回最终抛出的错误。 */
async function failureOf(
  status: number,
  body: string,
): Promise<{ code?: string; message: string; failure?: { status?: number } }> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
  try {
    for await (const _chunk of adapter().stream(options())) void _chunk
    throw new Error('预期抛错但没有')
  } catch (error) {
    return error as { code?: string; message: string; failure?: { status?: number } }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isGeminiSignatureError', () => {
  it('含 signature 即判定（大小写无关）', () => {
    expect(isGeminiSignatureError('Invalid Signature')).toBe(true)
    expect(isGeminiSignatureError('thought_signature is required')).toBe(true)
    expect(isGeminiSignatureError('SIGNATURE_MISMATCH')).toBe(true)
  })

  it('thought + invalid 同时出现也判定（上游文案不统一时的兜底）', () => {
    expect(isGeminiSignatureError('the thought block is invalid')).toBe(true)
  })

  it('普通 400 不误判（误判只会白试一次，但也不该到处触发）', () => {
    expect(isGeminiSignatureError('invalid request')).toBe(false)
    expect(isGeminiSignatureError('model not found')).toBe(false)
    expect(isGeminiSignatureError('')).toBe(false)
  })
})

describe('classifyFailure 归类（经由 stream 端到端验证）', () => {
  it('403 → SERVER（不是 AUTH：重新登录救不了权限问题）', async () => {
    const error = await failureOf(403, 'permission denied')
    expect(error.code).toBe('SERVER')
    expect(error.failure?.status).toBe(403)
    expect(error.message).toMatch(/HTTP 403/)
  })

  it('404 → SERVER（模型名是准入钥匙，404 意味着名字不对）', async () => {
    const error = await failureOf(404, 'not found')
    expect(error.code).toBe('SERVER')
    expect(error.failure?.status).toBe(404)
  })

  it('429 → RATE_LIMIT', async () => {
    const error = await failureOf(429, 'rate limited')
    expect(error.code).toBe('RATE_LIMIT')
  })

  it('401 → AUTH', async () => {
    const error = await failureOf(401, 'unauthorized')
    expect(error.code).toBe('AUTH')
  })

  it('400 + quota 文案 → QUOTA_EXCEEDED', async () => {
    const error = await failureOf(400, 'RESOURCE_EXHAUSTED: quota exceeded')
    expect(error.code).toBe('QUOTA_EXCEEDED')
  })

  it('400 普通请求错误 → INVALID_REQUEST（不透传成配额问题）', async () => {
    const error = await failureOf(400, 'invalid argument: temperature out of range')
    expect(error.code).toBe('INVALID_REQUEST')
  })

  it('5xx → SERVER（交给 harness 退避）', async () => {
    const error = await failureOf(503, 'upstream unavailable')
    expect(error.code).toBe('SERVER')
    expect(error.failure?.status).toBe(503)
  })

  it('错误正文被截断到 500 字（避免把整页 HTML 灌进 UI）', async () => {
    const error = await failureOf(500, 'x'.repeat(2_000))
    expect(error.message.length).toBeLessThan(600)
    expect(error.message).toMatch(/HTTP 500/)
  })

  it('空正文只显示状态码，不留一个空破折号', async () => {
    const error = await failureOf(500, '')
    expect(error.message).toBe('gemini: HTTP 500')
  })
})
