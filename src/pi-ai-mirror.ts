/**
 * 把本地 Anthropic 桥声明成 `llm-pi-ai` 的**声明式 provider**。
 *
 * ## 为什么不自己 `registerConfigurableProviders`
 *
 * `dsh-llm` 的 `commit()` 对已存在的 route 直接抛 `DUPLICATE_DIRECTORY`，
 * 而 `llm-pi-ai` 已经把 `providers.<route>` 里的每个键登记进 directory
 * （`ensureDirectory()` → `directory.replace(entries)`）。再声明一次会让
 * **整个插件加载失败**（注册是 all-or-nothing，抛错后后面的
 * `registerAdapter` 全部不执行）—— free-glm 的 `6ad3b2c` 实测过这条：
 * `LlmError: configurable provider "zcode-free" is already declared at
 * registerConfigurableProviders (dsh-llm/lib/index.js:1937)`。
 *
 * ⇒ 本模块**只写配置**（`settings.mutate("llm-pi-ai", ...)`），route 的
 * 声明完全由 `llm-pi-ai` 自己完成。写完之后它的
 * `ctx.on("loader/volatile-update")` 会自动 `ensureRegistrationFacts()`
 * 与 `ensureDirectory()`，**不需要重启 DSH**。
 *
 * ## 为什么必须换一个新 id（`zcode-free` ≠ `zcode`）
 *
 * `dsh-llm` 的 `registerAdapter` 判据是
 * `if (unique.has(provider) || this.adapters.has(provider) && !owned.has(provider))`
 * → `DUPLICATE_ADAPTER`，而且**不在任何 try 里**，启动期直接抛，
 * 会打断整个 profile 加载。`zcode` 已被本插件的适配器占用，
 * 故镜像 route 取 `zcode-free`（满足官方 `ROUTE_PATTERN
 * /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`）。
 *
 * ## 为什么每次加载都要重写
 *
 * 桥用 `server.listen(0, "127.0.0.1")` 由系统分配端口，**没有环境变量能固定**，
 * 所以 `baseURL` 每次进程启动都不同。好处是 `providers` 是 `.volatile()`
 * 字段，写下去即时生效。
 *
 * ## 为什么刻意不写凭据
 *
 * 桥是自己的进程内 HTTP 服务，不需要任何鉴权。但 pi-ai 的
 * `assertRequestAuth()`（`pi-ai/dist/api/anthropic-messages.js:169-178`）
 * 在「既没有 apiKey、也没有 authorization / x-api-key /
 * cf-aig-authorization 头」时抛 `No API key for provider: ...`；
 * Anthropic SDK 的 `validateHeaders()` 同样要求二者之一存在。
 * 而 `apiKeyEnv` 一旦声明就必须**真有**那份凭据，否则
 * `resolveApiKey` 抛 `MISSING_CREDENTIAL`。
 *
 * ⇒ 正解是**不声明 `apiKeyEnv`**，改在 `headers` 里塞一个固定的假
 * `x-api-key`：`requestHeaders()` 只剔除与 attribution 同名的键，
 * 自定义头能穿透到 SDK 的 `defaultHeaders`，两处闸门同时放行。
 *
 * ## 模型目录：官方模板与思考档位
 *
 * 每个模型都显式写 `contextWindow` / `maxTokens` —— 只有显式写出的
 * `maxTokens` 才会进 `configuredMaxTokens`（`resolveRouteModels` 里
 * `if (entry.maxTokens !== void 0) configuredMaxTokens.set(...)`），
 * 也才能在官方模型卡片里编辑「最大输出」。
 *
 * `reasoningEfforts` 是三档思考强度的**唯一**来源：pi-ai 的
 * `resolveModelReasoning` 从它推出 `thinkingLevelMap`（未声明的档位被钉成
 * `null`），`getSupportedThinkingLevels` 再把 `null` 的档位过滤掉 ——
 * 于是声明 `{low, high, max}` 得到的选择器档位**恰好是 三个**，
 * 由 composer 通过 `reasoningEfforts` 传回、pi-ai 用
 * `mapThinkingLevelToEffort` 原样取出，最终以
 * `output_config.effort` 落到上游（配合 route 级
 * `compat.forceAdaptiveThinking: true`，wire 形态是
 * `thinking:{type:"adaptive"}` + `output_config:{effort}`）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { readService } from './settings-compat.js'
import type { ZcodeBridgeHandle } from './zcode-bridge.js'
import type { ZcodeRemoteModelLike } from './zcode-product.js'

/** 镜像 route 名。**不能**等于 `zcode`（会被判 `DUPLICATE_ADAPTER`）。 */
export const MIRROR_ROUTE = 'zcode-free'

/** 假凭据头的值；桥不校验它，只为过 pi-ai / Anthropic SDK 的鉴权闸门。 */
export const MIRROR_DUMMY_KEY = 'zcode-bridge'

/** 镜像卡片的展示名。 */
export const MIRROR_DISPLAY_NAME = 'ZCode（智谱免费额度 · 官方模板）'

/** pi-ai 认识的思考档位（`THINKING_LEVELS`），用于过滤上游多余的档位。 */
const PI_AI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** `llm-pi-ai` 的条目 id（= 它的 settings 命名空间）。 */
const PI_AI_SETTINGS_NS = 'llm-pi-ai'

