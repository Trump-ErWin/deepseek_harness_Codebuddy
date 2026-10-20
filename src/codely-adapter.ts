/**
 * Codely 适配器：**目录 + 推理**都已接通（推理走官方 CLI 子进程）。
 *
 * ## ⚠️⚠️ 推理为什么是「驱动官方 CLI」而不是自己发 HTTP
 *
 * 推理网关 `https://codely-litellm.tuanjie.cn/v1/chat/completions` 要求
 * `X-Codely-Signature`（HMAC-SHA256），签名密钥藏在官方客户端的编译产物里 ——
 * 2026-10-20 已穷尽以下手段，均未取得：
 *
 * 1. 二进制 64 位 hex 常量枚举（ASCII 412 + UTF-16 28 个）；
 * 2. 运行时进程内存 64 位 hex 枚举（425 个）；
 * 3. 进程内存 32 字节滑动窗口全量扫描（833MB × 三种派生假设）；
 * 4. 签名盐值附近 ±256KB 步长 1 精细扫描；
 * 5. 决定性实验：同 ts / 同 path 下把官方签名换成自算签名 → 401，官方 → 200。
 *
 * ⇒ 结论是「协议与端点都对，只差密钥」。与其发一个注定 401 的请求（那正是
 * 本仓库明令禁止的静默失效），不如**让官方客户端自己签名**：它带着合法凭据与
 * 签名逻辑，我们只消费它的输出（同 `qoder-machine.ts` 的既有取舍）。
 * 驱动层在 `src/codely-cli.ts`（含实测报文与代价说明）。
 *
 * ## 已知代价（用户 2026-10-20 拍板接受）
 *
 * - **依赖本机安装** Tuanjie Cowork CLI（`DSH_CODERLY_CLI_PATH` 可覆盖）；
 * - **凭据是 CLI 自己的登录态**，不是本插件账号池的那份 ⇒ 推理侧**没有**换号
 *   / 多账号（积分与签到仍走插件自己的凭据，不受影响）；
 * - **每次请求起一个进程**（实测端到端 ~3.1s）；
 * - **`--approval-mode yolo`**：CLI 可读写文件、执行命令（用户选的「更接近
 *   官方 CLI」体验；改成 `ask` 即只读）。
 *
 * ## 目录为什么能直接接（不需要签名）
 *
 * `GET /api/model-status` 只要 Bearer access_token（实测 200，8 个模型组），
 * 签名只用于推理网关 ⇒ 目录侧是完整、真实、可验证的能力。骨架复用共享实现
 * `createModelCatalog`（与 trae / cline 等家同款）：门控 → 远端优先、失败回退
 * 兜底表 → 黑名单 → 三态回填。
 */

import { LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
// 消息序列化**复用** `openai-compat.ts` 的权威实现：它已处理
// `tool_calls` / `role:'tool'` / `content:null` 规范 / 孤儿工具调用清理
// （`resolveToolPairing`）。自己再写一份必然漂移（仓库首条红线）。
import { serializeMessages } from './openai-compat.js'
// 工具参数三件套：空参补 `{}`、截断判定（顺序必须是「先判截断，再归一化」）
import { hasUsableToolName, isTruncatedArguments, normalizeToolArguments } from './sse.js'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountPool } from './account-pool.js'
import { createModelCatalog, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { CODERLY } from './codely-product.js'
import {
  CODELY_HTTP_TIMEOUT_MS,
  fetchCodelyCliApiKey,
  type CodelyCredential,
} from './codely-auth.js'
// 推理签名（2026-10-20 起不再需要任何客户端，见 `codely-sign.ts` 模块头）。
import { signedCodelyHeaders } from './codely-sign.js'
import { randomUUID } from 'node:crypto'
// 推理：驱动官方 CLI 子进程（签名密钥未取得，见模块头）。
import {
  runCodelyCli,
  type CodelyCliApprovalMode,
  type CodelyCliSpawner,
} from './codely-cli.js'
// ⚠️ 复用共享的「内容块 → 纯文本」，不另写一份同义实现（本仓库红线）。
import { contentToText } from './openai-compat.js'
// DSML 标记归一化（正文出口的强制项，见 `stream()` 内注释）。
import { createDsmlMarkerNormalizer } from './sse.js'

/** 远端目录条目（只取用得到的字段，其余忽略）。 */
export interface CodelyRemoteModel {
  /** 模型 id（`/api/model-status` 的 `modelGroup`）。 */
  id: string
  /** 运行状态（`operational` / `degraded` / `outage`；未知形态不猜）。 */
  status?: string
}

/**
 * **实测**支持图片输入的模型（2026-10-20，真凭据逐模型探测，5 个模型 × 2 次请求）。
 *
 * ⚠️ 全是实测结论，**不是按名字推断**：
 * - `codely-vl` 名字里的 vl 指 vision-language，但它收到 `image_url` 反而
 *   `400 invalid_parameter_error`；
 * - `codely-basic` 名字里看不出视觉能力，却正确答出了 1×1 PNG 的颜色。
 *
 * | 模型 | 图片 |
 * |---|---|
 * | `codely-basic` / `codely-flash` / `codely-air` | ✅ 收 `image_url` |
 * | `codely-core` | ❌ `400 Model only supports text` |
 * | `codely-vl` | ❌ `400 invalid_parameter_error` |
 *
 * ⇒ 用于 `toCatalogEntry` 的 `inputModalities`。上游若调整能力，只改这一处。
 */
const CODERLY_ABILITIES: Readonly<Record<string, readonly ('reasoning' | 'image' | 'tools')[]>> = {
  'codely-core': ['reasoning', 'tools'],
  'codely-basic': ['image', 'tools'],
  'codely-flash': ['reasoning', 'image', 'tools'],
  'codely-air': ['reasoning', 'image', 'tools'],
  'codely-vl': ['reasoning', 'tools'],
}

/** 能力中文名（顺序即展示顺序：推理 | 图片 | 工具）。 */
const CODERLY_ABILITY_LABEL: Readonly<Record<'reasoning' | 'image' | 'tools', string>> = {
  reasoning: '推理',
  image: '图片',
  tools: '工具',
}

/**
 * 模型选择器里追加的能力后缀（用户 2026-10-20 要求，**只标 Codely**）。
 *
 * ⚠️ 只写**具备**的能力：`codely-basic` 是「图片 | 工具」（它无思考链），
 *    `codely-core` 是「推理 | 工具」（它拒图）。不写「无」是为了不让名字过长。
 * ⚠️ 未知模型**不加后缀**（不编造）。
 */
function abilitySuffix(modelId: string): string {
  const abilities = CODERLY_ABILITIES[modelId]
  if (abilities === undefined) return ''
  return ` · ${abilities.map((ability) => CODERLY_ABILITY_LABEL[ability]).join(' | ')}`
}

/** `/api/model-status` 的原始报文（只取 `models[]`）。 */
interface RawModelStatus {
  models?: unknown
}

export interface CodelyAdapterOptions {
  /**
   * 取当前账号的凭据（**目录只读，不扣积分**）。
   *
   * ⚠️ 由接线层注入：适配器自己不知道账号池与凭据库。缺省（未注入）时
   *    目录走兜底表 —— 面板仍有 8 个模型，只是那份是编译期快照。
   */
  credentialProvider?: () => Promise<CodelyCredential | undefined>
  /**
   * 读取图片附件的原始字节（内联为 `data:` URL 用）。
   *
   * 由接线层注入 `makeReadImage(ctx)`（`ctx.attachments.readImage` 的桥接）。
   * 未注入时收到图片会报 `UNSUPPORTED_CONTENT`，**不静默丢图**。
   *
   * ⚠️ 上游**确实收图**（2026-10-20 实测：`codely-basic` 收到 1×1 PNG 的
   *    `image_url` 后答出「这张图是粉红色」，而 `codely-vl` 反而 400
   *    `invalid_parameter_error`）⇒ 图片通路必须接通，不能靠"模型不支持"搪塞。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 覆盖默认的 fetch（测试注入）。 */
  fetchImpl?: typeof fetch
  /** 账号池（目录门控 + 黑名单；缺它则无「已登录」门控，目录恒可见）。 */
  accountPool?: AccountPool
  /** 目录可用后回调 —— 接线层注入 `broadcastCatalogChanged(ctx)`。 */
  onCatalogLoaded?: () => void
  /**
   * 推理用的官方 CLI 路径（缺省按 `DSH_CODERLY_CLI_PATH` → 默认安装路径解析）。
   * 测试注入；生产不传。
   */
  cliPath?: string
  /** 审批模式，缺省 `yolo`（用户 2026-10-20 拍板；`ask` 为只读）。 */
  cliApprovalMode?: CodelyCliApprovalMode
  /** CLI 的工作目录（工具在此目录内工作），缺省 `process.cwd()`。 */
  cliCwd?: string
  /** 注入的 spawner（测试用）；缺省真 `spawn`。 */
  cliSpawner?: CodelyCliSpawner
  /** 环境变量源（测试用）；缺省 `process.env`。 */
  cliEnv?: NodeJS.ProcessEnv
}

export class CodelyAdapter extends LlmAdapter {
  /** 远端目录缓存；`undefined` = 还没读到（此时用兜底表）。 */
  private remoteModels: readonly CodelyRemoteModel[] | undefined
  /** 目录闸门：并发去重 + 失败冷却（依据见 `remote-catalog-gate.ts`）。 */
  private readonly catalogGate: RemoteCatalogGate
  private readonly catalog: ModelCatalog

  constructor(private readonly options: CodelyAdapterOptions = {}) {
    super()
    this.catalogGate = new RemoteCatalogGate(
      options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded },
    )
    this.catalog = createModelCatalog(
      { accountPool: options.accountPool },
      {
        product: CODERLY,
        loadCatalog: () => this.loadCatalogEntries(),
        syncCatalog: () => this.catalogEntries(),
        // ⚠️ 未知 id 保守报 `['text']`：宁可少报能力，也不要报一个服务端
        //    可能不认的模态（本渠道的多模态能力未按模型实测过）。
        unknownModelInputModalities: () => ['text'] as const,
      },
    )
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : CODERLY.id
    return { id, name: CODERLY.displayName }
  }

  /** ⚠️ 必须同步（`provider.status` 与 `ModelCatalogSource` 不 await）。 */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.catalog.listAllModels()
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(CODERLY.id)
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolveModel(provider, model)
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 推理：驱动官方 CLI 子进程，把它的增量输出转成 harness 的 StreamChunk。
   *
   * ⚠️ 出错一律**抛**，绝不返回空流 —— 静默空流会让上层显示「模型没说话」，
   * 而真实原因是 CLI 没装 / 没登录 / 模型不被允许（autoclaw 与 officeace 都
   * 记过同款静默失效）。
   */
  /**
   * 推理入口：**HTTP 直连网关**（2026-10-20 起默认，不需要任何客户端）。
   *
   * ⚠️ 仅当测试注入了 `cliSpawner` 时才走旧的 CLI 路径 —— 那是为了保住
   * `codely-cli.ts` 的调用点（零调用点 = 本仓库记过的陷阱）与既有 14 条用例；
   * **生产永远走 HTTP**。
   */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.options.cliSpawner !== undefined) {
      yield* this.streamViaCli(options)
      return
    }
    yield* this.streamViaHttp(options)
  }

  /** HTTP + SSE 真流式（签名见 `codely-sign.ts`；换发见 `codely-auth.ts`）。 */
  private async *streamViaHttp(options: GenerateOptions, retryBudget = 3): AsyncGenerator<StreamChunk> {
    const credential = await this.options.credentialProvider?.()
    if (
      credential === undefined
      || typeof credential.access_token !== 'string'
      || credential.access_token.length === 0
    ) {
      // ⚠️ 同样不用 `AUTH`：那会把这条指路文案换成「API 密钥无效」（见下方 `!res.ok` 的取证表）
      throw new LlmError(
        'codely: 没有可用凭据 —— 请先在 Jet Hub 的「账号池」里登录 Codely（推理已不需要安装任何客户端）',
        'PERMISSION_DENIED',
      )
    }
    const model = typeof options.model === 'string' ? options.model : ''
    if (model.length === 0) throw new LlmError('codely: 未指定模型', 'INVALID_REQUEST')

    /**
     * ⚠️ **前置校验：模型必须在本渠道「团队可访问」的目录内**。
     *
     * 宿主会记住上一次的选择，而那个选择可能是团队无权访问的公共模型名
     * （`DeepSeek-V4.1-Flash` 等，2026-10-20 真实报障：目录清理后用户仍卡在旧选择上，
     * 每轮 `401 team_model_access_denied`）。这里**主动拦下**并给出可切换的清单，
     * 而不是让请求打到上游换回一个 401。
     *
     * ⚠️ 刻意**不自动降级**到目录第一个：静默换模型会让用户以为在用 A 实际在跑 B
     *    （本仓库反对静默替换）。宁可报错并列出可用项。
     */
    const available = this.catalogEntries().map((entry) => entry.id ?? '')
    if (available.length > 0 && !available.includes(model)) {
      throw new LlmError(
        `codely: 模型 \`${model}\` 不在你当前的可用目录里`
        + `（本团队可访问：${available.join(' / ')}）`
        + '。请在模型选择器里切换 —— 目录里的 DeepSeek / GLM / KIMI 需要团队额外授权',
        'PERMISSION_DENIED',
      )
    }

    /**
     * ⚠️⚠️ **消息必须走 `serializeMessages`**，不能自己压平成 `{role, content}` 文本。
     *
     * 2026-10-20 真实报障：agent 调用工具后模型**看不到工具结果**，且它把工具调用
     * 写成 DSML 文本（`<|DSML|invoke name="bash"|>`）而不是结构化调用。根因就是
     * 这里只发 `content` 文本：
     *
     * - assistant 的 `tool_calls` 丢了 ⇒ 上游不知道之前调过什么工具；
     * - 工具结果没有 `role:'tool'` + `tool_call_id` ⇒ 关联断裂；
     * - 再叠加**下面没下发 `tools`** ⇒ 模型认为「没有工具可用」，只能把调用意图
     *   写进正文（那是它训练时的文本标记习惯，不是协议错误）。
     *
     * ⇒ 改为复用 `openai-compat.ts` 的 `serializeMessages`（与 cline / buddy / trae
     *   同源），它处理 `tool_calls`、`role:'tool'`、`content:null` 规范与孤儿清理。
     */
    /**
     * 图片：收集附件引用 → 读字节 → `data:` URL → 交给 `serializeMessages` 升级成
     * `image_url` parts。
     *
     * ⚠️ `imageUrls` 为 `undefined` 表示「本请求没有图片」；**有图时必须是 Map**
     *    （哪怕是空 Map）—— 降级成 `undefined` 会让 `[image unavailable]` 占位符
     *    也被跳过，图片静默消失（`openai-compat.ts` 的注释记过这条）。
     * ⚠️ 未注入 `readImage` 时**明确报错**，不静默丢图。
     */
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages ?? []) {
      const content = (message as { content?: unknown }).content
      if (Array.isArray(content)) collectCodelyImages(content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      const readImage = this.options.readImage
      if (readImage === undefined) {
        throw new LlmError(
          'codely: 收到图片但未注入附件读取通道（`readImage`）—— 请重载插件',
          'UNSUPPORTED_CONTENT',
        )
      }
      imageUrls = new Map<string, string>()
      for (const [attachmentId, ref] of imageRefs) {
        const bytes = await readImage(ref).catch(() => undefined)
        // ⚠️ 读不到就**不 set**：`userContentParts` 会据此留 `[image unavailable]`
        //    占位符（set 空串会发出 `image_url:{url:''}`，上游直接 400）。
        if (bytes === undefined || bytes.data.byteLength === 0) continue
        imageUrls.set(attachmentId, `data:${bytes.mediaType};base64,${Buffer.from(bytes.data).toString('base64')}`)
      }
    }
    const system = typeof options.system === 'string' ? options.system.trim() : ''
    /**
     * ⚠️⚠️ **清洗历史里的 DSML 文本残留**（2026-10-20 真实症状）。
     *
     * 旧版本没下发 `tools` 时，模型把工具调用写成正文
     * （`<|DSML|invoke name="bash"|>`）。这些文本一旦进了会话历史，**模型会
     * 继续模仿**：即使后来补上了 `tools`，它仍倾向「先说一句计划」而不发结构化
     * 调用 —— 实测症状正是思考里写 "Let me actually build it now. I'll create an
     * HTML5 canvas game"，正文只有一句「我用原生 Canvas…做成单个 HTML 文件」，
     * 然后流就结束了（没有任何 tool_calls）。
     *
     * ⇒ 序列化前把 assistant 历史里的 DSML 块截掉；若截完为空且无 `tool_calls`，
     *    整条丢弃（空 assistant 消息会被上游 400）。
     * ⚠️ 只清 assistant：判据只对模型自己的输出成立，清用户输入等于篡改。
     */
    const serialized = serializeMessages(options.messages ?? [], imageUrls)
    const messages: Array<Record<string, unknown>> = [
      ...system.length === 0 ? [] : [{ role: 'system', content: system }],
      ...serialized.filter((message) => {
        if (message.role !== 'assistant') return true
        const content = message.content
        if (typeof content !== 'string' || !/<\s*\|?\s*DSML/i.test(content)) return true
        const stripped = content.replace(/<\s*\|?\s*DSML[\s\S]*$/i, '').trim()
        if (stripped.length > 0) {
          message.content = stripped
          return true
        }
        return Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      }),
    ]
    /**
     * ⚠️⚠️ **工具使用纪律**（2026-10-20 真实症状的直接对策）。
     *
     * Codely 的模型在 agent 场景下有一个稳定倾向：**把「计划」当成回合产出**。
     * 实测两次（`codely-core` 4 分 26 秒、`codely-flash` 12 秒）都是同一形态：
     * 建好 todo、说一句「开始写游戏页面骨架：」，然后 `finish_reason='stop'`
     * ⇒ 循环停住，用户看到"说一半没了"。
     *
     * 而实测同一模型**一次能输出 36965 字符**（`finish_reason='stop'`，未被截断）
     * ⇒ **不是输出上限问题，是回合边界判断问题**。
     *
     * ⇒ 这里显式声明纪律：需要动文件/执行命令时必须**直接调工具**，不许只描述计划。
     *   只在**本次请求带工具**时追加（纯聊天加它反而干扰）。
     *   放在消息最前（紧跟系统提示）：多数模型对靠前的 system 更敏感。
     */
    if (options.tools !== undefined && options.tools.length > 0) {
      messages.splice(system.length === 0 ? 0 : 1, 0, {
        role: 'system',
        content: '【工具使用纪律】本次会话已提供工具。凡任务需要创建/修改文件、'
          + '执行命令、读取内容，**必须直接发起工具调用**完成；'
          + '禁止只输出「我来做…」「先列个计划」「开始写…」「接下来我会…」之类的说明'
          + '后就结束回合。一次写不完全部代码就分多次工具调用来写。'
          /**
           * ⚠️ 以下两条来自 2026-10-20 的真实报障（截图里一片红）：
           *
           * 1. 模型把临时脚本写到 `C:\Users\…\AppData\Local\Temp\`（用了 `$env:TEMP`）
           *    ⇒ 文件在工作区外，DSH 编辑工具的「读-改版本检测」直接失效：
           *    `file changed since it was read` / `file no longer exists` 连环报错。
           * 2. 模型为了修编码，用 PowerShell `Set-Content -Encoding UTF8` 重写文件
           *    ⇒ 写出 BOM、破坏 UTF-8，且让编辑工具的文件版本快照过期 ⇒ 同样的报错。
           *
           * ⇒ 明确禁止：临时文件不得落系统临时目录；改文件不得用 shell 重定向。
           */
          + '\n【路径纪律】所有临时脚本/测试文件**只能放在当前项目的 `tmp/` 目录下**'
          + '（不存在就先建），**严禁**写到 `%TEMP%`、`$env:TEMP`、'
          + '`C:\\Users\\…\\AppData`、`/tmp` 等系统目录 —— 那些位置在工作区之外，'
          + '会让编辑工具的版本检测失效并产生一串 `file changed since it was read` 报错。'
          + '\n【编辑纪律】**不要**用 shell 的 `Set-Content` / `Out-File` / `>` 重定向去改写'
          + '已存在的源码或脚本（会写出 BOM、破坏编码，并让编辑工具的文件快照过期）。'
          + '要改文件内容，一律用 `write_file` / `edit` 这类文件工具，不要绕 shell。'
          /**
           * ⚠️ 用户 2026-10-20 明确要求：**即使「完全权限」也要先问**。
           *
           * 这条只能在提示词层约束 —— 实测 `dsh-agent` 的类型定义里没有任何给插件
           * 注册工具拦截/审批的扩展点（`approval` 只作为宿主状态出现），所以
           * **插件拦不到 `write_file` / `bash` 的路径**，弹窗必须由 DSH 客户端提供。
           * 客户端侧的硬护栏是启动参数 `--path-policy strict`（工作区外直接拒绝）。
           */
          + '\n【越界确认】任何要写到**当前项目工作区之外**的操作——包括 `%TEMP%`、'
          + '`$env:TEMP`、`C:\\Users\\…\\AppData`、`C:\\Windows`、`/tmp`、其它盘符目录——'
          + '**必须先停下来说明「我要写 <路径>」并等待用户明确同意**；'
          + '未得到同意前不得执行该写入或创建。工作区内的写入不受此限。',
      })
    }
    if (messages.length === 0) {
      throw new LlmError('codely: 输入为空（没有可发送的文本）', 'INVALID_REQUEST')
    }

    // ⚠️ 每个请求换发一次 `cli_api_key`：它与后面 `Bearer` 必须**成对**
    //    （签名由它派生，用 A 签 B 会 401，见 `codely-auth.ts` 的注释）。
    const exchanged = await fetchCodelyCliApiKey(credential.access_token, {
      ...this.options.fetchImpl === undefined ? {} : { fetcher: this.options.fetchImpl },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (exchanged === undefined) {
      throw new LlmError(
        'codely: 换发 cli_api_key 失败（访问令牌可能已过期）'
        + '。请在 Jet Hub 的「账号池」里对该账号点「续期」；仍失败再重新登录',
        'PERMISSION_DENIED',
      )
    }

    const url = `${CODERLY.chatHost}/chat/completions`
    const headers = signedCodelyHeaders({
      cliApiKey: exchanged.cliApiKey,
      target: url,
      sessionId: randomUUID(),
    })
    /**
     * 诊断开关（`DSH_CODERLY_DEBUG=1`）：一行看清「工具到底发出去没有」。
     *
     * 2026-10-20 真实症状：`codely-core` 思考了 4 分 26 秒，正文只输出
     * 「先列个计划，然后动手写」，**没有 tool_calls**。要判断是「通道没发 tools」
     * 还是「模型自己选择先说计划」，必须先看这一行——
     * `toolCount > 0` 且 `finish=stop` ⇒ 是**模型行为**；`toolCount === 0` ⇒ 是**接线缺陷**。
     */
    if (process.env.DSH_CODERLY_DEBUG === '1') {
      console.warn('[codely] 请求诊断', {
        model,
        toolCount: options.tools?.length ?? 0,
        messageCount: messages.length,
        bodyChars: JSON.stringify(messages).length,
      })
    }
    const fetcher = this.options.fetchImpl ?? fetch
    const res = await fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        /**
         * ⚠️⚠️ **必须下发 `tools`**（2026-10-20 实测，决定性对照）。
         *
         * 同一 prompt、同一 key，唯一差别是带不带 `tools`：
         *
         * | 请求 | 结果 |
         * |---|---|
         * | 带 `tools` | 200，**13 帧标准 `delta.tool_calls`**（含 id/name/arguments），**零** DSML 文本 |
         * | 不带 `tools` | 200，模型把调用写进正文：`<|DSML|invoke name="bash"|>` |
         *
         * ⇒ 上游**完整支持** OpenAI function calling。DSML 文本不是协议差异，
         *   而是「没给它工具」时模型按训练习惯的自由发挥。
         *   缺这一段 = agent 永远无法真正执行工具（真实报障 2026-10-20 13:22）。
         */
        ...options.tools === undefined || options.tools.length === 0
          ? {}
          : {
              tools: options.tools.map((tool) => ({
                type: 'function' as const,
                function: {
                  name: tool.name,
                  ...typeof tool.description === 'string' && tool.description.length > 0
                    ? { description: tool.description }
                    : {},
                  ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
                },
              })),
              /**
               * ⚠️⚠️ **`tool_choice` 三档策略**（2026-10-20 用户要求"上更强的 required"）。
               *
               * 为什么**不常开 `required`**：那会让模型**每一轮**都被强制调工具，
               * 连「任务已完成、该收尾说话」也不允许 ⇒ 陷入反复调工具的死循环。
               *
               * 所以按「**首轮强制 → 后续放开 → 停滞兜底**」三层：
               *
               * | 场景 | tool_choice | 理由 |
               * |---|---|---|
               * | **首轮**（历史里还没有 `role:'tool'`） | **`required`** | 实测三次都是「首轮只说计划不调工具」，这一档直接掐死 |
               * | 后续轮（已有工具结果） | `auto` | 让模型能正常总结并结束，不死循环 |
               * | 停滞被兜底重试 | **`required`**（`forceToolChoice`） | 它在后续轮又"只说不做"时强拉一把 |
               * | 本次请求没有工具 | 不发该字段 | 纯聊天不该被约束 |
               *
               * ⚠️ 逃生阀：`DSH_CODERLY_TOOL_CHOICE=auto` 可整体退回原生行为
               *    （首轮也不再强制），用于诊断"是不是 required 引起的异常"。
               */
              ...(() => {
                const hasToolHistory = messages.some((message) => message.role === 'tool')
                const escalated = (options as { forceToolChoice?: boolean }).forceToolChoice === true
                const envOverride = process.env.DSH_CODERLY_TOOL_CHOICE
                /**
                 * ⚠️ **必须识别「这是不是任务型输入」**：实测常开 `required` 时，
                 * 用户说「你好」也会被强制去跑 `pwd && ls -la`（3320ms、白烧积分、
                 * 行为诡异）。所以只在**看起来要做事**时才强拉。
                 *
                 * 判据（任一命中）：含动作动词 / 长度 ≥ 20 字。
                 * 误判的代价不对称：把聊天误判成任务 ⇒ 多跑一次工具（可接受）；
                 * 把任务误判成聊天 ⇒ 模型只说计划不干活（用户已在报障）。
                 */
                const TASK_HINT = /(写|创建|新建|生成|实现|修改|修复|重构|删除|运行|执行|检查|列出|搜索|安装|部署|测试|添加|优化|排查|分析|做一个|搞一个|继续|接着|动手|改一|试一)/u
                const lastUser = [...(options.messages ?? [])]
                  .reverse()
                  .find((message) => (message as { role?: unknown }).role === 'user')
                const userText = lastUser === undefined
                  ? ''
                  : contentToText((lastUser as { content?: unknown }).content)
                const looksLikeTask = TASK_HINT.test(userText) || userText.trim().length >= 20
                const forceRequired = escalated
                  || (envOverride !== 'auto' && !hasToolHistory && looksLikeTask)
                return { tool_choice: forceRequired ? 'required' : 'auto' }
              })(),
            },
      }),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const body = detail.length === 0 ? '' : `（${detail.slice(0, 240)}）`
      /**
       * ⚠️⚠️ **401/403 一律不得归 `AUTH`**。
       *
       * DSH 客户端 `failureMessage()` 只要看到 `AUTH` 就把**整条 message** 换成
       * 固定文案「API 密钥无效」（`docs/agent-notes/client-ui.md` 记了三次同款
       * 事故：cline 地域 403、opencode FreeTier、buddy 安全策略）。而 Codely 的
       * 401 **绝大多数不是凭据问题**——2026-10-20 实测：
       *
       * | 模型 | 结果 |
       * |---|---|
       * | `codely-basic` | 200 |
       * | `DeepSeek-V4.1-Flash` | **401 `team_model_access_denied`** |
       * | `GLM-5.3-FLASH` | **401 `team_model_access_denied`** |
       *
       * 上游原文：`team not allowed to access model. This team can only access
       * models=['alias-only-proxy-models']`。即**目录列出的模型不等于团队可访问**
       * （`/api/model-status` 是全局目录，团队策略在网关侧另判）⇒ 用户切到
       * Codely 却仍选着 DeepSeek/GLM/KIMI 时，看到「API 密钥无效」会去重登，
       * 全是无效动作。
       *
       * ⇒ 模型权限类一律 `PERMISSION_DENIED` 并把上游原文带上；其余 4xx/5xx 走
       *   `SERVER`。凭据真失效的路径在**换发**那一步就已拦下（`fetchCodelyCliApiKey`
       *   返回 `undefined`），不会落到这里。
       */
      const denied = /team_model_access_denied|model_access_denied|not allowed to access model/i.test(detail)
      if (denied) {
        throw new LlmError(
          `codely: 该模型不在你所在团队的可访问范围${body}`
          + '。请改用 codely-basic / codely-core 等 codely-* 模型'
          + '（目录里的 DeepSeek / GLM / KIMI 常被团队策略拒绝）',
          'PERMISSION_DENIED',
        )
      }
      throw new LlmError(
        `codely: 上游 ${res.status}${body}`,
        res.status === 401 || res.status === 403 ? 'PERMISSION_DENIED' : 'SERVER',
      )
    }
    if (res.body === null) throw new LlmError('codely: 上游返回空响应体', 'EMPTY_RESPONSE')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const dsmlFix = createDsmlMarkerNormalizer()
    let buffer = ''
    let text = ''
    let started = false
    let ended = false
    /**
     * 上游 `choices[0].finish_reason`（`stop` / `length` / `tool_calls` / `content_filter`）。
     *
     * ⚠️⚠️ **必须读它**：2026-10-20 真实症状——模型说「开始写游戏页面骨架：」然后
     * 12 秒就结束了，大段 HTML 一个字没出来。因为输出撞上 `length`（被截断），
     * 而我当时只按 `toolCount` 判 `finish.kind` ⇒ 报成 `stop`（"正常说完"）⇒
     * 宿主不会续写、也不会提示截断，用户只看到"说一半就没了"。
     */
    let finishReason: string | undefined
    /**
     * SSE 里累积的工具调用（按 `delta.tool_calls[].index` 聚合）。
     *
     * ⚠️ OpenAI 的工具调用是**增量下发**的：首帧只给 `id`/`name`，参数
     *    `arguments` 分散在后续多帧里逐字符下发 ⇒ 必须累积到 `block-end` 才完整。
     */
    const toolAccs = new Map<number, { id: string; name: string; text: string; announced: boolean }>()
    /** 已公告（`block-start` 已发）的工具块 index，收尾时按它发 `block-end`。 */
    const announcedTools: number[] = []
    /**
     * 推理内容（上游 `delta.reasoning_content`）。
     *
     * ⚠️ 不接它的症状：界面「已思考」是**空的**（内容被当未知字段丢弃），
     *    而用户以为模型没思考。上游确实下发该字段（实测帧里有
     *    `"delta":{"reasoning_content":""...`）。
     * ⚠️ 单独一个归一化器：它是跨帧状态，与正文共用一个会串流。
     */
    const reasoningFix = createDsmlMarkerNormalizer()
    let reasoningStarted = false
    let reasoningText = ''
    /** 推理块的 index：正文固定 0，推理用 1、工具从 2 起（不与正文抢 index）。 */
    const REASONING_INDEX = 1
    try {
      while (!ended) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx = buffer.indexOf('\n')
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          idx = buffer.indexOf('\n')
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') { ended = true; break }
          let delta = ''
          let reasoningDelta = ''
          let toolFrames: unknown[] = []
          try {
            const json = JSON.parse(payload) as {
              choices?: {
                finish_reason?: unknown
                delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown }
              }[]
            }
            const choice = json.choices?.[0]
            if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
            const frame = choice?.delta
            if (typeof frame?.content === 'string') delta = frame.content
            if (typeof frame?.reasoning_content === 'string') reasoningDelta = frame.reasoning_content
            if (Array.isArray(frame?.tool_calls)) toolFrames = frame.tool_calls
          } catch { /* 非 JSON 帧（心跳/空行）忽略 */ }
          /**
           * 推理内容 → `reasoning` 块（否则界面「已思考」永远是空的）。
           * ⚠️ 也要过 DSML 归一化：推理里同样可能出现被写坏的标记。
           */
          if (reasoningDelta.length > 0) {
            const fixedReasoning = reasoningFix.push(reasoningDelta)
            if (fixedReasoning.length > 0) {
              if (!reasoningStarted) {
                reasoningStarted = true
                yield { type: 'block-start', index: REASONING_INDEX, blockType: 'reasoning' }
              }
              reasoningText += fixedReasoning
              yield { type: 'reasoning-delta', index: REASONING_INDEX, text: fixedReasoning }
            }
          }
          /**
           * ⚠️ **工具调用帧必须在这里吃掉**：下发了 `tools` 之后，上游会持续下发
           * `delta.tool_calls`（实测 13 帧）。若这里只认 `content`，这些帧会被
           * 当「非 JSON 帧」丢掉 ⇒ 模型调了工具而宿主完全不知道（症状是回答
           * 说完就停、工具永不执行）。
           */
          for (const rawFrame of toolFrames) {
            const record = rawFrame as {
              index?: unknown
              id?: unknown
              function?: { name?: unknown; arguments?: unknown }
            }
            const idx = typeof record.index === 'number' ? record.index : 0
            const acc = toolAccs.get(idx) ?? { id: '', name: '', text: '', announced: false }
            if (typeof record.id === 'string' && record.id.length > 0) acc.id = record.id
            const fn = record.function
            if (typeof fn?.name === 'string' && fn.name.length > 0) acc.name = fn.name
            /**
             * ⚠️ **过滤工具参数里的 DSML 标记残留**（2026-10-20 实测）。
             *
             * `codely-flash` 在长输出时会把标记插进 JSON **值内部**：
             * `{"path">/tmp/game/index.html</｜DSML｜: "<!DOCTYPE html>…`
             * ⇒ 参数变成非法 JSON，`normalizeToolArguments` 只能兜成 `{}`，
             * 工具白调一次（用户看到"写文件失败"）。
             *
             * 这里先删掉标记对；**删完仍不合法的情况无法修复**（那是模型把 `:`
             * 写成 `>` 的结构性损坏），由下游 `normalizeToolArguments` 兜底。
             */
            const rawFragment = typeof fn?.arguments === 'string' ? fn.arguments : ''
            const fragment = rawFragment.replace(/[|｜]\s*DSML\s*[|｜]/gi, '')
            acc.text += fragment
            toolAccs.set(idx, acc)
            if (acc.announced) {
              if (fragment.length > 0) {
                yield {
                  type: 'tool-call-delta',
                  index: idx,
                  id: ToolCallId(acc.id),
                  ...acc.name.length > 0 ? { name: acc.name } : {},
                  argumentsDelta: fragment,
                }
              }
              continue
            }
            /**
             * ⚠️ **名称为空前不发射任何 chunk**（与 `openai-compat.ts` / `trae-adapter.ts`
             * 同因同修）：只跳过收尾的 `block-end` 不够 —— 组装器会把没有 block-end
             * 的 partial 也组装成 `name:''`，污染会话后让下游端点以 400 拒绝请求。
             */
            if (!hasUsableToolName(acc.name)) continue
            acc.announced = true
            announcedTools.push(idx)
            yield { type: 'block-start', index: idx, blockType: 'tool-call' }
            yield {
              type: 'tool-call-delta',
              index: idx,
              id: ToolCallId(acc.id),
              name: acc.name,
              argumentsDelta: acc.text,
            }
          }
          if (delta.length === 0) continue
          const fixed = dsmlFix.push(delta)
          if (fixed.length === 0) continue
          if (!started) {
            started = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          text += fixed
          yield { type: 'text-delta', index: 0, text: fixed }
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }

    // 流尾 flush（不 flush ⇒ 回答尾部丢字符，见 `dsml-normalizer-coverage.spec.ts`）
    const tail = dsmlFix.flush()
    if (tail.length > 0) {
      if (!started) {
        started = true
        yield { type: 'block-start', index: 0, blockType: 'text' }
      }
      text += tail
      yield { type: 'text-delta', index: 0, text: tail }
    }
    // ── 推理块收尾：先 flush 待定缓冲（不 flush ⇒ 思考内容尾部丢字）──
    const reasoningTail = reasoningFix.flush()
    if (reasoningTail.length > 0) {
      if (!reasoningStarted) {
        reasoningStarted = true
        yield { type: 'block-start', index: REASONING_INDEX, blockType: 'reasoning' }
      }
      reasoningText += reasoningTail
      yield { type: 'reasoning-delta', index: REASONING_INDEX, text: reasoningTail }
    }
    if (reasoningStarted) {
      yield {
        type: 'block-end',
        index: REASONING_INDEX,
        block: { type: 'reasoning', text: reasoningText },
      }
    }

    /**
     * ⚠️⚠️ **软兜底：模型「只说不做」时自动重试一次（强制调工具）**。
     *
     * ## 为什么不能只靠提示词
     *
     * 2026-10-20 三次真实复现（`codely-core` 4m26s / `codely-flash` 12s / 3m18s）：
     * 模型都**建了 todo、说了一句计划，然后 `finish_reason='stop'`**，零工具调用。
     * 加了【工具使用纪律】system 后仍然复现（同一条 prompt 实测仍 0 调用）
     * ⇒ **提示词压不住这个模型的回合边界判断**，必须在代码层兜。
     *
     * ## 判据（只在**高置信度**时触发，避免打断正常回答）
     *
     * 全部满足才重试：
     * 1. 本次请求**带工具**（纯聊天不管）；
     * 2. `finish_reason` 不是 `length`（那是截断，走 max-tokens）；
     * 3. **本回合零工具调用**；
     * 4. 正文很短（< 200 字）且**以「：/。」「…」结尾**（"我这就开始写："这类未完成句式）。
     *
     * ## 重试怎么做
     *
     * 追加一条 user 提示要求立刻执行，并在重试请求里把 `tool_choice` 提到
     * **`required`**（强制调用）⇒ 重试几乎必然返回 `tool_calls`，循环就能继续。
     * ⚠️ 最多重试**一次**（`allowRetry` 参数），绝不递归成死循环。
     * ⚠️ 第一轮已下发的正文**保留**（用户看到"我先看看"然后真的去看了，比静默重来自然）。
     */
    /**
     * ⚠️ 判据刻意**从宽**（2026-10-20 第二次报障后放宽）：
     *
     * 上一版要求「正文 < 200 字 **且** 以句号/冒号结尾」，实测漏掉了一类真实形态：
     * 「PowerShell 5.1、Node 和 GDI+ 都可用……**我先建好任务清单，再开始做。**」
     * ——56 字、句号结尾，本该命中却因为**只在重试 1 次**时生效，第二次仍停住。
     *
     * 现改为：
     * - **允许最多 3 次**强拉（`retryBudget` 递减），因为模型可能每次都说一句新理由；
     * - **不再要求结尾标点**、正文上限放到 500 字（正常回答通常远超此长度）；
     * - 只要「有工具 + 本轮零调用 + 正文不长」就判为停滞 ⇒ 续拉。
     *
     * ⚠️ 代价：每次强拉多一次请求（计费）。但「用户手动打字才能推进」的体验
     * 明显更差 —— 用户明确要求「全自动、不要一步步确认」。
     * ⚠️ 仍有 `text.trim().length < 500` 兜住：正常长篇回答不该被它打断。
     */
    const stalled = retryBudget > 0
      && finishReason !== 'length'
      && announcedTools.length === 0
      && (options.tools?.length ?? 0) > 0
      && text.trim().length < 500
    if (stalled) {
      const retryOptions = {
        ...options,
        messages: [
          ...(options.messages ?? []),
          {
            role: 'user',
            content: '（系统提示）不要只说明计划或"准备开始"。**现在这一刻就调用工具执行**：'
              + '要建文件就调 write_file，要看目录/跑命令就调 shell 类工具，'
              + '要改代码就调 edit/write 类工具。逐个 todo 做完，中途不要停下来征求确认。',
          },
        ],
        forceToolChoice: true,
      } as unknown as GenerateOptions
      yield* this.streamViaHttp(retryOptions, retryBudget - 1)
      return
    }

    // ⚠️ 有工具调用但没有正文是**正常**的（模型直接调工具），不算空响应
    if (!started && announcedTools.length === 0) {
      throw new LlmError('codely: 上游未产出任何内容', 'EMPTY_RESPONSE')
    }
    if (started) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    /**
     * 工具块收尾（每个已公告调用发一个 `block-end`）。
     *
     * ⚠️ **顺序必须是「先判截断，再归一化」**：反了会把「参数分片在流里丢了」
     * 补成 `{}`，模型收到莫名的 `missing required property`，病因被完全掩盖
     * （`sse.ts` 的 `isTruncatedArguments` 注释记了这起真实事故）。
     */
    let toolCount = 0
    for (const idx of announcedTools) {
      const acc = toolAccs.get(idx)
      if (acc === undefined || !hasUsableToolName(acc.name)) continue
      toolCount += 1
      yield {
        type: 'block-end',
        index: idx,
        block: {
          type: 'tool-call',
          id: ToolCallId(acc.id),
          name: acc.name,
          arguments: isTruncatedArguments(acc.text) ? acc.text : normalizeToolArguments(acc.text),
        },
      }
    }
    /**
     * `finish.kind` 的**权威来源是上游 `finish_reason`**，优先级：
     *
     * 1. `length` ⇒ **`max-tokens`**（必须让宿主知道"被截断了"，它会续写/压缩；
     *    判成 `stop` 会让用户看到"说一半就没了"——2026-10-20 真实症状：
     *    模型说「开始写游戏页面骨架：」后 12 秒静默结束，大段 HTML 没出来）；
     * 2. 有工具调用 或 `finish_reason === 'tool_calls'` ⇒ **`tool-calls`**
     *    （判成 `stop` 会让宿主以为模型只是说完话 ⇒ 工具永不执行）；
     * 3. `content_filter` ⇒ `stop`（内容被过滤，不是我们的问题，也无从续写）；
     * 4. 其余（`stop` / 缺失）⇒ `stop`。
     *
     * ⚠️ `length` 必须**压过** `tool-calls`：参数只下发一半时若报 tool-calls，
     *    执行层会拿到残缺 JSON（`sse.ts` 的 `isTruncatedArguments` 就是为此存在，
     *    但根因在 `finish_reason`，不能只靠下游兜）。
     */
    const kind = finishReason === 'length'
      ? 'max-tokens' as const
      : toolCount > 0 || finishReason === 'tool_calls'
        ? 'tool-calls' as const
        : 'stop' as const
    yield { type: 'finish', reason: { kind } }
  }

  /** 旧的 CLI 驱动路径（仅测试注入 `cliSpawner` 时使用，生产不走）。 */
  private async *streamViaCli(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const prompt = buildCliPrompt(options)
    if (prompt.length === 0) {
      throw new LlmError('codely: 输入为空（没有可发送的文本）', 'INVALID_REQUEST')
    }
    // ⚠️ 模型 id 缺省时**不猜**：取兜底表第一个是「编造用户选择」，这里
    //    宁可让上层报错（模型未指定属于调用方缺陷）。
    const model = typeof options.model === 'string' ? options.model : ''

    let text = ''
    let started = false
    /**
     * DSML 标记归一化器（2026-10-13 事故根因：deepseek 系模型把工具标记写坏
     * 成双竖线，宿主解析不了）。
     *
     * ⚠️ **每个 `stream()` 调用一个实例**：待定缓冲是跨帧状态，共用会串流
     * （`openai-compat.ts` 同款纪律）。
     * ⚠️ 流尾**必须 flush**：否则末尾那一小段被当作「可能的前缀」扣住不下发，
     *    表现是回答尾部少几个字符（`dsml-normalizer-coverage.spec.ts` 守着）。
     */
    const dsmlFix = createDsmlMarkerNormalizer()
    try {
      for await (const event of runCodelyCli({
        prompt,
        model,
        ...this.options.cliPath === undefined ? {} : { cliPath: this.options.cliPath },
        ...this.options.cliApprovalMode === undefined
          ? {} : { approvalMode: this.options.cliApprovalMode },
        ...this.options.cliCwd === undefined ? {} : { cwd: this.options.cliCwd },
        ...this.options.cliSpawner === undefined ? {} : { spawner: this.options.cliSpawner },
        ...this.options.cliEnv === undefined ? {} : { env: this.options.cliEnv },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })) {
        // `result` 事件：CLI 正常收尾（用量统计暂不上报 —— 它与 DSH 侧的
        // token 口径未对齐，报一个对不上的数不如不报）。
        if (event.type !== 'delta') continue
        // ⚠️ 下发的是**归一化后**的文本（`push` 会把可能构成标记前缀的尾部扣住）。
        const fixed = dsmlFix.push(event.text)
        if (fixed.length === 0) continue
        if (!started) {
          started = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        text += fixed
        yield { type: 'text-delta', index: 0, text: fixed }
      }
    } catch (error) {
      if (error instanceof LlmError) throw error
      // ⚠️ 保留驱动层的原始文案（它说明了「缺 CLI / 退出码 / stderr」），
      //    只补上渠道前缀，方便用户定位是哪个渠道出的。
      throw new LlmError(
        `codely: ${error instanceof Error ? error.message : String(error)}`,
        'SERVER',
      )
    }

    // ── 流尾 flush：把被扣住的尾部补发（不 flush ⇒ 回答尾部丢字符）──
    const tail = dsmlFix.flush()
    if (tail.length > 0) {
      if (!started) {
        started = true
        yield { type: 'block-start', index: 0, blockType: 'text' }
      }
      text += tail
      yield { type: 'text-delta', index: 0, text: tail }
    }

    if (!started) {
      throw new LlmError('codely: 官方客户端未产出任何内容', 'EMPTY_RESPONSE')
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    // ⚠️ `reason` 是**对象**形态（`{ kind: 'stop' }`），不是字符串 `'stop'`
    //    —— 与 `zcode-anthropic.ts` / `openai-compat.ts` 同款。
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  // ── 目录：远端优先、失败回退兜底表 ──

  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    await this.ensureRemoteModels()
    return this.catalogEntries()
  }

  /**
   * 目录出口（`loadCatalog` 与 `syncCatalog` 都走这里 ⇒ 过滤只需一处）。
   *
   * ## ⚠️ 为什么必须筛掉「目录里有、但团队无权访问」的模型（2026-10-20 实测）
   *
   * `/api/model-status` 下发的是**全局目录**，团队授权在网关侧**另判**。同一账号实
   * 测（`tmp-probe-models` 逐模型打 `/v1/chat/completions`）：
   *
   * | 模型 | 结果 |
   * |---|---|
   * | `codely-core` / `codely-basic` / `codely-flash` / `codely-air` / `codely-vl` | **200** |
   * | `DeepSeek-V4.1-Flash` / `GLM-5.3-FLASH` / `KIMI-K3` | **401 `team_model_access_denied`** |
   *
   * 上游原文：`team not allowed to access model. This team can only access
   * models=['alias-only-proxy-models']`。即 `codely-*` 是本渠道**自有别名**
   * （前缀 = provider id），公共模型名需要团队额外授权。
   *
   * **不过滤的后果**（真实报障 2026-10-20「不然怎么使用」）：用户在选择器里选
   * `DeepSeek-V4.1-Flash` ⇒ 每一轮都 `401` 直接失败，且目录里看着它是"可用"的。
   *
   * ⚠️ **这不是「临时故障隐藏模型」**（仓库反对那种隐藏：会让「模型消失」与
   *    「模型下架」同形）—— 团队授权是**确定性**的、短期不变，隐藏是**准确表达**。
   * ⚠️ **若某账号被授权了公共模型**：放宽下面这一行判据即可（目录仍从远端拉全量，
   *    这里只是**出口**过滤，恢复时不必改数据源）。
   * ⚠️ 判据只能按**前缀**：上游没有任何接口能查「本团队可用模型」，`/api/model-status`
   *    只给全局目录。
   */
  private catalogEntries(): readonly CatalogEntry[] {
    const source = this.remoteModels === undefined
      ? CODERLY.fallbackModels
      : this.remoteModels
    return source
      .filter((model) => model.id.toLowerCase().startsWith(`${CODERLY.id.toLowerCase()}-`))
      .map((model) => this.toCatalogEntry(model))
  }

  /**
   * 转成共享骨架的中间结构。
   *
   * ⚠️ **不声明 `contextWindow` / `maxTokens` / `inputModalities`**：
   *    上游 `/api/model-status` 只给运行状态，没有任何能力元数据；本仓库
   *    红线是「未知即不声明」（编造窗口会让自动压缩按错误阈值决策）。
   * ⚠️ 也不把 `status` 写进 `name`：见 `codely-product.ts` 的说明。
   */
  /**
   * 转成共享骨架的中间结构。
   *
   * ## `inputModalities`：**逐模型**按实测声明（2026-10-20，真凭据 10 次请求）
   *
   * | 模型 | 工具 | 推理 | 图片 |
   * |---|---|---|---|
   * | `codely-basic` | ✅ | ❌ 无 | ✅ |
   * | `codely-flash` | ✅ | ✅ | ✅ |
   * | `codely-air` | ✅ | ✅ | ✅ |
   * | `codely-core` | ✅ | ✅ | ❌ `400 Model only supports text` |
   * | `codely-vl` | ✅ | ✅ | ❌ `400 invalid_parameter_error` |
   *
   * ⚠️ **`codely-vl` 名字带 vl 却不收 `image_url`** —— 这张表就是权威，别按名字猜。
   *
   * ⚠️ 三态语义（见 `model-catalog.ts` 的 `CatalogEntry.inputModalities`）：
   *    `['text']` 是**明确声明不支持**（DSH 会把图片投影成文本占位，用户不会
   *    白等一个注定 400 的请求）；**省略** = 「未知」⇒ 宿主放行图片 ⇒ 仍然 400。
   *    两者后果不同，**不能合并**。
   *
   * ⚠️ 判据是**模型 id 白名单**：`/api/model-status` 只给运行状态，没有任何模态
   *    元数据。上游若调整能力，只改 {@link CODERLY_IMAGE_MODELS} 一处。
   */
  private toCatalogEntry(model: CodelyRemoteModel): CatalogEntry {
    const abilities = CODERLY_ABILITIES[model.id]
    return {
      id: model.id,
      // 展示名带能力后缀（`codely-flash · 推理 | 图片 | 工具`），见 `abilitySuffix`
      name: `${model.id}${abilitySuffix(model.id)}`,
      // ⚠️ 与展示名**同源**（同一张 `CODERLY_ABILITIES`）：两处各写一份必然漂移
      // —— 那正是「模型名说能发图、实际 400」的成因。
      inputModalities: abilities?.includes('image') === true
        ? (['text', 'image'] as const)
        : (['text'] as const),
    }
  }

  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined) return
    await this.catalogGate.run(async () => {
      const models = await this.fetchRemoteModels().catch(() => undefined)
      // ⚠️ 空数组也不算成功（与 trae 同口径）：空目录会让「远端读到了但为空」
      //    与「读失败」同形，进而把兜底表永久顶掉。
      if (models === undefined || models.length === 0) return false
      this.remoteModels = models
      return true
    })
  }

  /** 拉取远端目录；读不到（无凭据 / 非 200 / 非 JSON）返回 `undefined`。 */
  private async fetchRemoteModels(): Promise<readonly CodelyRemoteModel[] | undefined> {
    const credential = await this.options.credentialProvider?.()
    if (credential === undefined) return undefined
    const token = credential?.access_token
    if (typeof token !== 'string' || token.length === 0) return undefined

    const fetcher = this.options.fetchImpl ?? fetch
    const response = await fetcher(`${CODERLY.apiBase}${CODERLY.modelStatusPath}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'X-User-Agent': CODERLY.userAgent,
      },
      signal: AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS),
    })
    if (!response.ok) return undefined

    let body: RawModelStatus
    try {
      body = JSON.parse(await response.text()) as RawModelStatus
    } catch {
      return undefined
    }
    const raw = Array.isArray(body.models) ? body.models as Record<string, unknown>[] : []
    const models: CodelyRemoteModel[] = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      const id = typeof item.modelGroup === 'string' ? item.modelGroup.trim() : ''
      if (id.length === 0) continue
      models.push({
        id,
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
      })
    }
    return models
  }
}

/**
 * 把 harness 的 `messages` 文本化成 CLI 的**单条** prompt。
 *
 * ## ⚠️ 这是「文本化近似」，不是协议级多轮
 *
 * 官方 CLI 的非交互入参只有 `--prompt`（没有 messages 数组、没有工具协议），
 * 故历史按 `role: 文本` 逐段拼接。这是**能力边界**，不是等价实现 —— 注释
 * 写清是为了将来有人看到「多轮怎么没了」时不必重新推理一遍。
 *
 * ## 非文本内容**明确报错**而不是静默丢弃
 *
 * 图片等附件块经 `contentToText` 会被丢成空串 ⇒ 用户以为模型看到了图
 * （仓库对「静默吞掉」一贯说不得）⇒ 检测到非文本块就抛 `UNSUPPORTED_CONTENT`。
 */
function buildCliPrompt(options: GenerateOptions): string {
  const parts: string[] = []
  const system = typeof options.system === 'string' ? options.system.trim() : ''
  if (system.length > 0) parts.push(`system: ${system}`)
  for (const message of options.messages ?? []) {
    const record = message as { role?: unknown; content?: unknown }
    const content = record.content
    if (Array.isArray(content)) {
      const hasNonText = content.some((block) =>
        !(typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'))
      if (hasNonText) {
        throw new LlmError(
          'codely: 该通道只接受文本输入（图片等附件不受支持）',
          'UNSUPPORTED_CONTENT',
        )
      }
    }
    const text = contentToText(content).trim()
    if (text.length === 0) continue
    const role = typeof record.role === 'string' && record.role.length > 0 ? record.role : 'user'
    parts.push(`${role}: ${text}`)
  }
  return parts.join('\n\n')
}

/**
 * 收集消息里的图片附件引用（含 `tool-result` 内嵌图片，**递归**）。
 *
 * ⚠️ 必须递归 `tool-result` 内层：工具返回的图片（如 `read_image`）若只收一层
 *    就会漏 ⇒ refs 里没有它、序列化时读不到 ⇒ 图片静默消失
 *    （`openai-compat.ts` 的 `collectImages` / `userContentParts` 是对称递归的）。
 */
function collectCodelyImages(content: readonly unknown[], refs: Map<string, unknown>): void {
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { type?: unknown; attachment?: { attachmentId?: unknown }; content?: unknown }
    if (block.type === 'image' && typeof block.attachment?.attachmentId === 'string') {
      refs.set(block.attachment.attachmentId, block.attachment)
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      collectCodelyImages(block.content, refs)
    }
  }
}

/** 在 `ctx.llm` 上注册 Codely provider 路由（幂等，返回**原始适配器实例**）。 */
export function registerCodelyLlm(
  ctx: Context,
  options: CodelyAdapterOptions = {},
): CodelyAdapter {
  const adapter = new CodelyAdapter(options)
  // ⚠️ **返回 `adapter` 而不是 `registerAdapterIdempotent` 的返回值**：
  //    后者在重复注册时返回 `undefined`、非重复时返回宿主句柄（**不是**适配器），
  //    接线层要把它放进 `modelAdapters` 调 `listAllModels()`（与 officeace /
  //    gemini / zcode 同款；实测症状 `listAllModels is not a function`）。
  registerAdapterIdempotent(
    ctx.llm,
    [CODERLY.id],
    adapter,
    (message: string) => ctx.logger?.warn?.(message),
  )
  return adapter
}
