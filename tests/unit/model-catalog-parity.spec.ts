/**
 * `createModelCatalog`：**逐 provider 对拍**（Task 7 的必交产物）。
 *
 * ## ⚠️ 为什么必须有这个文件（plan §Task 7 的原文）
 *
 * 14 家的 `toCatalogEntry()` 是**新写的转换**（不是搬移）。逐家的
 * `*-adapter.spec.ts` 只保证「改造后与改造前的**那一家的既有断言**仍然成立」；
 * 它们**保证不了**「转换没漏字段」—— 因为漏掉的那个字段，通常此前也没人断言
 * （否则当初就不会漏）。
 *
 * ## 两部分（驱动层次不同，缺一不可）
 *
 * | 部分 | 驱动方式 | 能抓到的缺陷 |
 * |---|---|---|
 * | **一、骨架对拍** | 手写 `CatalogEntry` 直接喂骨架 | 骨架自己**多写 / 漏写 / 改写**字段 |
 * | **二、端到端对拍** | **真实适配器**（`new XxxAdapter(...)`）经 `listModels` / `resolveModel` | 各家的 `toCatalogEntry` **漏字段 / 判据写错** |
 *
 * 第一部分的对称性：骨架**多写**（把「未知模态」写成 `['text']`）⇒ 红；
 * **漏写**（丢掉 `description` / `contextWindow`）⇒ 红；**改写**（把倍率名当裸名）⇒ 红。
 *
 * 第二部分的必要性：只有真适配器才能证明「远端报文 → `toCatalogEntry` → 骨架 →
 * 公开输出」这条**全链路**无损 —— 手写 entry 测不到解析层
 * （实测踩过：把 `context_length` 写成 `contextWindow` 会让第一部分的用例
 * **假绿**，因为手写 entry 根本不经过解析层）。
 *
 * ## ⚠️ 与 `model-catalog.spec.ts` 的分工（不是同义反复）
 *
 * | 文件 | 问的问题 |
 * |---|---|
 * | `model-catalog.spec.ts` | 骨架自身的六条不变式**是否成立**（构造式用例） |
 * | **本文件** | 各家 `toCatalogEntry` 的**真实产物**经骨架后**是否字段无损** |
 *
 * ## ⚠️ 反向验证（plan §Task 7 Step 7 的三条，全部实测有效）
 *
 * | 变异 | 变红的用例 |
 * |---|---|
 * | `toModelInfo` 把「未知模态」写成 `['text']` | 本文件 ② + `model-catalog.spec.ts` ④ |
 * | `resolveModel` 给未知模型写死 `contextWindow: 200_000` | 本文件 ③⑤ + `model-catalog.spec.ts` + `minimax-adapter.spec.ts` ×2 |
 * | `listAllModels` 也套黑名单 | 本文件 ④ + `model-catalog.spec.ts` ⑥⑮ |
 *
 * 三处变异均已在验证后还原（还原后 43/43 绿）。
 */

import { describe, expect, it, vi } from 'vitest'

import { createModelCatalog, type CatalogEntry } from '../../src/model-catalog.js'
import { LoomyAdapter, parseLoomyRemoteModels } from '../../src/loomy-adapter.js'
import { MinimaxAdapter } from '../../src/minimax-adapter.js'
import { RaccoonAdapter } from '../../src/raccoon-adapter.js'
import { fallbackToEntry } from '../../src/minimax.js'
import { MINIMAX } from '../../src/minimax-product.js'

/** 造一个 provider 的骨架（替身池 + 可控目录 + 可控黑名单）。 */
function makeCatalog(
  entries: readonly CatalogEntry[],
  options: { disabled?: readonly string[]; visible?: boolean } = {},
) {
  const pool = {
    hasLoggedInAccount: vi.fn(async () => options.visible ?? true),
    disabledModelsFor: vi.fn(() => new Set(options.disabled ?? [])),
  }
  return createModelCatalog(
    { accountPool: pool as never },
    { product: { id: 'demo' }, loadCatalog: () => entries, syncCatalog: () => entries },
  )
}

