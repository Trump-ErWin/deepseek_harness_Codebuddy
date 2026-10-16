/**
 * 余额读数共享缓存（`src/balance-cache.ts`）的回归。
 *
 * 规格：`docs/superpowers/specs/2026-10-15-aggregate-gating-manual-order-design.md` §5.7
 *
 * ⚠️ 本文件的判据都打在**行为**上（调用次数、顺序、TTL 边界），而不是断言内部字段 ——
 *    内部结构（`TtlCache` 实例、槽）是实现细节，锁死它们会让重构变成假失败。
 */
import { describe, expect, it } from 'vitest'
import { createBalanceCache, type BalanceReading } from '../../src/balance-cache.js'

/** 造一个可控时钟 + 可数调用次数的世界。 */
function makeWorld(options: {
  ttlMs?: number
  failureTtlMs?: number
  fetch?: (provider: string, entry: { id: string }) => Promise<unknown>
  isAbort?: (error: unknown) => boolean
} = {}) {
  let clock = 1_000_000
  const calls: string[] = []
  const cache = createBalanceCache({
    ttlMs: options.ttlMs ?? 120_000,
    ...options.failureTtlMs === undefined ? {} : { failureTtlMs: options.failureTtlMs },
    ...options.isAbort === undefined ? {} : { isAbort: options.isAbort },
    now: () => clock,
    fetch: options.fetch ?? (async (provider: string, entry: { id: string }) => {
      calls.push(`${provider}:${entry.id}`)
      return { provider, id: entry.id, balance: 42 }
    }),
  })
  return {
    cache,
    calls,
    advance: (ms: number) => { clock += ms },
    now: () => clock,
  }
}

const acct = (id: string) => ({ id })

describe('createBalanceCache：TTL 命中与回源', () => {
  it('★ 同一账号 TTL 内只回源一次（第二次 read 不调 fetch）', async () => {
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('buddy', [acct('a1')])
    expect(calls).toEqual(['buddy:a1'])
  })

  it('★ TTL 过后必须重新取数（不得永久钉住）', async () => {
    const { cache, calls, advance } = makeWorld({ ttlMs: 120_000 })
    await cache.read('buddy', [acct('a1')])
    advance(119_999)
    await cache.read('buddy', [acct('a1')])
    expect(calls, 'TTL 内仍是 1 次').toHaveLength(1)
    advance(2)
    await cache.read('buddy', [acct('a1')])
    expect(calls, '★ 超过 TTL 必须重取').toHaveLength(2)
  })

  it('★ 不同渠道的同名 accountId 是**两条**缓存（键必须含 provider）', async () => {
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('workbuddy', [acct('a1')])
    expect(calls).toEqual(['buddy:a1', 'workbuddy:a1'])
  })

  it('★ force: true 绕过缓存（面板「刷新」的语义）', async () => {
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('buddy', [acct('a1')], { force: true })
    expect(calls, '★ 显式刷新必须真重查').toHaveLength(2)
  })

  it('★★ force 只影响**这一次**读取，**不作废**其它消费者的读数', async () => {
    // ⚠️⚠️ 这条锁的是本模块的**核心价值**（用户 2026-10-15 的更正）：积分面板
    //    「刷新」不该顺手把用量徽标正在用的读数也作废 —— 两者**共享**这份缓存。
    //    若实现把 force 写成 `clear()` + `get()`（一个很自然的错误走法），
    //    那么「面板点刷新 ⇒ 徽标下一轮也重查」⇒ 上游请求量翻倍。
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('buddy', [acct('a1')], { force: true })
    expect(calls).toHaveLength(2)   // 本次确实重查了
    // ★ 但缓存里已是**新的**读数 ⇒ 紧接着的普通读取必须命中它（不再回源）。
    await cache.read('buddy', [acct('a1')])
    expect(calls, '★ force 不得把缓存清成空的（否则每个消费者都要重查）').toHaveLength(2)
  })

  it('★ 只读本次传入的账号（取舍在调用方，不在缓存）', async () => {
    const { cache, calls } = makeWorld()
    const all = [acct('a1'), acct('a2')]
    await cache.read('buddy', all)
    // 徽标只要启用账号：只传 a1 ⇒ 不得因为 a2 在别处被读过就把它带回来。
    const only1 = await cache.read('buddy', [acct('a1')])
    expect([...only1.keys()]).toEqual(['a1'])
    expect(calls).toEqual(['buddy:a1', 'buddy:a2'])
  })

  it('★ 畸形条目（缺 id）被跳过，不让整次读取失败', async () => {
    const { cache } = makeWorld()
    const result = await cache.read('buddy', [acct('a1'), { id: undefined } as never, null as never])
    expect([...result.keys()]).toEqual(['a1'])
  })
})

