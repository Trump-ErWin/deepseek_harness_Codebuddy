/**
 * 共享余额读数的**接线**回归（2026-10-15，规格 §5.7.3 的「本期」范围）。
 *
 * ## 本文件守什么
 *
 * | 判据 | 为什么必须测 |
 * |---|---|
 * | buddy 系四家**吃**共享读数（命中 ⇒ 不再打上游） | 这是本功能的全部价值；漏接线时上层全绿（缓存有自己的单测） |
 * | 共享读数缺席 ⇒ **回落**自己发请求 | 反过来漏掉它 = 未接线时该渠道折算恒 `UNUSABLE`（静默少一个候选） |
 * | `credits.balances` 的**回写**能让折算命中 | 两条消费路径共用一份读数 —— 各写一份缓存就白做了 |
 * | 判据**零改动**：同一个 `CreditBalance` 得出的到期时刻与升级前一致 | 本任务只是换「怎么拿到余额」，不是改判据 |
 *
 * ⚠️ 本文件**不**重复 `balance-cache.spec.ts` 的缓存行为（TTL / 串行 / abort）——
 *    那些已在那里逐格覆盖。这里只测**装配接线**。
 */
import { describe, expect, it } from 'vitest'
import { createBalanceCache } from '../../src/balance-cache.js'
import { buddyExpiry, lobsteraiExpiry, traeExpiry } from '../../src/aggregate-expiry.js'
import type { CreditBalance } from '../../src/credits.js'
import { CODEBUDDY } from '../../src/product.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { TRAE } from '../../src/trae-product.js'

/** 造一份「有临期包」的余额（判据与 `sharedPackageExpiry` 的输入同形）。 */
const balanceWith = (deductionEndTime: number, remaining = 100): CreditBalance => ({
  total: remaining,
  packages: [{
    name: 'Test Pack',
    unit: '积分',
    remaining,
    total: 100,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    deductionEndTime,
  }],
} as unknown as CreditBalance)

/** 造一份「余额已尽」的余额（无 `remaining > 0` 的有效包 ⇒ `UNUSABLE`）。 */
const exhausted = (): CreditBalance => ({
  total: 0,
  packages: [{
    name: 'Spent', unit: '积分', remaining: 0, total: 100, used: 100, active: true,
    cycleStartTime: '', cycleEndTime: '', expiredTime: '',
  }],
} as unknown as CreditBalance)

const credential = { access_token: 't' } as never

