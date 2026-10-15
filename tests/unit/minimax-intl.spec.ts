import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  ALL_MINIMAX_PRODUCTS,
  MINIMAX,
  MINIMAX_INTL,
  minimaxProductById,
} from '../../src/minimax-product.js'
import { MinimaxAuth } from '../../src/minimax-auth.js'
import { MinimaxAdapter } from '../../src/minimax-adapter.js'
import {
  claimMinimaxDailyCheckin,
  fetchMinimaxCreditBalance,
  fetchMinimaxSigninStatus,
} from '../../src/minimax-credits.js'
import { providerOfAccountRef } from '../../src/jet-hub-store.js'
import { descriptorOf } from '../../src/provider-registry.js'
import { createProviderCredits } from '../../src/provider-credits.js'
import type { MinimaxCredential } from '../../src/minimax.js'

/**
 * MiniMax Code **双站点**（`minimax` 中国版 / `minimaxintl` 国际版）的回归防线。
 *
 * ## 为什么这两个是多带个 provider 而不是「一个 provider 加站点参数」
 *
 * 两站的**账号不互通**、且**API 主机与凭据 ref 前缀都不同** —— 这不是「同一个
 * 服务的两个区域」，而是两套账号体系。故照 `qoder` / `qodercn` 的做法用两个
 * provider id（理由与对照表见 `src/minimax-product.ts` 文件头）。
 *
 * ## 本文件守什么
 *
 * 上面那个决定一旦成立，**最大的风险就是两站串号**：
 * - 国际站账号的登录/目录/推理/签到/余额打到 `.cn`（必然 401，且症状是
 *   「国际站账号永远查不到积分」，不指向主机）；
 * - 国际站账号的续期去刷国内站凭据（本仓库「同族串接」复发过 6 次的形态）；
 * - `MINIMAXINTL_ACCOUNT_*` 在 `state.json` 缺失时认不出归属、账号静默消失。
 *
 * 故本文件的断言全部落在**可观测量**上：真实 fetch 收到的 URL 主机、
 * 真实 `apply()` 后的服务实例分派、真实 ref 反查结果。
 *
 * ⚠️ 三项**未真机验证**（本机无国际站账号）：国际站的推理路径、签到端点形状、
 * 兜底模型表。本文件只能锁「我们按同形实现」这个**实现事实**，锁不住
 * 「上游真的同形」—— 后者要 `tests/e2e/minimaxintl-*.e2e.spec.ts` 真机核验。
 * 详见 `src/minimax-product.ts` 文件头的未实测清单。
 */

/** 造一个 JSON `Response`。 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 造一个真实 Cordis Context（`MinimaxAuth` 是 Service，裸对象跑不起来）。 */
function makeContext(
  credentials: {
    resolve?: (ref: unknown) => Promise<{ value: string } | undefined>
    set?: (ref: unknown, value: string) => Promise<void>
  } = {},
): Context {
  const ctx = new Context()
  ctx.provide('credentials', {
    resolve: async () => undefined,
    set: async () => {},
    ...credentials,
  } as never)
  return ctx
}

/** 一条**形状合法**的凭据（`parseMinimaxTokenGrant` 的硬校验要求 scope 含 agent.default）。 */
function credential(): MinimaxCredential {
  return {
    access_token: 'a'.repeat(60),
    refresh_token: 'r'.repeat(60),
    token_type: 'Bearer',
    expires_at: String(Date.now() + 3_600_000),
    scope: 'agent.default',
  }
}

/** 设备码响应（两站同形）。 */
function deviceCodeBody(host: string): Record<string, unknown> {
  return {
    device_code: 'd'.repeat(43),
    user_code: '98FJ-WYXZ',
    verification_uri: `${host}/oauth-authorize`,
    verification_uri_complete: `${host}/oauth-authorize?user_code=98FJ-WYXZ`,
    expires_in: 300,
    interval: 3,
  }
}

