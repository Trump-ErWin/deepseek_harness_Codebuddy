/**
 * Jet Hub「自动」适配器 —— 一个模型名用整池，按临期优先。
 *
 * ## 它解决什么
 *
 * 对标 OmniRoute 的 `auto`：模型选择器里只挂一个 `jet-hub-auto/auto`，请求进来时现场
 * 从多个 provider 的账号池里挑「积分最快作废」的那个 provider 发出去。临期的先烧、
 * 长期的留着 —— 这正是用户要的「当天/临期过期的优先使用」。
 *
 * ## 为什么只选 provider、不选账号
 *
 * 每个 provider 的适配器**自己**就会按临期/限流在它的账号间轮转（buddy/loomy 走
 * `*-balance-selector`，其余走 `getAvailableAccount` + 429 换号）。auto 若再替它们
 * 选账号，等于把同一件事做两遍、还要往账号池里塞「强制账号」的旁路（易与手动顺序、
 * 永久积分锁定打架）。所以 auto 只做**跨 provider** 的那一层：谁最快作废用谁。
 *
 * ## 临期判据（每个 provider 折算成一个「最早失效时刻」，升序取最小）
 *
 * | provider | 有可用余额时的失效时刻 |
 * |---|---|
 * | codearts | 当日额度，UTC+8 当日 24:00（`nextUtc8DayStartMs`） |
 * | loomy | 有今日赠送 → 当日 24:00；只剩永久 → Infinity |
 * | zcode | 各桶 `expiresAt` 的最小值；无桶但有可领 → 当日 24:00 |
 * | buddy / workbuddy | 有效资源包 `deductionEndTime` 的最小值 |
 *
 * 只有永久/长期积分的 provider 折算成 `Infinity`（排最后，但不剔除 —— 没有临期号时
 * 仍要用它）。查询失败 / 无启用账号的 provider 折算成 `-1`（**剔除**，不参与排序）。
 *
 * ## 缓存与失效
 *
 * 一次「选 provider」的结果缓存 {@link AUTO_CHOICE_TTL_MS}（默认 60 秒，与既有余额
 * 缓存同量级）：跨 provider 的余额探测有网络成本，每分钟一次足够。⚠️ 这不破坏
 * 「临期优先」的语义 —— 一分钟内积分不会凭空作废；而 provider **内部**换号不受本
 * 缓存影响（那是各适配器每次请求现做的）。
 *
 * @module src/auto-adapter.ts
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, ReasoningEffortId, contentHasImage } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AccountPool } from './account-pool.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { CODEBUDDY, WORKBUDDY } from './product.js'
import type { BuddyCredential } from './buddy.js'
import { fetchCreditBalance } from './credits.js'
import { LOOMY } from './loomy-product.js'
import type { LoomyCredential } from './loomy.js'
import { fetchLoomyCreditDetail } from './loomy-credits.js'
import { fetchCodeArtsAccountInfoDetailed } from './codearts-credits.js'
import type { CodeArtsCredential } from './types.js'
import type { ZcodeCredential } from './zcode.js'
import { fetchZcodeBalance } from './zcode-upstream.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import { translateReasoningEffort } from './reasoning-ladder.js'

/** 注册到 ctx.llm 的 provider 路由，也是 providerInfo().id（DSH 校验二者相等）。 */
export const AUTO_PROVIDER = 'jet-hub-auto'

/** 对外的唯一模型名。 */
export const AUTO_MODEL = 'auto'

/** 一次跨 provider 选型的缓存时长（毫秒）。 */
export const AUTO_CHOICE_TTL_MS = 60_000

/**
 * v1 接入的 provider（顺序即「并列最早失效时」的兜底优先级）。
 *
 * 其余 provider（qoder / trae / cline / …）结构上留好接口但不接入：它们没有跨账号
 * 的到期余额探测端点，接进来只能算成 Infinity 永远垫底，不如先不放。
 */
export const AUTO_PROVIDERS = ['codearts', 'loomy', 'zcode', 'buddy', 'workbuddy'] as const

/** 无到期概念（只有永久/长期积分）时的失效时刻。 */
const NEVER = Number.POSITIVE_INFINITY
/** 该 provider 本次不可用（无启用账号 / 探测失败）的哨兵值。 */
const UNUSABLE = -1

/** 一次选型的结果：目标 provider + 目标模型 id。 */
interface AutoChoice {
  provider: string
  model: string
}

/**
 * 一次转发的目标：provider + 模型 + **该模型声明的思考档位 id**。
 *
 * ⚠️ `efforts` 必须在 `prepareCall` 阶段备好（那里才有 `resolveModelInfo` 的
 * 结果），因为 `stream` 闭包是**同步**的（见 `PreparedAdapterCall` 契约），
 * 拿不到 await 的机会。
 */
interface DispatchTarget extends AutoChoice {
  /** 目标模型声明的档位 id（空 = 该模型不声明任何思考档位）。 */
  efforts: readonly string[]
}

