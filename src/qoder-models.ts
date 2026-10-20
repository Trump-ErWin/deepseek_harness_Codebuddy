/** Qoder 两站共用的签名目录请求与解析；目录仅交给适配器保存在内存中。 */
import { decryptQoderServerResponse, QoderEncryptedInfer } from './qoder-wasm.js'
import { qoderBearerToken, type QoderCredential } from './qoder.js'
import type { QoderFallbackModel, QoderProduct } from './qoder-product.js'

/** 只接受有限非负数，兼容上游把数值编码成字符串。 */
function numberOf(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return undefined
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : undefined
}

/** 对象字段的最小形状检查。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** 仅使用官方 chat 场景，不混入补全、内部 agent 或用户自定义服务。 */
export function parseQoderModels(body: unknown, product: QoderProduct): QoderFallbackModel[] {
  const chat = recordOf(body)?.chat
  if (!Array.isArray(chat)) throw new Error(`${product.id}: 模型目录缺少 chat 场景`)
  const fallback = new Map(product.fallbackModels.map((model) => [model.id, model]))
  const seen = new Set<string>()
  const result: QoderFallbackModel[] = []
  for (const raw of chat) {
    const entry = recordOf(raw)
    if (!entry || entry.enable === false || entry.enable === 0 || entry.source === 'custom') continue
    const id = typeof entry.key === 'string' ? entry.key.trim() : ''
    const name = typeof entry.display_name === 'string' ? entry.display_name.trim() : ''
    if (!id || !name || seen.has(id)) continue
    if (entry.format !== undefined && entry.format !== 'openai') continue
    const known = fallback.get(id)
    const contextConfig = recordOf(entry.context_config)
    // 上下文用档位表最大值；max_input_tokens 只是默认档位的输入预算。
    const windows = Object.values(contextConfig ?? {}).map((value) => numberOf(recordOf(value)?.token_count) ?? 0)
    const contextWindow = Math.max(0, ...windows) || numberOf(entry.max_input_tokens) || known?.contextWindow || 0
    const thinking = recordOf(entry.thinking_config)
    const enabled = recordOf(thinking?.enabled)
    const efforts = recordOf(enabled?.efforts)
    // 档位原样保留上游键序，默认档独立取 is_default，不按数组位置猜测。
    const defaultEffort = efforts === undefined ? undefined
      : Object.keys(efforts).find((key) => recordOf(efforts[key])?.is_default === true)
    const priceFactor = numberOf(entry.priceFactor ?? entry.price_factor)
    const originalPriceFactor = numberOf(entry.originPriceFactor ?? entry.original_price_factor)
    const free = entry.isFree ?? entry.is_free
    const promotion = recordOf(entry.promotion)
    const before = numberOf(promotion?.before_promotion_price_factor)
    const discount = numberOf(promotion?.discount_factor)
    seen.add(id)
    result.push({
      id, name, contextWindow,
      supportsImage: typeof entry.is_vl === 'boolean' ? entry.is_vl : known?.supportsImage,
      supportsThinking: typeof entry.is_reasoning === 'boolean' ? entry.is_reasoning : known?.supportsThinking,
      ...(priceFactor === undefined ? {} : { priceFactor }),
      ...(originalPriceFactor === undefined ? {} : { originalPriceFactor }),
      ...(typeof free === 'boolean' ? { isFree: free } : {}),
      ...(thinking === undefined
        ? { efforts: known?.efforts, defaultEffort: known?.defaultEffort, supportsDisable: known?.supportsDisable }
        : { efforts: Object.keys(efforts ?? {}), defaultEffort, supportsDisable: recordOf(thinking.disabled) !== undefined }),
      ...(promotion === undefined ? {} : {
        promotion: {
          active: promotion.active === true,
          ...(before === undefined ? {} : { beforePromotionPriceFactor: before }),
          ...(discount === undefined ? {} : { discountFactor: discount }),
          ...(typeof promotion.window_start === 'string' ? { windowStart: promotion.window_start } : {}),
          ...(typeof promotion.window_end === 'string' ? { windowEnd: promotion.window_end } : {}),
        },
      }),
    })
  }
  // 空/异常响应不得替换已成功取得的内存目录，也不得被永久缓存成兜底表。
  if (result.length === 0) throw new Error(`${product.id}: 上游没有返回可用的 chat 模型`)
  return result
}

/** 按产品域名签名；请求头必须原样透传，不得用普通 Bearer 覆盖 COSY 签名。 */
export async function fetchQoderModels(
  credential: QoderCredential,
  product: QoderProduct,
  fetcher: typeof fetch,
): Promise<QoderFallbackModel[]> {
  const client = await QoderEncryptedInfer.create({
    user: { uid: credential.uid!, securityOauthToken: qoderBearerToken(credential) },
    machineId: credential.machine_id!, metadata: { ...product.clientMetadata }, host: product.encryptedInferBase,
  })
  try {
    // prepareRequest 会补 /algo 前缀，沿用官方目录的 Encode=1 编解码协议。
    const request = client.prepareRequest(product.encryptedInferBase, '/api/v2/model/list?Encode=1', 'GET', 'auth')
    const response = await fetcher(request.url, {
      method: 'GET', headers: request.headers, signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`${product.id}: 模型目录请求失败 HTTP ${response.status}`)
    return parseQoderModels(JSON.parse(await decryptQoderServerResponse(await response.text())), product)
  } finally {
    client.dispose()
  }
}
