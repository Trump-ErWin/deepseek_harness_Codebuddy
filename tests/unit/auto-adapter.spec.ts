/**
 * `src/auto-adapter.ts` 的缺陷回归（PR !69 审计实测，2026-10-06）。
 *
 * ## 为什么要单独守这个
 *
 * PR !69 新增 669 行「单一 auto 模型 + 按积分到期时间跨 provider 选型」，**零单测**。
 * 本仓库对「静默降级 / 误导性报错 / 关掉却仍在用」零容忍（见 AGENTS.md），而本文件
 * 恰好集中了这三类缺陷。以下 5 条**均由审计阶段实际跑通生产代码复现**，不是推断。
 *
 * ## 五条约定
 *
 * 1. **目录全空/全被关闭 ⇒ 该 provider 退出候选**，绝不发出 `'auto'` 这种
 *    「别的 provider 的模型名」（必然 404，且绕过用户的模型开关）。
 * 2. **账号都在、只是积分全是永久/长期 ⇒ 不得报「请先登录」**。
 * 3. **abort 必须以 AbortError 结束**，不得被降级成 `MISSING_CREDENTIAL`。
 * 4. **倍率解析必须有分隔符**：`Spark X2.5` 是模型名，不是「x2.5 倍」。
 * 5. **代表账号必须跳过限流标记的账号**：空 modelId 会让
 *    `getAvailableAccount` 的限流过滤整体短路（`account-pool.ts:1051`），
 *    于是「手动序第一个号正限流」会被误当成该 provider 的真实余额。
 *
 * ⚠️ 用例必须驱动**真实调用链**（`prepareCall` → 返回的 `call.stream`），
 * 直接调内部私有方法会绕过真实路径 —— 那正是 PR !66 的教训。
 * ⚠️ 替身的 `listModels` **必须复刻真实适配器的过滤行为**（`filter(!disabled)`，
 * 见 `zcode-adapter.ts:445-448`），否则第 1 条会是同义反复。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { AutoAdapter, pickSoonestProvider, priceFactorFromName } from '../../src/auto-adapter.js'

const here = dirname(fileURLToPath(import.meta.url))
const adapterSource = readFileSync(resolve(here, '../../src/auto-adapter.ts'), 'utf8').replace(/\r\n/g, '\n')

/** 一条纯文本用户消息（content 必须是块数组，否则 `contentHasImage` 抛错）。 */
function userMessage(text = 'hi'): { role: 'user'; content: Array<{ type: 'text'; text: string }> } {
  return { role: 'user', content: [{ type: 'text', text }] }
}

interface HarnessOptions {
  /** provider → 目录（**已按关闭名单过滤**，复刻真实适配器行为）。 */
  catalogs?: Record<string, Array<{ id: string; name: string }>>
  /** provider → 关闭的模型 id 集合。 */
  disabled?: Record<string, ReadonlySet<string>>
  /** provider → 该 provider 的代表账号到期时刻（毫秒）；`null` = 无可用账号。 */
  expiries?: Record<string, number | null>
  /** 目录读取时实际返回的原始账号（用于第 5 条断言取号参数）。 */
  pool?: { getAvailableAccount: (provider: string, model: string) => Promise<unknown> }
}

/** 驱动真实 `prepareCall` → `call.stream` 链路，返回实际发往的 `provider/model`。 */
async function dispatchThrough(options: HarnessOptions): Promise<{ sent: string[]; error?: { code?: string; name?: string } }> {
  const sent: string[] = []
  const catalogs = options.catalogs ?? {}
  const disabled = options.disabled ?? {}
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    llm: {
      listModels: async (provider: string) => catalogs[provider] ?? [],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: (o: { provider: string; model: string }) => {
        sent.push(`${o.provider}/${o.model}`)
        return (async function* () { /* 无输出即可 */ })()
      },
    },
  }
  const pool = options.pool ?? {
    getAvailableAccount: async (provider: string) => (
      (options.expiries ?? {})[provider] === null ? null : { entry: { id: `${provider}-a1` }, credential: { token: 't' } }
    ),
    // ⚠️ 必须提供：firstModelOf 会调它过滤已关闭模型。
    disabledModelsFor: (provider: string) => (options.disabled ?? {})[provider] ?? new Set<string>(),
  }
  const adapter = new AutoAdapter(ctx as never, {
    accountPool: pool as never,
    now: () => 1_000,
    ttlMs: 0,
  })
  // 余额探测隔离：到期时刻由用例给定，避免真实网络。
  // ⚠️ 只桩 `expiryOf` 的**余额折算**部分对 selectProvider 不可见 ——
  //   故此处改为让 expiryOf 直接返回用例给定的时刻（selectProvider 仍会
  //   自行调用 firstModelOf 判定「目录是否有可调用模型」）。
  adapter.expiryOf = async (provider: string) => {
    const table = options.expiries ?? {}
    return table[provider] === null || table[provider] === undefined ? -1 : (table[provider] as number)
  }
  try {
    const call = await adapter.prepareCall('jet-hub-auto', 'auto')
    const iterable = call.stream({ messages: [userMessage()] } as never)
    // ⚠️ 必须**真正消费**这个 AsyncIterable：`ctx.llm.stream` 是在迭代时才被调用的，
    // 不 drain 就断言 `sent` 会得到空数组（这是本文件初版写法的坑）。
    for await (const _chunk of iterable) { /* noop */ }
    return { sent }
  } catch (error) {
    return { sent, error: error as { code?: string; name?: string; message?: string } }
  }
}

