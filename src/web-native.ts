/**
 * 让 DSH 官方的 `web_search` / `web_fetch` 在 **buddy 系渠道**下走腾讯原生后端。
 *
 * ## 这个模块解决什么
 *
 * DSH 的搜索走 Host 的 `ctx.web` seam，默认 provider 是 `deepseek-official`
 * （`web-search-deepseek`）：它只认 DeepSeek 账号令牌与 `DEEPSEEK_API_KEY`，
 * 而账号令牌分支写死了 `provider === 'deepseek-account'`。于是 buddy / workbuddy
 * 路由下搜索必然落到 API Key 路径，没有 key 就报
 * `WEB_PROVIDER_CREDENTIAL_MISSING`。
 *
 * 而腾讯客户端**自带**原生搜索（`/agenttool/v1/search` 与 `/agenttool/v1/webfetch`），
 * 与聊天同源、同账号。本模块把那两个端点接到官方工具上。
 *
 * ## 设计约束（用户明确要求）
 *
 * 1. **替换，不新增**：不注册新工具、不加提示词、不改 schema —— 模型无感。
 * 2. **跟随渠道**：当前会话用什么渠道，就用那个渠道的原生搜索。
 * 3. **只做 buddy 系**：`buddy` + `workbuddy` 两条，其余一概不碰。
 * 4. **不回退、不路由**：判断不通过就 `return next()`，官方链路逐字节不变。
 *
 * ## 为什么挂在 `tools/execute`
 *
 * `tools/execute` 是 Cordis 的 **waterfall**：`next()` 就是「执行原工具体」。
 * 不调 `next()` 直接返回 `{ value }` ⇒ 官方工具体不执行，但返回值仍会被
 * `createSuccessResult(exec, 原工具, value)` 用**原工具自己的** `output.schema`
 * 校验、用它的 `render` 渲染 ⇒ 模型看到的结果与官方**同构**。
 *
 * 实测（cordis 4.0.2）：不调 `next()` 时内层工具体确实不执行，故**必须**返回
 * `{ value }` 形状。若返回 `undefined`，宿主会在 `normalizeDispatchResult` 里
 * 读 `result.isError` 而抛 `TypeError`，被外层 catch 转成一句无意义的
 * `Error: Cannot read properties of undefined (reading 'isError')` ——
 * 模型拿不到任何有用信息。（此条为**宿主源码推断**，未在真实宿主实跑。）
 *
 * ## 与插件既有行为的一致性
 *
 * 选号复用适配器自己的 `resolveCredentialFor()`（转发到聊天链路用的同一个
 * `resolveCredential`），因此「哪些号可用、选哪个号」与聊天完全一致。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { BuddyCredential } from './buddy.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from './product.js'

/**
 * `tools/execute` 的事件类型说明。
 *
 * ⚠️ **刻意不用 `declare module '@deepseek-ai/cordis' { interface Events { … } }`**
 * 去声明这个事件（对抗性审查 M4）：
 *
 * 该事件由 `@deepseek-ai/dsh-tools` 用 `declare module` 扩展声明。TS 的接口合并
 * 会把**同名成员的两次声明变成重载集合** —— 我们的签名（无 `this`、`exec` 更窄、
 * 返回 `unknown`）与宿主签名（`this: Scoped<ToolRuntime>`、返回
 * `Promise<ToolExecutionResult>`）在**使用点**冲突，独立 `tsc` 复现为 TS2345。
 *
 * 当前爆炸半径小（`index.d.ts` 不含本模块导入、不随包外泄），但会把雷埋给
 * 「将来把 `dsh-tools` 加进 devDependency 做集成测试」的那一刻。
 *
 * 故改为**一次局部断言**：只在挂载点把 `scope` 收窄成我们需要的窄接口，
 * 不触碰全局 `Events`。代价是这里失去该事件名的编译期拼写检查 ——
 * 由本文件与 `tests/unit/web-native.spec.ts` 的行为用例共同兜住。
 */