describe('createBalanceCache：失败读数（值而非抛错）', () => {
  const failing = () => {
    let fail = true
    const world = makeWorld({
      failureTtlMs: 15_000,
      fetch: async (provider: string, entry: { id: string }) => {
        world.calls.push(`${provider}:${entry.id}`)
        if (fail) throw new Error('上游 503')
        return { ok: true }
      },
    })
    return { ...world, recover: () => { fail = false } }
  }

  it('★ 失败被表达为**读数**（带 error），不是抛错', async () => {
    const { cache } = failing()
    const result = await cache.read('buddy', [acct('a1')])
    const reading = result.get('a1') as BalanceReading
    expect(reading.error).toContain('503')
    expect(reading.value).toBeUndefined()
  })

  it('★ 失败按 failureTtlMs 缓存 ⇒ 一次抖动不会被反复重试（但很快能自愈）', async () => {
    const { cache, calls, advance, recover } = failing()
    await cache.read('buddy', [acct('a1')])
    expect(calls).toHaveLength(1)
    advance(14_999)
    await cache.read('buddy', [acct('a1')])
    expect(calls, 'failureTtlMs 内不重试').toHaveLength(1)
    advance(2)
    recover()
    const result = await cache.read('buddy', [acct('a1')])
    expect(calls, '★ 失败 TTL 一过就要重试').toHaveLength(2)
    expect((result.get('a1') as BalanceReading).error, '★ 自愈后不得再报错').toBeUndefined()
  })

  it('★ 一个账号失败不影响同批其它账号的读数（逐账号独立）', async () => {
    const { cache } = makeWorld({
      fetch: async (_provider: string, entry: { id: string }) => {
        if (entry.id === 'bad') throw new Error('boom')
        return { id: entry.id }
      },
    })
    const result = await cache.read('buddy', [acct('bad'), acct('good')])
    expect(result.get('bad')!.error).toBeDefined()
    expect(result.get('good')!.error).toBeUndefined()
    expect(result.get('good')!.value).toEqual({ id: 'good' })
  })

  it('★★ 失败读数**不得**用成功的 TTL（否则一次抖动锁死两分钟）', async () => {
    const { cache, calls, advance } = makeWorld({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      fetch: async (provider: string, entry: { id: string }) => {
        // ⚠️ 自建 fetch **必须自己记录**（`makeWorld` 只在缺省 fetch 里记）——
        //    我第一版漏了这行，用例看到的是空数组，失败原因看着像实现错了。
        calls.push(`${provider}:${entry.id}`)
        throw new Error('down')
      },
    })
    await cache.read('buddy', [acct('a1')])
    advance(16_000)
    await cache.read('buddy', [acct('a1')])
    expect(calls, '★ 16 秒后必须已能重试（若用了 120 秒 TTL 这里会是 1）').toHaveLength(2)
  })
})

describe('createBalanceCache：取数顺序必须是串行', () => {
  it('★★ 双账号**顺序**执行（并发会在同一时刻有两个在飞）', async () => {
    // ⚠️⚠️ 单账号时「串行」与「并发」**不可区分** ⇒ 必须用两个账号，并记录
    //    「进入 / 退出」的时刻序。判据照 `credits-balance-self-heal.spec.ts` 的同款理由。
    let inflight = 0
    let maxInflight = 0
    const order: string[] = []
    const { cache } = makeWorld({
      fetch: async (_provider: string, entry: { id: string }) => {
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        order.push(`start:${entry.id}`)
        // 让出事件循环（若实现并发，第二个会在这里插进来）
        await new Promise((resolve) => setTimeout(resolve, 0))
        order.push(`end:${entry.id}`)
        inflight -= 1
        return { id: entry.id }
      },
    })
    await cache.read('buddy', [acct('a1'), acct('a2')])
    expect(maxInflight, '★ 同一时刻最多一个在飞（不得 Promise.all）').toBe(1)
    expect(order, '★ 必须逐个跑完再跑下一个').toEqual([
      'start:a1', 'end:a1', 'start:a2', 'end:a2',
    ])
  })
})