describe('auto：模型目录全空 / 全被关闭时不得发出别的 provider 的模型名', () => {
  it('用户关闭全部模型后，auto 不发出 `zcode/auto` 这种必然 404 的请求', async () => {
    const disabled = new Set(['GLM-5.3-Flash', 'GLM-5.3'])
    const { sent, error } = await dispatchThrough({
      // 真实 `listModels` 内部已 filter(!disabled) ⇒ 全关时返回空目录
      catalogs: { zcode: [], buddy: [{ id: 'deepseek-v4-flash', name: 'DS v4 Flash' }] },
      disabled: { zcode: disabled },
      expiries: { zcode: 5, buddy: 9 },
    })

    // ⛔ 回归前：sent = ['zcode/auto']（把字符串 'auto' 当成 zcode 的模型发出去）。
    expect(sent.some((s) => s === 'zcode/auto')).toBe(false)
    expect(sent.some((s) => s.endsWith('/auto'))).toBe(false)
    // 目录为空即「该 provider 没有可调用的模型」⇒ 要么退出候选，要么如实报错，
    // 绝不能把请求发往一个用户已明确禁用的模型。
    for (const target of sent) {
      expect(disabled.has(target.split('/')[1] ?? '')).toBe(false)
    }
    // 若报错，必须是清晰的本地错误，而不是让请求打上去再 404。
    if (sent.length === 0) {
      expect(error?.code).toBe('INVALID_MODEL' as never)
    }
  })

  it('源码级：兜底不得回落到 `AUTO_MODEL`（那会把模型名当 provider 的模型发出）', () => {
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // ❌ 回归前的两处：兜底取 AUTO_MODEL、以及把 AUTO_MODEL 当返回值。
    expect(code).not.toMatch(/AUTO_FALLBACK_MODELS\[provider\]\s*\?\?\s*AUTO_MODEL/)
    expect(code).not.toMatch(/disabled\.has\(fallback\)\s*\?\s*AUTO_MODEL\s*:\s*fallback/)
  })
})

describe('auto：账号都正常只是没有临期额度时，不得报「请先登录」', () => {
  it('全部 provider 都是永久/长期积分（NEVER）时，报错文案不误导为未登录', async () => {
    const { sent, error } = await dispatchThrough({
      catalogs: { buddy: [{ id: 'deepseek-v4-flash', name: 'DS v4 Flash' }] },
      expiries: { buddy: Number.POSITIVE_INFINITY },
    })
    // 账号正常 ⇒ 必须能发出请求（而不是 MISSING_CREDENTIAL）。
    expect(error?.code).not.toBe('MISSING_CREDENTIAL')
    expect(sent).toContain('buddy/deepseek-v4-flash')
  })

  it('排序：全部 NEVER 时仍应选出一个（只有 UNUSABLE 才剔除）', () => {
    // ❌ 回归前：全 NEVER ⇒ best 恒为 undefined ⇒ 整个 auto 不可用。
    expect(pickSoonestProvider([['buddy', Number.POSITIVE_INFINITY]])).toBe('buddy')
    expect(pickSoonestProvider([['buddy', Number.POSITIVE_INFINITY], ['loomy', Number.POSITIVE_INFINITY]]))
      .toBe('buddy')
    // UNUSABLE(-1) 仍然必须被剔除 —— 这是与上一条配套的另一半约定。
    expect(pickSoonestProvider([['buddy', -1], ['loomy', -1]])).toBeUndefined()
    // 临期优先的主约定不能被破坏。
    expect(pickSoonestProvider([['buddy', 900], ['loomy', 100]])).toBe('loomy')
  })
})