interface ToolExecuteScope {
  on(event: 'tools/execute', listener: (exec: WebNativeToolExecution, next: () => Promise<unknown>) => unknown): void
}

/** `tools/execute` 事件里本模块用到的那部分 exec。 */
export interface WebNativeToolExecution {
  /** 工具名（`web_search` / `web_fetch`）。 */
  readonly name: string
  /**
   * 工具入参（**未经官方 schema 校验**）。
   *
   * ⚠️ 短路跳过了 `defineTool` 包装的 `execute`，而官方 schema 校验就在那里面
   *（见 `readQueries` 的说明）⇒ 这里拿到的入参**可能是任意形状**，本模块必须
   * 自己逐项校验，不能假设它已经是 `{ queries: string[] }`。
   */
  readonly arguments: unknown
  /** 本次调用的取消信号（外层超时策略可能已替换为带 deadline 的版本）。 */
  readonly signal: AbortSignal
  /** 发起本次调用的 agent；缺席表示非会话发起的调用。 */
  readonly agent?: {
    readonly session: {
      /**
       * 折叠后的 `request/header` 事件：当前会话最新解析出的路由配置。
       * 官方 `read_image` 的 `assertImageCapableRoute` 用的就是它。
       */
      requestHeader(): { readonly config?: { readonly provider?: string; readonly model?: string } } | undefined
    }
  }
}

/**
 * 纳入本模块的渠道 → 产品配置。
 *
 * ⚠️ **必须复用 `product.ts` 的常量**，不要另抄一份 endpoint：两者是**同一客户端
 * 的两套环境端点**（中国区 `copilot.tencent.com` / 国际版 `www.workbuddy.ai`），
 * 插件改端点时必须一起跟随。
 */
const CHANNEL_PRODUCTS: Readonly<Record<string, BuddyProduct>> = {
  buddy: CODEBUDDY,
  workbuddy: WORKBUDDY,
}

/**
 * 单次搜索返回的 source 上限。
 *
 * ⚠️ **写死 8**：这是官方 `@deepseek-ai/dsh-tool-web` 的 `searchMaxResults`
 * schema 默认值（`WEB_SEARCH_MAX_RESULTS = 8`），但它是该包的**闭包变量**，
 * 未暴露到任何服务上，外部拿不到。
 *
 * 后果需知：若部署在 `cordis.yml` 里覆盖了 `tool-web.searchMaxResults`，
 * 本模块仍按 8 截断 —— 已知的、可接受的偏差（见模块头的「替换」约束）。
 *
 * ## 这个 8 有双重身份，不是巧合
 *
 * 它**同时**是「发给上游的 `max_results`」和「本地合并后的截断上限」：
 * - **上游侧**：实测 `max_results` 完全生效，1/3/5/8 原样返回、>8 一律封顶 8
 *   （见 `docs/workbuddy-native-search-research.md` §6.5）⇒ 上游已按 8 限流；
 * - **本地侧**：多 query 合并后仍需 cap（seam 的 `capSources()` 被短路跳过）。
 *
 * ⚠️ 双重截断可能导致**静默少结果**：若上游对 `max_results` 的理解与「返回条数」
 * 不同（例如按候选池计），本地去重后再截会让最终条数少于 8。属可接受的保守行为
 * ——少给总比超发安全，且上游实测行为已确认是按返回条数。
 */
const MAX_RESULTS = 8

/**
 * 单次调用允许的 query 数上限。
 *
 * 与 {@link MAX_RESULTS} 同源：官方 `WEB_SEARCH_MAX_QUERIES = 4`，同样是
 * `dsh-tool-web` 的闭包变量、外部拿不到，故写死并在此注明依据。
 */
const MAX_QUERIES = 4

/** 上游请求超时（毫秒）。与客户端 `WEB_SEARCH_TIMEOUT_MS = 2e4` 对齐。 */
const UPSTREAM_TIMEOUT_MS = 20_000

/** 官方 `web_search` 工具名。 */
const WEB_SEARCH = 'web_search'
/** 官方 `web_fetch` 工具名。 */
const WEB_FETCH = 'web_fetch'