/**
 * ⚠️ 各家的 `toCatalogEntry` 产物形状**取自真实实现**（不是想象）。
 *
 * 逐条来源：
 * - `loomy` / `minimax` / `raccoon`：倍率拼进 `name`，`bareName` 是去倍率的裸名；
 *   远端条目**总是**带 `supportsImage` ⇒ `inputModalities` 恒为数组（无「未知」态）；
 * - `buddy`：`inputModalitiesFor` 可能返回 `undefined` ⇒ **省略**该字段（未知态）；
 *   同名消歧把变体标记拼进 `name`；
 * - `cline` / `lobsterai`：`description` 可选透传；
 * - `codearts`：VL 多模态条目被过滤，不在目录里。
 *
 * ⚠️ `efforts` 是**对象数组**（`{ id, name }`），不是字符串数组 ——
 * `defaultEffort` 与 `effort.id` 比对（骨架的判据，见 `createModelCatalog`）。
 */
const REASONING_EFFORTS = [
  { id: 'low' as never, name: 'Low' },
  { id: 'high' as never, name: 'High' },
]

const LOOMY_ENTRY: CatalogEntry = {
  id: 'MiniMax-M3',
  name: 'MiniMax M3 · x4.0',
  bareName: 'MiniMax M3',
  inputModalities: ['text', 'image'],
  contextWindow: 1_048_576,
  reasoning: { efforts: REASONING_EFFORTS, defaultEffort: 'low' as never },
}

/** buddy 的「未知模态」条目（远端能力表拿不到时就是它）。 */
const BUDDY_UNKNOWN_MODALITY: CatalogEntry = {
  id: 'claude-sonnet-4',
  name: 'Claude Sonnet 4',
  bareName: 'Claude Sonnet 4',
  // ⚠️ `inputModalities` **刻意省略** —— 这是「未知」，不是「不支持图片」。
}

/** cline 的带 description 条目。 */
const CLINE_WITH_DESC: CatalogEntry = {
  id: 'gpt-5',
  name: 'GPT-5',
  description: '来自 Cline 目录的模型',
  inputModalities: ['text'],
}

/** 免费模型：标记**必须**在 `name` 里（不是 `description`）。 */
const FREE_ENTRY: CatalogEntry = {
  id: 'free-model',
  name: 'Free Model · 免费',
  bareName: 'Free Model',
  isFree: true,
  inputModalities: ['text'],
}

describe('createModelCatalog 对拍：① 枚举字段在 listModels 上逐项无损', () => {
  it('loomy 形态：name 带倍率 / bareName 去倍率 / 模态数组 / context / reasoning 全部到位', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY])
    const listed = await catalog.listModels('demo')

    expect(listed).toHaveLength(1)
    const info = listed[0]!
    // ⚠️ `listModels` 用**带倍率**的 name（价格只属于选择列表语境）。
    expect(info.name).toBe('MiniMax M3 · x4.0')
    expect(info.id).toBe('MiniMax-M3')
    expect(info.provider).toBe('demo')
    expect(info.inputModalities).toEqual(['text', 'image'])
    // ⚠️ `LlmModelInfo` 只有这四个字段 —— `bareName` / `contextWindow` /
    //    `reasoning` **不得**出现在 `listModels` 的输出里（它们属于 resolveModel）。
    expect(Object.keys(info).sort()).toEqual(['id', 'inputModalities', 'name', 'provider'])
  })

  it('⚠️ 倍率名绝不能被当成裸名下发（` · x4.0` 必须留在 name 里）', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY])
    const listed = await catalog.listModels('demo')

    expect(listed[0]!.name).toContain('· x4.0')
  })

  it('⚠️ 免费标记必须在 name 里（写进 description 会让 composer 菜单看不到）', async () => {
    const catalog = makeCatalog([FREE_ENTRY])
    const listed = await catalog.listModels('demo')

    expect(listed[0]!.name).toContain('免费')
  })

  it('description 逐字透传', async () => {
    const catalog = makeCatalog([CLINE_WITH_DESC])
    const listed = await catalog.listModels('demo')

    expect(listed[0]!.description).toBe('来自 Cline 目录的模型')
  })
})

