import { describe, expect, it, vi } from 'vitest'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * ★ `credits.balances` 的**按需自愈**（Gitee issue IKKHL5 建议 C）。
 *
 * ## 被修的缺陷
 *
 * 系统睡眠/挂起数小时后恢复，**宿主进程全程没退出** ⇒ `state.json` 里的
 * `expiresAt`（上次续期时刻 + 令牌寿命）落在过去。客户端判据只有一次本地
 * 比较（`plugin-src/client/jet-hub.js` 的 `account.expiresAt <= Date.now()`）
 * ⇒ 卡片显示红色「已过期 · 自动续期」；而 `credits.balances` 原本
 * **resolve 凭据后直连上游、全程不续期** ⇒ 积分行报「HTTP 401」。
 * 该窗口内没有任何手动自救手段（「重测」的 refresh 是刻意 no-op）。
 *
 * ## 为什么这层是对的（issue 建议的 A「墙钟跳变检测」不是）
 *
 * 实测 `NtSuspendProcess` 真实挂起：libuv 定时器基于**单调时钟**，
 * 睡眠时长 > interval 时**恢复瞬间就补触发**一轮（不需要墙钟检测来抢救）；
 * 真正的缺口是**恢复后第一轮要等最多一个 interval**，而短寿命 provider
 * （minimax 1h / codearts 2h / raccoon 3h）在这个窗口里必然显示「已过期」。
 * 让**用户主动发起的积分查询**自带续期，一次刷新面板同时消灭显示与 401。
 *
 * ## 本文件锁的五件事
 *
 * 1. 已过期 → **先续期再查余额**（缺陷本体）；
 * 2. 未过期 → **一个请求都不多发**（不能变成「每次刷新都续期一遍」）；
 * 3. 续期失败 → **不上抛**、照常查余额（凭据本来就过期，直连必然 401，
 *    报「续期失败」比原来的「HTTP 401」更难懂）；
 * 4. **不判 `entry.refreshable`**（那个布尔是凭据材料的镜像、可能被误标，
 *    误标过一次就永不自愈 —— AGENTS.md 已有的铁律）；
 * 5. loomy / zcode **不进自愈**（没有 refresh 端点，探测只会白发请求）。
 */

type Handler = (request: Request) => Promise<Response>

/** 一条「已过期」的账号条目。 */
function expiredEntry(over: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'acc-1',
    provider: 'minimax',
    nickname: '测试账号',
    credentialRef: 'MINIMAX_ACCOUNT_1',
    enabled: true,
    refreshable: true,
    expiresAt: Date.now() - 3 * 60 * 60 * 1000,
    ...over,
  } as ProviderAccountEntry
}

interface HarnessOptions {
  accounts: ProviderAccountEntry[]
  /** 每家 auth 的 refreshAccountCredential 替身；未列出的 provider 仅记录调用。 */
  auths?: Record<string, (ref: string, pool: unknown, id: string) => Promise<void>>
  /**
   * 凭据解析钩子。它是**余额查询路径的第一步**（`collectCreditBalances` 的
   * `deps.resolve`），故可用来见证「先续期、后查余额」的**顺序**而不必发网络。
   */
  onResolve?: () => void
}

function setup(options: HarnessOptions) {
  const calls: Array<{ provider: string; ref: string; accountId: string }> = []
  const warns: string[] = []

  const makeAuth = (provider: string) => ({
    refreshAccountCredential: async (ref: string, _pool: unknown, accountId: string) => {
      calls.push({ provider, ref, accountId })
      const injected = options.auths?.[provider]
      if (injected !== undefined) return injected(ref, _pool, accountId)
      return undefined
    },
  })

  const ctx: Record<string, unknown> = {
    get: (key: string) => key === 'connection'
      ? { fetch: { register: (c: { path: string; fetch: Handler }) => { if (c.path === JET_HUB_API_PATH) handler = c.fetch } } }
      : undefined,
    inject: (_deps: string[], cb: (c: unknown) => void) => { cb(ctx) },
    logger: { warn: (m: string) => { warns.push(m) }, info: () => {} },
    credentials: {
      // 返回 undefined 让逐账号流程走「凭据未配置」分支（**无需真实网络**），
      // 同时它仍能作为「余额查询已开始」的可观测信号。
      resolve: async () => { options.onResolve?.(); return undefined },
    },
  }

  let handler: Handler | undefined
  const pool = {
    listAccounts: async () => options.accounts,
    // ⚠️ `account.refresh` 端点走的是 `listAllAccounts()`（跨 provider 找条目），
    // 与 `credits.balances` 的 `listAccounts(provider)` 不同 —— 两个都要给。
    listAllAccounts: async () => options.accounts,
  }

  // ⚠️ 2026-10-10（合并 master 的 provider 抽象重构）：`registerJetHubRpc` 的
  // 13 个 provider 形参已从**位置传参**改为**命名对象 `auths`**（键 = provider
  // id）。这消除的正是「少传/插队静默错位」那一类缺陷（本仓库历史复发 6 次）。
  // 本 harness 随之改为传对象 —— 少一个键会**编译不过**，而不是静默错位。
  const a = makeAuth
  const auths = {
    codearts: a('codearts'), buddy: a('buddy'), workbuddy: a('workbuddy'),
    lobsterai: a('lobsterai'), qoder: a('qoder'), qodercn: a('qodercn'),
    trae: a('trae'), cline: a('cline'), loomy: a('loomy'),
    raccoon: a('raccoon'), minimax: a('minimax'), zcode: a('zcode'),
    gemini: a('gemini'),
  }
  registerJetHubRpc(
    ctx as never,
    pool as never,
    auths as never,
  )
  if (handler === undefined) throw new Error('endpoint handler was not registered')

  const call = async (method: string, payload: unknown) => {
    const response = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub', payload: { method, payload },
      }),
    }))
    const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
    return body.result
  }

  return { call, calls, warns }
}

