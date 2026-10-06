/**
 * ZCode **冷启动首轮切号空转**的回归测试（真实缺陷，2026-10-06）。
 *
 * ## 用户报障
 *
 * > 用完余额一个号就自动卡死了，不会切下一个号。
 *
 * ## 根因（在役代码实测）
 *
 * `zcode-adapter.ts` 的 `streamScoped()` 里，**账号 id 的读取排在凭据解析之前**：
 *
 * ```ts
 * let activeAccountId = this.options.currentAccountId?.()   // ← 先读
 * let credential = await this.resolveCredentialOrThrow(options)  // ← 后解析
 * ```
 *
 * 而 `currentAccountId()` 读的是 `index.ts` 里 `activeZcodeAccountId` 那个 Map ——
 * 它**只在 `resolveCredential` 内部被写入**。进程刚启动（或该 provider 首次被调用）时
 * Map 是空的 ⇒ `activeAccountId === undefined`。
 *
 * 于是 `switchAccountOnQuota()` 里那个守卫：
 *
 * ```ts
 * if (activeAccountId !== undefined && activeAccountId.length > 0) {
 *   await pool.updateModelRateLimit(activeAccountId, ...)
 *   tried.add(activeAccountId)          // ← 只有进了这里才排除刚失败的账号
 * }
 * const next = await pool.getAvailableAccount(this.product.id, options.model, tried)
 * ```
 *
 * **既不标记、也不把刚失败的账号放进 `tried`** ⇒ 池按「用户手动顺序」返回的
 * **第一个候选正是刚刚失败的那个**（它的冷却标记从未被写下）⇒ 这次「切号」
 * 切到的是**同一个账号、同一份凭据**，白发一次请求。
 *
 * 受 `ZCODE.quotaSwitchMax === 2` 限制，一次用户请求最多发 3 发 ——
 * 其中**第一发切号纯属空转**，真正换到新账号要等到第二轮。
 * 症状正是用户说的「卡死，不切下一个号」。
 *
 * ## 本文件锁住什么
 *
 * **「额度用尽后的第一次切号，就必须落到一个与失败账号不同的账号上」**。
 *
 * ⚠ 既有用例全都传 `currentAccountId: () => 'acct-A'`（常量）⇒ 天然绕过了这个缺陷；
 * 本文件用**忠实复刻 `index.ts` 接线**的桩（`resolveCredential` 写入、`currentAccountId` 读取）
 * 才暴露得出来。这也是它值得单独成文件的原因。
 *
 * ⚠ 反向验证：把 `activeAccountId` 的读取挪回 `resolveCredential` **之前** ⇒
 * 第 1 条变红（`calls()` 从 2 变成 3、`auths[1]` 变成 `jwt-A`）。
 */
import { describe, expect, it } from 'vitest'

import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { ModelGate } from '../../src/model-gate.js'
import { ZCODE } from '../../src/zcode-product.js'

/* ────────────────────────── 桩 ────────────────────────── */

/** 上游业务错误（HTTP 状态 + 业务码正文）。 */
function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 一个能正常结束的 Anthropic SSE 响应。 */
function okSse(): Response {
  const text = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant"}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    '',
  ].join('\n\n')
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/**
 * **忠实复刻真实 `AccountPool` 语义**的桩：
 *
 * - 候选顺序 = 数组顺序（用户手动顺序，见 `account-pool.ts` 的 `getAvailableAccount`）
 * - `tried` 里的账号**必须被排除**（这正是「排除不生效 ⇒ 原地打转」的那条）
 *
 * ⚠ 不能用 `zcode-throttle.spec.ts` 里那个 `stubPool` —— 它忽略 `tried`、
 * 恒返回 `options.next`，会把本缺陷**掩盖**成「切号成功」。
 */
function orderedPool(
  accounts: Array<{ id: string; credential: Record<string, unknown> }>,
  marks: Array<{ accountId: string; modelId: string; resetAtMs: number }>,
  triedSeen: Array<ReadonlySet<string>>,
): unknown {
  return {
    updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
      marks.push({ accountId, modelId, resetAtMs })
    },
    getAvailableAccount: async (
      _provider: string,
      _modelId: string,
      tried?: ReadonlySet<string>,
    ) => {
      if (tried !== undefined) triedSeen.push(tried)
      const hit = accounts.find((a) => tried === undefined || !tried.has(a.id))
      if (hit === undefined) return null
      return { entry: { id: hit.id }, credential: hit.credential }
    },
  }
}

/** 一轮最小可用的 `stream()` 参数。 */
function streamOptions(): never {
  return {
    provider: 'zcode',
    model: 'GLM-5.3-Flash',
    messages: [{ role: 'user', content: 'hi' }],
  } as never
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of iterable) out.push(item)
  return out
}