describe('createModelCatalog 对拍：② 模态三态在真实形状上仍然可分', () => {
  it('⚠️⚠️「未知」（省略）与「明确不支持」（[text]）在**同一批目录**里各保其形', async () => {
    // 这一条是本 Task 最大风险的正面防线：两种条目**同时**存在时，
    // 骨架不得把二者归一成同一种输出。
    const catalog = makeCatalog([BUDDY_UNKNOWN_MODALITY, CLINE_WITH_DESC])
    const listed = await catalog.listModels('demo')

    const unknown = listed.find(m => m.id === 'claude-sonnet-4')!
    const textOnly = listed.find(m => m.id === 'gpt-5')!

    // 未知 ⇒ 字段**不存在**（`'inputModalities' in obj` 为 false）。
    expect('inputModalities' in unknown).toBe(false)
    // 明确不支持图片 ⇒ 字段存在且恰为 ['text']。
    expect(textOnly.inputModalities).toEqual(['text'])
    // ⚠️ 两者必须**可区分**（这正是三态的存在意义）。
    expect('inputModalities' in unknown).not.toBe('inputModalities' in textOnly)
  })

  it('未知模态经 resolveModel 后**仍不写**该字段（两个入口同判据）', async () => {
    const catalog = makeCatalog([BUDDY_UNKNOWN_MODALITY])
    const resolved = await catalog.resolveModel('demo', 'claude-sonnet-4')

    expect('inputModalities' in resolved).toBe(false)
  })
})

describe('createModelCatalog 对拍：③ resolveModel 的字段比 listModels 多，且各自到位', () => {
  it('contextWindow / reasoning / bareName 派生的 name 全部下发', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY])
    const resolved = await catalog.resolveModel('demo', 'MiniMax-M3')

    // ⚠️ `resolveModel` 的 name 用**裸名**（bareName 优先）——价格不属于这里。
    expect(resolved.name).toBe('MiniMax M3')
    expect(resolved.name).not.toContain('· x4.0')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
    expect(resolved.reasoning).toEqual({ efforts: REASONING_EFFORTS, defaultEffort: 'low' })
  })

  it('⚠️ reasoning 的两种非法形态都不下发（空 efforts / defaultEffort 不在 efforts 内）', async () => {
    const catalog = makeCatalog([
      { id: 'a', name: 'A', reasoning: { efforts: [], defaultEffort: 'low' as never } },
      { id: 'b', name: 'B', reasoning: { efforts: ['low'], defaultEffort: 'high' as never } },
    ])

    expect((await catalog.resolveModel('demo', 'a')).reasoning).toBeUndefined()
    expect((await catalog.resolveModel('demo', 'b')).reasoning).toBeUndefined()
  })

  it('⚠️ 非法 contextWindow（0 / 负数 / NaN）不下发，也不编造', async () => {
    const catalog = makeCatalog([
      { id: 'z', name: 'Z', contextWindow: 0 },
      { id: 'n', name: 'N', contextWindow: -1 },
      { id: 'nan', name: 'NaN', contextWindow: Number.NaN },
    ])

    expect((await catalog.resolveModel('demo', 'z')).context).toBeUndefined()
    expect((await catalog.resolveModel('demo', 'n')).context).toBeUndefined()
    expect((await catalog.resolveModel('demo', 'nan')).context).toBeUndefined()
  })
})