/** 一次成功的续期响应。 */
function refreshOk(): Response {
  return json({
    access_token: 'n'.repeat(60),
    refresh_token: 'r2'.repeat(30),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'agent.default',
  })
}

/** 记一次请求的 URL 并回一个给定响应。 */
function recorder(response: () => Response): { seen: string[]; fetcher: typeof fetch } {
  const seen: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    seen.push(String(input))
    return response()
  }) as typeof fetch
  return { seen, fetcher }
}

describe('★ 双站点产品配置：两站只差声明的那几个字段', () => {
  it('中国版：id / 展示名 / 主机 / region / ref 前缀', () => {
    expect(MINIMAX.id).toBe('minimax')
    // ⚠️ 加国际站后展示名**必须带括注** —— 否则左栏会是
    // 「MiniMax Code」+「MiniMax Code (国际版)」，用户看不出前者是国内站。
    expect(MINIMAX.displayName).toBe('MiniMax Code (中国版)')
    expect(MINIMAX.accountHost).toBe('https://account.minimax.cn')
    expect(MINIMAX.apiHost).toBe('https://agent.minimax.cn')
    expect(MINIMAX.region).toBe('cn')
    expect(MINIMAX.defaultCredentialRef).toBe('MINIMAX_ACCESS_TOKEN')
  })

  it('国际版：id / 展示名 / 主机 / region / ref 前缀', () => {
    expect(MINIMAX_INTL.id).toBe('minimaxintl')
    expect(MINIMAX_INTL.displayName).toBe('MiniMax Code (国际版)')
    expect(MINIMAX_INTL.accountHost).toBe('https://account.minimax.io')
    expect(MINIMAX_INTL.apiHost).toBe('https://agent.minimax.io')
    // ⚠️ 目录查询参数按站点不同（国内 cn / 国际 en）。
    expect(MINIMAX_INTL.region).toBe('en')
    // ⚠️ ref 前缀必须与国内站**不同**：否则两站账号共用一个 ref、互相覆盖。
    expect(MINIMAX_INTL.defaultCredentialRef).toBe('MINIMAXINTL_ACCESS_TOKEN')
  })

  /**
   * ★★ **两站只差 6 个字段，其余逐字段相同** —— 这是「不复制任何实现文件」的
   * 前提。哪天有人给国际站单独改一处端点路径，这条会红并指出是哪个字段，
   * 迫使他把「为什么国际站要不一样」写清楚（而不是悄悄分叉）。
   */
  it('★★ 除 6 个已知字段外，两站配置逐字段相同', () => {
    const DIFFERENT = new Set(['id', 'displayName', 'accountHost', 'apiHost', 'region', 'defaultCredentialRef'])
    const keys = Object.keys(MINIMAX) as Array<keyof typeof MINIMAX>
    expect(keys.sort()).toEqual((Object.keys(MINIMAX_INTL) as Array<keyof typeof MINIMAX>).sort())
    for (const key of keys) {
      if (DIFFERENT.has(key)) continue
      expect(MINIMAX_INTL[key], `${key} 两站不该不同（要么改回一致，要么加进 DIFFERENT 并写明理由）`)
        .toEqual(MINIMAX[key])
    }
    // 反向自检：DIFFERENT 里的键必须**确实**不同（防「白名单里塞了个其实相同的键」）。
    for (const key of DIFFERENT) {
      expect(MINIMAX_INTL[key as keyof typeof MINIMAX_INTL],
        `${key} 在两站里相同 ⇒ 它不该留在 DIFFERENT 白名单里`).not.toEqual(MINIMAX[key as keyof typeof MINIMAX])
    }
  })

  it('★★ 两站共用同一份兜底模型表（未按国际站远端采集，见文件头未实测清单）', () => {
    expect(MINIMAX_INTL.fallbackModels).toBe(MINIMAX.fallbackModels)
    // 反向：确认它不是空表（空表会让这条恒真）。
    expect(MINIMAX.fallbackModels.length).toBeGreaterThan(0)
  })

  it('产品注册表含两项，且 minimaxProductById 按 id 命中', () => {
    expect(ALL_MINIMAX_PRODUCTS.map((p) => p.id)).toEqual(['minimax', 'minimaxintl'])
    expect(minimaxProductById('minimax')).toBe(MINIMAX)
    expect(minimaxProductById('minimaxintl')).toBe(MINIMAX_INTL)
    expect(minimaxProductById('nope')).toBeUndefined()
  })

  it('registry 里两站各占一条，且能力声明相同（余额 + 每日签到）', () => {
    expect(descriptorOf('minimax')?.label).toBe('MiniMax Code (中国版)')
    expect(descriptorOf('minimaxintl')?.label).toBe('MiniMax Code (国际版)')
    expect(descriptorOf('minimaxintl')?.logoClass).toBe('minimaxintl')
    expect(descriptorOf('minimaxintl')?.settingsNamespace).toBe('llm-minimaxintl')
    expect(descriptorOf('minimaxintl')?.credits).toEqual(descriptorOf('minimax')?.credits)
    expect(descriptorOf('minimaxintl')?.channel).toBe(true)
  })

  /**
   * ⚠️ `rateLimit` **不得**被显式写成 false：两站共用同一个 `MinimaxAdapter`，
   * 而它自 issue IKJW32 起会写 `modelRateLimits` ⇒ 缺省 `true` 才是对的。
   * 写成 false 会让客户端**不渲染**「重测 / 重置」按钮，于是标记写进去却
   * 清不掉（且用户没有任何入口）。
   */
  it('⚠️ 两站都不许登记 rateLimit: false（它们会写 modelRateLimits）', () => {
    expect(descriptorOf('minimaxintl')?.rateLimit, 'minimaxintl 登记了 rateLimit: false —— 那会让「重测 / 重置」按钮不渲染，而它真的会写限流标记')
      .not.toBe(false)
    expect(descriptorOf('minimax')?.rateLimit, 'minimax 登记了 rateLimit: false').not.toBe(false)
  })
})

