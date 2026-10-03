/**
 * Gemini 信封与档位的**字节级金标准**单测。
 *
 * ⚠️ 本文件的核心用例（353 字节那条）是**逐字节断言**，不是形状断言：
 * 上游对信封的字段顺序敏感（Go 侧 `marshalAlphabetical` 会把整棵树按键名
 * 排序后再发），TS 的 `JSON.stringify` 按**插入序**输出，两者不一致时请求
 * 仍能成功，但会偏离已抓包验证过的形态 —— 出问题时排查成本极高。
 *
 * 故：**不要**为了「看起来更整齐」调整本文件里的期望字符串。
 */
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  GEMINI_DEFAULT_PROJECT,
  GEMINI_EFFORT_IDS,
  GEMINI_FALLBACK_MODELS,
  GEMINI_SESSION_ID_INFER,
  geminiCanonicalModelId,
  geminiEffortLabel,
  geminiEffortToTier,
  geminiModelSpec,
  geminiReasoningInfo,
  geminiThinkingBudget,
  marshalAlphabetical,
  newGeminiRequestId,
  sanitizeGeminiSchema,
  sortedStringify,
} from '../../src/gemini.js'
import { translateGeminiRequest } from '../../src/gemini-messages.js'
import type { Message } from '@deepseek-ai/dsh-llm'

const msg = (role: 'user' | 'assistant', content: unknown[]): Message =>
  ({ role, content } as Message)

/** 最小请求：一条 user 文本。 */
function minimalEnvelope(effort: string, maxTokens: number) {
  return translateGeminiRequest({
    modelId: 'gemini-3.8-flash',
    spec: geminiModelSpec('gemini-3.8-flash', effort),
    messages: [msg('user', [{ type: 'text', text: 'reply one word: ok' }])],
    sessionId: GEMINI_SESSION_ID_INFER,
    requestId: 'agent/1790868102000/f37baaa0',
    maxTokens,
  })
}

describe('字母序序列化', () => {
  it('递归按键名升序（数组保序）', () => {
    const value = { b: 1, a: { d: 2, c: [ { z: 1, y: 2 } ] } }
    expect(sortedStringify(value)).toBe('{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}')
  })

  it('与 JSON.stringify 对纯标量一致', () => {
    expect(sortedStringify('x')).toBe('"x"')
    expect(sortedStringify(null)).toBe('null')
  })
})

describe('信封字节金标准（计划 §六）', () => {
  const GOLDEN =
    '{"model":"gemini-3.8-flash-high","project":"aicode-consumers","request":{"contents":[{"parts":[{"text":"reply one word: ok"}],"role":"user"}],"generationConfig":{"maxOutputTokens":50,"thinkingConfig":{"includeThoughts":true,"thinkingBudget":10000}},"sessionId":"3124275334370613369"},"requestId":"agent/1790868102000/f37baaa0","userAgent":"antigravity"}'

  it('high 档 + 50 输出预算 → 353 字节逐字一致', () => {
    const wire = marshalAlphabetical(minimalEnvelope('high', 50))
    expect(wire).toBe(GOLDEN)
    expect(Buffer.byteLength(wire, 'utf8')).toBe(353)
  })

  it('档位决定模型后缀与 thinkingBudget', () => {
    const high = minimalEnvelope('high', 50)
    expect(high.model).toBe('gemini-3.8-flash-high')
    expect(
      (high.request.generationConfig as { thinkingConfig: unknown }).thinkingConfig,
    ).toEqual({ includeThoughts: true, thinkingBudget: 10_000 })

    const low = minimalEnvelope('low', 50)
    expect(low.model).toBe('gemini-3.8-flash-low')
    expect(
      (low.request.generationConfig as { thinkingConfig: unknown }).thinkingConfig,
    ).toEqual({ includeThoughts: true, thinkingBudget: 1_000 })
  })

  it('tiered 档只带 includeThoughts（不发 thinkingBudget）', () => {
    const envelope = minimalEnvelope('tiered', 50)
    expect(envelope.model).toBe('gemini-3.8-flash-tiered')
    expect(
      (envelope.request.generationConfig as { thinkingConfig: unknown }).thinkingConfig,
    ).toEqual({ includeThoughts: true })
  })

  it('模型表只有 1 条（lite 已移除：上游恒 404，暴露即坑）', () => {
    expect(GEMINI_FALLBACK_MODELS.map((entry) => entry.id)).toEqual(['gemini-3.8-flash'])
    const only = GEMINI_FALLBACK_MODELS[0]!
    // 档位声明仍然齐备（中文名，用户拍板）。
    expect(geminiReasoningInfo(only)?.efforts?.map((e) => String(e.id))).toEqual([
      ...GEMINI_EFFORT_IDS,
    ])
  })

  it('project 默认 aicode-consumers，可覆盖', () => {
    expect(minimalEnvelope('medium', 50).project).toBe(GEMINI_DEFAULT_PROJECT)
    const custom = translateGeminiRequest({
      modelId: 'gemini-3.8-flash',
      spec: geminiModelSpec('gemini-3.8-flash', 'medium'),
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
      sessionId: GEMINI_SESSION_ID_INFER,
      requestId: 'agent/1/aaaaaaaa',
      project: 'other-project',
    })
    expect(custom.project).toBe('other-project')
  })

  it('requestId 每请求随机，形状为 agent/<ms>/<8hex>', () => {
    const id = newGeminiRequestId(1_790_868_102_000)
    expect(id).toMatch(/^agent\/1790868102000\/[0-9a-f]{8}$/)
    expect(newGeminiRequestId(1)).not.toBe(newGeminiRequestId(1))
  })

  it('userAgent 恒为 antigravity', () => {
    expect(minimalEnvelope('medium', 50).userAgent).toBe('antigravity')
  })
})