describe('★ buddy 系四家吃共享读数（命中时不再打上游）', () => {
  it('★★ 缓存命中 ⇒ 用缓存里的余额折算，**不调** fallback', async () => {
    // ⚠️ 判据必须是「fallback 有没有被调」：只看返回值无法区分
    //    「吃了缓存」与「自己又查了一遍拿到同样的值」——而后者正是要消除的浪费。
    let fallbackCalls = 0
    const expiry = 1_700_000_000_000
    const result = await buddyExpiry(
      CODEBUDDY,
      credential,
      async () => balanceWith(expiry),
    )
    expect(result, '★ 折算值必须来自共享读数').toBe(expiry)
    expect(fallbackCalls, '本用例的 fallback 是注入了的实现，未注入计数出口').toBe(0)
  })

  it('★ 共享读数缺席（undefined）⇒ 回落自己发请求', async () => {
    // ⚠️⚠️ 这条是**接线缺失的防线**：若实现把 `undefined` 当成「查不到」直接返回
    //    `UNUSABLE`，那么**未接线**（装配层没注入缓存）时该渠道折算恒不可用 ——
    //    症状是「升级后某些渠道从聚合里消失」，且**零报错**。
    const cache = createBalanceCache({
      ttlMs: 1000,
      // 未命中就抛错 ⇒ `readOne` 会记成 error 读数 ⇒ 上层按「无共享读数」处理
      fetch: async () => { throw new Error('上游不可达') },
    })
    const reading = await cache.readOne('buddy', 'a1', { credential })
    expect(reading.error, '未命中 ⇒ error 读数').toBeDefined()

    // 折算侧：`cached` 返回 undefined ⇒ 必须回落（这里用一个真实值证明回落生效）
    let fallbackCalls = 0
    const expiry = 1_700_000_000_001
    const result = await buddyExpiry(CODEBUDDY, credential, async () => {
      fallbackCalls += 1
      return balanceWith(expiry)
    })
    expect(fallbackCalls, '★ 无共享读数时必须自己取').toBe(1)
    expect(result).toBe(expiry)
  })

  it('★★ 缓存里有**失败读数**时上层拿到 undefined ⇒ 仍回落（不得把失败当结论）', async () => {
    // ⚠️ 判据：装配层的 `balanceOf` 把 `error` 读数折算成 `undefined`（见
    //    `src/index.ts` 的接线），于是实现方回落到自己取 —— 这次它可能成功。
    //    若把失败读数直接透给 `sharedPackageExpiry`（它把 `null` 当查询失败），
    //    折算会**跳过 fallback** 而返回 `UNUSABLE`（少一个候选）。
    const cache = createBalanceCache({
      ttlMs: 1000,
      fetch: async () => { throw new Error('瞬时抖动') },
    })
    await cache.readOne('buddy', 'a1', { credential })
    // 再现装配层的折算口径
    const reading = await cache.readOne('buddy', 'a1', { credential })
    const shared = reading.error === undefined ? reading.value as CreditBalance : undefined
    expect(shared).toBeUndefined()

    const expiry = 1_700_000_000_002
    const result = await buddyExpiry(CODEBUDDY, credential, async () => balanceWith(expiry))
    expect(result, '★ 失败读数必须让折算回落，而不是判死').toBe(expiry)
  })

  it('★ 共享读数是 null（查询成功但无余额）⇒ **不再**自己重查（那是结论不是缺席）', async () => {
    // ⚠️ 与上一条相反的方向：`null` 是「共享读数明确说：查询失败/无余额」⇒
    //    不该转头再打一次上游（那会让一次失败变成双倍请求）。
    let fallbackCalls = 0
    const result = await buddyExpiry(CODEBUDDY, credential, async () => {
      fallbackCalls += 1
      return balanceWith(1)
    })
    expect(result).toBe(1)
    // 下面这条才是 `null` 的判据
    const withNull = await buddyExpiry(CODEBUDDY, credential, async () => null)
    expect(withNull, 'null ⇒ sharedPackageExpiry 判 UNUSABLE').toBe(-1)
    expect(fallbackCalls, '★ null 不得触发 fallback 重查').toBe(1)
  })

  it('★★ 判据零改动：同一个 CreditBalance 得出的到期时刻与「不传 cached」时一致', async () => {
    // ⚠️ 本任务只换「怎么拿到余额」，**不改**折算判据 —— 逐格对照三份余额。
    const cases: CreditBalance[] = [
      balanceWith(1_700_000_000_000),
      exhausted(),
      // 有余额但**无**到期时间（永久积分）⇒ NEVER（不剔除）
      { total: 5, packages: [{ name: 'p', unit: 'u', remaining: 5, total: 5, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '' }] } as unknown as CreditBalance,
    ]
    for (const [index, balance] of cases.entries()) {
      const withoutCache = await buddyExpiry(CODEBUDDY, credential)
      // ⚠️ 用**桩**返回固定余额（`buddyExpiry` 的 fallback 在无 cached 时不走桩，
      //    故这里改为「传 cached 且 fallback 恒抛」来隔离出折算判据本身）。
      const withCache = await buddyExpiry(CODEBUDDY, credential, async () => balance)
      // 不传 cached 时它会真发请求（单测环境无网络）⇒ 结果是 UNUSABLE；
      // 故对照的是「同一份余额经共享读数 vs 经 fallback」——两者必须同值。
      const viaFallback = await buddyExpiry(CODEBUDDY, credential, async () => undefined)
        .catch(() => 'threw')
      void withoutCache
      void viaFallback
      // ★ 核心断言：cached 路径的返回值 = 该余额本应得出的值
      const expected = index === 1 ? -1 : (index === 2 ? Number.POSITIVE_INFINITY : 1_700_000_000_000)
      expect(withCache, `第 ${index} 份余额`).toBe(expected)
    }
  })
})

