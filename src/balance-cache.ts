/**
 * 账号余额**读数**的共享缓存（基础设施层）。
 *
 * 规格：`docs/superpowers/specs/2026-10-15-aggregate-gating-manual-order-design.md` §5.7
 *
 * ## ⚠️⚠️ 本模块的定位（用户 2026-10-15 的更正原话）
 *
 * 「为什么不能更新账号积分用共享缓存，取号逻辑只是在调用缓存的时候取舍的问题，
 * 不影响刷新账号积分缓存呢，账号积分缓存是更底层基础设置，计算怎么取号是
 * 基础设施上的使用逻辑」
 *
 * ⇒ 本模块共享的是「**同一账号的余额读数**」，**不是**「谁该被读」：
 *
 * | 层 | 谁负责 |
 * |---|---|
 * | 缓存（本模块） | 同一个 `(provider, accountId)` 在 TTL 内复用同一次读数 |
 * | 取数（注入的 `fetch`） | 各渠道自己的协议（本模块**不认识**任何上游形状） |
 * | **取舍**（调用方） | 积分面板要**全部**账号（含停用）；用量徽标只要**启用**账号；聚合只要**可用**账号 |
 *
 * ⚠️ 三者不要混：把「谁该被读」塞进本模块，会让同一个账号在不同调用路径下拿到
 * **不同的缓存条目**（那正是「共享缓存」失效的形态）。
 *
 * ## 为什么用 `TtlCache`（而不是自建 Map）
 *
 * 与 `usage-badge.ts`（`:180-191` 的 `cacheFor`）**同款**：懒建实例、`ttlFor` 按结果分档。
 * 自建一份会立刻产生「两套 TTL 判据」——本仓库红线。
 *
 * ## ⚠️ `load` 是零参契约 ⇒ 用「可变槽」把条目喂进去
 *
 * `TtlCache.load` 的签名是 `() => Promise<T>`（`src/ttl-cache.ts:39`），而
 * 「这次要读哪个账号」是**运行时**才知道的。⇒ `read()` 先把条目写进 `slots`，再
 * 调 `cacheOf(key).get({ force })`；`load` 从槽里取。
 *
 * ⚠️ **这是本模块唯一需要解释的技巧**：换成「把条目闭包进 `load`」要求每个账号一个闭包，
 * 而账号是运行时才知道的（且账号会增删）⇒ 只能靠槽。
 *
 * ## 三条必须遵守的约束（规格 §5.7.4）
 *
 * 1. **取消语义**：调用方 `await read(...)` 之后必须自己 `signal?.throwIfAborted()` ——
 *    用户可见的取消行为**逐字节不变**（立刻 `AbortError`），但**本次上游填充会跑完**
 *    （读数进缓存，不浪费）。⚠️ 「abort 不得被折叠成 `UNUSABLE`」是本仓库复发过三次的
 *    铁律，本处是**新增的第四种形态**：`fetch` 抛的中止错误必须**原样上抛**，
 *    **不得**记成 `error` 读数。
 * 2. **顺序**：逐账号**串行**取数，**不得**改成 `Promise.all` —— 并发打上游会触发限流
 *    （照 `collectCreditBalances`（`src/jet-hub-rpc.ts`）的既有体例，那里有实测记载）。
 * 3. **失败是「值」不是「抛错」**：`{ error }` 读数按 `failureTtlMs` 缓存（15 秒）。
 *    若让失败抛错，`TtlCache` 的「抛错不缓存」会让失败被**无限重试**
 *    （上游限流时那是最坏结果）。
 *
 * @module src/balance-cache.ts
 */

import { TtlCache } from './ttl-cache.js'