/**
 * 从「provider → 最早失效时刻」里挑出胜者（**纯函数**，便于单测）。
 *
 * 规则：剔除 `UNUSABLE`；其余按失效时刻**升序**（越早越先烧）；时刻相同按传入顺序
 * （即 {@link AUTO_PROVIDERS} 的次序）。全部不可用时返回 `undefined`。
 *
 * ⚠️ `NEVER`（无到期概念的永久/长期积分）**必须参与排序**并能当选：它表示
 * 「可用、只是没有临期可烧」，而不是「不可用」。⚠️ 真实缺陷（PR !69 审计实测）：
 * 初版用 `bestExpiry` 的初值 `Infinity` 作「还没选中任何 provider」的哨兵，于是
 * **全部条目都是 `NEVER` 时循环一次都不赋值** ⇒ 返回 `undefined` ⇒ 用户看到
 * 「没有任何已登录且可用的 provider 账号，请先登录」—— 而账号全都正常，只是积分
 * 都是永久的。这是「账号都在」被误报成「没登录」。
 * ⇒ 改用独立的 `best === undefined` 判定，两种语义彻底分开。
 *
 * @param entries - `[provider, expiryMs]`，顺序即并列时的优先级。
 * @returns 胜出的 provider；**全部 `UNUSABLE`** 时才返回 `undefined`。
 */
export function pickSoonestProvider(entries: readonly (readonly [string, number])[]): string | undefined {
  let best: string | undefined
  let bestExpiry = Number.POSITIVE_INFINITY
  for (const [provider, expiry] of entries) {
    if (expiry === UNUSABLE) continue
    // 严格小于：并列时保留先出现的（AUTO_PROVIDERS 次序），不重排。
    if (best === undefined || expiry < bestExpiry) {
      bestExpiry = expiry
      best = provider
    }
  }
  return best
}

/** auto 适配器对外只挂一个模型；真实能力在选型后从目标 provider 借用。 */
const AUTO_MODEL_INFO: LlmModelInfo = {
  provider: AUTO_PROVIDER,
  id: AUTO_MODEL,
  name: 'Auto（临期优先 · 整池）',
  description: '自动选择积分最快作废的 provider，把临期额度先用掉。',
  inputModalities: ['text', 'image'],
}

export interface AutoAdapterOptions {
  accountPool: AccountPool
  /** 注入的当前时刻（测试用）。 */
  now?: () => number
  /** 选型缓存时长（测试用）。 */
  ttlMs?: number
}

/** Jet Hub 自动适配器。 */
export class AutoAdapter extends LlmAdapter {
  /** 缓存的一次选型结果（含计算时刻）。 */
  private cached: { at: number; choice: AutoChoice } | undefined
  /** 缓存的「auto 借用目标能力」的元数据（与 choice 同生命周期）。 */
  private cachedInfo: LlmResolvedModelInfo | undefined