/**
 * 原生搜索链路的失败。
 *
 * ⚠️ **刻意不复用官方的 `WEB_*` 码**：那套码描述的是 `ctx.web` 的
 * **provider 选择**语义（`WEB_PROVIDER_*` / `WEB_DUPLICATE_PROVIDER` …），
 * 而本模块**绕过了 `ctx.web`**，直接调上游。借用会让后续排查误判归属。
 *
 * 形态对齐官方：官方工具层**不做任何包装**（零 try/catch），异常一路抛到
 * `dispatchToolBody` 的 catch，由 `toolErrorResult()` 统一转成
 * `{ isError: true, content: [{text: 'Error: …'}], error: { message, info } }`。
 * 故这里也**只抛不包**，让宿主产出与官方逐字同形的错误结果。
 */
export class WebNativeError extends HarnessError {}

/** 无可用账号。 */
const NO_ACCOUNT_CODE = 'WEB_NATIVE_NO_ACCOUNT'
/** 上游非 2xx。 */
const UPSTREAM_CODE = 'WEB_NATIVE_UPSTREAM'
/** 响应无法解析（上游返回了非预期形状）。 */
const BAD_RESPONSE_CODE = 'WEB_NATIVE_BAD_RESPONSE'
/**
 * 入参不合法。
 *
 * ⚠️ 与 {@link BAD_RESPONSE_CODE} **必须分开**（对抗性审查 m1）：后者描述的是
 * **上游响应**解析失败，而这里描述的是**模型给的入参**不合法。官方对应路径是
 * `defineTool` 的 `validate()` → `ToolArgsError`，其 code 是 **`INVALID_ARGS`**。
 * 复用「响应」码会让排查误判归属（本是模型传错参数，却去查上游）。
 */
const INVALID_ARGS_CODE = 'WEB_NATIVE_INVALID_ARGS'
/**
 * 上游请求超时。
 *
 * ⚠️ 与 {@link UPSTREAM_CODE} 分开（对抗性审查 m2）：超时是一条独立的失败归因。
 * 且要知悉：本模块的 `UPSTREAM_TIMEOUT_MS`（20s）**小于**官方 `web_search` 的
 * `timeoutMs`（30s），故本超时**总是先于**宿主 `tool-call-timeout-policy` 的
 * `TOOL_TIMEOUT` 触发 —— 模型看到的是本模块的文案，而不是「tool call timed out」。
 * 这是刻意的：原生链路的预算由本模块自己兜，不依赖外层包装器。
 */
const TIMEOUT_CODE = 'WEB_NATIVE_TIMEOUT'

/** 上游 search 响应的形状（只声明用到的字段；逐项都当作不可信输入处理）。 */
interface NativeSearchResponse {
  results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown } | null | unknown>
}

/** 上游 webfetch 响应的形状（只声明用到的字段）。 */
interface NativeFetchResponse {
  url?: unknown
  title?: unknown
  content?: unknown
  content_length?: unknown
  truncated?: unknown
  status_code?: unknown
}

/** 官方 `web_search` 的 output value。 */
interface WebSearchValue {
  sources: Array<{ url: string; title?: string; snippet?: string }>
  truncated: boolean
}

/** 官方 `web_fetch` 的 output value。 */
interface WebFetchValue {
  url: string
  statusCode: number
  body: { kind: 'text'; content: string }
  truncated: boolean
}

/** 适配器需要暴露给本模块的最小面（结构化，便于单测注入替身）。 */
export interface NativeSearchAdapter {
  /**
   * 用聊天链路**同一套**编排解析凭据（`BuddyAdapter.resolveCredentialFor`）。
   * @param modelId - 当前会话路由的模型 id。
   */
  resolveCredentialFor(modelId: string | undefined): Promise<BuddyCredential | undefined>
}