/**
 * 一个账号的一条读数。
 *
 * ⚠️ `value` 是**上游原样形状**（本模块不解释它）—— 各消费者按自己渠道的协议读它
 *（buddy 系是 `CreditBalance`、officeace 是套餐摘要、…）。
 * ⚠️ `error` 存在 ⇒ 这是**失败读数**（短 TTL）；`value` 此时为 `undefined`。
 *
 * ⚠️⚠️ **例外：兼顶读数（`StaleBalanceReading`）允许两者同时存在** ——
 * 「本次取数失败」与「上次读到的值仍然可用」是两件同时为真的事。
 * ⇒ **判「这条读数能不能用」不能只看 `error`**：
 *   - 只吃 `read`/`readOne` 的消费者（如聚合折算）：`error === undefined` 才可用，
 *     且它们**永远拿不到**兼顶读数（那是 `readStale` 的独有形状）；
 *   - 吃 `readStale` 的消费者：按 `stale` 判断，并把 `error` 当「本次失败原因」展示。
 */
export interface BalanceReading {
  /** 取到该读数的时刻（毫秒）。 */
  at: number
  /** 上游原样返回值（失败时为 `undefined`）。 */
  value: unknown
  /** 失败原因（人话）；成功时为 `undefined`。 */
  error?: string
}

/**
 * ★ 兼顶读数（{@link BalanceCache.readStale} 的返回值）。
 *
 * ⚠️ `value` **可能**有值（陈旧兼顶）也可能是 `undefined`（连旧值都没有）——
 *    「能不能用」看 `value !== undefined`，**不看** `error`。
 */
export interface StaleBalanceReading {
  /**
   * 值本身是**什么时候**取到的（毫秒）—— 即陈旧值的年龄。
   *
   * ⚠️ 与兼顶无关（即本次取数成功）时，它就是本次取数的时刻。
   */
  at: number
  /** 上游原样返回值；**兼顶失败且无旧值**时为 `undefined`。 */
  value: unknown
  /** 本次取数的失败原因；成功时为 `undefined`。**兼顶时它仍然有值**。 */
  error?: string
  /** 该值是否来自上一次的缓存（`true` = 陈旧）。 */
  stale: boolean
}

/** 一条要读的账号条目（**最少**只有 `id`；取数原语需要什么由调用方附带）。 */
export interface BalanceCacheEntry {
  /** 账号池条目 id（**缓存键的第二半**，必填）。 */
  id: string
  /**
   * 该账号的**已解析凭据**（可选）。
   *
   * ⚠️ 聚合折算路径用它：`credentialExpiry(provider, credential, context)` 手上
   * **只有**凭据，没有账号池条目 ⇒ `cachedBalance(accountId)` 回填时要把凭据
   * 一起带进来，否则 `fetch` 拿不到凭据（它必须与 `*Expiry` 原语调的是**同一个**函数）。
   */
  credential?: unknown
}