describe('auto：取消请求必须以 AbortError 结束，而不是降级成「请先登录」', () => {
  it('已 abort 的 signal 不得产出 MISSING_CREDENTIAL', async () => {
    const controller = new AbortController()
    controller.abort()
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async () => [],
        resolveModelInfo: async () => ({ provider: 'x', id: 'y' }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () { /* noop */ })()
        },
      },
    }
    const pool = {
      getAvailableAccount: async () => { throw new Error('探测失败') },
      disabledModelsFor: () => new Set<string>(),
    }
    const adapter = new AutoAdapter(ctx as never, { accountPool: pool as never, now: () => 1_000, ttlMs: 0 })
    // 余额探测在 abort 下也应立即中止，而不是折算成「该 provider 不可用」。
    adapter.expiryOf = async () => Number.POSITIVE_INFINITY

    let caught: { code?: string; name?: string } | undefined
    try {
      const call = await adapter.prepareCall('jet-hub-auto', 'auto', controller.signal)
      call.stream({ messages: [userMessage()] } as never)
    } catch (error) {
      caught = error as { code?: string; name?: string }
    }
    // ⛔ 回归前：code = 'MISSING_CREDENTIAL'、name = 'LlmError'、文案是「请先登录」。
    expect(caught?.code).not.toBe('MISSING_CREDENTIAL')
    expect(caught?.name === 'AbortError' || caught?.code === 'ABORTED').toBe(true)
    expect(sent).toHaveLength(0)
  })

  it('源码级：`expiryOf` 不得把已中止折算成 UNUSABLE', () => {
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // ❌ 回归前这一行让 abort 被吞成「该 provider 不可用」。
    expect(code).not.toMatch(/signal\?\.aborted\s*===\s*true\s*\)\s*return\s+UNUSABLE/)
  })
})

describe('auto：倍率解析必须有分隔符，不得把模型名里的 x 当倍率', () => {
  // ⚠️ 直接调用**生产函数**（已 export），不在测试里复刻正则 ——
  // 复刻会变成「测我的副本」，正是 AGENTS.md 第 8 条点名的同义反复。
  it('`Spark X2.5`（无倍率标注）解析为无标注，而不是 2.5 倍', () => {
    // ❌ 回归前：`/[×x]\s*(\d+(?:\.\d+)?)\s*$/i` ⇒ 返回 2.5。
    expect(priceFactorFromName('Spark X2.5')).toBe(Number.POSITIVE_INFINITY)
  })

  it('真实倍率标注仍能正确解析（含促销箭头形态）', () => {
    expect(priceFactorFromName('DeepSeek V4 Flash 0731 · x3.0')).toBeCloseTo(3.0)
    expect(priceFactorFromName('GLM 5.3 Flash · x0.8')).toBeCloseTo(0.8)
    expect(priceFactorFromName('Kimi k2.6 · x6.5')).toBeCloseTo(6.5)
    expect(priceFactorFromName('GLM 5.3 Flash · ×0.8')).toBeCloseTo(0.8)
    expect(priceFactorFromName('Hy4 preview · 免费')).toBe(0)
    // 无标注的模型名（不该被误判）
    expect(priceFactorFromName('GLM-5.3-Flash')).toBe(Number.POSITIVE_INFINITY)
    expect(priceFactorFromName('Hy4 preview')).toBe(Number.POSITIVE_INFINITY)
    // 促销形态（`formatCreditsRate`，buddy.ts:701）：取**促销后**的实际计费倍率。
    expect(priceFactorFromName('Deepseek-V4.1-Flash · x0.17→x0.03')).toBeCloseTo(0.03)
  })

  it('行为级：同池里「有倍率标注的便宜模型」必须胜过「名字里带 x 的贵模型」', async () => {
    // 这是用户可见的失效形态：初版会把 Spark X2.5 当 2.5 倍，于是 0.8 的模型
    // 排在它后面 —— auto「挑最便宜」反而挑了最贵的。
    const { sent, error } = await dispatchThrough({
      catalogs: {
        loomy: [
          { id: 'spark-x', name: 'Spark X2.5' },
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash · x0.8' },
        ],
      },
      expiries: { loomy: 100 },
    })
    expect(error?.code).not.toBe('MISSING_CREDENTIAL')
    expect(sent).toEqual(['loomy/glm-5.3-flash'])
  })
})

