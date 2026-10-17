/**
 * AutoClaw（智谱清言桌面端）产品配置 —— 唯一真相源。
 *
 * ## 数据与协议来源
 *
 * - API 基址：`https://autoglm-acceleration-api.zhipuai.cn`
 * - 认证静态参数：`appId = '100003'`, `appKey = '38d2391985e2369a5fb8227d8e6cd5e5'`
 * - 核心模型：`zai_glm-5.3-flash`（实测免费畅通可用）、`zaicoding_glm-5.3`、`zai_auto`
 * - 协议：OpenAI Chat Completions 兼容，SSE text/event-stream 响应
 * - 406 绕过硬性约束：首条 message 必须为 system 且包含前缀
 *   `You are AutoClaw. Answer the user directly and concisely`
 */

export interface AutoclawFallbackModel {
  /** 模型 ID（传给上游的 model 标识，例如 zai_glm-5.3-flash）。 */
  readonly id: string
  /** UI 显示名称。 */
  readonly name: string
  /**
   * 真实上下文窗口大小（Token 数）。通过智谱官方模型配置端点实测探测为 1M (1,048,576)。
   *
   * ⚠️ **字段名已与桌面端源码核对**（2026-10-17，`AutoClaw2\...\dist\main.cjs`
   * 的 `normalizeModel`）：远端模型配置报文的键就是 **`contextWindow`**（驼峰），
   * 且上游用 `boundedPositiveInteger(value, 1e7)` 钳制、`>= 1e3` 才采纳。
   */
  readonly contextWindow: number
  /**
   * 最大输出 Token 数。
   *
   * ⚠️ **字段名已与桌面端源码核对**（同上，`normalizeModel`）：远端报文的键
   * 是 **`maxTokens`**（不是 `max_output_tokens`），上游钳制在 `1e6`，且有
   * 一条额外约束：**`maxTokens` 必须 `< contextWindow`**，否则整条被丢弃。
   * ⇒ 本仓库 `parseAutoclawRemoteModels` 的候选别名里 `maxTokens` 在列。
   */
  readonly maxOutputTokens?: number
  /**
   * 是否支持图片输入。
   *
   * ⚠️ **远端字段名已核对**（同上，`normalizeInput`）：远端用 **`input`**
   * 数组，元素只接受 `"text"` / `"image"`；**缺该字段或非数组时回落
   * `["text"]`** ⇒ 这与我们「未知按不支持处理」的口径一致。
   */
  readonly supportsImage?: boolean
  /** 是否归类为免费额度模型。 */
  readonly isFree?: boolean
}

/**
 * 上游认可的思考档位词汇表（2026-10-17 **实测取证**，非推测）。
 *
 * 来源：桌面端 `dist\main.cjs` 的 `MODEL_THINKING_LEVELS`，同一常量还被
 * SQLite 的 `CHECK(thinking_level IN (...))` 约束引用 ⇒ 两处独立印证。
 *
 * ⚠️ 本仓库只声明其中**三档**（`low` / `high` / `max`）——刻意**不**声明
 *   `off`：关思考在本仓库语义里由「不传 `reasoningEffort`」表达，而把
 *   `off` 混进档位数组会让客户端多出一格「关闭」，且与兄弟渠道
 *   （buddy / raccoon / zcode）的档位轴不一致。
 *
 * ⚠️ 数组顺序 = **强度序（弱→强）**，不是「默认档排第一」——宿主把它当
 *   展示顺序且官方客户端直接 `map` 不排序（AGENTS.md 明文记载）。
 */
export const AUTOCLAW_THINKING_LEVELS = Object.freeze([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
] as const)