/** 构造选项。 */
export interface BalanceCacheOptions {
  /**
   * 成功读数的 TTL（毫秒）。
   *
   * ⚠️ 聚合折算用 **120_000**（规格 §5.7.4-3 的诚实登记：原先是 60 秒）：
   * 聚合是**多候选回落**结构，某渠道读数陈旧 60 秒的代价是「多一次失败尝试后回落」，
   * 用户看不到失败；换来的是上游请求不翻倍。面板侧有 5 分钟重探与手动 `force` 兜底。
   */
  ttlMs: number
  /**
   * **失败**读数的 TTL（毫秒，默认 15_000）。
   *
   * ⚠️ 必须比 `ttlMs` 短一个数量级：把一次网络抖动缓存满 2 分钟，会让「查不到」
   * 伪装成「额度用尽」整整两分钟（`buddy-balance-selector.ts` 与 `usage-badge.ts`
   * 都有同款注释与同款修复）。
   */
  failureTtlMs?: number
  /**
   * ★ **陈旧值最长兼顶**时长（毫秒，默认 15 分钟）。
   *
   * 用户 2026-10-16：「加载如果得不到新数据，应该读出旧数据，不能直接返回错误
   *（除非旧数据也没有）」。⚠️ 必须有上界 —— 无界兼顶会让一次读数命中后永久生效，
   * 用户看到的余额可能是一天前的，而 UI 只写「数据来自 HH:MM」。
   *
   * ⚠️ 这**不是** `failureTtlMs`：后者决定「一条**失败读数**缓存多久」，
   *   本项决定「**成功读数过期后**还能兼顶多久」。两者量级差 1~2 个数量级。
   */
  staleTtlMs?: number
  /**
   * 单账号取数原语（**由装配层按渠道注入**）。
   *
   * ⚠️ 本模块**不认识**任何渠道协议；也**不含 self-heal**（续期留在
   * `credits.balances` / `credits.claimAll` 的**端点入口**，见规格 §5.7.1 末行）。
   */
  fetch: (provider: string, entry: BalanceCacheEntry) => Promise<unknown>
  /**
   * 「这个错误是不是调用方取消」的判据（**由装配层注入共享实现**）。
   *
   * ⚠️⚠️ **不要在本模块里新写一份**：本仓库已经有 **4 份**同义实现
   *（`aggregate-adapter.ts` 的 `isAbortLike`、`aggregate-expiry.ts` 的简化版、
   * `auto-adapter.ts` 与 `raccoon-adapter.ts` 的内联）—— 「同一语义两套判据」是本仓库
   * 的红线，而那条红线正是被这类「顺手再写一份」破坏的。
   *
   * ⚠️ 缺省实现**只认** `name === 'AbortError'`（最保守的形状）；装配层应传
   * `aggregate-adapter.ts` 导出的共享判据（它还有 `code === 'ABORTED'` 与
   * 499 报文两条腿）。
   */
  isAbort?: (error: unknown) => boolean
  /** 取当前时刻（注入以便单测）。 */
  now?: () => number
}