describe('createBalanceCache：中止必须原样逃逸（铁律的第四种形态）', () => {
  it('★★ fetch 抛 AbortError ⇒ read() 原样上抛（不得记成 error 读数）', async () => {
    // ⚠️ 若被记成读数：撤回请求的用户会看到「余额查询失败」（静默把取消伪装成故障），
    //    而且失败 TTL 15 秒 ⇒ 下一轮**再打一次**上游（取消本该立刻停下）。
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const { cache, calls } = makeWorld({
      fetch: async () => { throw abort },
    })
    await expect(cache.read('buddy', [acct('a1')])).rejects.toThrow(/aborted/)
    expect(calls, '本用例的 fetch 不记录 calls（它抛错）').toEqual([])
  })

  it('★ 中止**不写缓存**（TtlCache 的「抛错不缓存」）⇒ 下一次会重试', async () => {
    let fail = true
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const { cache, calls } = makeWorld({
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        if (fail) throw abort
        return { ok: true }
      },
    })
    await expect(cache.read('buddy', [acct('a1')])).rejects.toThrow()
    fail = false
    const result = await cache.read('buddy', [acct('a1')])
    expect(calls, '★ 中止不得留下任何缓存条目').toHaveLength(2)
    expect(result.get('a1')!.error).toBeUndefined()
  })

  it('★ 中止在**批中间**：前面的账号已入缓存，后面的不再尝试', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const { cache, calls } = makeWorld({
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        if (entry.id === 'a2') throw abort
        return { id: entry.id }
      },
    })
    await expect(cache.read('buddy', [acct('a1'), acct('a2'), acct('a3')])).rejects.toThrow()
    expect(calls, '★ 不得继续尝试 a3').toEqual(['buddy:a1', 'buddy:a2'])
    // a1 的读数真的进了缓存（「本次上游填充会跑完，不浪费」）。
    expect(cache.peek('buddy', 'a1')?.value).toEqual({ id: 'a1' })
  })

  it('★ 注入的 isAbort 被真的用上（不是只声明）', async () => {
    // ⚠️ 上游有多种中止形状（`code: 'ABORTED'`、499 报文）。本模块**不**自带那套判据
    //（避免第 5 份同义实现），而是注入 —— 本用例锁「注入的判据真的生效」。
    const weird = Object.assign(new Error('provider: client has aborted request HTTP_499'), { code: 'ABORTED' })
    const { cache } = makeWorld({
      fetch: async () => { throw weird },
      isAbort: (error) => (error as { code?: string }).code === 'ABORTED',
    })
    await expect(cache.read('buddy', [acct('a1')])).rejects.toThrow(/499/)
  })

  it('★ 缺省 isAbort 只认 AbortError（保守）⇒ 其它错误仍是失败读数', async () => {
    const { cache } = makeWorld({ fetch: async () => { throw new Error('普通网络错') } })
    const result = await cache.read('buddy', [acct('a1')])
    expect(result.get('a1')!.error).toContain('普通网络错')
  })
})

describe('createBalanceCache：peek 与 clear', () => {
  it('★ peek 是同步零网络读；未知键 / 未读过的账号 ⇒ undefined', async () => {
    const { cache, calls } = makeWorld()
    expect(cache.peek('buddy', 'a1')).toBeUndefined()
    expect(calls, '★ peek 不得触发取数').toEqual([])
    await cache.read('buddy', [acct('a1')])
    expect(cache.peek('buddy', 'a1')?.value).toEqual({ provider: 'buddy', id: 'a1', balance: 42 })
    // 不同渠道的同一个 id 互不干扰
    expect(cache.peek('workbuddy', 'a1')).toBeUndefined()
  })

  it('★ peek 过期后返回 undefined（与 get 的 TTL 判据同源，不是第二套）', async () => {
    const { cache, advance } = makeWorld({ ttlMs: 1000 })
    await cache.read('buddy', [acct('a1')])
    advance(1001)
    expect(cache.peek('buddy', 'a1')).toBeUndefined()
  })

  it('★ clear(provider) 只清该渠道', async () => {
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('workbuddy', [acct('a1')])
    cache.clear('buddy')
    await cache.read('buddy', [acct('a1')])
    await cache.read('workbuddy', [acct('a1')])
    expect(calls, 'buddy 被清（重查）、workbuddy 未清（命中）').toEqual([
      'buddy:a1', 'workbuddy:a1', 'buddy:a1',
    ])
  })

  it('★ clear() 清全部', async () => {
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('workbuddy', [acct('a1')])
    cache.clear()
    expect(cache.peek('buddy', 'a1')).toBeUndefined()
    expect(cache.peek('workbuddy', 'a1')).toBeUndefined()
    await cache.read('buddy', [acct('a1')])
    expect(calls).toHaveLength(3)
  })

  it('★ clear 后仍可正常工作（不得把实例弄坏）', async () => {
    const { cache } = makeWorld()
    cache.clear('buddy')      // 清一个从没读过的渠道
    cache.clear()
    const result = await cache.read('buddy', [acct('a1')])
    expect(result.get('a1')!.error).toBeUndefined()
  })
})

describe('createBalanceCache：在飞去重（并发读取同一账号只回源一次）', () => {
  it('★ 两个并发 read 对同一账号共用同一次取数', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined
    const { cache, calls } = makeWorld({
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        return await new Promise((resolve) => { resolveFetch = resolve })
      },
    })
    const first = cache.read('buddy', [acct('a1')])
    const second = cache.read('buddy', [acct('a1')])
    // 让两次 read 都跑到 load（await 一个 tick）
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveFetch?.({ ok: true })
    await Promise.all([first, second])
    expect(calls, '★ 在飞去重：并发只发一次').toHaveLength(1)
  })
})
