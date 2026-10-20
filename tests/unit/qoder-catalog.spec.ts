import { describe, expect, it, vi } from 'vitest'
import {
  QODER_CATALOG_SCENE,
  QODER_MODEL_LIST_PATH,
  fetchQoderRemoteModels,
  parseQoderRemoteModels,
  qoderRemoteModelToFallback,
} from '../../src/qoder-catalog.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/qoder.js'

const cred: QoderCredential = buildQoderCredential(
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
  { machineId: 'm-1' },
)

/**
 * 一段 `chat` 场景的远端条目 —— 字段名与取值**逐项照抄 2026-10-20 真机响应**
 * （CN `gateway.qoder.com.cn`，真实凭据）。
 */
const REMOTE_DFMODEL = {
  key: 'dfmodel',
  format: 'openai',
  source: 'system',
  enable: true,
  display_name: 'DeepSeek-Flash',
  is_vl: true,
  is_reasoning: false,
  is_new: true,
  price_factor: 0,
  original_price_factor: 0.1,
  max_input_tokens: 180000,
  is_free: true,
  is_editable: true,
  context_config: {
    '1M': { token_count: 1000000 },
    '200K': { token_count: 200000, is_default: true },
    '400K': { token_count: 400000 },
  },
  thinking_config: {
    disabled: { description: 'Disable thinking' },
    enabled: {
      description: 'Enable thinking',
      efforts: { high: { description: 'High thinking intensity' }, max: { is_default: true }, low: {} },
      is_default: true,
    },
  },
}

const REMOTE_MMODEL = {
  key: 'mmodel',
  enable: true,
  display_name: 'MiniMax-M3.1-Flash',
  is_vl: true,
  is_reasoning: false,
  price_factor: 0.1,
  context_config: { '200K': { token_count: 200000, is_default: true } },
}

describe('parseQoderRemoteModels', () => {
  it('把远端条目转成兜底表同形（价格/免费/上下文按档位表最大档）', () => {
    const models = parseQoderRemoteModels({ chat: [REMOTE_DFMODEL, REMOTE_MMODEL] })
    expect(models?.map((m) => m.id)).toEqual(['dfmodel', 'mmodel'])
    const df = models![0]!
    expect(df.name).toBe('DeepSeek-Flash')
    expect(df.priceFactor).toBe(0)
    expect(df.originalPriceFactor).toBe(0.1)
    expect(df.isFree).toBe(true)
    expect(df.supportsImage).toBe(true)
    expect(df.supportsThinking).toBe(false)
    expect(df.contextWindow).toBe(1_000_000)
    expect(models![1]!.contextWindow).toBe(200_000)
  })

  it('⚠️ price_factor = 0 是**合法值**（免费），不能当缺失丢掉', () => {
    const model = qoderRemoteModelToFallback(REMOTE_DFMODEL)
    expect(model?.priceFactor).toBe(0)
    expect(Object.hasOwn(model!, 'priceFactor')).toBe(true)
  })

  it('档位保持上游键序、按白名单过滤、别名归一，且默认档取 is_default', () => {
    const model = qoderRemoteModelToFallback({
      ...REMOTE_DFMODEL,
      thinking_config: {
        disabled: {},
        enabled: {
          efforts: {
            // 白名单外的键必须被丢掉（客户端 `ao()` 也丢），否则 DSH 会渲染出
            // 一个上游不认的档位。
            bogus: {},
            max: { is_default: true },
            off: {},
            xhigh: {},
          },
        },
      },
    })
    expect(model?.efforts).toEqual(['max', 'none', 'xhigh'])
    expect(model?.defaultEffort).toBe('max')
    expect(model?.supportsDisable).toBe(true)
  })

  it('只有 disabled、无 efforts ⇒ 只有「关闭思考」（supportsDisable 与 efforts 相互独立）', () => {
    const model = qoderRemoteModelToFallback({
      key: 'qmodel', display_name: 'Qwen3.7-Plus',
      thinking_config: { disabled: {}, enabled: { is_default: true } },
    })
    expect(model?.efforts).toBeUndefined()
    expect(model?.supportsDisable).toBe(true)
  })

  it('错峰折扣映射为 QoderModelPromotion（窗口 + 折扣 + 角标）', () => {
    const model = qoderRemoteModelToFallback({
      key: 'qmodel_38max', display_name: 'Qwen3.8-Max', price_factor: 0.5,
      promotion: {
        active: false,
        discount_factor: 0.4,
        before_promotion_price_factor: 0.5,
        window_start: '22:00',
        window_end: '08:00',
        badge: { zh: '错峰 4 折' },
      },
    })
    expect(model?.promotion).toEqual({
      active: false,
      discountFactor: 0.4,
      beforePromotionPriceFactor: 0.5,
      windowStart: '22:00',
      windowEnd: '08:00',
      badgeZh: '错峰 4 折',
    })
  })

  it('丢掉 enable:false 与形状不符的条目，并按 id 去重', () => {
    const models = parseQoderRemoteModels({
      chat: [
        { ...REMOTE_MMODEL, enable: false },
        { key: 'x' },                        // 缺 display_name
        { display_name: '无 key' },          // 缺 key
        'not-an-object',
        REMOTE_MMODEL,
        REMOTE_MMODEL,                       // 重复 id ⇒ DSH 会抛 INVALID_CATALOG
      ],
    })
    expect(models?.map((m) => m.id)).toEqual(['mmodel'])
  })

  it('响应形状不符返回 undefined（与「空列表」严格区分）', () => {
    expect(parseQoderRemoteModels(null)).toBeUndefined()
    expect(parseQoderRemoteModels([])).toBeUndefined()
    expect(parseQoderRemoteModels({ developer: [] })).toBeUndefined()
    expect(parseQoderRemoteModels({ chat: [] })).toEqual([])
  })

  it('场景键可覆盖（默认 chat）', () => {
    expect(QODER_CATALOG_SCENE).toBe('chat')
    expect(parseQoderRemoteModels({ qwork: [REMOTE_MMODEL] }, 'qwork')?.length).toBe(1)
  })

  it('⚠️ 没有档位表也没有 available_context_windows ⇒ 窗口报 0（= 不声明，不编造）', () => {
    const model = qoderRemoteModelToFallback({ key: 'k', display_name: 'K', max_input_tokens: 180000 })
    expect(model?.contextWindow).toBe(0)
  })
})