/** 桥默认的三档（上游未声明档位时的兜底，与 `ZCODE.fallbackModels` 同源）。 */
const DEFAULT_REASONING_LEVELS: readonly string[] = ['low', 'high', 'max']

/**
 * `ctx.settings` 在 0.1.7+ 上的写入面。
 *
 * `settings-compat.ts` 的 `SettingsServiceLike` 刻意不含 `mutate`
 * （老契约没有它），故这里按结构再声明一次并逐项判能力。
 */
interface SettingsWriterLike {
  describe?: (options?: { redactSecrets?: boolean }) => Array<{ ns: string; revision?: number }>
  mutate?: (
    ns: string,
    ops: ReadonlyArray<{ op: 'set'; path: string[]; value: unknown }>,
    expectedRevision?: number,
  ) => Promise<unknown>
}

/** 同步结果，供调用方决定要不要打日志。 */
export interface MirrorSyncResult {
  /** 是否真的写进去了。 */
  written: boolean
  /** 未写入的原因（已含足够上下文，可直接进日志）。 */
  reason?: string
}

/** 上游模型 → `llm-pi-ai` 的 `models` 条目。 */
function mirrorModel(entry: ZcodeRemoteModelLike): Record<string, unknown> {
  const declared = entry.reasoningLevels ?? DEFAULT_REASONING_LEVELS
  const efforts: Record<string, string> = {}
  for (const level of declared) {
    // 只保留 pi-ai 认识的档位：多写一个未知键会让 `z.dict` 校验直接失败，
    // 进而使**整个** `llm-pi-ai` 段落被判非法（`resolveProfiles` 的标量检查
    // 在 try 之外，抛错会连累同段其它 route）。
    if ((PI_AI_THINKING_LEVELS as readonly string[]).includes(level)) efforts[level] = level
  }
  return {
    id: entry.id,
    name: entry.name,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    input: entry.supportsImage ? ['text', 'image'] : ['text'],
    // 空映射会让 `resolveModelReasoning` 抛「offers no level beyond off」，
    // 故无档位的模型必须显式写 `false`（= 非推理模型）。
    ...(Object.keys(efforts).length > 0 ? { reasoningEfforts: efforts } : { reasoningEfforts: false }),
  }
}

/** 读当前 revision；读不到就不带乐观锁（宁可冒险也不要因为读不到而完全写不进去）。 */
function revisionOf(settings: SettingsWriterLike): number | undefined {
  try {
    return settings.describe?.().find(row => row.ns === PI_AI_SETTINGS_NS)?.revision
  } catch {
    return undefined
  }
}

/**
 * 把桥写进 `llm-pi-ai.providers.<MIRROR_ROUTE>`。
 *
 * **尽力而为**：任何一步失败都只返回 `{written:false, reason}`，
 * 由调用方打一条 warn。镜像不可用绝不该影响 `zcode` 直连通道。
 */
export async function syncPiAiMirror(
  ctx: Context,
  bridge: ZcodeBridgeHandle,
  options: { route?: string; displayName?: string; logger?: { info?: (m: string) => void; warn?: (m: string) => void } } = {},
): Promise<MirrorSyncResult> {
  const route = options.route ?? MIRROR_ROUTE
  const settings = readService(ctx, 'settings') as SettingsWriterLike | undefined
  if (typeof settings?.mutate !== 'function') {
    return { written: false, reason: '当前 DSH 的 settings 服务没有 mutate（老契约），跳过声明式镜像' }
  }

  let models: readonly ZcodeRemoteModelLike[]
  try {
    models = await bridge.models()
  } catch (error) {
    return { written: false, reason: `读取桥的模型目录失败：${String(error)}` }
  }
  if (models.length === 0) {
    return { written: false, reason: '桥没有报告任何模型，跳过（空 models 会让 route 被判非法）' }
  }

  const value = {
    displayName: options.displayName ?? MIRROR_DISPLAY_NAME,
    // 必须是 `anthropic-messages`：只有这样 `listingUrl()` 才会去请求
    // `${baseURL}/v1/models`，`assertRequestAuth()` 才走 Anthropic 分支。
    api: 'anthropic-messages',
    // ⚠ 不含 `/v1` —— Anthropic SDK 自己会拼 `/v1/messages`。
    baseURL: bridge.baseUrl,
    headers: { 'x-api-key': MIRROR_DUMMY_KEY },
    // 默认档位给 `max`（与 `ZCODE.fallbackModels` 的 `defaultReasoningLevel`
    // 一致）；不写的话 composer 未显式选档时 pi-ai 会完全不带
    // `output_config`，上游就退回它自己的默认值。
    reasoning: 'max',
    models: models.map(mirrorModel),
    compat: { forceAdaptiveThinking: true },
  }
  const op = { op: 'set' as const, path: ['providers', route], value }

  // 乐观锁：revision 在别处被改过就重读重写。三次足够（每轮都是最新读）。
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await settings.mutate(PI_AI_SETTINGS_NS, [op], revisionOf(settings))
      options.logger?.info?.(
        `[zcode-bridge] 已把本地桥声明为 llm-pi-ai 的 provider「${route}」→ ${bridge.baseUrl}`,
      )
      return { written: true }
    } catch (error) {
      lastError = error
    }
  }
  return { written: false, reason: `settings.mutate 失败：${String(lastError)}` }
}