describe('★ 凭据 ref 前缀：两站各自可反查（state.json 丢失后的唯一恢复路径）', () => {
  it('MINIMAX_* 与 MINIMAXINTL_* 各自反查到自己那个 provider', () => {
    expect(providerOfAccountRef('MINIMAX_ACCOUNT_ABCDEF')).toBe('minimax')
    expect(providerOfAccountRef('MINIMAXINTL_ACCOUNT_ABCDEF')).toBe('minimaxintl')
  })

  /**
   * ★★ **超串前缀不得抢先匹配**：`MINIMAXINTL` 以 `MINIMAX` 开头，若正则顺序
   * 错了（或没有按长度降序定序），`MINIMAXINTL_ACCOUNT_*` 会被判成 `minimax`
   * —— 于是国际站账号被挂到国内站面板、用国内站主机发请求（必然失败），
   * 而**用户看不出哪里错了**。
   *
   * ⚠️ 判据是「两条 ref 各归各家」而不是「有没有匹配上」：只断言后者的话，
   * 归属错了也照样通过。
   */
  it('★★ `MINIMAXINTL_ACCOUNT_*` 不被 `MINIMAX` 抢先匹配（超串前缀的经典坑）', () => {
    // 同一批 ref 一起反查，逐条断言归属 —— 单查一条容易漏「谁抢了谁」。
    const refs: Array<[string, string]> = [
      ['MINIMAX_ACCOUNT_AAABBB', 'minimax'],
      ['MINIMAXINTL_ACCOUNT_AAABBB', 'minimaxintl'],
    ]
    for (const [ref, want] of refs) {
      expect(providerOfAccountRef(ref), `${ref} 归属错了`).toBe(want)
    }
    // 反向：确认两条**不是**同一个 provider（否则上面两条断言同义反复）。
    expect(providerOfAccountRef('MINIMAX_ACCOUNT_AAABBB'))
      .not.toBe(providerOfAccountRef('MINIMAXINTL_ACCOUNT_AAABBB'))
  })

  it('非账号 ref 形态（单凭据回退 ref）返回 undefined，不被误吞', () => {
    expect(providerOfAccountRef('MINIMAX_ACCESS_TOKEN')).toBeUndefined()
    expect(providerOfAccountRef('MINIMAXINTL_ACCESS_TOKEN')).toBeUndefined()
  })
})

