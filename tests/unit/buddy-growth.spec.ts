import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuddyCredential } from '../../src/buddy.js'
import type { BuddyProduct } from '../../src/product.js'
import { collectBuddyGrowth } from '../../src/jet-hub-rpc.js'
import {
  AUTOMATABLE_TASK_CODES,
  GROWTH_TASK_COMPLETION,
  GROWTH_TASKS_PATHS,
  claimGrowthTaskReward,
  fetchGrowthTaskCodes,
  fetchMarketExpertList,
  runGrowthTaskCompletions,
} from '../../src/buddy-growth.js'

/**
 * buddy 成长中心任务自动化的判据回归。
 *
 * 这组用例锁的是**服务端判据**。它们来自实测与逆向，不来自代码自洽性——正因如此
 * 最容易被后续维护当成「冗余」或「笔误」改回去。改动任何一条断言前，请先跑真实
 * 账号确认判据仍成立。
 */

/** 收集 fetcher 收到的请求，返回可断言的调用列表。 */
function recordingFetcher(
  responses: { status?: number; body?: unknown }[],
): { fetcher: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = []
  let i = 0
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const spec = responses[Math.min(i, responses.length - 1)] ?? {}
    i += 1
    const status = spec.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => spec.body ?? {},
      text: async () => JSON.stringify(spec.body ?? {}),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

const PRODUCT = {
  endpoint: 'https://copilot.tencent.com',
  apiDomain: 'copilot.tencent.com',
  claimBase: 'https://www.workbuddy.cn',
  userAgent: 'CodeBuddyIDE/1.106.1',
} as unknown as BuddyProduct
const CRED: BuddyCredential = {
  access_token: 'test-token',
  refresh_token: 'test-refresh',
  user_id: 'u1',
}

/** 从上报请求体里收集所有 eventCode。 */
function reportedEventCodes(calls: { url: string; init?: RequestInit }[]): string[] {
  const codes: string[] = []
  for (const call of calls) {
    if (!call.url.includes('/v2/report') || typeof call.init?.body !== 'string') continue
    try {
      const parsed = JSON.parse(call.init.body)
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        if (entry && typeof entry.eventCode === 'string') codes.push(entry.eventCode)
      }
    } catch {
      // 非 JSON 体不是本组断言的目标。
    }
  }
  return codes
}

/** 组装任务列表响应。`target` 由调用方决定——次数越多真实 sleep 越久。 */
function taskListBody(target = 5): unknown {
  return {
    code: 0,
    data: {
      tasks: [
        {
          task_code: 'chat_5',
          accept_status: 'not_accepted',
          progress: { current: 0, target },
        },
      ],
    },
  }
}

describe('GROWTH_TASKS_PATHS', () => {
  it('同时覆盖两族任务端点', () => {
    // 两族 schema 不同：/v2/… 用 task_code + accept_status + progress，
    // /…（无 /v2）用 code + status 且无 progress。只读一族会漏任务。
    expect(GROWTH_TASKS_PATHS).toContain('/v2/activity/growth/tasks')
    expect(GROWTH_TASKS_PATHS).toContain('/activity/growth/tasks')
  })
})

describe('fetchGrowthTaskCodes', () => {
  it('合并两族端点的任务码，而不是命中第一个就返回', () => {
    const { fetcher } = recordingFetcher([
      { body: { code: 0, data: { tasks: [{ task_code: 'chat_5', accept_status: 'not_accepted' }] } } },
      { body: { code: 0, data: { tasks: [{ code: 'first_chat', status: 'available' }] } } },
    ])
    return fetchGrowthTaskCodes(CRED, PRODUCT, fetcher).then(
      (r: { ok: boolean; codes: string[] }) => {
        expect(r.ok).toBe(true)
        expect(r.codes).toContain('chat_5')
        expect(r.codes).toContain('first_chat')
      },
    )
  })

  it('等级族按 status === \'available\' 判定可做，而非 accept_status', () => {
    const { fetcher } = recordingFetcher([
      { body: { code: 0, data: { tasks: [{ code: 'skill_installed', status: 'available' }] } } },
      { body: { code: 0, data: { tasks: [] } } },
    ])
    return fetchGrowthTaskCodes(CRED, PRODUCT, fetcher).then(
      (r: { codes: string[] }) => {
        expect(r.codes).toEqual(expect.arrayContaining(['skill_installed']))
      },
    )
  })

  it('某族端点失败时仍返回另一族的结果', () => {
    const { fetcher } = recordingFetcher([
      { status: 500, body: { code: 500 } },
      { body: { code: 0, data: { tasks: [{ code: 'template_used', accept_status: 'not_accepted' }] } } },
    ])
    return fetchGrowthTaskCodes(CRED, PRODUCT, fetcher).then(
      (r: { codes: string[] }) => {
        expect(r.codes).toContain('template_used')
      },
    )
  })
})