describe('auto：代表账号必须跳过正在限流的账号', () => {
  it('取代表账号时不得用空 modelId（会让限流过滤整体短路）', async () => {
    const modelIds: string[] = []
    const pool = {
      getAvailableAccount: async (_provider: string, model: string) => {
        modelIds.push(model)
        return { entry: { id: 'a1' }, credential: { token: 't' } }
      },
      disabledModelsFor: () => new Set<string>(),
    }
    const adapter = new AutoAdapter(
      {
        logger: { warn: () => {}, error: () => {} },
        llm: {
          listModels: async () => [{ id: 'm1', name: 'M1' }],
          resolveModelInfo: async () => ({ provider: 'p', id: 'm1' }),
          stream: () => (async function* () { /* noop */ })(),
        },
      } as never,
      { accountPool: pool as never, now: () => 1_000, ttlMs: 0 },
    )
    // ⚠️ 不打桩 expiryOf：本条就是要验「探测阶段」的取号参数。
    await adapter.expiryOf('buddy')
    expect(modelIds).toHaveLength(1)
    // ⛔ 回归前：modelIds = [''] ⇒ `if (modelId.length === 0) return true`
    //           ⇒ modelRateLimits 里所有限流标记被跳过（account-pool.ts:1049-1055）。
    expect(modelIds[0]).not.toBe('')
  })

  it('源码级：不得出现空 model 的 getAvailableAccount 取号', () => {
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/getAvailableAccount\(\s*provider\s*,\s*''\s*\)/)
  })
})

/**
 * ★★ 胜者必须在**将要派发的那个模型**上还有可用账号（真实缺陷，2026-10-07）。
 *
 * ## 缺陷机制
 *
 * 「额度耗尽」在账号池里**按 modelId 记账**（`entry.modelRateLimits[modelId]`；
 * codearts 的 benefit 免费额度耗尽就写在那里，`llm-adapter.ts:1290`）。而
 * **生产装配**注入的 `sharedExpiryProbe` 取号用的是「目录第一个模型」
 *（`index.ts` 的 `firstModelIdOf`：`models[0]?.id`），**不是** `firstModelOf`
 * 挑出来的那个（按倍率最便宜）⇒ 两者不同时，按 modelId 的过滤**整体失效**。
 *
 * ⚠️ 这**推翻**了 `index.ts` 那段「共享带来的语义松弛**已核实无害**」的注释：
 * 它假设 `probeModel` 不参与折算结果、故与派发无关 —— 但它**参与账号池的
 * 限流过滤**，而那正是「这个模型还能不能用」的判据。
 */