describe('★ 登录：国际站的设备码必须打到 account.minimax.io', () => {
  it('★★ 国际站实例的设备码请求打到 .io', async () => {
    const { seen, fetcher } = recorder(() => json(deviceCodeBody('https://account.minimax.io')))
    const auth = new MinimaxAuth(makeContext(), {
      // ⚠️ 站点由**构造时的 product** 决定（双 id 方案：不需要登录参数，
      //    因为两个站点是两个 provider、各自有实例）。
      product: MINIMAX_INTL,
      fetchImpl: fetcher,
      sleep: async () => {},
    })
    const flow = await auth.startLogin()
    expect(seen[0], '国际站的设备码请求打到了别的主机').toBe('https://account.minimax.io/oauth2/device/code')
    expect(flow.loginUrl).toContain('account.minimax.io')
    // ⚠️ 返回的授权 URL 必须含 user_code（用户点开即完成授权）。
    expect(flow.loginUrl).toContain('user_code=')
    flow.close()
  })

  it('★★ 中国站的设备码请求打到 .cn（不得被国际站的改动带偏）', async () => {
    const { seen, fetcher } = recorder(() => json(deviceCodeBody('https://account.minimax.cn')))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher, sleep: async () => {} })
    const flow = await auth.startLogin()
    expect(seen[0]).toBe('https://account.minimax.cn/oauth2/device/code')
    flow.close()
  })

  it('国际站实例的服务名由 product.id 派生（ctx.minimaxintlAuth）', () => {
    const auth = new MinimaxAuth(makeContext(), { product: MINIMAX_INTL })
    expect(auth.product.id).toBe('minimaxintl')
    // ⚠️ 服务名是 `${product.id}Auth` 即 `minimaxintlAuth`（全小写）——
    // 按变量名驼峰惯例拼成 `minimaxIntlAuth` 会恒 undefined。
    expect((auth as unknown as { name: string }).name).toBe('minimaxintlAuth')
    expect(auth.credentialRefName).toBe('MINIMAXINTL_ACCESS_TOKEN')
  })
})

describe('★ 续期：两站各打各的 accountHost', () => {
  it('★★ 国际站凭据的续期打到 account.minimax.io/oauth2/token', async () => {
    const { seen, fetcher } = recorder(refreshOk)
    const auth = new MinimaxAuth(makeContext(), { product: MINIMAX_INTL, fetchImpl: fetcher })
    const next = await auth.refreshCredentialFor(credential())
    expect(seen[0], '国际站的续期打到了别的主机（症状：国际站账号永远续期失败）')
      .toBe('https://account.minimax.io/oauth2/token')
    expect(next.access_token).toBe('n'.repeat(60))
  })

  it('★★ 中国站凭据的续期打到 account.minimax.cn/oauth2/token', async () => {
    const { seen, fetcher } = recorder(refreshOk)
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher })
    await auth.refreshCredentialFor(credential())
    expect(seen[0]).toBe('https://account.minimax.cn/oauth2/token')
  })
})