describe('fetchQoderRemoteModels', () => {
  it('走 WASM 签名（COSY）+ `/api/v2/model/list?Encode=1`，明文响应也能解析', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ chat: [REMOTE_DFMODEL, REMOTE_MMODEL] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const models = await fetchQoderRemoteModels(cred, QODER, { fetcher: fetchImpl as never })
    expect(models.map((m) => m.id)).toEqual(['dfmodel', 'mmodel'])

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain(QODER_MODEL_LIST_PATH)
    expect(url.startsWith(QODER.encryptedInferBase)).toBe(true)
    // ⚠️ 必须是 WASM 生成的 COSY 签名，不是普通 Bearer <token>（后者会被拒）。
    const headers = init.headers as Record<string, string>
    expect(String(headers.Authorization)).toMatch(/^Bearer COSY\./)
  })

  it('CN 走它自己的 host（两站共用同一实现，差异只在产品配置）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ chat: [REMOTE_MMODEL] }), { status: 200 }))
    await fetchQoderRemoteModels(cred, QODER_CN, { fetcher: fetchImpl as never })
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url.startsWith(QODER_CN.encryptedInferBase)).toBe(true)
  })

  it('非 2xx 抛错并**带上响应体片段**（401/403 分不开 token 过期与签名无效）', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(
      JSON.stringify({ code: '105', message: 'Login expired' }), { status: 403 },
    )
    await expect(fetchQoderRemoteModels(cred, QODER, { fetcher: fetchImpl as never }))
      .rejects.toThrow(/HTTP 403.*Login expired/)
  })

  it('空列表抛错（调用方据此回退兜底表，而不是把菜单变空）', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ chat: [] }), { status: 200 })
    await expect(fetchQoderRemoteModels(cred, QODER, { fetcher: fetchImpl as never }))
      .rejects.toThrow(/为空/)
  })

  it('响应不是 JSON 时抛错，不静默返回空目录', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('<html>502</html>', { status: 200 })
    await expect(fetchQoderRemoteModels(cred, QODER, { fetcher: fetchImpl as never })).rejects.toThrow()
  })

  it('⚠️ 凭据缺 uid / machine_id ⇒ 直接抛错，不发一次注定失败的请求', async () => {
    const fetchImpl = vi.fn()
    const noUid = { ...cred, uid: undefined }
    await expect(fetchQoderRemoteModels(noUid, QODER, { fetcher: fetchImpl as never }))
      .rejects.toThrow(/uid/)
    expect(fetchImpl).not.toHaveBeenCalled()

    const noMachine = { ...cred, machine_id: '' }
    await expect(fetchQoderRemoteModels(noMachine, QODER, { fetcher: fetchImpl as never }))
      .rejects.toThrow(/machine_id/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