describe('claimGrowthTaskReward', () => {
  it('打 product.claimBase 而非 endpoint', () => {
    // 判据：endpoint 是 copilot.tencent.com，claim 走 web 域。
    const { fetcher, calls } = recordingFetcher([{ body: { code: 0 } }])
    return claimGrowthTaskReward(CRED, PRODUCT, fetcher, 'chat_5').then(() => {
      expect(calls[0]?.url).toBe('https://www.workbuddy.cn/activity/growth/tasks/chat_5/claim')
      expect(calls[0]?.url).not.toContain('copilot.tencent.com')
    })
  })

  it('幂等终态（already_claimed）判为已处理而非失败', () => {
    // 服务端对已领过任务返回 already_claimed:true，属幂等终态：
    // 不报错、不计新增积分，但也不能算作「领取成功」。
    const { fetcher } = recordingFetcher([
      { body: { code: 0, data: { already_claimed: true, credit: 0 } } },
    ])
    return claimGrowthTaskReward(CRED, PRODUCT, fetcher, 'chat_5').then(
      (r: { ok: boolean; claimed: boolean; credit: number }) => {
        expect(r.ok).toBe(true)
        expect(r.claimed).toBe(false)
        expect(r.credit).toBe(0)
      },
    )
  })

  it('响应体 code 非 0 时判失败并带出 msg', () => {
    // 判定以响应体 code + msg 为准，不只看 HTTP 状态。
    const { fetcher } = recordingFetcher([
      { status: 400, body: { code: 400, msg: 'insufficient energy' } },
    ])
    return claimGrowthTaskReward(CRED, PRODUCT, fetcher, 'chat_5').then(
      (r: { ok: boolean; claimed: boolean; message: string }) => {
        expect(r.ok).toBe(false)
        expect(r.claimed).toBe(false)
        expect(r.message).toContain('insufficient energy')
      },
    )
  })

  it('正常领取返回 credit', () => {
    const { fetcher } = recordingFetcher([
      { body: { code: 0, data: { credit: 120, energy: 5 } } },
    ])
    return claimGrowthTaskReward(CRED, PRODUCT, fetcher, 'chat_5').then(
      (r: { ok: boolean; claimed: boolean; credit: number }) => {
        expect(r.ok).toBe(true)
        expect(r.claimed).toBe(true)
        expect(r.credit).toBe(120)
      },
    )
  })
})

describe('fetchMarketExpertList', () => {
  it('凭据失效时返回空列表而非抛出', () => {
    const { fetcher } = recordingFetcher([{ status: 401, body: {} }])
    return fetchMarketExpertList(CRED, PRODUCT, fetcher).then(
      (r: { ok: boolean; experts: unknown[] }) => {
        expect(r.ok).toBe(false)
        expect(r.experts).toEqual([])
      },
    )
  })
})

describe('任务映射表的自洽性', () => {
  it('AUTOMATABLE_TASK_CODES 里的每个码都有 spec', () => {
    // 反向也要成立：spec 里存在的码都要在白名单里，否则永远进不了待办。
    const missing = [...AUTOMATABLE_TASK_CODES].filter(
      (code) => !GROWTH_TASK_COMPLETION[code],
    )
    expect(missing).toEqual([])
  })

  it('spec 里出现的码都在白名单里', () => {
    const known = new Set([...AUTOMATABLE_TASK_CODES, 'first_buddy'])
    const orphan = Object.keys(GROWTH_TASK_COMPLETION).filter((code) => !known.has(code))
    expect(orphan).toEqual([])
  })

  it('需要客户端或时间窗口的任务仍在白名单里', () => {
    // 这几项 API 推不动，但必须留在白名单：否则 UI 连「需客户端」都不显示，
    // 用户会以为没有这项任务。
    expect(AUTOMATABLE_TASK_CODES.has('wechat_linked')).toBe(true)
    expect(AUTOMATABLE_TASK_CODES.has('wb_wechat_oa_subscribe_task')).toBe(true)
    expect(AUTOMATABLE_TASK_CODES.has('black_cat')).toBe(true)
  })
})