describe('★ 远端目录：国际站打 agent.minimax.io + region=en', () => {
  it('★★ 国际站的目录请求主机与 region 都对', async () => {
    const { seen, fetcher } = recorder(() => json({
      providers: [{ providerId: 'minimax', config: { models: { 'MiniMax-M3': { name: 'M3' } } } }],
    }))
    const auth = new MinimaxAuth(makeContext(), { product: MINIMAX_INTL, fetchImpl: fetcher })
    await auth.fetchModelsWith(credential())
    const url = seen[0] ?? ''
    expect(url).toContain('https://agent.minimax.io/mavis/api/v1/models')
    // ⚠️ region 必须跟着站点走（`en`）：写死 `cn` 会让国际站拿到国内站的目录。
    expect(url).toContain('region=en')
    expect(url).toContain('buildEnv=prod')
    expect(url).not.toContain('region=cn')
  })

  it('中国站的目录仍走 .cn + region=cn（零行为变化）', async () => {
    const { seen, fetcher } = recorder(() => json({
      providers: [{ providerId: 'minimax', config: { models: { 'MiniMax-M3': { name: 'M3' } } } }],
    }))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher })
    await auth.fetchModelsWith(credential())
    expect(seen[0]).toContain('https://agent.minimax.cn/mavis/api/v1/models')
    expect(seen[0]).toContain('region=cn')
  })
})

describe('★ 积分：三个入口都要按站点选主机', () => {
  /**
   * ★★ 这一组是「两站分开」最容易漏的一处：三个积分原语都收 `product` 形参，
   * 但调用点（`provider-credits.ts` 的表）**两条表项**必须各传自己那站的配置。
   * 共用一份会让国际站账号的签到/余额打到 `.cn` ⇒ 必然 401，而面板只会显示
   * 「积分查询失败」——用户凭这个提示根本想不到是主机配错。
   */
  it('★★ 国际站的签到状态/领取/余额都打到 agent.minimax.io', async () => {
    const panel = {
      scene: 2,
      days: Array.from({ length: 7 }, (_, i) => ({
        day_no: i + 1, points: 400, bonus_points: 0,
        status: i === 0 ? 3 : 1, is_today: i === 0,
      })),
    }
    // ① 签到状态
    {
      const { seen, fetcher } = recorder(() => json({ data: panel, base_resp: { status_code: 0 } }))
      await fetchMinimaxSigninStatus(credential(), fetcher, MINIMAX_INTL)
      expect(seen[0], '国际站的签到状态打到别的主机').toContain('https://agent.minimax.io/minimax-cloud/api/v1/signin/status')
      // ⚠️ timezone_id 是 query 参数且必填（与国内站同形）。
      expect(seen[0]).toContain('timezone_id=')
    }
    // ② 领取
    {
      const { seen, fetcher } = recorder(() => json({
        data: { claim_result: 1, points: 400, panel },
        base_resp: { status_code: 0 },
      }))
      const outcome = await claimMinimaxDailyCheckin(credential(), fetcher, MINIMAX_INTL)
      expect(seen[0]).toContain('https://agent.minimax.io/minimax-cloud/api/v1/signin/claim')
      expect(outcome.kind).toBe('claimed')
    }
    // ③ 余额
    {
      const { seen, fetcher } = recorder(() => json({
        details: [{ remaining_amount: '800.00' }], total_count: 1,
        base_resp: { status_code: 0 },
      }))
      const balance = await fetchMinimaxCreditBalance(credential(), fetcher, MINIMAX_INTL)
      expect(seen[0]).toContain('https://agent.minimax.io/minimax-cloud/api/v1/credit/details')
      expect(balance?.total).toBe(800)
    }
  })

  it('★★ 生产积分表的两条表项各传自己那站的 product（不是共用一份）', async () => {
    const table = createProviderCredits()
    expect(table.minimax, 'minimax 没进积分表').toBeDefined()
    expect(table.minimaxintl, 'minimaxintl 没进积分表 —— 国际站面板的积分会恒回 unsupported provider')
      .toBeDefined()
    // 三个入口都必须有（漏一个 = 该功能对国际站不可用）。
    expect(table.minimaxintl?.fetchBalance).toBeTypeOf('function')
    expect(table.minimaxintl?.fetchStatus).toBeTypeOf('function')
    expect(table.minimaxintl?.claim).toBeTypeOf('function')
    // ⚠️ 不另立 `claimStatus`：预检与面板读数是同一个端点，只声明一次。
    expect(table.minimaxintl?.claimStatus).toBeUndefined()

    // 行为判据：两条表项的**基线走各自的主机**（stub 掉全局 fetch 观测 URL）。
    const seen: string[] = []
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return json({ base_resp: { status_code: 0 }, total_count: 0 })
    }) as typeof fetch)
    try {
      await table.minimaxintl!.fetchBalance!(credential(), {} as never)
      await table.minimax!.fetchBalance!(credential(), {} as never)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(seen, '国际站表项的余额打到了别的主机').toEqual([
      'https://agent.minimax.io/minimax-cloud/api/v1/credit/details',
      'https://agent.minimax.cn/minimax-cloud/api/v1/credit/details',
    ])
  })
})