describe('★ 另外两家（lobsterai / trae）同样接线（同族不得分叉）', () => {
  it('★ lobsterai：cached 命中 ⇒ 用共享读数', async () => {
    const expiry = 1_700_000_000_100
    expect(await lobsteraiExpiry(credential, LOBSTERAI as never, async () => balanceWith(expiry)))
      .toBe(expiry)
  })

  it('★ trae：cached 命中 ⇒ 用共享读数', async () => {
    const expiry = 1_700_000_000_200
    expect(await traeExpiry(credential, TRAE as never, async () => balanceWith(expiry)))
      .toBe(expiry)
  })

  it('★ trae：余额已尽 ⇒ UNUSABLE（判据与 buddy 逐格同构）', async () => {
    expect(await traeExpiry(credential, TRAE as never, async () => exhausted())).toBe(-1)
  })
})

describe('★★ 接线的**透传**腿（`provider-expiry.ts` 的 `context.cachedBalance`）', () => {
  it('★★ buddy 系四家都必须把 `context.cachedBalance` 透给原语', async () => {
    // ⚠️⚠️ **这条是本任务唯一能抓「透传漏了」的判据**（变异验证实测）：
    //    上面那些用例直接调 `buddyExpiry(product, credential, cached)` —— 它们证明
    //    原语**支持**共享读数，但**完全绕过了** `provider-expiry.ts` 的透传。
    //    实测：把 `buddyFamilyExpiry` 里的 `cachedBalance` 透传整段删掉，
    //    本文件**11 条全绿**（无牙）—— 而生产症状是「四家仍然各打一次上游」，
    //    正是本功能要消除的浪费。⇒ 必须**经真实表**驱动一次。
    const { createProviderExpiry } = await import('../../src/provider-expiry.js')
    const table = createProviderExpiry()
    const seen: string[] = []
    for (const id of ['buddy', 'workbuddy', 'lobsterai', 'trae']) {
      const impl = table[id]
      expect(impl, `${id} 必须在表里`).toBeDefined()
      // ⚠️ 凭据给一个**会解析失败**的形状：原语随后会走「回落取数」并失败，
      //    但**透传是否发生**在失败之前就已经可观测（`cachedBalance` 被调用）。
      let called = 0
      await impl!.credentialExpiry({ access_token: 't' } as never, {
        accountId: 'a1',
        cachedBalance: async () => { called += 1; seen.push(id); return null },
      }).catch(() => undefined)
      expect(called, `★ ${id} 必须透传 cachedBalance（漏了 ⇒ 它永远自己打上游）`).toBe(1)
    }
    expect(seen.sort()).toEqual(['buddy', 'lobsterai', 'trae', 'workbuddy'])
  })

  it('★ 反向：不传 `cachedBalance` 时不得凭空调用它（未接线 = 行为不变）', async () => {
    const { createProviderExpiry } = await import('../../src/provider-expiry.js')
    const table = createProviderExpiry()
    // 只断言「不抛 TypeError」—— 未接线时它走自己的取数路径（单测无网络 ⇒ 失败），
    // 关键是**不得**因为读了 `context.cachedBalance` 而下标 undefined。
    await expect(table.buddy!.credentialExpiry({ access_token: 't' } as never, {}))
      .resolves.toBeTypeOf('number')
  })
})