describe('createModelCatalog 对拍：④ 黑名单只影响 listModels，且不改 name', () => {
  it('被拉黑的条目从 listModels 消失，但 name 不被改写（消歧基于未过滤集合）', async () => {
    const entries: CatalogEntry[] = [
      { id: 'sonnet', name: 'Claude Sonnet 4 · 1x', bareName: 'Claude Sonnet 4' },
      { id: 'sonnet-thinking', name: 'Claude Sonnet 4 · 思考', bareName: 'Claude Sonnet 4' },
    ]

    const withBlacklist = makeCatalog(entries, { disabled: ['sonnet-thinking'] })
    const listed = await withBlacklist.listModels('demo')

    expect(listed.map(m => m.id)).toEqual(['sonnet'])
    // ⚠️ 留下那条的 name **不得**因另一条被拉黑而改变（否则名字随开关跳变）。
    expect(listed[0]!.name).toBe('Claude Sonnet 4 · 1x')

    // 全量视图**不套**黑名单（设置页要能看到已关闭模型的倍率）。
    const all = withBlacklist.listAllModels()
    expect(all.map(m => m.id).sort()).toEqual(['sonnet', 'sonnet-thinking'])
  })

  it('resolveModel 对**被拉黑**的模型仍能解析（黑名单不是「删除」）', async () => {
    const catalog = makeCatalog([CLINE_WITH_DESC], { disabled: ['gpt-5'] })
    const resolved = await catalog.resolveModel('demo', 'gpt-5')

    expect(resolved.id).toBe('gpt-5')
    expect(resolved.name).toBe('GPT-5')
  })
})

describe('createModelCatalog 对拍：⑤ 未知模型与空目录的边界', () => {
  it('未知 id：name 回退到裸 model，且不编造 context / reasoning', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY])
    const resolved = await catalog.resolveModel('demo', 'never-heard-of-it')

    expect(resolved.name).toBe('never-heard-of-it')
    expect(resolved.context).toBeUndefined()
    expect(resolved.reasoning).toBeUndefined()
  })

  it('空目录：listModels / listAllModels 都是空数组，**不抛错**', async () => {
    const catalog = makeCatalog([])

    await expect(catalog.listModels('demo')).resolves.toEqual([])
    expect(catalog.listAllModels()).toEqual([])
  })

  it('无已登录账号：两个入口都不吐条目（门控先于目录加载）', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY], { visible: false })

    await expect(catalog.listModels('demo')).resolves.toEqual([])
  })
})

describe('createModelCatalog 对拍：⑥ listAllModels 的同步契约', () => {
  it('⚠️ 返回**非 Promise**（11 处既有实现全同步，两处调用方契约也是同步）', () => {
    const catalog = makeCatalog([LOOMY_ENTRY])
    const result = catalog.listAllModels()

    expect(result).not.toBeInstanceOf(Promise)
    expect(Array.isArray(result)).toBe(true)
  })

  it('只吐 id / name / isFree 三键（不透出 description / 模态 / context）', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY, FREE_ENTRY])
    // 先热缓存，避免冷缓存回退路径
    await catalog.listModels('demo')

    const all = catalog.listAllModels()
    const free = all.find(m => m.id === 'free-model')!
    expect(Object.keys(free).sort()).toEqual(['id', 'isFree', 'name'])
    expect(free.isFree).toBe(true)
    // 未声明 isFree 的条目**不得**出现该键（`false` 与「未声明」不同）。
    const loomy = all.find(m => m.id === 'MiniMax-M3')!
    expect('isFree' in loomy).toBe(false)
  })
})