describe('★ 推理：国际站打 agent.minimax.io', () => {
  function adapterOf(product: typeof MINIMAX | typeof MINIMAX_INTL): MinimaxAdapter {
    return new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => credential(),
      refresh: async () => {},
      product,
    } as never)
  }

  it('★★ 国际站适配器的 stream 打到 agent.minimax.io/mavis/api/v1/llm/v1/messages', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      // 一个最小的合法 SSE 流（本用例只关心请求发到哪，不关心内容）。
      return new Response(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as typeof fetch)
    try {
      const adapter = adapterOf(MINIMAX_INTL)
      await (async () => {
        for await (const _chunk of adapter.stream({ model: 'MiniMax-M3', messages: [] } as never)) {
          // drain
        }
      })().catch(() => {})
    } finally {
      vi.unstubAllGlobals()
    }
    expect(seen.length, '没有发出推理请求').toBeGreaterThan(0)
    expect(seen[0], '国际站的推理打到了别的主机（症状：国际站账号无法对话）')
      .toBe('https://agent.minimax.io/mavis/api/v1/llm/v1/messages')
  })

  it('中国站适配器的 stream 仍打 agent.minimax.cn（零行为变化）', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch)
    try {
      const adapter = adapterOf(MINIMAX)
      await (async () => {
        for await (const _chunk of adapter.stream({ model: 'MiniMax-M3', messages: [] } as never)) {
          // drain
        }
      })().catch(() => {})
    } finally {
      vi.unstubAllGlobals()
    }
    expect(seen[0]).toBe('https://agent.minimax.cn/mavis/api/v1/llm/v1/messages')
  })
})

/**
 * ★★ **两站不串号**（本双 id 方案的核心风险）。
 *
 * ## 它守的失效形态
 *
 * 本仓库「同族串接」已复发 6 次（`account.refresh` 端点把 A 站的凭据交给 B 站
 * 的实例去续期）。MiniMax 两站**共用同一个 `MinimaxAuth` 类**，故这个风险是
 * 结构性的：`authOf(auths, 'minimaxintl')` 若被接成国内站实例，国际站账号的
 * 续期就会拿国内站主机去发它的 refresh_token —— 而两站账号不互通，**必然失败**，
 * 症状只是「国际站账号一直显示已过期 / 点刷新没反应」，完全指不到接线。
 *
 * ## 判据是「谁被调用」
 *
 * 布桩在两个**独立实例**上（各自记录自己被调用过），驱动真实端点，断言
 * **恰好它自己那个**被调到。这比源码文本断言强：文本只证明那串字符在，
 * 行为能证明实参真的落到了正确的实例上。
 */