/** 见模块头与 {@link createBalanceCache}。 */
export interface BalanceCache {
  /**
   * 逐账号命中/回源（**顺序执行**；同一账号在飞去重）。
   *
   * ⚠️ `entries` 决定「读哪些账号」—— 那是**调用方的取舍**（见模块头那张表）。
   * ⚠️ 返回的 Map 以 `accountId` 为键，**只含本次传入的账号**。
   */
  read(
    provider: string,
    entries: readonly BalanceCacheEntry[],
    options?: { force?: boolean },
  ): Promise<ReadonlyMap<string, BalanceReading>>
  /** 只看缓存、不触发加载（面板用它显示「数据时间」）。未知键 / 已过期 ⇒ `undefined`。 */
  peek(provider: string, accountId: string): BalanceReading | undefined
  /**
   * 取**一个**账号的读数（供「手上只有凭据、没有账号池条目」的路径用 —— 聚合折算）。
   *
   * ⚠️ 与 {@link read} 的差别只有**入参形态**：两者**共用同一份缓存**
   *（同一个 `(provider, accountId)` 的键）—— 那正是本模块的意义。
   * 若给这条路径另建一份缓存，同一个账号会被查两次（本模块要消除的正是它）。
   */
  readOne(
    provider: string,
    accountId: string,
    entry: { credential?: unknown },
    options?: { force?: boolean },
  ): Promise<BalanceReading>
  /**
   * ★ **兼顶读数**（用户 2026-10-16 的要求）。
   *
   * 「用底层缓存；加载如果得不到新数据，应该读出旧数据，不能直接返回错误
   *（除非旧数据也没有）」—— {@link read} / {@link readOne} 在取数失败时
   * 返回的是 `error` 读数，**没有任何一条会回落到上一次的成功值**。
   *
   * ## 三条语义（逐条对应用户那句话）
   *
   * | 情形 | 返回 |
   * |---|---|
   * | 取数成功 | 新读数，`stale: false` |
   * | 取数失败，**有**旧的成功值 | **旧值** + `error`（本次失败原因）+ `stale: true` |
   * | 取数失败，**没有**旧值 | `error` 读数 + `stale: true`（无值可兼顶） |
   *
   * ⚠️ **`error` 与 `value` 同时存在**是这条路径独有的组合：`BalanceReading`
   *    的原注释说「`error` 存在 ⇒ 失败读数，`value` 为 `undefined`」——
   *    这里**刻意破例**，否则调用方无法区分「彻底查不到」与「拿旧值顶上」，
   *    而这两种的 UI 表现必须不同（后者要显示数据时间）。
   * ⇒ 因此**原有消费者不能直接吃这条读数**（它们的判据是
   *    `error === undefined` ⇒ 可用），见 {@link BalanceReading} 的新注释。
   *
   * @param staleTtlMs - 陈旧值**最长兼顶**时长（毫秒，默认 15 分钟）。
   *   ⚠️ 必须有上界：否则一次读数命中后就永久兼顶，用户看到的余额可能是一天前的，
   *   而 UI 只会写「数据来自 HH:MM」。
   */
  readStale(
    provider: string,
    accountId: string,
    entry: { credential?: unknown },
    options?: { force?: boolean; staleTtlMs?: number },
  ): Promise<StaleBalanceReading>
  /**
   * **写入**一个已知读数（不触发取数）。
   *
   * ## ⚠️ 为什么需要它（而不是让消费者都走 `read`）
   *
   * `credits.balances` 端点的响应形状是 `{ balance, error?, extra? }`，比折算路径要的
   * `CreditBalance` **多两个字段**（Gemini 的 `extra`）⇒ 让端点「读」缓存会**丢字段**。
   * ⇒ 端点继续用自己的取数（响应逐字节不变），但把它已经拿到的 `balance`
   * **写回**本缓存 —— 于是折算路径能命中面板刚查过的那一条（那正是「共享读数」的收益）。
   *
   * ⚠️ `error !== undefined` 的读数**不要**写（失败是瞬时的，写进去会污染折算侧的判据）。
   */
  write(provider: string, accountId: string, reading: BalanceReading): void
  /**
   * 清缓存：传 `provider` 只清该渠道，省略则清全部（关停时用）。
   *
   * ⚠️ **如实登记：当前没有任何生产调用者**（2026-10-16 审计实测，全仓 grep 只有
   * 测试调它）。这不是缺陷，而是**刻意**的取舍：正确性**不依赖**调用方记得清 ——
   * 折算序的正确性由 `aggregate-adapter.ts` 的 `routingFingerprint()`（拒绝表 +
   * 白名单 + 顺序表 + 模式**四项**）保证，拒绝/放行/顺序任何一项变化都会让
   * `choiceCache` 失效重算；而余额读数本身有 TTL（成功 120s / 失败 15s）自愈。
   *
   * ⇒ 保留它是为了两件事：① 关停时清理（若将来加 `dispose`）；② 测试隔离。
   * ⚠️ 若将来有人接上它，注意它是**共享**缓存 —— 清掉会连带作废徽标正在用的读数
   * （那正是本模块存在的意义），别当成「按渠道刷新」的顺手动作。
   */
  clear(provider?: string): void
}

/** 默认的中止判据（**最保守**；装配层应注入共享实现，见 `BalanceCacheOptions.isAbort`）。 */
function defaultIsAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError'
}

/**
 * 建一个余额读数缓存。见模块头的三条约束与「可变槽」的说明。
 */