/**
 * 编译期兜底模型表。
 *
 * ## ⚠️⚠️ 本表与远端目录**不完全一致**，且这是**有意保留**的（2026-10-17 真机取证）
 *
 * 对 `autoclaw-model-config` 真实 GET（用插件自己的凭据）拿到的目录**只有 3 条**：
 *
 * | id | 远端 | 本表 | 说明 |
 * |---|---|---|---|
 * | `zai_auto` | ✅ | ✅ | 数值逐格一致 |
 * | `zai_auto-fast` | ✅ | ✅ | 数值逐格一致 |
 * | `zaicoding_glm-5.3` | ✅ | ✅ | 数值逐格一致 |
 * | `zai_glm-5.3-flash` | ❌ **不在目录里** | ✅ 保留 | 见下 |
 *
 * **三个共有模型的三项能力（`contextWindow` / `maxTokens` / `input`）
 * 与远端逐格一致** —— 这是本表数值可信的直接证据。
 *
 * ### 为什么仍保留 `zai_glm-5.3-flash`
 *
 * 「目录里没有」≠「不可用」：真机实测**直接调它仍然 200 且正常回复**
 * （`reasoning_tokens=46`）。合理解释是目录按账号/灰度裁剪，或它属「兼容保留」
 * 通道。⇒ 保留它，因为：
 * - 它是 PR 里唯一标 `isFree: true` 的模型，**删掉会让免费额度分栏变空**；
 * - 删掉之后用户**无法**再选用一个实测可用的模型。
 *
 * ⚠️ 但**必须如实登记**它与目录不一致 —— 否则后人看代码会以为目录里也有它。
 * ⚠️ 若将来它真的下线（调用返回 `400 非法模型`），本表要一并删掉它。
 *
 * ### 名称差异（保留本表写法）
 *
 * 远端 `name` 是 `Auto` / `Auto-Fast` / `GLM-5.3`（**不含品牌前缀**），本表加了
 * `AutoClaw` / `(AutoClaw)` 后缀。这是**刻意的**：DSH 的模型选择器是跨渠道
 * 平铺的，不带前缀会与别的渠道的 `Auto` / `GLM-5.3` 混淆（本仓库
 * `providers-buddy` 笔记记载过「同名模型必须把品牌写进 name」的要求）。
 */
export const AUTOCLAW_FALLBACK_MODELS: readonly AutoclawFallbackModel[] = [
  {
    // ⚠️ 远端目录里**没有**这一条，但实测**直接调用仍可用**（见上方说明）。
    //   它是唯一的 `isFree: true` 模型 ⇒ 删掉会让「免费额度」分栏变空。
    id: 'zai_glm-5.3-flash',
    name: 'GLM-5.3 Flash (AutoClaw)',
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'zaicoding_glm-5.3',
    name: 'GLM-5.3 Coding (AutoClaw)',
    contextWindow: 1048576,
    maxOutputTokens: 307200,
    supportsImage: false,
    isFree: false,
  },
  {
    id: 'zai_auto',
    name: 'AutoClaw Auto',
    contextWindow: 1048576,
    maxOutputTokens: 393216,
    supportsImage: false,
    isFree: false,
  },
  {
    id: 'zai_auto-fast',
    name: 'AutoClaw Auto Fast',
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    supportsImage: true,
    isFree: false,
  },
]

/**
 * 本仓库对外声明、并作为**默认档**使用的思考档位。
 *
 * ## 为什么只声明三档、且默认 `high`（用户 2026-10-17 决定）
 *
 * 上游词汇表有 7 档（见 {@link AUTOCLAW_THINKING_LEVELS}），但实测取证表明
 * **推理量在档内波动跨 16 倍、区间完全重叠**（详见
 * `docs/audit/pr111-autoclaw-audit.md` 的踩坑记录）⇒ 我们**无法**用数据证明
 * 相邻档位（如 `low` vs `medium`）存在可感知差异。
 *
 * ⇒ 声明策略：**只给差异最可能显著的三个端点档**，不做更细的分档 ——
 *   展示一个「实际无差别」的档位等于给用户假选择。
 *
 * ### 默认 `high` 而不是 `max`
 *
 * 用户 2026-10-17 明确取舍：**`max` 的适用面太窄**。
 * - `max` 是「极限推理」：实测在难题上单次可跑 **170~192 秒**
 *   （`max`/`low` 都有超 190s 的样本），日常对话的等待代价过高；
 * - `high` 是智谱官方标注的**推荐默认**
 *   （`docs/autoclaw-models.md:72`：「【官方推荐默认】完整展开推导演算」）；
 * - 远端目录的 `reasoningLevel` 顺序也是 `["low","high","max"]`，
 *   `high` 居中是「均衡」位。
 *
 * ⚠️ 所以 `high` 是**折中**而**非**「证明最强可用」——它是「够用且不会让用户
 *   等两分钟」的那一档。要极限推理时用户可手动选 `max`。
 *
 * ⚠️ 顺序是**强度序（弱→强）**，不是「默认档排第一」：宿主把它当展示顺序，
 *   官方客户端直接 `map` 不排序（AGENTS.md 明文记载）⇒ 若把 `high` 排到首位，
 *   横向档位轴会变成「左强右弱」。
 */