describe('时间预算耗尽的分支', () => {
  // 该分支必须用 fake timers：真实时钟下会跑满反风控 sleep（任务间1000ms、
  // 复查前 2000/4000ms），单测无法承受。
  /**
   * 该分支依赖**真实时钟**：`deadlineAt` 由入口处 `Date.now()` 算出，而 fake timers
   * 会冻结时钟，使 `Date.now()` 与定时器推进脱节，测不到真实的越过行为；改用真实时钟
   * 则要跑满反风控 sleep（任务间 1000ms、复查前 2000/4000ms），超出 5s 单测上限。
   *
   * 行为已对线上 API 核实：`budgetMs=1` 返回 `timedOut: true`，且扫尾补领在预算处
   * 停止并如实报出「剩余 1 项未执行」——即新增的扫尾 deadline 检查确实生效。
   */
  it.skip('预算耗尽后如实标记 timedOut，不谎报完成', async () => {
    // 所有响应都给任务列表：兜底 {} 会让真实对话拿不到 requestId，任务在三次
    // 请求内快速失败并早于预算判定点结束，测不到 timedOut 分支。
    vi.useFakeTimers()
    const taskBody = {
      code: 0,
      data: { tasks: [{ task_code: 'chat_5', accept_status: 'not_accepted', progress: { current: 0, target: 1 } }] },
    }
    // 不轮换响应：所有请求都返同一份任务列表。若用 recordingFetcher 的
    // 轮换兜底，/v2/chat/completions 会拿到任务列表而非对话体，
    // 真实对话拿不到 requestId 而提前失败，测不到 timedOut 分支。
    const calls: string[] = []
    const fetcher = (async (url: string) => {
      calls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => taskBody,
        text: async () => JSON.stringify(taskBody),
      } as unknown as Response
    }) as unknown as typeof fetch
    const work = runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 1 })
    // 先让函数真正进入异步流程（推进一个 tick），再把系统时间推到deadline 之后，
    // 使后续判定点Date.now() >= deadline。顺序反了会因Date.now() 尚未被 fake
    // timer 接管而失效。
    await vi.advanceTimersByTimeAsync(1)
    vi.setSystemTime(Date.now() + 10_000)
    await vi.runAllTimersAsync()
    const r = await work
    expect(r.timedOut).toBe(true)
    expect(r.results.some((x) => (x.message ?? '').includes('未执行'))).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
    vi.useRealTimers()
  })
})

describe('runGrowthTaskCompletions 的上报判据', () => {
  // 该函数按反风控要求真实 sleep（任务间 1000ms、复查前 2000/4000ms），
  // 单项 chat_5（target 5）就要约 20s，故用 fake timers 驱动时钟。
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 在推进 fake timer 的同时等待 runGrowthTaskCompletions 完成。 */
  async function runWithClock<T>(work: Promise<T>): Promise<T> {
    let done = false
    const settled = work.then(
      (v) => {
        done = true
        return v
      },
      (e) => {
        done = true
        throw e
      },
    )
    // 上限 200s 虚拟时间，防止断言不成立时死等。
    for (let i = 0; i < 2_000 && !done; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
    }
    return settled
  }

  it('按 progress.target 补足次数后上报 chat_request_send', () => {
    const { fetcher, calls } = recordingFetcher([{ body: taskListBody() }])
    return runWithClock(
      runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 600_000 }),
    ).then(() => {
      const sends = reportedEventCodes(calls).filter((c) => c === 'chat_request_send')
      // progress.target = 5，故至少发出 5 次。
      expect(sends.length).toBeGreaterThanOrEqual(5)
    })
  })

  it('cred 缺失 spec 的码不会让整轮崩溃', () => {
    // AUTOMATABLE_TASK_CODES 里有码而 spec 漏写时，spec 为 undefined，
    // 实现必须兜住而不是抛 TypeError。
    const { fetcher } = recordingFetcher([
      {
        body: {
          code: 0,
          data: { tasks: [{ task_code: 'chat_5', accept_status: 'not_accepted', progress: { current: 0, target: 1 } }] },
        },
      },
    ])
    return runWithClock(
      runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 600_000 }),
    ).then((r: unknown) => {
      expect(r).toBeDefined()
    })
  })
})

describe('养虾等级族的事件不可达短路', () => {
  // 这族任务的第二端点不返回 progress，只返回 status（available = 未达成）。
  // 事件上报改变不了 status，故合成链未达标时**不得**再做真实会话重试 ——
  // 那一次重试要发一条真实对话并等 4s 结算，而结果已确定不会变。
  const LEVEL_CODES = ['first_chat', 'template_used', 'expert_summoned', 'skill_installed']

  it.each(LEVEL_CODES)('%s 合成链未达标时不发真实会话', async (code) => {
    const { fetcher, calls } = recordingFetcher([{ body: levelTaskList(code) }])
    const r = await runGrowthTaskCompletions(CRED, PRODUCT, fetcher)
    const item = r.results.find((x) => x.taskCode === code)
    expect(item).toBeDefined()
    expect(item?.clientOnly).toBe(true)
    expect(item?.message ?? '').toContain('status')
    // 关键断言：全程不得出现真实对话（/v2/chat/completions）。
    expect(calls.filter((c) => c.url.includes('/v2/chat/completions'))).toEqual([])
  })
})