  constructor(private readonly ctx: Context, private readonly options: AutoAdapterOptions) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Jet Hub 自动（临期优先）' }
  }

  /** 目录里永远只有一个 auto（真实模型由选型决定，不在此暴露）。 */
  async listModels(): Promise<readonly LlmModelInfo[]> {
    return [AUTO_MODEL_INFO]
  }

  /**
   * 解析 `auto` 的能力元数据。
   *
   * 尽量借用「当前选型目标」的真实 context / 档位（让 harness 的请求校验贴近实际），
   * 但**身份必须改回 auto**：DSH 的 `normalizeModelInfo` 会拒掉 provider/id 与请求
   * 路由不符的元数据。选型不可用时退回到一份保守的通用元数据（不声明档位，任何
   * reasoningEffort 都会被 harness 判为不支持 —— 故这里连 reasoning 字段都不带）。
   */
  async resolveModel(): Promise<LlmResolvedModelInfo> {
    const resolved = await this.ensureChoice()
    if (resolved?.info !== undefined) {
      // ⚠️ 身份必须改写回 auto（真实缺陷修复）：DSH 的 normalizeModelInfo 拒绝
      // provider/id 与请求路由不符的元数据 —— 直接返回目标的 info 会让目录加载报
      // INVALID_MODEL_INFO。能力（context / 档位）保留目标那份。
      // ⚠️ inputModalities 必须恒为 text+image（真实缺陷修复 #2，用户报障
      // 「怎么又不支持图片了」）：宿主**附加图片前**按这里判，而借用的目标 info
      // 可能缺失该字段（如 loomy 的 resolveModel 不声明）—— 缺失会被宿主当
      // 「不支持」，于是带图消息在选择器阶段就被拦。auto 是整池，池里有能看图的
      // provider，声明如实；「这次选中的目标收不收得了图」由 stream 闭包改道保证。
      return {
        ...resolved.info,
        provider: AUTO_PROVIDER,
        id: AUTO_MODEL,
        inputModalities: ['text', 'image'],
      }
    }
    return {
      provider: AUTO_PROVIDER,
      id: AUTO_MODEL,
      name: AUTO_MODEL_INFO.name,
      ...(AUTO_MODEL_INFO.description === undefined ? {} : { description: AUTO_MODEL_INFO.description }),
      inputModalities: ['text', 'image'],
      context: { contextWindow: 200_000 },
    }
  }

  /**
   * 绑定「一次选型」到本次分发。
   *
   * 返回的 `stream` 闭包把请求改写为目标 provider/model 后交给 `ctx.llm.stream` ——
   * 走公开路径，目标适配器照常做它自己的选号 / 限流换号 / 续期。
   *
   * ## 图片感知选型（真实缺陷修复：为什么不能只用 ensureChoice 的缓存）
   *
   * 对外 auto 声明支持图片（整池里有能看图的 provider，声明纯文本会让宿主在
   * **进入请求前**就拒绝带图消息 ——「当前模型不支持图片」正是这样来的）。
   * 但**临期胜者不一定能看图**（如 codearts 的模型全是纯文本）。故这里在分发时
   * 检查本次消息是否真的带图：带图而胜者不支持 → 改发「支持图片的 provider 里
   * 临期最早」的那个。无图请求完全不受影响，仍走 60 秒缓存。
   *
   * ⚠️ 覆盖目标用 `llm.stream`（公开路径）而非「再挑一个模型直接发给它的适配器」：
   * 只有走公开路径，目标适配器的选号 / 续期 / 限流换号才全部照常生效。
   */
  async prepareCall(
    _provider: string,
    _model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    const resolved = await this.ensureChoice(signal)
    if (resolved === undefined) {
      throw new LlmError(
        'jet-hub-auto: 没有任何已登录且可用的 provider 账号。请先在 Jet Hub 面板登录至少一个（codearts / loomy / zcode / CodeBuddy / WorkBuddy）。',
        'MISSING_CREDENTIAL',
      )
    }
    let { choice, info } = resolved

    // 请求需要图片吗？（与宿主 capability 判据同一函数：含 tool-result 递归。）
    // prepareCall 拿不到完整消息（它只有 provider/model），带图判定发生在 stream
    // 闭包里 —— 那里才拿得到 options.messages。见下方闭包内的二次检查。
    const imageCapable = info?.inputModalities?.includes('image') === true
    if (!imageCapable) {
      // 目录元数据缺失或声明纯文本：先按无缓存决策继续，真正带图时由 stream
      // 闭包里的 imageFallback 兜底改道。
      this.ctx.logger?.warn?.(
        `[jet-hub-auto] 临期胜者 ${choice.provider}（${choice.model}）可能不支持图片；`
        + '带图请求将自动改道到支持图片的 provider',
      )
    }

    // ⚠️ 预解析**两个**转发目标（prepareCall 是异步的，闭包必须保持同步签名 ——
    // `PreparedAdapterCall.stream` 的契约是「同步返回 AsyncIterable」）：
    // ① 临期胜者（正常路径）；② 胜者不能收图时的「支持图片且临期最早」目标。
    // 两者的思考档位也在这里一并解析（见 {@link DispatchTarget.efforts}）。
    const mainTarget = await this.dispatchTargetOf(choice, signal)
    let imageTarget: DispatchTarget | null = null
    if (!imageCapable) {
      const entries: Array<readonly [string, number]> = []
      for (const provider of AUTO_PROVIDERS) {
        if (provider === choice.provider) continue
        if (!(await this.providerSupportsImages(provider))) continue
        let expiry = await this.expiryOf(provider, signal)
        // 目录空/模型全关 ⇒ 该 provider 不可调用，不能当改道目标（PR !69 审计实测）。
        if ((await this.firstModelOf(provider)) === undefined) expiry = UNUSABLE
        entries.push([provider, expiry])
      }
      const picked = pickSoonestProvider(entries)
      if (picked !== undefined) {
        const model = await this.firstModelOf(picked)
        if (model !== undefined) {
          imageTarget = await this.dispatchTargetOf({ provider: picked, model }, signal)
        }
      }
    }

    return {
      // 身份必须是 auto（DSH 校验），能力取自目标。
      // ⚠️ `name` 带上**实际选中的 provider**：这是「选型降级」唯一的用户可见
      // 提醒 —— 临期额度被关闭/用尽后 auto 会换到谁，直接显示在模型选择器里，
      // 不必去翻日志（静默降级正是本仓库反复修过的那类缺陷）。
      // ⚠️ inputModalities 恒为 text+image（整池诚实声明）：宿主据此放行带图消息，
      // 真正「这次能不能收图」由 stream 闭包里的改道保证，而不是在这里掐死。
      model: {
        ...(info === undefined ? await this.resolveModel() : info),
        provider: AUTO_PROVIDER,
        id: AUTO_MODEL,
        name: `Auto（临期优先）· ${choice.provider}`,
        description: `自动选择积分最快作废的 provider；本次选中 ${choice.provider}（模型 ${choice.model}）。`,
        inputModalities: ['text', 'image'],
      },
      stream: (options: GenerateOptions) => {
        // 带图判定在闭包里做：只有这里拿得到 options.messages（与宿主
        // capability 判据同一函数 contentHasImage，含 tool-result 递归）。
        const hasImage = options.messages.some((message) => contentHasImage(message.content))
        if (hasImage && !imageCapable) {
          if (imageTarget === null) {
            // 全池都不支持图片：如实报错而不是把图降级成文字占位 —— 后者会让
            // 模型「看到一张图被抹掉」却不知道用户发了什么，属静默丢数据。
            throw new LlmError(
              'jet-hub-auto: 本次请求带图片，但池内所有已登录 provider 都不支持图片输入。'
              + '请换一个支持图片的模型，或去掉图片后重试。',
              'INVALID_REQUEST',
            )
          }
          // 带图而胜者不能收图 → 改道（这是**本次请求**的能力需求，不走选型缓存）。
          this.ctx.logger?.warn?.(
            `[jet-hub-auto] 带图请求：临期胜者 ${choice.provider}（${choice.model}）不支持图片，已改道到 ${imageTarget.provider}（${imageTarget.model}）`,
          )
          return this.dispatch(imageTarget, options)
        }
        return this.dispatch(mainTarget, options)
      },
    }
  }

  /**
   * 解析一个转发目标：**连同该模型声明的思考档位**。
   *
   * 档位必须在这里取（而非分发时）—— `stream` 闭包是同步的，而取档位要
   * `await resolveModelInfo`。解析失败按「无档位」处理（转发时不下发该字段），
   * 不影响其余能力。
   */
  private async dispatchTargetOf(choice: AutoChoice, signal?: AbortSignal): Promise<DispatchTarget> {
    try {
      const info = await this.ctx.llm.resolveModelInfo(choice.provider, choice.model, signal)
      const efforts = (info.reasoning?.efforts ?? [])
        .map((effort) => String(effort.id))
        .filter((id) => id.length > 0)
      return { ...choice, efforts }
    } catch {
      return { ...choice, efforts: [] }
    }
  }

  /**
   * 按目标 provider 转发一次请求，**先翻译思考档位**。
   *
   * ## 为什么要翻译（真实缺陷，用户报障 2026-10-05）
   *
   * auto 借用的 `reasoning.efforts` 来自**本次选中的目标模型**（如 zcode 的
   * `low` / `high` / `max`），但请求里的 `reasoningEffort` 是 harness 依据
   * **上一次对话**留下的值，可能带着**别的模型族**的档位名（如 TRAE 的
   * `xhigh`、LobsterAI 的 `light`）。原样转发会被 DSH 按 id 严格校验拦下：
   *
   * ```
   * provider "zcode" model "GLM-5.3-Flash" does not support reasoning effort "xhigh"
   *   UNSUPPORTED_REASONING_EFFORT
   * ```
   *
   * 改道（带图）或换号后同理 —— 目标换了，档位语义也就跟着变。
   *
   * 修法复用仓库既有的 {@link translateReasoningEffort}（本网关
   * `openai-gateway/messages.ts` 一直在用同一套口径）：
   * - `exact` → 原样下发；
   * - `mapped` → 就近落到目标声明的同族档位（**同距取更强**，与仓库口径一致）
   *   并记一条 warn —— 这是「静默降级」与「静默改语义」之间唯一的区别；
   * - `unexpressible` → 目标根本没这一族（如要 `off` 而它只声明 `high`）→ **不
   *   下发**该字段（让上游走它自己的默认），而不是硬塞一个错的；
   * - `unknown` → 请求值是未登记的怪名字，**删掉该字段**并 warn：让上游按默认
   *   走，比抛错打断整轮对话更可取（用户改个档位不该让整个任务失败）。
   */
  private dispatch(
    target: DispatchTarget,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    const requested = options.reasoningEffort
    if (requested === undefined) {
      return this.ctx.llm.stream({ ...options, provider: target.provider, model: target.model })
    }
    const requestedEffort = String(requested)
    const declared = target.efforts
    if (declared.length === 0) {
      // 目标不声明任何档位：不下发（否则 DSH 会报 UNSUPPORTED_REASONING_EFFORT）。
      this.ctx.logger?.warn?.(
        `[jet-hub-auto] ${target.provider}（${target.model}）未声明思考档位，已忽略请求的「${requestedEffort}」`,
      )
      return this.ctx.llm.stream({
        ...options,
        provider: target.provider,
        model: target.model,
        reasoningEffort: undefined,
      })
    }
    const mapped = translateReasoningEffort(requestedEffort, declared)
    if (mapped.kind === 'exact') {
      return this.ctx.llm.stream({ ...options, provider: target.provider, model: target.model })
    }
    if (mapped.kind === 'mapped') {
      this.ctx.logger?.warn?.(
        `[jet-hub-auto] ${target.provider}（${target.model}）没有档位「${requestedEffort}」，已就近改为「${mapped.effort}」`,
      )
      return this.ctx.llm.stream({
        ...options,
        provider: target.provider,
        model: target.model,
        reasoningEffort: ReasoningEffortId(mapped.effort) as GenerateOptions['reasoningEffort'],
      })
    }
    // unexpressible / unknown：不下发该字段，让上游走自己的默认。
    this.ctx.logger?.warn?.(
      `[jet-hub-auto] ${target.provider}（${target.model}）无法表达档位「${requestedEffort}」（${mapped.kind}），本次按上游默认发送`,
    )
    return this.ctx.llm.stream({
      ...options,
      provider: target.provider,
      model: target.model,
      reasoningEffort: undefined,
    })
  }

  /**
   * 该 provider 的目录里是否存在**未被彻底关闭**且支持图片的模型。
   *
   * 读各适配器 `listModels()` 播报的 `inputModalities`（它内部已应用隐藏/关闭表），
   * 不看账号余额 —— 余额是 {@link expiryOf} 的事，这里只回答「能不能收图」。
   */
  private async providerSupportsImages(provider: string): Promise<boolean> {
    try {
      const models = await this.ctx.llm.listModels(provider)
      return models.some((model) => model.inputModalities?.includes('image') === true)
    } catch {
      return false
    }
  }

  /** auto 从不直接被 stream（总是先经 prepareCall）；兜底抛错而非静默。 */
  async *stream(): AsyncIterable<StreamChunk> {
    throw new LlmError('jet-hub-auto: 请通过模型选择器使用 auto', 'INVALID_REQUEST')
  }

  /**
   * 取选型（命中缓存直接回；否则重新探测全池）。
   *
   * 与 {@link resolveModel} / {@link prepareCall} 共用同一份缓存，保证「本轮能力」与
   * 「本轮实际发往的 provider」出自同一次决策 —— 分裂会让 harness 用 A 的能力校验、
   * 却发往 B。
   */
  private async ensureChoice(
    signal?: AbortSignal,
  ): Promise<{ choice: AutoChoice; info?: LlmResolvedModelInfo } | undefined> {
    const now = this.options.now?.() ?? Date.now()
    // ⚠️ abort 必须**立刻**以 AbortError 结束，绝不能被降级（PR !69 审计实测）。
    // 初版把 `expiryOf` 里的 `signal?.aborted` 折算成 `UNUSABLE`，于是所有 provider
    // 都被剔除 ⇒ 返回 undefined ⇒ 抛 MISSING_CREDENTIAL ⇒ 用户取消请求后看到的
    // 是「请先在 Jet Hub 面板登录至少一个」。而缓存命中分支根本不查 signal，
    // 同一个取消事件在 60 秒窗口的不同位置会产出两种完全不同的错误，极难复现。
    signal?.throwIfAborted()
    if (this.cached !== undefined && now - this.cached.at < (this.options.ttlMs ?? AUTO_CHOICE_TTL_MS)) {
      return { choice: this.cached.choice, info: this.cachedInfo }
    }
    const picked = await this.selectProvider(signal, choice => this.firstModelOf(choice))
    if (picked?.model === undefined) {
      this.cached = undefined
      this.cachedInfo = undefined
      return undefined
    }
    const choice: AutoChoice = { provider: picked.provider, model: picked.model }
    // 借用目标真实能力；失败不致命（resolveModel 会退回保守元数据）。
    let info: LlmResolvedModelInfo | undefined
    try {
      info = await this.ctx.llm.resolveModelInfo(choice.provider, choice.model, signal)
    } catch {
      info = undefined
    }
    this.cached = { at: now, choice }
    this.cachedInfo = info
    return { choice, info }
  }

  /**
   * 探测各 provider 的最早失效时刻并选出胜者。
   *
   * ⚠️ `modelOf` 是「该 provider 能否**实际被调用**」的判据（PR !69 审计实测）：
   * 一个 provider 余额充足、但目录为空或模型被用户全关时，仍**不能**当选 ——
   * 初版会让它拿到请求再发出一个必然 404 的模型 id。故排序时就把这类 provider
   * 当作 `UNUSABLE` 剔除，顺位让给下一个候选（而不是整体放弃 auto）。
   */
  async selectProvider(
    signal?: AbortSignal,
    modelOf?: (provider: string) => Promise<string | undefined>,
  ): Promise<AutoChoice | undefined> {
    const entries: Array<readonly [string, number]> = []
    for (const provider of AUTO_PROVIDERS) {
      let expiry = await this.expiryOf(provider, signal)
      if (expiry !== UNUSABLE && modelOf !== undefined) {
        // 目录空/全关 ⇒ 退出候选（不可调用），与「不可用」同等对待。
        if ((await modelOf(provider)) === undefined) expiry = UNUSABLE
      }
      entries.push([provider, expiry])
    }
    const winner = pickSoonestProvider(entries)
    if (winner === undefined) return undefined
    const model = modelOf !== undefined ? await modelOf(winner) : undefined
    if (modelOf !== undefined && model === undefined) return undefined
    return { provider: winner, model: model ?? '' }
  }

  /**
   * 某 provider「一个代表账号」的最早失效时刻（毫秒）。
   *
   * 取一个启用账号做代表：它同时确认了「这个 provider 现在有没有可用账号」
   * （取不到即 UNUSABLE）。⚠️ 探测的是代表账号的余额，provider 内部换号由各适配器
   * 每次请求现做，不依赖这里。
   *
   * ⚠️⚠️ **必须带真实 modelId 取号，不能传空串**（真实缺陷，PR !69 审计实测）：
   * `getAvailableAccount` 对空 modelId 直接 `return true` 跳过限流过滤
   * （`account-pool.ts:1049-1055`），而候选顺序就是**用户的手动顺序**
   * （`:1057`）⇒ 空串取回的是「手动序第一个启用账号」，**哪怕它此刻正在限流**。
   * 本仓库在 `index.ts:598-600` 已为同一坑留下过成文警告，这里是同一个缺陷的第二实例。
   *
   * 后果是多账号池的真实场景：手动序第一个号额度已烧完（折算 `NEVER`）、第二个号还有
   * 9 天后作废的额度 ⇒ auto 只看到第一个号 ⇒ 该 provider 被判成「无临期」而排到最后，
   * **临期额度被完全忽略**，与「临期优先」的价值主张相反。
   *
   * ⇒ 取号前先从目录拿一个真实 modelId，让限流过滤真正生效。
   */
  async expiryOf(provider: string, signal?: AbortSignal): Promise<number> {
    const pool = this.options.accountPool
    let available
    try {
      // ⚠️ 先解析一个真实模型 id：空串会让限流过滤整体短路（见上）。
      // 目录不可读时退回空串 —— 此时「有没有账号」这个判据仍然成立，
      // 只是限流维度退化为不参与（宁可少筛，不可把整池判成不可用）。
      const probeModel = await this.firstModelOf(provider) ?? ''
      available = await pool.getAvailableAccount(provider, probeModel)
    } catch {
      return UNUSABLE
    }
    if (available === null || available === undefined) return UNUSABLE
    // ⚠️ abort 不是「这个 provider 不可用」，而是「这次调用不该继续」（PR !69 审计
    // 实测）：折算成 UNUSABLE 会让取消请求的用户看到误导性的「请先登录」。
    signal?.throwIfAborted()
    const credential = available.credential as unknown
    switch (provider) {
      case 'buddy':
        return this.buddyExpiry(CODEBUDDY, credential as BuddyCredential)
      case 'workbuddy':
        return this.buddyExpiry(WORKBUDDY, credential as BuddyCredential)
      case 'loomy':
        return this.loomyExpiry(credential as LoomyCredential)
      case 'codearts':
        return this.codeArtsExpiry(credential as CodeArtsCredential)
      case 'zcode':
        return this.zcodeExpiry(credential as ZcodeCredential)
      default:
        return UNUSABLE
    }
  }

  /** buddy 系：有效资源包 `deductionEndTime` 的最小值；无有效包 → Infinity（只有永久）。 */
  private async buddyExpiry(product: typeof CODEBUDDY, credential: BuddyCredential): Promise<number> {
    let balance
    try {
      balance = await fetchCreditBalance(credential, product)
    } catch {
      return UNUSABLE
    }
    if (balance === null) return UNUSABLE
    let earliest = NEVER
    for (const pkg of balance.packages) {
      if (pkg.active !== true) continue
      if (!(typeof pkg.remaining === 'number' && pkg.remaining > 0)) continue
      const end = pkg.deductionEndTime
      if (typeof end === 'number' && Number.isFinite(end) && end > 0 && end < earliest) earliest = end
    }
    return earliest
  }

  /** loomy：有今日赠送 → 当日 24:00；只剩永久 → Infinity。 */
  private async loomyExpiry(credential: LoomyCredential): Promise<number> {
    let detail
    try {
      detail = await fetchLoomyCreditDetail(credential, LOOMY)
    } catch {
      return UNUSABLE
    }
    if (detail === null) return UNUSABLE
    if (detail.daily > 0) return nextUtc8DayStartMs()
    return detail.permanent > 0 ? NEVER : UNUSABLE
  }

  /** codearts：积分账户有余额即按当日额度处理（UTC+8 当日 24:00 重置）。 */
  private async codeArtsExpiry(credential: CodeArtsCredential): Promise<number> {
    let result
    try {
      result = await fetchCodeArtsAccountInfoDetailed(credential)
    } catch {
      return UNUSABLE
    }
    if (!result.ok) return UNUSABLE
    const total = result.info.credit?.total ?? 0
    return total > 0 ? nextUtc8DayStartMs() : NEVER
  }

  /** zcode：各桶 `expiresAt`（秒）最小值；无桶但有可领活动 → 当日 24:00。 */
  private async zcodeExpiry(credential: ZcodeCredential): Promise<number> {
    let balance
    try {
      balance = await fetchZcodeBalance(credential)
    } catch {
      return UNUSABLE
    }
    if (balance === undefined) return UNUSABLE
    let earliest = NEVER
    for (const bucket of balance.buckets) {
      const remaining = bucket.availableUnits ?? bucket.remainingUnits ?? 0
      if (!(remaining > 0)) continue
      const exp = bucket.expiresAt
      if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
        const ms = exp * 1000
        if (ms < earliest) earliest = ms
      }
    }
    if (earliest !== NEVER) return earliest
    // 桶里没有带到期时间的余额：若还有可领的每日活动，按当日额度算（先烧它）。
    if (balance.remaining > 0 || (balance.claimablePlans?.length ?? 0) > 0) return nextUtc8DayStartMs()
    return NEVER
  }

  /**
   * 目标 provider 里选一个**未被彻底关闭**的模型 —— **同 provider 内按倍率升序**
   * （限时折扣 / 免费优先），倍率解析自目录展示名（`Space-Bunny · x0.03` 这类，
   * 各 provider 的目录名都带；带「免费」按 0 算）。没有倍率标注的模型视为
   * `Infinity`，排在任何有标注的之后。
   *
   * ## 返回 `undefined` 的含义（真实缺陷修复，PR !69 审计实测）
   *
   * `undefined` = **该 provider 目录里没有可调用的模型**（目录为空 / 读取失败 /
   * 用户把模型全关了）。调用方必须把该 provider **退出候选**，绝不能发请求。
   *
   * ⚠️ 初版在这里回落到硬编码 `AUTO_FALLBACK_MODELS[provider]`，而触发回落的前提
   * 恰恰是「目录为空或**全被关闭**」—— 此时那个 id 正是用户明确关掉的模型。
   * 实测（真实链路探针）：用户关掉 zcode 全部模型后，auto 仍选中 zcode 并发出
   * **`zcode/auto`**（字符串 `'auto'` 被当成 zcode 的模型名）⇒ 必然 404，且请求
   * 打到了一个用户已禁用的 provider。这违反本文件自己的注释「关闭即不可调用」。
   *
   * ## 为什么按倍率选（真实缺陷，用户报障 2026-10-05）
   *
   * 原实现取目录第一个 —— CodeBuddy 目录首个是 `hy4-preview`（x0.29），而同池的
   * `Space-Bunny` 正在限时折扣（x0.03）。大任务跑了前者，等于同样的活多花约十倍
   * 积分。auto 既然定位是「省钱烧临期」，同 provider 内当然该挑最便宜的。
   *
   * ⚠️ 必须跳过被关闭的模型（`disabledModelsFor`）—— 关闭即「不可调用」，
   * auto 不能把请求路由过去。
   */
  async firstModelOf(provider: string): Promise<string | undefined> {
    const disabled = this.options.accountPool.disabledModelsFor(provider)
    let skipped = 0
    let best: { id: string; price: number } | undefined
    try {
      const models = await this.ctx.llm.listModels(provider)
      for (const model of models) {
        if (typeof model.id !== 'string' || model.id.length === 0) continue
        if (disabled.has(model.id)) { skipped++; continue }
        const price = priceFactorFromName(model.name ?? model.id)
        if (best === undefined || price < best.price) best = { id: model.id, price }
      }
      if (best !== undefined) {
        // ⚠️ 这里必须**先**记 warn 再返回：初版把 `return` 写在 warn 之前，那条日志
        // 在正常路径上永远不执行，注释「跳过不是静默降级」因此完全失真。
        if (skipped > 0) {
          this.ctx.logger?.warn?.(
            `[jet-hub-auto] ${provider} 目录中的 ${skipped} 个模型已被关闭，已跳过`,
          )
        }
        return best.id
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`[jet-hub-auto] ${provider} 读取模型目录失败：${String(error)}`)
      return undefined
    }
    if (skipped > 0) {
      this.ctx.logger?.warn?.(
        `[jet-hub-auto] ${provider} 的 ${skipped} 个模型全部被关闭，已退出候选`,
      )
    }
    // 目录为空 / 全被关闭：如实返回「无可用模型」，由调用方把该 provider 剔除。
    // ⚠️ 绝不能回落到硬编码 id —— 那正是用户关掉的模型（见方法注释）。
    return undefined
  }
}