/**
 * 把原生搜索挂到官方 web 工具上。
 *
 * @param ctx - 插件上下文（`tools/execute` 由它派发）。
 * @param adapters - 两个 buddy 系渠道的适配器；**必须是聊天链路用的那两个实例**。
 * @param isEnabled - 「渠道原生搜索」总开关。返回 `false` 时**所有渠道**（含 buddy 系）
 *   一律 `next()` 回官方搜索。⚠️ **每次调用都会求值**，调用方不要在这里做缓存 ——
 *   用户随时可能在 Jet Hub 面板里切换它。
 */
export function installWebNative(
  ctx: Context,
  adapters: Readonly<Record<string, NativeSearchAdapter>>,
  isEnabled: () => boolean,
): void {
  ctx.inject(['tools'], (scope) => {
    // 局部收窄：`tools/execute` 的类型由 `dsh-tools` 声明，本插件不依赖那个包
    //（理由见上方的 `ToolExecuteScope` 说明）。这是一次**刻意的**断言，
    // 不是随手写的 `as any` —— 收窄后的接口就是本模块真正读写的全部字段。
    const toolScope = scope as unknown as ToolExecuteScope
    toolScope.on('tools/execute', async (exec, next) => {
      // ① 只管官方这两个 web 工具，其余一概放行。
      if (exec.name !== WEB_SEARCH && exec.name !== WEB_FETCH) return next()

      // ② 总开关。关掉即**所有渠道**回官方搜索 —— 与「只做 buddy 系」不同，
      //    这一条对 buddy 系**也**生效（用户显式要求「要么都用原生要么都用官方」）。
      //    ⚠️ 必须放在渠道判断**之前**：关掉时不该有任何渠道被我们接管。
      if (!isEnabled()) return next()

      // ③ 读当前会话的路由。与官方 `read_image` 的 `assertImageCapableRoute`
      //    同一手法（`exec.agent.session.requestHeader().config`）。
      const route = exec.agent?.session.requestHeader()?.config
      const channel = route?.provider
      if (channel === undefined) return next()

      // ④ 只做 buddy 系。**没有 else 分支** —— 不通过即 `next()` 原样放行，
      //    官方链路（`runSearchQueries` → `ctx.web.search` → DeepSeek provider）
      //    逐字节不变。
      //
      //    ⚠️ 必须用 `Object.hasOwn` 而不是直接下标取值（真实缺陷，对抗性审查 M3）：
      //    两个表都是对象字面量，`channel` 取到原型链上的名字时查找会命中
      //    （`'constructor'` → `Object.prototype.constructor`，truthy 且非 `undefined`），
      //    于是守卫失效、进入短路分支。虽然要求会话路由的 provider 恰为这些字符串
      //    （可达性低），但守卫写法本身必须成立。
      if (!Object.hasOwn(CHANNEL_PRODUCTS, channel) || !Object.hasOwn(adapters, channel)) return next()
      const product = CHANNEL_PRODUCTS[channel]!
      const adapter = adapters[channel]!

      // ⑤ 短路：返回 `{ value }`，官方工具体不执行。
      return { value: await runNative(exec, product, adapter) }
    })
  })
}

/** 按工具名分发到 search / fetch。 */
async function runNative(
  exec: WebNativeToolExecution,
  product: BuddyProduct,
  adapter: NativeSearchAdapter,
): Promise<WebSearchValue | WebFetchValue> {
  const model = exec.agent?.session.requestHeader()?.config?.model
  // ⚠️ 与聊天链路同一个 `resolveCredential` 实例：筛号规则（enabled / 模型级
  //    限流 / 免费判定 / 余额分档 / 池兜底）因此完全一致。
  const credential = await adapter.resolveCredentialFor(model)
  // ⚠️ 必须同时判 `access_token` **是不是非空字符串**，不能只判 credential 存在：
  //    凭据是 `JSON.parse` 出来的外部数据，形状不可信（缺字段 / 类型错都可能）。
  //    只判 `credential === undefined` 会让坏凭据抛
  //    `TypeError: Cannot read properties of undefined (reading 'length')` ——
  //    模型看到的是一句无意义的 JS 报错，而不是「去登录」的指引。
  const accessToken = typeof credential?.access_token === 'string' ? credential.access_token : ''
  if (accessToken.length === 0) {
    throw new WebNativeError(
      `${product.id} search has no usable account; sign in to a ${product.id} account `
      + `from the Jet Hub panel first. The current route is "${product.id}". `
      + 'Only the user can change accounts.',
      NO_ACCOUNT_CODE,
    )
  }

  const args = asRecord(exec.arguments) ?? {}
  if (exec.name === WEB_FETCH) return await nativeFetch(args, accessToken, product, exec.signal)
  return await nativeSearch(args, accessToken, product, exec.signal)
}