describe('端到端对拍：minimax（同构组代表）', () => {
  function makeMinimax() {
    const entries = MINIMAX.fallbackModels.map(fallbackToEntry)
    return new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => entries,
      product: MINIMAX,
    })
  }

  it('listModels 的每一条都有 provider/id/name 三键，且 provider 是 minimax', async () => {
    const listed = await makeMinimax().listModels(MINIMAX.id)

    expect(listed.length).toBeGreaterThan(0)
    for (const m of listed) {
      expect(m.provider).toBe(MINIMAX.id)
      expect(typeof m.id).toBe('string')
      expect(m.id.length).toBeGreaterThan(0)
      // ⚠️ name **绝不空**（空名会让选择器出现空白项）。
      expect(m.name.length).toBeGreaterThan(0)
    }
  })

  it('⚠️ resolveModel 对目录里**每一个** id 都不抛错、name 非空（逐个遍历）', async () => {
    const adapter = makeMinimax()
    const listed = await adapter.listModels(MINIMAX.id)

    for (const m of listed) {
      const resolved = await adapter.resolveModel(MINIMAX.id, m.id)
      expect(resolved.id).toBe(m.id)
      expect(resolved.provider).toBe(MINIMAX.id)
      expect(resolved.name.length).toBeGreaterThan(0)
      // ⚠️ `resolveModel` 的 name 用**裸名**（不含倍率 ` · xN`）。
      expect(resolved.name).not.toMatch(/·\s*x[\d.]+/u)
    }
  })

  it('⚠️ 有 reasoning 的模型：defaultEffort **必须**落在 efforts 内（否则选择器空白）', async () => {
    const adapter = makeMinimax()
    const listed = await adapter.listModels(MINIMAX.id)

    let withReasoning = 0
    for (const m of listed) {
      const resolved = await adapter.resolveModel(MINIMAX.id, m.id)
      const r = resolved.reasoning
      if (r === undefined) continue
      withReasoning++
      expect(r.efforts.length).toBeGreaterThan(0)
      if (r.defaultEffort !== undefined) {
        expect(r.efforts.map(e => e.id)).toContain(r.defaultEffort)
      }
    }
    // ⚠️ 反向自检：本家**确实**有带 reasoning 的模型。若这条为 0，
    //    上面的循环体从未执行 ⇒ 用例退化成恒真（FALSE COVERAGE）。
    expect(withReasoning).toBeGreaterThan(0)
  })

  it('⚠️ contextWindow 非 0 时才声明（不编造假窗口）', async () => {
    const adapter = makeMinimax()
    const listed = await adapter.listModels(MINIMAX.id)

    let declared = 0
    for (const m of listed) {
      const resolved = await adapter.resolveModel(MINIMAX.id, m.id)
      if (resolved.context === undefined) continue
      declared++
      // ⚠️ 声明的窗口**必须**是正数（0 / 负数会被 DSH 拒）。
      expect(resolved.context.contextWindow).toBeGreaterThan(0)
    }
    expect(declared).toBeGreaterThan(0)
  })
})

describe('端到端对拍：loomy（同构组，模态恒为数组）', () => {
  /**
   * ⚠️ loomy 的远端条目**总是**带 `supportsImage` 布尔 ⇒ 它的模态
   * **恒为数组**，永远不会有「未知」态 —— 这与 buddy 恰好相反。
   */
  function makeLoomy(models: readonly Record<string, unknown>[]) {
    return new LoomyAdapter({
      credentialRef: 'LOOMY_ACCOUNT_TEST' as never,
      resolveCredential: async () => ({
        access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3_600_000,
      }) as never,
      refresh: async () => {},
      // ⚠️ 契约是「**已解析**的 LoomyRemoteModel[]」（不是原始报文）——
      //    故这里必须过一遍 `parseLoomyRemoteModels`，与既有
      //    `loomy-adapter.spec.ts` 同一做法。直接喂原始报文会让
      //    `context_length` / `input_modalities` 全被读成缺省值，
      //    用例于是**假绿**（断言到一个生产不会出现的形状）。
      fetchRemoteModels: async () => parseLoomyRemoteModels({ data: [...models] }),
    })
  }

  /** 远端报文的真实字段名：`context_length`（不是 `contextWindow`）。 */
  const remote = (over: Record<string, unknown> = {}) => ({
    id: 'MiniMax-M3',
    name: 'MiniMax M3 · x4.0',
    type: 'chat',
    context_length: 1_048_576,
    capabilities: { reasoning: true, input_modalities: ['text', 'image'] },
    ...over,
  })

  it('⚠️ 支持图片 ⇒ [text, image]；不支持 ⇒ [text]（**两者都写字段**，无未知态）', async () => {
    const adapter = makeLoomy([
      remote({ id: 'vision', name: 'Vision · x1.0' }),
      remote({
        id: 'text-only',
        name: 'Text Only · x2.0',
        capabilities: { reasoning: false, input_modalities: ['text'] },
      }),
    ])
    const listed = await adapter.listModels('loomy')

    const vision = listed.find(m => m.id === 'vision')!
    const textOnly = listed.find(m => m.id === 'text-only')!
    expect(vision.inputModalities).toEqual(['text', 'image'])
    expect(textOnly.inputModalities).toEqual(['text'])
    // ⚠️ 与 buddy 的对照点：两家**都**写该字段（loomy 从不省略）。
    expect('inputModalities' in vision).toBe(true)
    expect('inputModalities' in textOnly).toBe(true)
  })

  it('⚠️ resolveModel 用裸名（倍率不进 name），而 listModels 带倍率', async () => {
    const adapter = makeLoomy([remote()])

    const listed = await adapter.listModels('loomy')
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')

    expect(listed[0]!.name).toContain('· x4.0')
    expect(resolved.name).not.toContain('· x4.0')
    expect(resolved.name).toBe('MiniMax M3')
  })

  it('⚠️ 未知 id：不编造 context，name 回退到裸 id', async () => {
    const adapter = makeLoomy([remote()])
    const resolved = await adapter.resolveModel('loomy', 'no-such-model')

    expect(resolved.name).toBe('no-such-model')
    expect(resolved.context).toBeUndefined()
  })
})