/**
 * 从目录展示名解析倍率；带「免费」按 0；解析不出按 `Infinity`（排在任何有标注的之后）。
 *
 * # 为什么必须要求「倍率分隔符」（真实缺陷，PR !69 审计实测）
 *
 * 初版正则 `/[×x]\s*(\d+(?:\.\d+)?)\s*$/i` 只要求「`x` + 数字 + 行尾」，**不要求分隔符**
 * ⇒ 模型名里的 `x` 被当成倍率标记。实测（拿本仓库真实展示名逐条跑）：
 *
 * | 展示名 | 初版解析 | 应为 |
 * |---|---|---|
 * | `Spark X2.5`（**无**倍率标注） | **2.5 倍** ❌ | 无标注 ⇒ `Infinity` |
 * | `GPT-X5` | **5 倍** ❌ | 无标注 |
 * | `Grok x4` | **4 倍** ❌ | 无标注 |
 * | `DeepSeek V4 Flash 0731 · x3.0` | 3.0 ✅ | 3.0 |
 *
 * `Spark X2.5` 这条路径**真实可达**：loomy 的 `splitLoomyRate` 在远端下发**不带倍率**的
 * 名称时原样返回原名（`loomy.ts:136/147`），而 `loomyDisplayName` 不追加分隔符，
 * 该原名会被 `loomy-adapter.ts:163` 直接写进目录名 ⇒ `firstModelOf` 就会把它当 2.5 倍，
 * 于是「挑最便宜」反而**挑到了最贵的**（同池里 `· x0.8` 的模型排到了它后面）。
 *
 * ✅ 修法：要求倍率前有**分隔符**（`·` / `×` / `·x`），并按真实形态支持促销箭头
 * `x0.17→x0.50`（`formatCreditsRate`，`buddy.ts:701`）—— 取**促销后的**那个值，
 * 那才是实际计费倍率。
 *
 * ⚠️ 只做展示层解析：各 provider 的倍率权威来源不同（qoder 在目录 `priceFactor`、
 * buddy 在远端 config 拼进名字），逐家接字段是个大工程，而目录名是所有 provider
 * 统一展示的地方 —— 先用这一层。
 */