/**
 * 调上游搜索并投影成官方 `web_search` 的 output value。
 *
 * 官方入参是 `queries: string[]`（1~4 个，结果按 rank 轮转合并），故这里对
 * 每个 query 各发一次，再按官方 `mergeSearchResults` 的规则合并。
 */
async function nativeSearch(
  args: Record<string, unknown>,
  accessToken: string,
  product: BuddyProduct,
  signal: AbortSignal,
): Promise<WebSearchValue> {
  const queries = readQueries(args.queries)

  // ⚠️ 复刻官方 `runSearchQueries` 的并发语义：**一方失败即中止其余，且等全部
  //    settle 后才重抛首个失败**（宿主 `tool-web/src/search.ts` 用的是
  //    `AbortController` + `controller.abort(error)` + `await Promise.allSettled`）。
  //
  //    裸 `Promise.all` 不行（真实缺陷，对抗性审查 M1/探针 F7）：首个失败会
  //    **立即**抛出，兄弟请求既不被 abort、也无人等待 —— 它们在后台跑完，
  //    白白消耗账号配额（搜索是计费/限流动作）。
  const controller = new AbortController()
  const batchSignal = AbortSignal.any([signal, controller.signal])
  let firstFailure: { error: unknown } | undefined
  /**
   * ⚠️ 用 `Map` 而不是稀疏数组 —— **这是纯防御，不是已证实的缺陷**。
   *
   * 失败时 `perQuery[index]` 不会被赋值，理论上会让下面的 `result.length` /
   * `result[rank]` 抛 `TypeError`。但实测（对抗性审查第二轮 Major-2）：把本处
   * 三行一并改回数组、再去掉可选链，**45 个用例仍全绿** —— 因为 `catch` 里
   * 必然设置 `firstFailure`，紧接着就会抛出，**失败路径根本走不到合并段**。
   *
   * 故本处**没有任何可观测的行为差异**，保留它只为把「顺序不变量」这层隐式
   * 依赖去掉：将来谁调整了「先抛后合并」的顺序，也不会因此崩。
   */
  const perQuery = new Map<number, WebSearchValue['sources']>()
  const searches = queries.map(async (query, index) => {
    try {
      perQuery.set(index, await searchOnce(query, accessToken, product, batchSignal))
    } catch (error) {
      // 只记**首个**失败，与官方一致（后续失败不再覆盖归因）。
      if (firstFailure === undefined) firstFailure = { error }
      controller.abort(error)
      throw error
    }
  })
  await Promise.allSettled(searches)
  if (firstFailure !== undefined) throw firstFailure.error

  // 复刻官方 `mergeSearchResults`：按 rank 轮转 + url 去重 + cap。
  // ⚠️ 按 query 的**原始顺序**取出结果（`Map` 的插入顺序在并发下不保证等于
  //    `queries` 顺序），与官方 `results[index]` 的语义一致。
  const ordered = queries.map((_, index) => perQuery.get(index))
  const seen = new Set<string>()
  const sources: WebSearchValue['sources'] = []
  let sourceRanks = 0
  for (const result of ordered) sourceRanks = Math.max(sourceRanks, result?.length ?? 0)
  let truncated = false
  merge: for (let rank = 0; rank < sourceRanks; rank++) {
    for (const result of ordered) {
      const source = result?.[rank]
      if (source === undefined || seen.has(source.url)) continue
      if (sources.length === MAX_RESULTS) {
        truncated = true
        break merge
      }
      seen.add(source.url)
      sources.push(source)
    }
  }
  return { sources, truncated }
}