/**
 * 按**真实接线**构造适配器：
 *
 * - `resolveCredential` 返回凭据，并把「实际给了哪个账号」写进 `active`
 *   （对应 `index.ts` 的 `activeZcodeAccountId.set(...)`）
 * - `currentAccountId` 只**读**那个记录（对应 `() => activeZcodeAccountId.get(ZCODE.id)`）
 *
 * ⇒ 冷启动时 `active` 还是 `undefined`，缺陷才复现得出来。
 */
function makeWiredAdapter(options: {
  pool: unknown
  accounts: string[]
  fetchImpl: (call: number) => Promise<Response>
}): { adapter: ZcodeAdapter; calls: () => number; auths: string[] } {
  let active: string | undefined
  let call = 0
  const auths: string[] = []
  const adapter = new ZcodeAdapter({
    credentialRef: 'R' as never,
    resolveCredential: async () => {
      // 真实池会按顺序挑第一个可用账号；这里依次给出 accounts[0]、accounts[1]…
      const pick = options.accounts[Math.min(call, options.accounts.length - 1)] ?? 'acct-A'
      active = pick
      return { zcode_jwt: `jwt-${pick.slice(-1).toUpperCase()}`, device_mid: `mid-${pick}` }
    },
    refresh: async () => {},
    mintCaptcha: async () => 'param',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      call += 1
      const headers = (init.headers ?? {}) as Record<string, string>
      auths.push(headers['Authorization'] ?? '')
      return await options.fetchImpl(call)
    }) as never,
    gate: new ModelGate({ sleep: async () => {} }),
    sleep: async () => {},
    product: ZCODE,
    accountPool: options.pool as never,
    // ★ 只读，与 `index.ts` 的接线逐字同形。
    currentAccountId: () => active,
  })
  return { adapter, calls: () => call, auths }
}

/* ────────────────────── 一、冷启动首轮切号 ────────────────────── */

describe('ZCode 冷启动首轮切号（activeAccountId 尚未记录）', () => {
  it('★ 首次切号就必须落到**不同**账号（不得原地空转一发）', async () => {
    const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const triedSeen: Array<ReadonlySet<string>> = []
    const pool = orderedPool(
      [
        { id: 'acct-A', credential: { zcode_jwt: 'jwt-A', device_mid: 'mid-A' } },
        { id: 'acct-B', credential: { zcode_jwt: 'jwt-B', device_mid: 'mid-B' } },
      ],
      marks,
      triedSeen,
    )
    const { adapter, calls, auths } = makeWiredAdapter({
      pool,
      accounts: ['acct-A', 'acct-B'],
      fetchImpl: async (call) =>
        call === 1 ? errorResponse(429, { code: 1005, msg: 'exceed quota limit' }) : okSse(),
    })

    const chunks = await drain(adapter.stream(streamOptions()))
    expect(chunks.length).toBeGreaterThan(0)

    /**
     * ★ 核心断言：**只发 2 发**。
     *
     * 第 1 发撞额度用尽 ⇒ 第 2 发就该用**新账号**的凭据。
     * 修复前这里是 3 发：第 1 发失败 → 「切号」切回 acct-A → 第 2 发同样失败
     * → 才真正换到 acct-B → 第 3 发成功。
     */
    expect(calls()).toBe(2)
    expect(auths[0]).toContain('jwt-A')
    expect(auths[1]).toContain('jwt-B')

    // 取号时**第一次**就必须把失败账号排除掉。
    expect(triedSeen.length).toBeGreaterThan(0)
    expect(triedSeen[0]?.has('acct-A')).toBe(true)

    // 失败账号仍要被标记（当日 UTC+8 24:00 前不再选它）。
    expect(marks).toHaveLength(1)
    expect(marks[0]?.accountId).toBe('acct-A')
    expect(marks[0]?.modelId).toBe('GLM-5.3-Flash')
  })

  it('★ 冷启动 + 池里只有一个账号：如实报错，不空转', async () => {
    const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const triedSeen: Array<ReadonlySet<string>> = []
    const pool = orderedPool(
      [{ id: 'acct-A', credential: { zcode_jwt: 'jwt-A', device_mid: 'mid-A' } }],
      marks,
      triedSeen,
    )
    const { adapter, calls } = makeWiredAdapter({
      pool,
      accounts: ['acct-A'],
      fetchImpl: async () => errorResponse(429, { code: 1005, msg: 'exceed quota limit' }),
    })

    await expect(drain(adapter.stream(streamOptions()))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    })
    // 只有一发：没有别的账号可切，不白转。
    expect(calls()).toBe(1)
    expect(marks).toHaveLength(1)
  })
})