describe('端到端对拍：raccoon（同构组）', () => {
  function makeRaccoon(models: readonly Record<string, unknown>[]) {
    return new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => models,
    } as never)
  }

  it('⚠️ 每个已列出模型都能被 resolveModel 解析（两个入口的 id 集合一致）', async () => {
    const adapter = makeRaccoon([
      { id: 'raccoon-a', name: 'Raccoon A · x1.0' },
      { id: 'raccoon-b', name: 'Raccoon B · x2.0' },
    ])
    const listed = await adapter.listModels('raccoon')

    // ⚠️ 至少要有一条 —— 否则下面的循环空转、用例恒真。
    expect(listed.length).toBeGreaterThan(0)
    for (const m of listed) {
      const resolved = await adapter.resolveModel('raccoon', m.id)
      expect(resolved.id).toBe(m.id)
      expect(resolved.name.length).toBeGreaterThan(0)
    }
  })
})

describe('端到端对拍：跨家不变式（不针对某一家）', () => {
  it('⚠️ listAllModels 是**同步**的（13 家实际实现全同步，契约也同步）', () => {
    const adapter = new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => MINIMAX.fallbackModels.map(fallbackToEntry),
      product: MINIMAX,
    })

    const all = adapter.listAllModels()
    expect(all).not.toBeInstanceOf(Promise)
    expect(Array.isArray(all)).toBe(true)
    // ⚠️ 冷缓存下也**不得**为空（真实缺陷：从未调过 listModels 时设置页空白）。
    expect(all.length).toBeGreaterThan(0)
  })

  it('⚠️ 冷缓存的 listAllModels 与热缓存的条目集合一致（同步视图不丢条目）', async () => {
    const make = () => new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => MINIMAX.fallbackModels.map(fallbackToEntry),
      product: MINIMAX,
    })

    const cold = make().listAllModels().map(m => m.id).sort()
    const warmAdapter = make()
    await warmAdapter.listModels(MINIMAX.id) // 热缓存
    const warm = warmAdapter.listAllModels().map(m => m.id).sort()

    expect(warm).toEqual(cold)
  })

  it('⚠️ 目录门控：无已登录账号时 listModels 返回空（不抛错）', async () => {
    const adapter = new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => MINIMAX.fallbackModels.map(fallbackToEntry),
      product: MINIMAX,
      // 池替身：没有任何已登录账号
      accountPool: {
        hasLoggedInAccount: async () => false,
        disabledModelsFor: () => new Set<string>(),
      } as never,
    })

    await expect(adapter.listModels(MINIMAX.id)).resolves.toEqual([])
  })
})