describe('★★ auto：胜者必须在将要派发的模型上仍有可用账号', () => {
  /** 目录：第一个 `glm-5.3-flash`（无倍率），第二个更便宜（x0.1）⇒ firstModelOf 选后者。 */
  const CATALOG = [
    { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.1' },
  ]

  /** 池：账号在 `blocked` 这个模型上额度已尽（= 真实 `modelRateLimits` 判据）。 */
  const gatedPool = (blocked: string) => ({
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async (_p: string, modelId: string) => (
      modelId === blocked ? null : { entry: { id: 'A' }, credential: { token: 't' } }
    ),
  })

  const makeAuto = (pool: unknown) => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async () => CATALOG,
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () { /* noop */ })()
        },
      },
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: pool as never,
      now: () => 1_000,
      ttlMs: 0,
    })
    // 余额折算隔离：只桩「最早失效时刻」，取号/可用性判据仍走真实逻辑。
    adapter.expiryOf = async (provider: string) => (provider === 'codearts' ? 100 : -1)
    return { adapter, sent }
  }

  const run = async (adapter: AutoAdapter): Promise<{ code?: string } | undefined> => {
    try {
      const call = await adapter.prepareCall('jet-hub-auto', 'auto')
      for await (const _ of call.stream({ messages: [userMessage()] } as never)) { /* drain */ }
      return undefined
    } catch (error) {
      return error as { code?: string }
    }
  }

  it('★★ 最便宜的模型上额度已尽 ⇒ 不得选中该 provider（退出候选，不静默成功）', async () => {
    // ⛔ 回归前：`expiryOf` 只报临期值（100）⇒ codearts 当选 ⇒ 请求发往
    //    `deepseek-v4.1-flash`，而该模型上账号额度已尽 ⇒ 上游必然失败。
    //    修后：该 provider 退出候选 ⇒ 无候选 ⇒ 如实报错（而不是发一个必然失败的请求）。
    const { adapter, sent } = makeAuto(gatedPool('deepseek-v4.1-flash'))
    const error = await run(adapter)
    expect(sent, '该模型上无可用账号 ⇒ 不得发请求').toEqual([])
    // ⚠️ 报错码沿用「无可用候选」的既有语义（与 zcode 余额 0 被剔除时同一条路径）。
    expect(error?.code).toBe('MISSING_CREDENTIAL')
  })

  it('★ 对照：不设额度标记 ⇒ 正常选中（证明差异来自可用性，不是别的）', async () => {
    const { adapter, sent } = makeAuto(gatedPool('__none__'))
    await run(adapter)
    expect(sent).toEqual(['codearts/deepseek-v4.1-flash'])
  })

  it('★ 只标记**别的**模型 ⇒ 不影响（判据按将要派发的模型精确匹配）', async () => {
    const { adapter, sent } = makeAuto(gatedPool('glm-5.3-flash'))
    await run(adapter)
    // 被标记的是 `glm-5.3-flash`，而实际要派发 `deepseek-v4.1-flash` ⇒ 仍可选中。
    expect(sent).toEqual(['codearts/deepseek-v4.1-flash'])
  })

  it('★ 池未实现 `getAvailableAccount` ⇒ 跳过过滤（不可把整池误剔除）', async () => {
    const { adapter, sent } = makeAuto({ disabledModelsFor: () => new Set<string>() })
    await run(adapter)
    expect(sent).toEqual(['codearts/deepseek-v4.1-flash'])
  })

  it('★ 池查询抛错 ⇒ 视为可用（一次异常不得让渠道整体消失）', async () => {
    const { adapter, sent } = makeAuto({
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => { throw new Error('池异常') },
    })
    await run(adapter)
    expect(sent).toEqual(['codearts/deepseek-v4.1-flash'])
  })

  it('★★ 中止必须逃逸：池抛 `{ code: "ABORTED" }`（**无 `name`**）也要中止', async () => {
    // ⚠️⚠️ 真实缺陷（对抗审计实测证伪，2026-10-07）：我上一版只判 `name === 'AbortError'`，
    //    注释还声称「与 `filterByModelAvailability` 同口径」—— 而后者用共享
    //    `isAbortLike`，判**三条**（`signal.aborted` / `name` / **`code === 'ABORTED'`**）。
    //    只判 `name` 时，`code` 形态的中止会被**吞成「视为可用」并继续发请求** ——
    //    正是本仓库反复记录的那类缺陷（「同族判据必须逐格同构」）。
    const { adapter, sent } = makeAuto({
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => { throw Object.assign(new Error('cancelled'), { code: 'ABORTED' }) },
    })
    const error = await run(adapter)
    expect(sent, '中止不得继续发请求').toEqual([])
    expect(error?.code, '应原样上抛该错误（而不是吞掉）').toBe('ABORTED')
  })

  it('★ 中止必须逃逸：池抛 `AbortError`（`name` 形态）', async () => {
    const { adapter, sent } = makeAuto({
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      },
    })
    const error = await run(adapter)
    expect(sent, '中止不得继续发请求').toEqual([])
    expect(error?.name).toBe('AbortError')
  })
})

/**
 * ★★ 带图**改道**路径也必须按将要派发的模型复核可用性（真实缺陷，2026-10-07）。
 *
 * ⚠️ 这是同一缺陷的**第三处实例**（独立审计实测证伪）：主选型路径
 *（`selectProvider`）与聚合建池路径（`filterByModelAvailability`）都已补复核，
 * 但 `prepareCall` 里选 `imageTarget` 的那个循环**漏了** ⇒ 一个「支持图片但额度
 * 已尽」的渠道仍会被选成改道目标，带图请求发出去必然失败。
 *
 * 可达性真实：buddy 既声明 `['text','image']`（`buddy-adapter.ts:1272`）
 * **又**会写 `modelRateLimits`（`:1922`）。
 */