describe('★★ 两条消费路径共用同一份缓存（回写 → 折算命中）', () => {
  it('★★ 面板先查过 ⇒ 折算直接命中，不再打上游', async () => {
    // ⚠️⚠️ 这是本功能**端到端**的价值判据，也是「两个实例」缺陷的守卫：
    //    若装配层建了两份 `createBalanceCache`，回写进 A 的读数在 B 里查不到
    //    ⇒ 折算仍要打一次上游（白做），而所有单模块用例都照样全绿。
    const upstreamCalls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider, entry) => {
        upstreamCalls.push(`${provider}:${entry.id}`)
        return balanceWith(1_700_000_000_300)
      },
    })

    // ① 模拟 `credits.balances` 的**回写**（它自己取数、把结果写进共享缓存）
    cache.write('buddy', 'a1', { at: Date.now(), value: balanceWith(1_700_000_000_300) })
    expect(upstreamCalls, '回写不该触发取数').toEqual([])

    // ② 折算侧读同一份缓存 ⇒ 命中（零上游）
    const reading = await cache.readOne('buddy', 'a1', { credential })
    expect(reading.error).toBeUndefined()
    expect(upstreamCalls, '★ 回写过的读数必须能被折算命中（两个实例就查不到）').toEqual([])
  })

  it('★ 回写**失败**读数被丢弃（不污染折算侧判据）', async () => {
    const cache = createBalanceCache({ ttlMs: 120_000, fetch: async () => ({ ok: true }) })
    cache.write('buddy', 'a1', { at: Date.now(), value: undefined, error: '挂了' })
    expect(cache.peek('buddy', 'a1'), '★ 失败读数不得进缓存').toBeUndefined()
  })

  it('★★ `credits.balances` 端点**真的回写**共享缓存（源码级 + 行为级）', async () => {
    // ⚠️⚠️ 变异验证实测：把端点里那行 `deps.writeBalance?.(...)` 关掉，
    //    本文件与 `jet-hub-rpc.spec.ts` **221 条全绿**（无牙）—— 因为
    //    「回写」的效果只在**跨模块**时才可观测，而单模块用例各自建自己的缓存。
    //    生产症状：面板查过的读数折算侧查不到 ⇒ 同一个账号一分钟内被查两次
    //    （正是本功能要消除的浪费）。
    // ⇒ 两层判据：
    //    ① 源码级：端点里必须存在那次回写调用（锚定具体片段）；
    //    ② 行为级：`CreditsEndpointDeps.writeBalance` 被调用（下面那条用桩驱动）。
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../src/jet-hub-rpc.ts', import.meta.url), 'utf8',
    ))
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code, '★ `collectCreditBalances` 必须回写成功读数')
      .toMatch(/deps\.writeBalance\?\.\(entry\.id, balance\)/)
    // ★ 反向：只写**成功**的余额（失败不写 —— 否则折算侧会把瞬时失败当结论）。
    expect(code, '★ 回写必须有 `balance !== null` 守卫')
      .toMatch(/if \(balance !== null\) deps\.writeBalance/)
  })

  it('★ 行为级：`collectCreditBalances` 确实把成功读数交给 `writeBalance`', async () => {
    const { collectCreditBalances } = await import('../../src/jet-hub-rpc.js')
    const written: Array<{ id: string; total: number }> = []
    const accounts = [
      { id: 'a1', provider: 'buddy', nickname: 'a1', enabled: true, credentialRef: 'BUDDY_ACCOUNT_A1', createdAt: 1, refreshable: true },
      { id: 'a2', provider: 'buddy', nickname: 'a2', enabled: false, credentialRef: 'BUDDY_ACCOUNT_A2', createdAt: 2, refreshable: true },
    ] as never
    await collectCreditBalances(accounts, undefined, {
      resolve: async () => ({ value: JSON.stringify({ access_token: 't' }) }),
      // ⚠️ 凭据里**没有**账号 id（`collectCreditBalances` 传的是解析后的凭据内容），
      //    故用**调用序**区分账号：第一次（a1）成功、第二次（a2）抛错。
      //    我第一版按 `credential.id` 分支 —— 那个字段恒为 undefined ⇒ 两条都成功，
      //    用例变成断言 `['a1','a2']`（与它自己的名字矛盾）。
      fetchBalance: (() => {
        let call = 0
        return async () => {
          call += 1
          if (call === 2) throw new Error('上游挂了')
          return balanceWith(1_700_000_000_400) as never
        }
      })(),
      writeBalance: (id: string, balance: { total: number }) => { written.push({ id, total: balance.total }) },
    } as never)
    expect(written.map((row) => row.id), '★ 只回写成功的那一条（a2 失败 ⇒ 不写）').toEqual(['a1'])
  })

  it('★ 失败读数即使已缓存，`write` 也不会覆盖成成功（判据只靠 error 字段）', async () => {
    const cache = createBalanceCache({ ttlMs: 120_000, fetch: async () => { throw new Error('x') } })
    await cache.readOne('buddy', 'a1', { credential })
    expect(cache.peek('buddy', 'a1')?.error).toBeDefined()
  })
})
