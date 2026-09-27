/**
 * 只读探针：按 **Qoder 客户端自己的算法**解读排队错误，并给出我们的应对参数。
 *
 * ## 为什么需要它
 *
 * 用户报障两条真实错误（都是 HTTP 403 + 业务码 `10605`）：
 *
 * ```
 * 国际版: {"code":"10605","message":"{\"isQueued\":true,\"modelKey\":\"qfmodel\",
 *          \"queueCount\":0,\"queueType\":\"p3\",\"retryAfterSeconds\":30,
 *          \"serviceAvailable\":false,\"waitTime\":30}"}            ← 真排队 30s
 *
 * 中国版: {"code":"10605","message":"{\"isQueued\":false,\"modelKey\":\"qfmodel\",
 *          \"queueCount\":0,\"queueType\":\"p3\",\"retryAfterSeconds\":2,
 *          \"serviceAvailable\":true,\"waitTime\":0}"}             ← 瞬时，等 2s 即成功
 * ```
 *
 * ⚠️ 关键结构：`message` 是**一个 JSON 字符串**（不是对象），需要**二次解析**。
 * 客户端 `lFc()` 正是为此递归遍历 `data` / `result` / `message` / `body`，
 * 字符串则尝试 `JSON.parse`。我们此前的实现只读顶层 `code`，因此从未识别出排队。
 *
 * ## 客户端的权威算法（obf 产物取证）
 *
 * - 排队码：`mRA = "10605"` → 错误类 `"model_queued"`（`rJc()`）
 * - 认证码：`MF = "105"` → `"auth_error"`（**与排队分开**，`rJc()`）
 * - 延迟优先序（`kJa()` / `EV()` / `IRA()`）：
 *     `retry_after_ms` → `retryAfterMs` → `queue.retryAfterSeconds × 1000`
 *     → 兜底 `Retry-After` 响应头（`bnA()` → `bja()`：纯数字当**秒**，否则 HTTP 日期）
 * - 决策（`W7c()`）：**有 `retryAfterMs` 就精确等它**（`source:'retry-after'`）；
 *   否则退回退避 `500 × 2^(n-1)`、`maxBaseDelayMs=32`、抖动 1~1.25（`ltA()`）
 *
 * 用法：node scripts/probe-qoder-queue-error.mjs
 */

/** 客户端的 `RE()`：只接受有限数字，取整。 */
const toInt = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined)

/**
 * 复刻客户端 `lFc()`：递归展开 `data` / `result` / `message` / `body`，
 * 字符串字段尝试 `JSON.parse`。
 */
function collectNodes(root) {
  const seen = new Set()
  const out = []
  const queue = [root]
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === null || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    out.push(node)
    for (const key of ['data', 'result', 'message', 'body']) {
      const value = node[key]
      if (value !== null && typeof value === 'object') queue.push(value)
      else if (typeof value === 'string') {
        try { queue.push(JSON.parse(value)) } catch { /* 非 JSON，忽略 */ }
      }
    }
  }
  return out
}

/** 复刻客户端 `PJa()` / `dFc()`：取第一个含 `isQueued` 或 `serviceAvailable` 的节点。 */
function findQueueInfo(root) {
  for (const node of collectNodes(root)) {
    const isQueued = node.isQueued
    const serviceAvailable = node.serviceAvailable
    if (isQueued !== undefined || serviceAvailable !== undefined) return node
  }
  return undefined
}

/** 复刻客户端 `EV()`：取服务端指定延迟（毫秒）。 */
function retryAfterMsOf(node) {
  if (node === null || typeof node !== 'object') return undefined
  const direct = toInt(node.retry_after_ms) ?? toInt(node.retryAfterMs)
  if (direct !== undefined) return direct
  const seconds = toInt(node.retryAfterSeconds)
  return seconds === undefined ? undefined : 1000 * seconds
}

/** 复刻客户端 `W7c()`：给出重试决策。 */
function decideRetry(node, attempt) {
  const serverMs = retryAfterMsOf(node)
  if (serverMs !== undefined) {
    if (!Number.isFinite(serverMs) || serverMs < 0) return { type: 'fail' }
    return { type: 'retry', delayMs: Math.round(serverMs), source: 'retry-after' }
  }
  const backoff = Math.min(500 * 2 ** Math.max(0, attempt - 1), 32)
  return { type: 'retry', delayMs: backoff, source: 'backoff' }
}

const CASES = [
  {
    label: '国际版（用户报障 #1）',
    outer: {
      code: '10605',
      message: JSON.stringify({
        isQueued: true, modelKey: 'qfmodel', queueCount: 0, queueType: 'p3',
        retryAfterSeconds: 30, serviceAvailable: false, waitTime: 30,
      }),
    },
    userObserved: '5 次重试都没过 30 秒',
  },
  {
    label: '中国版（用户报障 #2）',
    outer: {
      code: '10605',
      message: JSON.stringify({
        isQueued: false, modelKey: 'qfmodel', queueCount: 0, queueType: 'p3',
        retryAfterSeconds: 2, serviceAvailable: true, waitTime: 0,
      }),
    },
    userObserved: '一次重试就能成功',
  },
]

for (const { label, outer, userObserved } of CASES) {
  console.log(`── ${label} ──`)
  console.log(`   用户观察: ${userObserved}`)
  const info = findQueueInfo(outer)
  console.log(`   解析出的排队节点: ${JSON.stringify(info)}`)
  if (info === undefined) { console.log('   ✗ 未解析出排队信息\n'); continue }
  const wait = decideRetry(info, 1)
  console.log(`   客户端决策: ${JSON.stringify(wait)}`)
  console.log(`   语义: isQueued=${info.isQueued}, serviceAvailable=${info.serviceAvailable}, waitTime=${info.waitTime}s`)
  if (info.isQueued === true && info.serviceAvailable === false) {
    console.log(`   ⇒ **真排队**：必须等满 ${wait.delayMs}ms（${wait.delayMs / 1000}s），`
      + '\n      期间**不应**刷新凭据（排队与认证无关），也不该消耗账号切换')
  } else if (info.isQueued === false && info.serviceAvailable === true) {
    console.log(`   ⇒ **瞬时排队**：服务可用、waitTime=0，只差短延迟 ${wait.delayMs}ms`
      + '\n      客户端一次重试即可成功（与用户观察一致）')
  }
  console.log('')
}

console.log('══ 我们当前实现的差距 ══')
console.log('  1. 只读顶层 code，**未二次解析 message 里的 JSON** → 从不识别 10605 排队')
console.log('  2. 403 一律当 AUTH：先 refresh() 再重试（对排队毫无意义，且多打一次 userinfo）')
console.log('  3. httpErrorCode(403) = AUTH 不在 DEFAULT_RETRYABLE_CODES')
console.log('     → harness 的 500/1000/2000/4000/8000（共 ~15.5s、5 次）与排队无关')
console.log('  4. 从不等待服务端给的 retryAfterSeconds（30s / 2s 都被忽略）')
console.log('')
console.log('══ 客户端权威参数（照抄即可）══')
console.log('  排队码 10605 → model_queued；认证码 105 → auth_error（互相独立）')
console.log('  延迟: retry_after_ms → retryAfterMs → retryAfterSeconds×1000 → Retry-After 头')
console.log('  有延迟就精确等，没有才退避（500×2^(n-1)，maxBase=32ms，抖动 1~1.25）')