describe('credits.balances 的按需自愈（issue IKKHL5 建议 C）', () => {
  it('★ 已过期的账号会先续期再查余额（缺陷本体）', async () => {
    const { call, calls } = setup({ accounts: [expiredEntry({ id: 'a1' })] })

    const result = await call('credits.balances', { provider: 'minimax' })

    expect(calls).toEqual([{ provider: 'minimax', ref: 'MINIMAX_ACCOUNT_1', accountId: 'a1' }])
    // 续期失败不改变端点契约：仍回 ok（逐账号带 error）
    expect(result.ok).toBe(true)
  })

  it('未过期的账号**一个续期请求都不多发**', async () => {
    const fresh = expiredEntry({ id: 'a1', expiresAt: Date.now() + 60 * 60 * 1000 })
    const { call, calls } = setup({ accounts: [fresh] })

    await call('credits.balances', { provider: 'minimax' })

    expect(calls).toEqual([])
  })

  it('expiresAt 缺失（undefined / 0）时不发续期请求', async () => {
    const { call, calls } = setup({
      accounts: [
        expiredEntry({ id: 'a1', expiresAt: undefined }),
        expiredEntry({ id: 'a2', expiresAt: 0 }),
      ],
    })

    await call('credits.balances', { provider: 'minimax' })

    // ⚠️ 与客户端判据逐字一致：`typeof x === 'number' && x > 0 && x <= now`。
    // 读不到过期时间 ≠ 已过期，不得凭空发请求。
    expect(calls).toEqual([])
  })

  it('停用（enabled:false）但已过期的账号**照样自愈**（停用只影响自动选号）', async () => {
    const { call, calls } = setup({ accounts: [expiredEntry({ id: 'a1', enabled: false })] })

    await call('credits.balances', { provider: 'minimax' })

    expect(calls).toHaveLength(1)
  })

  it('★ refreshable:false 也照样自愈（不得拿这个镜像布尔当门禁）', async () => {
    // AGENTS.md 铁律：池里的 refreshable 是**凭据材料的镜像**，可能因一次瞬时
    // 失败被误标成 false；拿它当过滤条件会让账号**永不进入**续期循环。
    // 能否续期由各家 auth 内部按凭据材料判断（缺 refresh_token 时抛
    // 「请重新登录」），本层不预判。
    const { call, calls } = setup({
      accounts: [expiredEntry({ id: 'a1', refreshable: false })],
    })

    await call('credits.balances', { provider: 'minimax' })

    expect(calls).toHaveLength(1)
  })

  it('★ 续期失败**不上抛**：仍回 ok:false/true 由上游决定，并留下 warn', async () => {
    const { call, calls, warns } = setup({
      accounts: [expiredEntry({ id: 'a1' })],
      auths: {
        minimax: async () => { throw new Error('refresh_token 已失效') },
      },
    })

    const result = await call('credits.balances', { provider: 'minimax' })

    // 续期确实被尝试了（不是静默跳过）
    expect(calls).toHaveLength(1)
    // ⚠️ 端点仍成功返回：凭据本来就过期，直连上游必然 401，
    // 让整条积分行报「续期失败」比原来的「HTTP 401」更难懂。
    expect(result.ok).toBe(true)
    // 但必须留痕，否则排障时看不到自愈发生过
    expect(warns.some((w) => w.includes('refresh_token 已失效'))).toBe(true)
  })

  it('★ loomy / zcode / opencode **静默跳过**：不续期、也不留误导性 warn', async () => {
    // ⚠️ 这条原先是「不续期」—— 用 throw + catch 吞掉实现的，于是**每次刷新
    // 面板都为每个过期 loomy 账号刷一条** `自愈续期失败：loomy 不支持…`。
    // loomy 的池内 `expiresAt` 是登录时本地按 14 天推算的固定值
    //（`loomy-auth.ts` 的 LOOMY_SESSION_TTL_SECONDS）、之后永不变更 ⇒ 14 天后
    // **确定可达**，属必然噪音（AGENTS.md：「重复同一行会把有用信息埋掉」）。
    // 故这里同时锁「不发请求」与「不记 warn」两件事 —— 只锁前者会漏掉噪音。
    for (const provider of ['loomy', 'zcode', 'opencode']) {
      const h = setup({ accounts: [expiredEntry({ id: `id-${provider}`, provider })] })
      await h.call('credits.balances', { provider })

      expect(h.calls, `${provider} 不应发起续期`).toEqual([])
      // ⚠️ 关键断言：跳过**不是失败**，不得留下任何告警。
      expect(
        h.warns.filter((w) => w.includes('自愈续期失败')),
        `${provider} 不应把「设计上不支持」记成续期失败`,
      ).toEqual([])
    }
  })

  it('★ 已过期账号必须**先续期、再查余额**（顺序语义，非「顺便发起」）', async () => {
    // ⚠️ 对抗审计实测的盲区：原先把 `await task` 改成 `void task`（不等待），
    // 12 条测试**全绿** —— 而「先续期再查余额」正是本改动存在的理由。
    // 判据：续期**完成**必须早于余额查询**开始**（用事件序列见证，而不是
    // 只看「有没有被调用」）。
    const events: string[] = []
    const { call } = setup({
      accounts: [expiredEntry({ id: 'a1' })],
      auths: {
        minimax: async () => {
          events.push('refresh:start')
          await new Promise((r) => setTimeout(r, 20))
          events.push('refresh:end')
        },
      },
      // 凭据解析是余额查询路径的第一步 ⇒ 它出现即代表「已进入余额查询」。
      onResolve: () => { events.push('balance:resolve') },
    })

    await call('credits.balances', { provider: 'minimax' })

    // ⚠️ 若改成 `void`，balance:resolve 会先于 refresh:end 出现 ⇒ 断言红。
    expect(events).toEqual(['refresh:start', 'refresh:end', 'balance:resolve'])
  })

  it('★ 多账号自愈必须**逐个串行**，不得并行（避免并发触发风控）', async () => {
    // ⚠️ 对抗审计实测的盲区：把循环改成 `Promise.all(accounts.map(...))` 后
    // 17 条测试全绿 —— 而「顺序执行避免并发触发风控」正是本端点既有约定
    //（`collectCreditBalances` 的注释），且并发续期还有轮换 token 的覆盖风险。
    // ⚠️ 单账号用例**测不出**这件事（一个账号时串行与并行不可区分），
    // 故必须用**两个**账号并断言「第二个在第一个结束之后才开始」。
    const events: string[] = []
    const { call } = setup({
      accounts: [expiredEntry({ id: 'a1' }), expiredEntry({ id: 'a2' })],
      auths: {
        minimax: async (_ref, _pool, id) => {
          events.push(`start:${id}`)
          await new Promise((r) => setTimeout(r, 15))
          events.push(`end:${id}`)
        },
      },
    })

    await call('credits.balances', { provider: 'minimax' })

    // 并行时顺序会是 start:a1, start:a2, end:a1, end:a2 ⇒ 断言红。
    expect(events).toEqual(['start:a1', 'end:a1', 'start:a2', 'end:a2'])
  })

  it('★ 同一账号并发自愈只发一次续期请求（在飞去重）', async () => {
    // ⚠️ 对抗审计实测的真实缺陷：本端点是用户可反复触发的（`loadCredits` 有
    // 四个调用点且无重入闸门；徽标每 60s 轮询走同一个 `handleMethod`），
    // 而**续期会轮换 refresh_token** —— 并发会让「后写的把先写的新 token
    // 覆盖成已失效的旧 token」（AGENTS.md 记过 codearts 那次事故）。
    let refreshCount = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { call } = setup({
      accounts: [expiredEntry({ id: 'a1' })],
      auths: {
        minimax: async () => { refreshCount += 1; await gate },
      },
    })

    // 两次「同时」的积分查询（第一次挂在续期上，第二次进来时仍在飞）。
    const first = call('credits.balances', { provider: 'minimax' })
    await new Promise((r) => setTimeout(r, 10))
    const second = call('credits.balances', { provider: 'minimax' })
    await new Promise((r) => setTimeout(r, 10))
    release()
    await Promise.all([first, second])

    expect(refreshCount, '并发自愈必须共享同一次续期').toBe(1)
  })

  it('★ 自愈失败后**放行下一次**（不得把该账号永久焊死）', async () => {
    // 与 `SerialQueue` 的「失败也必须放行下一个」同一条教训：若在失败路径上
    // 忘记从在飞表里删除，一次瞬时失败会让该账号的自愈在本次会话内永不生效。
    let attempts = 0
    const { call, warns } = setup({
      accounts: [expiredEntry({ id: 'a1' })],
      auths: {
        minimax: async () => { attempts += 1; throw new Error('网络抖动') },
      },
    })

    await call('credits.balances', { provider: 'minimax' })
    await call('credits.balances', { provider: 'minimax' })

    expect(attempts, '第二次仍应重试').toBe(2)
    expect(warns.filter((w) => w.includes('网络抖动')).length).toBe(2)
  })

  it('逐账号顺序自愈（顺序查询，避免并发触发风控）', async () => {
    const { call, calls } = setup({
      accounts: [
        expiredEntry({ id: 'a1' }),
        expiredEntry({ id: 'a2', expiresAt: Date.now() + 60_000 }), // 未过期，跳过
        expiredEntry({ id: 'a3' }),
      ],
    })

    await call('credits.balances', { provider: 'minimax' })

    expect(calls.map((c) => c.accountId)).toEqual(['a1', 'a3'])
  })

  it('各家都有自愈分派（codearts / raccoon / gemini 等短寿命 provider）', async () => {
    for (const provider of ['codearts', 'raccoon', 'gemini', 'buddy', 'workbuddy', 'qodercn']) {
      const h = setup({ accounts: [expiredEntry({ id: `id-${provider}`, provider })] })
      await h.call('credits.balances', { provider })
      expect(
        h.calls.map((c) => c.provider),
        `${provider} 未被自愈分派接住`,
      ).toEqual([provider])
    }
  })

  it('qodercn 必须刷**中国版**实例（不能写死 qoder，否则刷错凭据）', async () => {
    // 两站 token 不通用：写死 qoder 会让 CN 永远续不动而国际版被无谓刷一次。
    // 该串用由 `lobsterai-rpc-dispatch.spec.ts` 的行为级用例锁死（反向验证过）。
    const { call, calls } = setup({ accounts: [expiredEntry({ id: 'cn', provider: 'qodercn' })] })

    await call('credits.balances', { provider: 'qodercn' })

    expect(calls).toEqual([{ provider: 'qodercn', ref: 'MINIMAX_ACCOUNT_1', accountId: 'cn' }])
  })

  it('account.refresh 端点仍按 provider 分派（含 loomy / zcode 的探测路径）', async () => {
    const h = setup({ accounts: [expiredEntry({ id: 'r1', provider: 'codearts' })] })

    const result = await h.call('account.refresh', { accountId: 'r1' })

    expect(result.ok).toBe(true)
    expect(h.calls).toHaveLength(1)
  })

  it('★ 未知 provider 报 `Unknown provider`（文案不得语义错位）', async () => {
    // ⚠️ 对抗审计实测的真实缺陷：分派抽成共享表后，default 一度对 loomy /
    // zcode / opencode 抛「不支持在**积分查询前**自动续期」—— 而
    // `account.refresh` 根本没有「积分查询前」这个上下文。
    //
    // ⚠️ 2026-10-10（合并 master）：master 的 provider 抽象重构把这里的文案
    // **改得更精确**了 —— 它区分两种情况（`provider-abstraction-g3-exceptions.md`
    // 登记的有意变更）：
    //   - 未注册的 id      ⇒ `Unknown provider: X`
    //   - 注册了但不支持续期 ⇒ `Provider X 不支持续期（它的凭据不是可续期类型）`
    // opencode 属**后者**（它是已注册的渠道，只是凭据是静态 API key），
    // 故这里断言后者。两种都**不含**「积分查询前」那个错位措辞。
    const h = setup({ accounts: [expiredEntry({ id: 'x1', provider: 'opencode' })] })

    const result = await h.call('account.refresh', { accountId: 'x1' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('opencode')
    expect(result.error?.message).not.toContain('积分查询前')
  })

  it('★ 真正未注册的 provider id 报 `Unknown provider`', async () => {
    const h = setup({ accounts: [expiredEntry({ id: 'y1', provider: 'not-a-channel' })] })

    const result = await h.call('account.refresh', { accountId: 'y1' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('Unknown provider: not-a-channel')
  })

  /**
   * ⚠️ **边界与类型判据**（对抗审计实测的两个测试盲区：改成 `<` 或删掉
   * `typeof` 时**没有任何**用例变红）。这两条不是同义反复，而是分别锁住
   * 「临界时刻算不算过期」与「非数字值不得被 JS 强制转换后误判」。
   */
  it('★ 恰好等于当前时刻算过期（`<=` 边界，不是 `<`）', async () => {
    const now = Date.now()
    const { call, calls } = setup({ accounts: [expiredEntry({ id: 'a1', expiresAt: now })] })

    await call('credits.balances', { provider: 'minimax' })

    // 客户端判据是 `<= Date.now()`；宿主若写成 `<` 会出现「面板说已过期、
    // 宿主却不续期」的分叉（用户点刷新看不到任何自救）。
    expect(calls).toHaveLength(1)
  })

  it('★ 非数字的 expiresAt 不得被强制转换后误判（`typeof` 检查）', async () => {
    // `expiresAt` 可从**用户可编辑的备份文件**导入，而 `sanitizeAccounts`
    // 不过滤该字段 ⇒ 池里可能是数字字符串。保留 `typeof` → 不续期（与客户端
    // 判据一致）；删掉 `typeof` → JS 强制转换判为过期 → 宿主与 UI 行为分叉。
    const { call, calls } = setup({
      accounts: [
        expiredEntry({ id: 's1', expiresAt: '1' as unknown as number }),
        expiredEntry({ id: 's2', expiresAt: '1791559805000' as unknown as number }),
      ],
    })

    await call('credits.balances', { provider: 'minimax' })

    expect(calls, '字符串形式的 expiresAt 不应触发续期').toEqual([])
  })
})

/**
 * ★ `credits.claimAll` 的同一层自愈（issue IKKHL5）。
 *
 * 用户报障的场景里，「积分行报 HTTP 401」旁边**就挂着「一键领取积分」按钮**
 * —— 睡眠/挂起恢复后点它撞的是**同一个** 401。若只修余额查询，会出现
 * 「点刷新能看到余额、点领取却还是 401」这种自相矛盾的症状。
 */
describe('credits.claimAll 的按需自愈（与余额查询同一层）', () => {
  it('★ 已过期账号在领取前也会先续期', async () => {
    const { call, calls } = setup({ accounts: [expiredEntry({ id: 'a1' })] })

    await call('credits.claimAll', { provider: 'minimax' })

    expect(calls.map((c) => c.accountId)).toEqual(['a1'])
  })

  it('★ 领取路径同样要**先续期、再走领取流程**（顺序语义）', async () => {
    // 与余额端点同因：改成 `void` 就等于没修。
    const events: string[] = []
    const { call } = setup({
      accounts: [expiredEntry({ id: 'a1' })],
      auths: {
        minimax: async () => {
          events.push('refresh:start')
          await new Promise((r) => setTimeout(r, 15))
          events.push('refresh:end')
        },
      },
      // 凭据解析是领取流程的第一步 ⇒ 出现即代表「已进入领取」。
      onResolve: () => { events.push('claim:resolve') },
    })

    await call('credits.claimAll', { provider: 'minimax' })

    expect(events).toEqual(['refresh:start', 'refresh:end', 'claim:resolve'])
  })

  it('未过期账号在领取前不多发续期请求', async () => {
    const { call, calls } = setup({
      accounts: [expiredEntry({ id: 'a1', expiresAt: Date.now() + 60 * 60 * 1000 })],
    })

    await call('credits.claimAll', { provider: 'minimax' })

    expect(calls).toEqual([])
  })

  it('不签到的渠道（cline / workbuddy / raccoon）**不因自愈而改变拒绝行为**', async () => {
    // ⚠️ 这三家即使账号已过期也必须仍然返回「不支持签到」的可读错误 ——
    // 自愈不能把守卫的既有语义带偏（也不能因为续期失败就吞掉这条错误）。
    for (const provider of ['cline', 'workbuddy', 'raccoon']) {
      const h = setup({
        accounts: [expiredEntry({ id: `id-${provider}`, provider })],
        // 故意让续期失败：守卫必须在自愈失败后仍然生效。
        auths: { [provider]: async () => { throw new Error('boom') } },
      })
      const result = await h.call('credits.claimAll', { provider })
      expect(result.ok, `${provider} 应仍返回可读错误`).toBe(false)
      expect(result.error?.message).toContain('不支持每日签到')
    }
  })
})