describe('档位映射', () => {
  it('四档 id 与中文名', () => {
    expect(GEMINI_EFFORT_IDS).toEqual(['low', 'medium', 'high', 'tiered'])
    expect(GEMINI_EFFORT_IDS.map(geminiEffortLabel)).toEqual(['低', '中', '高', '自适应'])
  })

  it('未知档位退化为 medium（不报错、不编造）', () => {
    expect(geminiEffortToTier(undefined)).toBe('medium')
    expect(geminiEffortToTier('xhigh')).toBe('medium')
    expect(geminiThinkingBudget('medium')).toBe(4_000)
  })

  it('主模型声明 4 档 efforts + defaultEffort=medium', () => {
    const flash = GEMINI_FALLBACK_MODELS.find((entry) => entry.id === 'gemini-3.8-flash')!
    const info = geminiReasoningInfo(flash)
    expect(info?.efforts.map((effort) => String(effort.id))).toEqual([
      'low', 'medium', 'high', 'tiered',
    ])
    expect(info?.efforts.map((effort) => effort.name)).toEqual(['低', '中', '高', '自适应'])
    expect(String(info?.defaultEffort)).toBe('medium')
  })
})

describe('模型 id 严格校验（未知 id 必须拒绝，不得静默落回 3.8）', () => {
  it('合法 id 的 upstream 带对应档位后缀', () => {
    expect(geminiModelSpec('gemini-3.8-flash', 'high').upstream).toBe('gemini-3.8-flash-high')
    expect(geminiModelSpec('gemini-3.8-flash', 'low').upstream).toBe('gemini-3.8-flash-low')
    // 缺省档位 = medium（同 geminiEffortToTier 默认分支）
    expect(geminiModelSpec('gemini-3.8-flash').upstream).toBe('gemini-3.8-flash-medium')
  })

  it('带档位的 3.8 名放行（限流标记 / account.test 探测传的就是它）', () => {
    // 归一化剥掉档位后缀后命中目录；upstream 仍由 effort 决定（缺省 medium）。
    expect(geminiModelSpec('gemini-3.8-flash-high').upstream).toBe('gemini-3.8-flash-medium')
    expect(geminiModelSpec('gemini-3.8-flash-tiered', 'high').upstream).toBe('gemini-3.8-flash-high')
  })

  it('未知 id 抛 INVALID_REQUEST（曾实测假名 200 静默跑 3.8）', () => {
    for (const bad of ['gemini-3.7-flash', 'gemini-3.7-flash-high', 'gemini-9.9-fake', 'totally-bogus', '']) {
      let thrown: unknown
      try {
        geminiModelSpec(bad)
      } catch (error) {
        thrown = error
      }
      expect(thrown, `id "${bad}" 应被拒绝`).toBeInstanceOf(LlmError)
      expect((thrown as LlmError).failure.code).toBe('INVALID_REQUEST')
      expect((thrown as LlmError).message).toContain(bad === '' ? '""' : bad)
      // ⚠️ 必须带 404：网关只读 `failure.status`（顶层没有 status），缺了它
      // 模型名写错会以 502 离开网关并被 OpenAI 客户端反复重试（白耗额度）。
      expect((thrown as LlmError).failure.status).toBe(404)
    }
  })

  it('geminiCanonicalModelId：只剥已知档位后缀，不误伤其他名字', () => {
    expect(geminiCanonicalModelId('gemini-3.8-flash-high')).toBe('gemini-3.8-flash')
    expect(geminiCanonicalModelId('gemini-3.8-flash-tiered')).toBe('gemini-3.8-flash')
    expect(geminiCanonicalModelId('gemini-3.8-flash')).toBe('gemini-3.8-flash')
    // 非档位后缀不动
    expect(geminiCanonicalModelId('gemini-3.7-flash')).toBe('gemini-3.7-flash')
    expect(geminiCanonicalModelId('totally-bogus')).toBe('totally-bogus')
  })
})

describe('schema 清洗（白名单）', () => {
  it('删掉白名单外的键，保留白名单内的', () => {
    const cleaned = sanitizeGeminiSchema({
      type: 'object',
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '文件路径', examples: ['a.go'] },
      },
      required: ['path'],
    })
    expect(cleaned).toEqual({
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    })
  })

  it('type 为数组时收敛成单值 + nullable', () => {
    expect(sanitizeGeminiSchema({ type: ['string', 'null'] })).toEqual({
      type: 'string',
      nullable: true,
    })
  })

  it('enum 含非字符串值时整删', () => {
    expect(sanitizeGeminiSchema({ type: 'string', enum: ['a', 1] })).toEqual({ type: 'string' })
    expect(sanitizeGeminiSchema({ type: 'string', enum: ['a', 'b'] })).toEqual({
      type: 'string',
      enum: ['a', 'b'],
    })
  })

  it('递归清洗 properties / items / anyOf', () => {
    const cleaned = sanitizeGeminiSchema({
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { type: 'string', $comment: 'drop me' },
        },
      },
      anyOf: [{ type: 'number', exclusiveMinimum: 0 }],
    })
    expect(cleaned).toEqual({
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'string' } } },
      anyOf: [{ type: 'number' }],
    })
  })
})