export const AUTOCLAW_DECLARED_EFFORTS = Object.freeze(['low', 'high', 'max'] as const)

/** 默认思考档：`high`（理由见 {@link AUTOCLAW_DECLARED_EFFORTS}）。 */
export const AUTOCLAW_DEFAULT_EFFORT = 'high' as const

/**
 * 各档的中文展示名（与 {@link AUTOCLAW_DECLARED_EFFORTS} 一一对应）。
 *
 * ⚠️ 单独一张表而不是内联在 adapter 里：`Record` 的类型能保证
 *   「新增档位忘了写名字」在**编译期**就红，而不是运行时显示 `undefined`。
 */
export const AUTOCLAW_EFFORT_LABELS: Readonly<Record<
  (typeof AUTOCLAW_DECLARED_EFFORTS)[number], string
>> = Object.freeze({
  low: '快速思考 (Low)',
  high: '深度思考 (High)',
  max: '极限推理 (Max)',
})

/**
 * 模型输入模态的**唯一定义处**（2026-10-17 审计 P0 修复）。
 *
 * ## 为什么必须是纯函数、且两个入口共用一份
 *
 * 修复前 `AutoclawAdapter` 的两个入口对**同一个模型**说了两套相反的话：
 *
 * | 入口 | 原写法 | 对 `zai_auto-fast` 的结论 |
 * |---|---|---|
 * | `resolveModel` | `known?.supportsImage ? ['text','image'] : ['text']` | 支持图片 |
 * | `listModels` | 硬编码 `['text']` | **不支持**图片 |
 *
 * 而宿主两处都会用，且**用途不同**（`dsh-llm/lib/index.js`）：
 *
 * - `resolveModel` 的那份 → `normalizeModelInfo` 的 `inputModalities` →
 *   **请求前门禁**（`index.js:2311`）：声明里没有 `image` 就把图片
 *   **投影成文本占位符**，声明里有则**原样放行**给适配器；
 * - `listModels` 的那份 → 模型选择器与聚合目录。
 *
 * ⇒ 两处不一致 = 「选择器说能看图 → 门禁放行 → 适配器抛错」，
 *   且同一 provider 内不同模型走两套图片通路（本仓库已记录 `accio` 那条
 *   教训：`['text']` 与省略**语义不同** —— 省略 = 未知 = 放行，
 *   显式 `['text']` = 明确不支持）。
 *
 * ## ⚠️ 为什么未知模型显式给 `['text']` 而不是省略
 *
 * 省略 = 「未知」= 宿主放行 ⇒ 不支持图片的模型会**静默忽略图片并幻觉**
 * （`docs/agent-notes/providers-accio.md` 记载：GLM 5.1 据此幻觉出答案）。
 * 故「不知道」一律按「不支持」处理：宁可少一次能力，不可多一次幻觉。
 *
 * @param entry 兜底表里的一条；`undefined` = 用户手填的未知模型 id。
 */
export function inputModalitiesOf(
  entry: AutoclawFallbackModel | undefined,
): readonly ['text'] | readonly ['text', 'image'] {
  return entry?.supportsImage === true ? ['text', 'image'] : ['text']
}

export const AUTOCLAW_API_BASE = 'https://autoglm-acceleration-api.zhipuai.cn'
export const AUTOCLAW_APP_ID = '100003'
export const AUTOCLAW_APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5'
export const AUTOCLAW_SOURCE_ID = 'autoclaw'
export const AUTOCLAW_PRODUCT_NAME = 'autoclaw'

export const AUTOCLAW_DEFAULT_CREDENTIAL_REF = 'AUTOCLAW_ACCOUNT_DEFAULT'

export interface AutoclawProduct {
  readonly id: 'autoclaw'
  readonly displayName: string
  readonly apiBase: string
  readonly appId: string
  readonly appKey: string
  readonly product: string
  readonly defaultCredentialRef: string
  readonly fallbackModels: readonly AutoclawFallbackModel[]
}

export const AUTOCLAW: AutoclawProduct = {
  id: 'autoclaw',
  displayName: 'AutoClaw (智谱)',
  apiBase: AUTOCLAW_API_BASE,
  appId: AUTOCLAW_APP_ID,
  appKey: AUTOCLAW_APP_KEY,
  product: AUTOCLAW_PRODUCT_NAME,
  defaultCredentialRef: AUTOCLAW_DEFAULT_CREDENTIAL_REF,
  fallbackModels: AUTOCLAW_FALLBACK_MODELS,
}