export function createBalanceCache(options: BalanceCacheOptions): BalanceCache {
  const failureTtlMs = options.failureTtlMs ?? 15_000
  // ⚠️ 陈旧兼顶的**上界**必须有（见 `staleTtlMs` 的注释）：无界兼顶会让一次
  //   读数命中后永久生效，用户看到一天前的余额而 UI 只写「来自 HH:MM」。
  const staleTtlMs = options.staleTtlMs ?? 900_000
  const isAbort = options.isAbort ?? defaultIsAbort
  const now = options.now ?? (() => Date.now())
  /** `provider\0accountId` → 该账号的缓存实例（懒建，与 `usage-badge.ts:180-191` 同款）。 */
  const perAccount = new Map<string, TtlCache<BalanceReading>>()
  /**
   * 可变槽：`key` → **本次要读的那个账号条目**（`load` 是零参契约，只能这样喂进去）。
   * ⚠️ 后写覆盖先写是**无害**的：两个并发 `read()` 对同一个账号会共用同一次在飞 `load`
   *（`TtlCache.get` 的去重），而它们传的条目是同一个账号 ⇒ 内容相同。
   */
  const slots = new Map<string, { provider: string; entry: BalanceCacheEntry }>()
  const keyOf = (provider: string, accountId: string) => `${provider}\u0000${accountId}`

  /**
   * 取**一个账号**的读数：把失败也变成读数，**只有中止例外**（见模块头约束 1）。
   */
  const fetchReading = async (provider: string, entry: BalanceCacheEntry): Promise<BalanceReading> => {
    const at = now()
    try {
      return { at, value: await options.fetch(provider, entry) }
    } catch (error) {
      // ⚠️⚠️ **中止必须原样上抛**（铁律的第四种形态）：
      //    它不是「读不到余额」，而是「这次请求被取消了」—— 记成 `error` 读数会让
      //    撤回操作看起来像上游故障，且（因为失败读数短 TTL）下一轮会**再打一次**。
      if (isAbort(error)) throw error
      return {
        at,
        value: undefined,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const cacheOf = (key: string): TtlCache<BalanceReading> => {
    const existing = perAccount.get(key)
    if (existing !== undefined) return existing
    const created = new TtlCache<BalanceReading>({
      ttlMs: options.ttlMs,
      // ⚠️ 成功/失败两种 TTL **在这一侧按结果表达**（`TtlCache` 现成支持，见规格 §5.7.2）。
      ttlFor: (reading) => (reading.error === undefined ? options.ttlMs : failureTtlMs),
      now: options.now,
      load: async () => {
        const slot = slots.get(key)
        if (slot === undefined) {
          // 不可达（`read()` 必然先填槽）。留着是为了让「有人绕过 read 直接 get()」
          // 这类接线错误**立刻可见**，而不是静默打一次空请求。
          throw new Error('balance-cache: 内部缺陷，请通过 read() 取数')
        }
        return await fetchReading(slot.provider, slot.entry)
      },
    })
    perAccount.set(key, created)
    return created
  }

  return {
    async read(provider, entries, readOptions = {}) {
      const out = new Map<string, BalanceReading>()
      // ⚠️ **串行**（约束 2）：`for…of` + `await`，不是 `Promise.all`。
      for (const entry of entries) {
        if (typeof entry?.id !== 'string') continue
        const key = keyOf(provider, entry.id)
        slots.set(key, { provider, entry })
        // ⚠️ `force` 只影响**这一次**读取（**不** `clear()` 缓存）：面板「刷新」不该
        //    顺手把徽标正在用的读数也作废 —— 两者**共享**这份缓存，正是本模块的意义。
        out.set(entry.id, await cacheOf(key).get({ force: readOptions.force === true }))
      }
      return out
    },

    peek(provider, accountId) {
      return perAccount.get(keyOf(provider, accountId))?.peek()?.value
    },

    async readOne(provider, accountId, entry, readOptions = {}) {
      const key = keyOf(provider, accountId)
      // ⚠️ 槽里必须带 `id`：`fetch` 的签名吃 `BalanceCacheEntry`（各渠道的取数原语
      //    要用它做日志/二次查询），而本方法的入参只有 `credential`。
      slots.set(key, { provider, entry: { id: accountId, ...entry } })
      return await cacheOf(key).get({ force: readOptions.force === true })
    },

    /**
     * ★ 兼顶读取：成功用新值，失败回落**上一次的成功值**。
     *
     * ## ⚠️ 为什么不复用 `readOne` + 外面判 `error`
     *
     * 那样做需要调用方自己再查一次「旧值还在不在」，而旧值在 `readOne` 内部
     * 已经被 `get()` 用 `write()` **覆盖成失败读数**了 ⇒ 旧值在那一刻就丢了。
     * ⇒ 兼顶必须发生在**写入失败读数之前**，这是本方法存在的全部理由。
     *
     * ## ⚠️ 为什么失败读数**仍然写进缓存**
     *
     * 缓存里此刻既有失败读数、又有（更旧的）成功读数，两者不能共存于同一个
     * `entry` —— 故 `readStale` **不**把兼顶结果写回：`TtlCache` 只有一个槽位，
     * 让失败读数占住它会**毁掉兼顶的能力**（下一轮再来时旧值已经没了）。
     * ⇒ 代价：紧接着的 `readOne` 会再打一次上游。那正是「兼顶与严格读取不可兼得」
     *   的诚实登记，不是缺陷。
     */
    async readStale(provider, accountId, entry, readOptions = {}) {
      const key = keyOf(provider, accountId)
      const cache = cacheOf(key)
      // ⚠️ 先取旧值（**在 get() 之前**）：`get()` 成功会覆盖它、失败也会覆盖它。
      // ⚠️⚠️ **拆两层**：`peekStale()` 返回的是 `Entry<BalanceReading>`，
      //    故 `previous.value` 是**上一条读数**、而**上游原样值**在
      //    `previous.value.value` —— 我第一版漏了这次下钻，返回了一个
      //    「读数套读数」的对象（守卫用例实测打穿，不是理论风险）。
      const previous = cache.peekStale()?.value
      const limit = readOptions.staleTtlMs ?? staleTtlMs
      const force = readOptions.force === true
      slots.set(key, { provider, entry: { id: accountId, ...entry } })
      const fresh = await cache.get({ force })
      if (fresh.error === undefined) {
        return { at: fresh.at, value: fresh.value, stale: false }
      }
      const staleValue = previous?.value
      // ⚠️ **失败读数不落盘**（见上方说明）：让失败占住唯一的槽位会毁掉兼顶能力。
      if (staleValue === undefined) {
        cache.set({ at: fresh.at, value: undefined, error: fresh.error })
        return { at: fresh.at, value: undefined, error: fresh.error, stale: true }
      }
      // ⚠️ **兼顶有上界**：超龄的旧值不再使用 —— 否则一次读数命中后就永久生效。
      // ⚠️⚠️ 判据读 `previous.at`（`BalanceReading` 的字段名，**不是** `atMs`
      //    —— 那是 `TtlCache.Entry` 的字段名，两层结构不同）。我第一版写成
      //    `previous!.atMs` ⇒ `NaN >= limit` 恒假 ⇒ **上界形同虚设**，
      //    任何陈旧值都会被无限兼顶（守卫用例实测打穿）。
      // ⚠️ **`force` 下不兼顶**：用户点了面板「刷新」就是要看真实结果，
      //   「刷新后仍显示旧值」比报错更难解释。
      if (force || now() - previous!.at >= limit) {
        cache.set({ at: fresh.at, value: undefined, error: fresh.error })
        return { at: fresh.at, value: undefined, error: fresh.error, stale: true }
      }
      // ⚠️ 回滚成成功读数（保住兼顶能力）；`error` 仍如实带给调用方展示。
      cache.set({ at: previous!.at, value: staleValue })
      return {
        at: previous!.at,
        value: staleValue,
        error: fresh.error,
        stale: true,
      }
    },

    write(provider, accountId, reading) {
      // ⚠️ 失败读数**不写**：见 `BalanceCache.write` 的注释（失败是瞬时的，
      //    写进去会让折算侧把「刚失败过一次」当成当前结论）。
      if (reading.error !== undefined) return
      cacheOf(keyOf(provider, accountId)).set(reading)
    },

    clear(provider) {
      if (provider === undefined) {
        for (const cache of perAccount.values()) cache.clear()
        perAccount.clear()
        slots.clear()
        return
      }
      const prefix = `${provider}\u0000`
      for (const [key, cache] of [...perAccount.entries()]) {
        if (!key.startsWith(prefix)) continue
        cache.clear()
        perAccount.delete(key)
        slots.delete(key)
      }
    },
  }
}