/** 一次单 query 搜索；返回投影后的 source 列表。 */
async function searchOnce(
  query: string,
  accessToken: string,
  product: BuddyProduct,
  signal: AbortSignal,
): Promise<WebSearchValue['sources']> {
  const endpoint = `${product.endpoint}/agenttool/v1/search`
  const body = { query, type: 'text2text', max_results: MAX_RESULTS }
  // ⚠️ 响应体先过 `asRecord`：上游返回 JSON `null` 时直接读 `.results` 会抛
  //    `TypeError: Cannot read properties of null`（对抗性审查 F2），
  //    而我们想要的是「响应无法解析」这条业务错误。
  const { json } = await postJson(endpoint, body, accessToken, product, signal, 'search')
  const results = (asRecord(json) as NativeSearchResponse | undefined)?.results
  if (!Array.isArray(results)) {
    throw new WebNativeError(
      `${product.id} returned an unparseable search response: "results" is not an array.\n\n`
      + `The request used endpoint ${JSON.stringify(endpoint)}. `
      + 'Expected { results: [{ title, url, snippet }] }. '
      + 'This usually means the upstream API changed, or the account lacks search permission.',
      BAD_RESPONSE_CODE,
    )
  }

  const sources: WebSearchValue['sources'] = []
  for (const raw of results) {
    // ⚠️ 必须先挡 `null` / 非对象：`results: [null]` 时读 `item.url` 会抛
    //    `TypeError: Cannot read properties of null`（真实缺陷，对抗性审查 F1）——
    //    那会让**整条工具调用**失败，与本段的意图（畸形条目**丢弃**、少一条而已）相反。
    const item = asRecord(raw)
    if (item === undefined) continue
    const url = typeof item.url === 'string' ? item.url : ''
    // ⚠️ `url` 是官方 schema 的必填项（`additionalProperties: false` + `required`）。
    //    上游给不出 url 的条目直接丢弃，否则 `createSuccessResult` 会抛
    //    `ToolOutputError`（整个工具调用失败，而不是少一条结果）。
    if (url.length === 0) continue
    const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : undefined
    const snippet = typeof item.snippet === 'string' && item.snippet.length > 0 ? item.snippet : undefined
    sources.push({
      url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
    })
  }
  return sources
}

/**
 * 调上游抓取并投影成官方 `web_fetch` 的 output value。
 *
 * ⚠️ **`body.kind` 固定 `'text'`**：上游返回的 `content` **已经是转好的
 * Markdown**（实测含 `**加粗**`、`[链接](…)`、`# 标题`），而官方 `renderBody`
 * 对 `kind: 'html'` 会**再过一遍 turndown** —— 标错会把 Markdown 当 HTML 二次
 * 转换，内容被破坏。故这里必须标 `text`（原样输出）。
 *
 * ⚠️ 官方 `web_fetch` 工具**只有 `url` 一个参数**（无 `prompt`），故请求体只发
 * `url`；上游接受 `{ url }` 这一形态（`prompt` 是可选的）。
 */