describe('★★ auto：带图改道路径也必须按派发模型复核可用性', () => {
  /** buddy 不支持图片（当胜者）、codearts 支持图片但额度已尽。 */
  const makeImageWorld = (codeartsBlocked: boolean) => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        // ⚠️ `providerSupportsImages` 读的是 **`listModels` 返回的 `inputModalities`**
        //（`auto-adapter.ts:429-433`），**不是** `resolveModelInfo` —— 我第一版桩错了位置，
        // 导致「全池都不支持图片」而对照组也失败。
        listModels: async (p: string) => (p === 'codearts'
          ? [{ id: 'vision-model', name: 'Vision', inputModalities: ['text', 'image'] }]
          : [{ id: 'text-model', name: 'Text', inputModalities: ['text'] }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () { /* noop */ })()
        },
      },
    }
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async (p: string, modelId: string) => (
        codeartsBlocked && p === 'codearts' && modelId === 'vision-model'
          ? null
          : { entry: { id: 'a1' }, credential: { token: 't' } }
      ),
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: pool as never,
      now: () => 1_000,
      ttlMs: 0,
    })
    // buddy 临期更早 ⇒ 它当选（但它不支持图片）；codearts 是唯一能收图的候选。
    adapter.expiryOf = async (provider: string) => (provider === 'buddy' ? 100 : 900)
    return { adapter, sent }
  }

  /** ⚠️ 必须用 `makeImageWorld` 闭包里的 `sent`（我第一版在这里新建了一个，导致断言恒空）。 */
  const runWithImage = async (adapter: AutoAdapter): Promise<void> => {
    const call = await adapter.prepareCall('jet-hub-auto', 'auto')
    // 带图消息 ⇒ 触发 stream 闭包里的改道逻辑。
    for await (const _ of call.stream({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA==' } },
        ],
      }],
    } as never)) { /* drain */ }
  }

  it('★★ 唯一能收图的渠道额度已尽 ⇒ 不得改道过去（不得发必然失败的请求）', async () => {
    const { adapter, sent } = makeImageWorld(true)
    // ⚠️ 额度已尽的 codearts 被剔除 ⇒ 无改道目标 ⇒ 如实报错（而不是发一个必然失败的请求）。
    await expect(runWithImage(adapter)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(sent, 'codearts 在 vision-model 上无可用账号 ⇒ 不得改道过去').toEqual([])
  })

  it('★ 对照：不设额度标记 ⇒ 正常改道到支持图片的 codearts', async () => {
    const { adapter, sent } = makeImageWorld(false)
    await runWithImage(adapter)
    expect(sent).toEqual(['codearts/vision-model'])
  })
})

/**
 * ★★ B 方案：目标「收下请求却零输出」时顺位改道下一个 provider（issue IKJW31）。
 *
 * ## 缺陷机制
 *
 * 上游声明的窗口比真实墙大（loomy 的 `spark-x` 虚报 1M、真实 256K）⇒ 宿主按
 * 虚高窗口打包 ⇒ 越墙后上游**收下请求但 0 输出** + `finish_reason=length` ⇒
 * 插件报 `max-tokens`，而 DSH 对它**不自动重试** ⇒ 整轮静默失败。
 *
 * A 方案修了已知的那一处虚报；**本组守住与「哪一家虚报」无关的运行时兜底**。
 *
 * ## ⚠️ 两条方向相反的边界（本组必须同时守住）
 *
 * 1. `max-tokens` + **零输出** ⇒ 改道（否则静默失败，即本 issue）；
 * 2. `max-tokens` + **有输出** ⇒ **绝不改道**（否则丢掉已产出的正文 —— 而那才是
 *    `max-tokens` 更常见的含义：「正常答到半截撞了输出上限」）。
 *
 * 第 2 条是本次改动的最大风险点，故它与第 1 条同等重要。两处都用**真实调用链**
 * （`prepareCall` → `call.stream`）驱动，不打桩内部私有方法。
 */