describe('★★ 两站账号各刷各的实例（同族串接的核心风险）', () => {
  /** 造一个只记录「我被调用了吗」的 auth 替身。 */
  function stubAuth(log: string[], id: string): { refreshAccountCredential: () => Promise<void> } {
    return { refreshAccountCredential: async () => { log.push(id) } }
  }

  it('国际站账号的续期打到 minimaxintl 实例，**不碰** minimax 实例', async () => {
    const log: string[] = []
    const { registerJetHubRpc, JET_HUB_API_PATH } = await import('../../src/jet-hub-rpc.js')
    let handler: ((req: Request) => Promise<Response>) | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? {
            fetch: {
              register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
                if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
              },
            },
          }
        : undefined,
      inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      emit: () => {},
    }
    const accounts = [{
      id: 'intl-1',
      provider: 'minimaxintl',
      nickname: 'intl',
      enabled: true,
      credentialRef: 'MINIMAXINTL_ACCOUNT_A1',
      createdAt: 1,
      refreshable: true,
    }]
    const pool = {
      listAllAccounts: async () => accounts,
      listAccounts: async (provider: string) => accounts.filter((a) => a.provider === provider),
      updateAccount: async () => {},
    }
    registerJetHubRpc(ctx as never, pool as never, {
      codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
      lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
      trae: {} as never, cline: {} as never, loomy: {} as never,
      raccoon: {} as never, zcode: {} as never, gemini: {} as never,
      officeace: {} as never, accio: {} as never,
      // ★ 两个**不同**的替身，各自记自己那个 id。
      minimax: stubAuth(log, 'minimax') as never,
      minimaxintl: stubAuth(log, 'minimaxintl') as never,
    } as never)
    // ⚠️ 端点经 `ctx.inject` 惰性注册，让出一轮微任务才拿到 handler。
    await new Promise((resolve) => setTimeout(resolve, 0))
    const h = handler
    expect(h, 'jet-hub RPC 端点未注册').toBeDefined()

    const res = await h!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method: 'account.refresh', payload: { accountId: 'intl-1' } },
      }),
    }))
    const body = await res.json() as { result: { ok: boolean; error?: { message?: string } } }
    expect(body.result.ok, `续期应成功，实际 error=${body.result.error?.message}`).toBe(true)
    // ★★ 核心：恰好一个调用，且是**国际站**那个实例。
    expect(log, '国际站账号的续期串到了别的实例（本仓库复发 6 次的形态）').toEqual(['minimaxintl'])
  })

  it('中国站账号的续期打到 minimax 实例，**不碰** minimaxintl 实例', async () => {
    const log: string[] = []
    const { registerJetHubRpc, JET_HUB_API_PATH } = await import('../../src/jet-hub-rpc.js')
    let handler: ((req: Request) => Promise<Response>) | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? {
            fetch: {
              register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
                if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
              },
            },
          }
        : undefined,
      inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      emit: () => {},
    }
    const accounts = [{
      id: 'cn-1',
      provider: 'minimax',
      nickname: 'cn',
      enabled: true,
      credentialRef: 'MINIMAX_ACCOUNT_A1',
      createdAt: 1,
      refreshable: true,
    }]
    const pool = {
      listAllAccounts: async () => accounts,
      listAccounts: async (provider: string) => accounts.filter((a) => a.provider === provider),
      updateAccount: async () => {},
    }
    registerJetHubRpc(ctx as never, pool as never, {
      codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
      lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
      trae: {} as never, cline: {} as never, loomy: {} as never,
      raccoon: {} as never, zcode: {} as never, gemini: {} as never,
      officeace: {} as never, accio: {} as never,
      minimax: stubAuth(log, 'minimax') as never,
      minimaxintl: stubAuth(log, 'minimaxintl') as never,
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const h = handler
    expect(h, 'jet-hub RPC 端点未注册').toBeDefined()

    const res = await h!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method: 'account.refresh', payload: { accountId: 'cn-1' } },
      }),
    }))
    const body = await res.json() as { result: { ok: boolean } }
    expect(body.result.ok).toBe(true)
    expect(log, '中国站账号的续期串到了国际站实例').toEqual(['minimax'])
  })
})