async function nativeFetch(
  args: Record<string, unknown>,
  accessToken: string,
  product: BuddyProduct,
  signal: AbortSignal,
): Promise<WebFetchValue> {
  const url = typeof args.url === 'string' ? args.url.trim() : ''
  if (url.length === 0) throw new WebNativeError('url must be a non-empty string', INVALID_ARGS_CODE)

  const endpoint = `${product.endpoint}/agenttool/v1/webfetch`
  const { json: rawJson, httpStatus } = await postJson(endpoint, { url }, accessToken, product, signal, 'fetch')
  const json = (asRecord(rawJson) ?? {}) as NativeFetchResponse

  // ⚠️ `content` 必须是字符串：非字符串时静默变 `''` 会让模型拿到「成功但空正文」，
  //    且没有任何提示（对抗性审查 m5）。宁可报「响应无法解析」，让模型知道要换 URL。
  if (typeof json.content !== 'string') {
    throw new WebNativeError(
      `${product.id} returned a fetch response without a string "content".\n\n`
      + `The request used endpoint ${JSON.stringify(endpoint)}. `
      + 'Expected { url, content, status_code }. The page may be unsupported or the upstream API changed.',
      BAD_RESPONSE_CODE,
    )
  }

  // ⚠️ `statusCode` 在官方 output schema 里是 **integer**（宿主 `json-schema.js`
  //    用 `Number.isInteger` 判）。故：
  //    - 非数字 / 非整数 → 回落到 **HTTP 响应本身的 status**（不是硬编码 200！）；
  //    - 硬编码 200 会在上游返回错误页且不带 `status_code` 时，让模型误以为抓取成功
  //      （对抗性审查 m3：实测 `{url, content:'Not Found'}` → 报 statusCode=200）；
  //    - 浮点（如 200.5）会让 `createSuccessResult` 抛 `ToolOutputError`，整条调用失败
  //      （对抗性审查 m4）。
  const upstreamCode = Number.isInteger(json.status_code) ? (json.status_code as number) : undefined
  const statusCode = upstreamCode ?? httpStatus

  return {
    url: typeof json.url === 'string' && json.url.length > 0 ? json.url : url,
    statusCode,
    body: { kind: 'text', content: json.content },
    truncated: json.truncated === true,
  }
}

/**
 * 发一次上游 POST 并解析 JSON。
 *
 * 错误语义对齐官方：**直接抛**（工具层不包装，由宿主 `toolErrorResult` 统一转
 * `isError`），且文案带排障指引（端点、下一步动作、给模型的约束）。
 *
 * @param operation - 本次调用的动作名（`search` / `fetch`），只用于**错误文案**：
 *   两端点共用本函数，写死 "search" 会让抓取失败时归因误导（对抗性审查 Minor-1）。
 * @returns 解析后的 JSON 体，以及**上游 HTTP 状态**（后者供 fetch 在
 *   响应体缺 `status_code` 时回落 —— 绝不硬编码 200）。
 */
async function postJson(
  endpoint: string,
  body: unknown,
  accessToken: string,
  product: BuddyProduct,
  signal: AbortSignal,
  operation: 'search' | 'fetch',
): Promise<{ json: unknown; httpStatus: number }> {
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  const composed = AbortSignal.any([signal, timeout])

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: composed,
    })
  } catch (error) {
    // 取消与超时必须区分：前者是正常终止（`WEB_NATIVE_ABORTED`），
    // 后者是本模块自己的预算用尽（`WEB_NATIVE_TIMEOUT`），都不是上游故障。
    if (signal.aborted) {
      throw new WebNativeError(
        `${product.id} ${operation} aborted`,
        'WEB_NATIVE_ABORTED',
        { cause: error },
      )
    }
    if (timeout.aborted) {
      throw new WebNativeError(
        `${product.id} ${operation} timed out after ${UPSTREAM_TIMEOUT_MS}ms.\n\n`
        + `The request used endpoint ${JSON.stringify(endpoint)}. `
        + 'Web search/fetch uses the same account as chat but a separate endpoint. '
        + 'Retry, or narrow the request; if it keeps timing out the endpoint or network may be unreachable.',
        TIMEOUT_CODE,
        { cause: error },
      )
    }
    throw new WebNativeError(
      `${product.id} ${operation} request failed: ${errorMessage(error)}\n\n`
      + `The request used endpoint ${JSON.stringify(endpoint)}. `
      + 'Web search/fetch uses the same account as chat but a separate endpoint. '
      + 'If the network is unreachable or the endpoint is wrong, the user must decide how to proceed.',
      UPSTREAM_CODE,
      { cause: error },
    )
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new WebNativeError(
      `${product.id} ${operation} request failed (HTTP ${response.status})${detail}\n\n`
      + `The request used endpoint ${JSON.stringify(endpoint)}. `
      + 'Web search/fetch uses the same account as chat but a separate endpoint. '
      + "If the account's sign-in has expired, guide the user to sign in again from the Jet Hub panel; "
      + 'the endpoint does not need changing.',
      UPSTREAM_CODE,
    )
  }

  try {
    const json: unknown = await response.json()
    return { json, httpStatus: response.status }
  } catch (error) {
    throw new WebNativeError(
      `${product.id} returned a non-JSON response.\n\n`
      + `The request used endpoint ${JSON.stringify(endpoint)}. `
      + 'Expected a JSON body with { results: [{ title, url, snippet }] }.',
      BAD_RESPONSE_CODE,
      { cause: error },
    )
  }
}