describe('★★ auto：零输出撞墙时改道下一个 provider（B 方案）', () => {
  /** 让 `loomy` 最先当选（临期最早），`zcode` 次之。 */
  const CATALOGS = {
    loomy: [{ id: 'spark-x', name: 'Spark X2.5 · x0.1' }],
    zcode: [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash · x0.8' }],
  }

  /**
   * 造一个世界：`loomy` 的流按 `loomyChunks` 产出，`zcode` 正常出正文。
   *
   * ⚠️ `now` 是**可变**的（返回对象上的 `setNow`），用来验证冷却「到期自动恢复」
   * 与「冷却期内跳过」两种状态 —— 用固定时钟无法区分它们。
   */
  function makeWorld(loomyChunks: Array<{ type: string; reason?: { kind?: string } }>) {
    const sent: string[] = []
    let now = 1_000_000
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => CATALOGS[provider as keyof typeof CATALOGS] ?? [],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          const chunks = o.provider === 'loomy'
            ? loomyChunks
            : [
                { type: 'block-start', index: 0, blockType: 'text' },
                { type: 'text-delta', index: 0, text: 'ok' },
                { type: 'finish', reason: { kind: 'stop' } },
              ]
          return (async function* () { for (const c of chunks) yield c })()
        },
      },
    }
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { token: 't' } }),
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: pool as never,
      now: () => now,
      ttlMs: 0,
    })
    // loomy 临期更早 ⇒ 它当选；其余 provider 无候选（-1 = UNUSABLE）。
    adapter.expiryOf = async (provider: string) => (provider === 'loomy' ? 100 : provider === 'zcode' ? 200 : -1)
    return { adapter, sent, setNow: (v: number) => { now = v } }
  }

  /** 驱动真实链路并收集**最终看到的** chunk 序列。 */
  async function run(adapter: AutoAdapter): Promise<Array<{ type: string; reason?: { kind?: string } }>> {
    const seen: Array<{ type: string; reason?: { kind?: string } }> = []
    const call = await adapter.prepareCall('jet-hub-auto', 'auto')
    for await (const chunk of call.stream({ messages: [userMessage()] } as never)) {
      seen.push(chunk as { type: string; reason?: { kind?: string } })
    }
    return seen
  }

  /** 上游越墙的真实 chunk 形态：一个 usage + `max-tokens` 终止帧，**零内容**。 */
  const WALL_HIT = [
    { type: 'usage' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]

  it('★★ 零输出撞墙 ⇒ 改道下一个 provider 重发（不再静默失败）', async () => {
    const { adapter, sent } = makeWorld(WALL_HIT)
    const seen = await run(adapter)
    // 先打 loomy 撞墙，再改道 zcode 成功。
    expect(sent).toEqual(['loomy/spark-x', 'zcode/glm-5.3-flash'])
    // ⚠️ 关键：**不得**把 loomy 那个 max-tokens 终止帧透给 harness ——
    //    透出去 harness 就认为本轮结束了（它不重试 max-tokens），改道白做。
    expect(seen.filter((c) => c.type === 'finish').map((c) => c.reason?.kind)).toEqual(['stop'])
    // 用户看到的是 zcode 的正文。
    expect(seen.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('★★ 反向：`max-tokens` 但**有输出** ⇒ 绝不改道（否则丢正文）', async () => {
    // 这是 `max-tokens` 更常见的含义：模型答到半截撞了**输出上限**，应当原地续写。
    const { adapter, sent } = makeWorld([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '半截回答' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    const seen = await run(adapter)
    // ⛔ 若判据漏了「零输出」这一条，sent 会变成两个（正文被丢弃后重发）。
    expect(sent, '有输出时不得改道').toEqual(['loomy/spark-x'])
    expect(seen.some((c) => c.type === 'text-delta')).toBe(true)
    expect(seen.filter((c) => c.type === 'finish').map((c) => c.reason?.kind)).toEqual(['max-tokens'])
  })

  it('★ 正常 stop ⇒ 不改道（不得为「没有撞墙」的情形多发请求）', async () => {
    const { adapter, sent } = makeWorld([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const seen = await run(adapter)
    expect(sent).toEqual(['loomy/spark-x'])
    expect(seen.filter((c) => c.type === 'finish').map((c) => c.reason?.kind)).toEqual(['stop'])
  })

  it('★ 改道后**下一个请求**跳过该目标（跨请求冷却，防 60 秒选型缓存三连撞）', async () => {
    const { adapter, sent } = makeWorld(WALL_HIT)
    await run(adapter)
    expect(sent).toEqual(['loomy/spark-x', 'zcode/glm-5.3-flash'])

    // ⚠️ 第 2 个请求：`ttlMs: 0` ⇒ 每次都重新选型。loomy 已进冷却 ⇒ 不得再撞。
    //    （报障实测 t14/t15/t16 在 46 秒内三连撞同一堵墙，正是缺了这一层。）
    sent.length = 0
    await run(adapter)
    expect(sent, 'loomy 在冷却期内不得再被选中').toEqual(['zcode/glm-5.3-flash'])
  })

  it('★ 冷却到期后自动恢复（不得把一次误判永久固化）', async () => {
    const { adapter, sent, setNow } = makeWorld(WALL_HIT)
    await run(adapter)
    sent.length = 0
    // 越过 10 分钟冷却窗口 ⇒ loomy 重新参与候选（临期更早，故它又当选）。
    setNow(1_000_000 + 10 * 60 * 1000 + 1)
    await run(adapter)
    expect(sent, '冷却到期后应重新尝试 loomy').toEqual(['loomy/spark-x', 'zcode/glm-5.3-flash'])
  })

  it('★ 池内无其他候选 ⇒ 如实透出 max-tokens，不吞掉失败', async () => {
    // 只有 loomy 可用 ⇒ 无从改道 ⇒ 必须如实上报（不得静默成功、不得伪装 stop）。
    const { adapter, sent } = makeWorld(WALL_HIT)
    adapter.expiryOf = async (provider: string) => (provider === 'loomy' ? 100 : -1)
    const seen = await run(adapter)
    expect(sent).toEqual(['loomy/spark-x'])
    expect(seen.filter((c) => c.type === 'finish').map((c) => c.reason?.kind)).toEqual(['max-tokens'])
  })

  it('★ 不会改道回自己（否则会立刻再撞一次同一堵墙）', async () => {
    const { adapter, sent } = makeWorld(WALL_HIT)
    // zcode 也判 UNUSABLE ⇒ 唯一候选就是 loomy，而它已被排除 ⇒ 不得重发。
    adapter.expiryOf = async (provider: string) => (provider === 'loomy' ? 100 : -1)
    await run(adapter)
    // ⛔ 若 `replaceAfterZeroOutput` 没排除当前目标，sent 会是两个 loomy。
    expect(sent.filter((s) => s === 'loomy/spark-x')).toHaveLength(1)
  })

  /**
   * ★★ 冷却必须**穿透 60 秒选型缓存**（否则本方案形同虚设）。
   *
   * ⚠️ 上面那组用例都用 `ttlMs: 0`（每次真选型），**测不出这个缺陷**——
   * 而生产用的是 `AUTO_CHOICE_TTL_MS`（60 秒）。缺了这一层时，每个请求都会先按
   * 缓存**撞一次同一堵墙**（撞完才改道），「别再撞同一堵墙」的价值全部落空。
   * 报障实测 t14/t15/t16 在 46 秒内三连撞，正是这个形态。
   *
   * ⚠️ 故本条刻意**不传 `ttlMs`**（用生产默认值），这是它与上面几条的关键区别。
   */
  it('★★ 冷却必须穿透 60 秒选型缓存（生产 TTL 下不得再撞一次）', async () => {
    const sent: string[] = []
    let now = 1_000_000
    const catalogs: Record<string, Array<{ id: string; name: string }>> = {
      loomy: [{ id: 'spark-x', name: 'Spark X2.5 · x0.1' }],
      zcode: [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash · x0.8' }],
    }
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => catalogs[provider] ?? [],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          const chunks = o.provider === 'loomy'
            ? WALL_HIT
            : [
                { type: 'block-start', index: 0, blockType: 'text' },
                { type: 'text-delta', index: 0, text: 'ok' },
                { type: 'finish', reason: { kind: 'stop' } },
              ]
          return (async function* () { for (const c of chunks) yield c })()
        },
      },
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { token: 't' } }),
      } as never,
      now: () => now,
      // ⚠️ **刻意不传 ttlMs** ⇒ 用生产默认 60 秒缓存（本条的考点）。
    })
    adapter.expiryOf = async (p: string) => (p === 'loomy' ? 100 : p === 'zcode' ? 200 : -1)

    const run = async () => {
      const call = await adapter.prepareCall('jet-hub-auto', 'auto')
      for await (const _ of call.stream({ messages: [userMessage()] } as never)) { /* drain */ }
    }

    await run()
    expect(sent).toEqual(['loomy/spark-x', 'zcode/glm-5.3-flash'])

    // 第 2 个请求：仍在 60 秒缓存窗口内（now 未动）。
    // ⛔ 若 `ensureChoice` 不查冷却，这里会**又撞一次 loomy**（缓存命中）。
    sent.length = 0
    await run()
    expect(sent, '缓存窗口内也不得再撞冷却中的目标').toEqual(['zcode/glm-5.3-flash'])
  })
})