export function priceFactorFromName(name: string): number {
  if (name.includes('免费')) return 0
  // ⚠️ 倍率标注的**真实形态**只有两种（`formatCreditsRate`，buddy.ts:701；
  // `loomyDisplayName`，loomy.ts:157）：`… · x{n}` 与 `… ×{n}` —— 分隔符是
  // **间隔号 U+00B7** 或乘号。促销期为 `· x0.17→x0.50`，取箭头右侧（实际计费倍率）。
  //
  // ⚠️⚠️ 不能用「`[×x]` 后接数字」这种宽松形态（真实缺陷，PR !69 审计实测）：
  //   `Spark X2.5`（**无**倍率标注）会被解析成 **2.5 倍**，`GPT-X5` → 5 倍，
  //   `Grok x4` → 4 倍。于是同池里 `· x0.8` 的模型排在这个「2.5 倍」的后面 ——
  //   auto 号称「挑最便宜」，反而挑了最贵的。
  const m = /·\s*[×x]?\s*(\d+(?:\.\d+)?)(?:\s*[→>]\s*[×x]?\s*(\d+(?:\.\d+)?))?\s*$/i
    .exec(name.trim())
  if (m === null) return Number.POSITIVE_INFINITY
  const raw = m[2] ?? m[1]
  const value = Number(raw)
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

/** 在 ctx.llm 上注册 auto 路由（幂等，见 `llm-register-compat.ts`）。 */
export function registerAutoLlm(ctx: Context, options: AutoAdapterOptions): AutoAdapter {
  const adapter = new AutoAdapter(ctx, options)
  registerAdapterIdempotent(ctx.llm, [AUTO_PROVIDER], adapter, message => ctx.logger?.warn?.(message))
  return adapter
}

/**
 * 「auto 现在会选谁」——按临期判据算出当前胜者（供用量徽标等外部消费）。
 *
 * ⚠️ 与 {@link AutoAdapter.selectProvider} 是**同一套判据**（每个 provider 用
 * `getAvailableAccount` 确认可用性 + 各家余额端点折算最早失效时刻），但走的是
 * **独立实例**：徽标轮询不该与选型缓存互相踩（选型有 60 秒缓存且随请求刷新，
 * 徽标是 60 秒轮询、隐藏页跳过 —— 两者的节奏本来就该解耦）。
 */
export async function pickCurrentAutoProvider(
  ctx: Context,
  options: AutoAdapterOptions,
): Promise<string | undefined> {
  const probe = new AutoAdapter(ctx, options)
  // ⚠️ 必须带 `modelOf`：**模型全被关闭的 provider 不能算进徽标**（PR !69 审计实测），
  // 否则徽标会显示一个 auto 实际根本不会选中的 provider。
  const picked = await probe.selectProvider(undefined, p => probe.firstModelOf(p))
  return picked?.provider
}