/** 从非 2xx 响应里取一段可读的上游说明（截断，且不回显敏感内容）。 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    const trimmed = text.trim().slice(0, 300)
    return trimmed.length > 0 ? `: ${trimmed}` : ''
  } catch {
    return ''
  }
}

/**
 * 读取 `queries` 参数并校验。
 *
 * ## ⚠️ 为什么这里必须自己校验
 *
 * 官方工具的入参校验**不在** `tools/execute` 之外，而在 `defineTool` 包装的
 * `execute` **内部**（宿主源码）：
 * ```js
 * async execute(args, exec) {
 *   const violations = validate(args)          // ← 官方 schema 校验
 *   if (violations.length > 0) throw new ToolArgsError(violations)
 *   return userExecute(args, exec)             // ← 真正的工具体
 * }
 * ```
 * 而本模块**短路了 `dispatchToolBody`** ⇒ 那个 `execute` 根本不执行 ⇒
 * **官方校验被整体跳过**。故这里必须复刻官方 `parseSearchArgs` 的判据，
 * 否则畸形入参会一路传到上游（错误从「参数不合法」变成「上游 4xx」，
 * 模型得到的指引完全不同）。
 *
 * 判据与官方逐条对齐：
 * - 空数组 → 抛错；
 * - 超过 `maxQueries`（4）→ 抛错；
 * - 任一项 trim 后为空 → 抛错；
 * - 去重（官方用 `new Set`，这里同时 trim，差异见下方注释）。
 *
 * ⚠️ **一处刻意的小差异**：官方 `parseSearchArgs` 用 `[...new Set(queries)]`
 * **不 trim** 就去重，故 `' a '` 与 `'a'` 在官方是**两个** query。这里先 trim
 * 再去重，会把它们合并成一个。选择 trim 的理由：搜索是**外部副作用**，
 * 多发一次重复查询既慢又浪费账号配额，而两者的搜索语义完全相同。
 * 该差异只在「模型传了仅空白不同的重复 query」时可见，属可接受的收敛。
 *
 * @param value - 原始的 `queries` 入参（可能是任何形状）。
 * @returns 归一化后的 query 列表。
 * @throws {WebNativeError} 入参不满足官方判据时。
 */
function readQueries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new WebNativeError(
      'queries must be an array of strings',
      INVALID_ARGS_CODE,
    )
  }
  if (value.length === 0) {
    throw new WebNativeError('queries must contain at least one query', INVALID_ARGS_CODE)
  }
  if (value.length > MAX_QUERIES) {
    throw new WebNativeError(
      `queries must contain at most ${MAX_QUERIES} queries`,
      INVALID_ARGS_CODE,
    )
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new WebNativeError('each query must be a non-empty string', INVALID_ARGS_CODE)
    }
    const query = item.trim()
    if (query.length === 0) {
      throw new WebNativeError('each query must be a non-empty string', INVALID_ARGS_CODE)
    }
    if (!out.includes(query)) out.push(query)
  }
  return out
}

/**
 * 把未知值收敛成记录；非对象（含 `null`、数组之外的一切）返回 `undefined`。
 *
 * ⚠️ 与「返回 `{}`」不同：调用方需要能区分「不是对象」与「是空对象」，
 * 前者要丢弃、后者可能是合法入参。搜索结果的逐项过滤依赖这个区分。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** 错误 → 单行说明。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