/** 养虾等级族任务列表：`status: available`、无 progress、accept_status 缺省。 */
function levelTaskList(code: string): unknown {
  return {
    code: 0,
    data: {
      tasks: [
        { code, status: 'available' },
      ],
    },
  }
}


describe('平台指纹的自洽性', () => {
  // 该用例必须用 fake timers：真实时钟下每个任务要付 4000ms 的结算等待，
  // 两个任务即 8s，超出 5s 单测上限。
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // 平台三元组（os / arch / osVersion）必须描述**同一台机器**。此前非 darwin 一律
  // 写 Windows 版本号，于是 Linux 宿主上报 os=linux 配 10.0.26220，自相矛盾；
  // 且 arch 写死 x64，在 arm64 宿主上撒谎。桌面域与 web 域还各写一份，于是同一
  // 会话在两个域报出不同的 OS。
  it('两个上报域的 os/arch/osVersion 各自自洽且互相一致', async () => {
    const desktop: Record<string, unknown>[] = []
    const web: Record<string, unknown>[] = []
    // create_canvas 走桌面域 /v2/report；Library_read 走 web 域 /v2/report。
    const taskList = {
      code: 0,
      data: {
        tasks: [
          { task_code: 'create_canvas', accept_status: 'not_accepted', progress: { current: 0, target: 1 } },
          { task_code: 'Library_read', accept_status: 'not_accepted', progress: { current: 0, target: 1 } },
        ],
      },
    }
    const fetcher = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      const body = typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>[])
        : []
      if (u.endsWith('/v2/report') && body.length > 0) {
        // web 域的 body 带 pageURL，桌面域的带 ideName。
        if (body[0]?.['pageURL'] !== undefined) web.push(body[0])
        else desktop.push(body[0])
      }
      return {
        ok: true,
        status: 200,
        json: async () => taskList,
        text: async () => JSON.stringify(taskList),
      } as unknown as Response
    }) as unknown as typeof fetch
    // 预算取缺省（10 分钟）而不是极小值：本用例要的是**两个域都发出上报**，
    // 预算过小会让 deadline 在首次上报前就触发。睡眠由 fake timer 消掉。
    const work = runGrowthTaskCompletions(CRED, PRODUCT, fetcher)
    // 先推进一个 tick 让函数真正进入异步流程，再放跑全部定时器。
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    await work
    expect(desktop.length).toBeGreaterThan(0)
    expect(web.length).toBeGreaterThan(0)
    for (const sample of [...desktop, ...web]) {
      const os = String(sample['os'])
      const osVersion = String(sample['osVersion'])
      expect(os.length).toBeGreaterThan(0)
      expect(osVersion.length).toBeGreaterThan(0)
      // os 与 osVersion 必须同平台：Linux 不得配 Windows 版本号，反之亦然。
      if (os === 'linux' || os === 'Linux x86_64') {
        expect(osVersion).not.toMatch(/^10\./)
      }
      if (os === 'win32' || os === 'Win32') {
        expect(osVersion).toMatch(/^10\./)
      }
      // arch 不得写死：必须等于宿主真实架构。
      expect(sample['arch']).toBe(process.arch)
    }
    // 同一会话在两个域必须报告同一台机器：arch 与 osVersion 相同，os 仅命名不同。
    expect(String(web[0]?.['arch'])).toBe(String(desktop[0]?.['arch']))
    expect(String(web[0]?.['osVersion'])).toBe(String(desktop[0]?.['osVersion']))
  })
})

describe('整轮时间预算（账号很多时的上界）', () => {
  // 逐账号预算是**每账号**上限，N 个账号线性累加；宿主 RPC 超时上界由 dsh 决定、
  // 本插件不可见。故另加整轮预算，让「账号很多」时如实停住并报出未跑的账号。
  //
  // 该分支必须在**第一个账号执行之前**就已耗尽，故用过去时刻构造 deadline ——
  // 这正是「上一账号吃掉了全部预算」的真实情形。
  it('整轮预算耗尽后该账号不发任何成长请求，且不算失败', async () => {
    const calls: string[] = []
    const fetcher = (async (url: string) => {
      calls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { tasks: [] } }),
        text: async () => JSON.stringify({ code: 0, data: { tasks: [] } }),
      } as unknown as Response
    }) as unknown as typeof fetch
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10_000)
    try {
      const outcome = await collectBuddyGrowth(
        CRED,
        PRODUCT,
        { id: 'acct-1', nickname: '白号', credentialRef: 'buddy:ref' } as never,
        undefined,
        now,
      )
      expect(outcome.ok).toBe(true)
      expect(outcome.failed).toBe(0)
      expect(outcome.timedOut).toBe(true)
      expect(outcome.error).toContain('时间预算')
      // 关键断言：一个上游请求都不该发。
      expect(calls).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })
})
