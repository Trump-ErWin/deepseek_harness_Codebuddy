/**
 * 「本机 OpenAI 网关」设置面板的状态判定与文案（纯逻辑）。
 *
 * ## 为什么单独成文件
 *
 * 与 `provider-toggle.js` / `model-bulk.js` / `credits-capabilities.js` 同理：
 * 本仓库的单测环境里 react 不在依赖内，组件无法渲染。把判定与文案抽成纯函数
 * 才能用真实断言覆盖，而不是靠源码级字符串匹配间接验证。
 *
 * ## 判据全部由宿主侧给定，前端不重算
 *
 * `enabled` / `running` / `blockedByEnv` / `address` 四项都来自
 * `gateway.getEnabled`（见 `src/jet-hub-rpc.ts`）。前端**只读不判**：
 *
 * - `enabled` 是**用户的选择**（持久化状态），与端口是否真在监听无关；
 * - `running` 是**实际运行态**（可能因端口冲突而未监听）；
 * - `blockedByEnv` 表示被 `DSH_OPENAI_GATEWAY_ENABLED` 显式停用，此时
 *   用户的 `enabled` 为真也**不会**让网关跑起来。
 *
 * ⚠️ 前端若自己拿 `enabled` 推导「是否在运行」，就会在端口冲突或 env 停用时
 * 显示「已开启」而用户连不上 —— 这类自相矛盾最难排查，故一律以宿主侧为准。
 *
 * @typedef {object} ApiKeyInfo
 * @property {string} value 密钥本体
 * @property {boolean} fromEnv 是否来自 DSH_OPENAI_GATEWAY_API_KEY
 * @property {string | null} path 密钥文件路径（来自环境变量时为 null）
 *
 * @typedef {object} GatewayStatus
 * @property {boolean} enabled 用户在设置页里的选择
 * @property {boolean} running 当前是否真的在监听端口
 * @property {boolean} blockedByEnv 是否被环境变量显式停用
 * @property {{ host: string, port: number } | null} address 实际监听地址
 * @property {ApiKeyInfo | null} [apiKey] 正在使用的凭据
 */

/**
 * 把密钥写进剪贴板。
 *
 * ## 为什么默认**不**把密钥明文渲染到页面上
 *
 * 设置页会被截图、被录屏、被投屏演示。让用户点一下「复制」比让密钥整条躺在
 * 屏幕上更可控 —— 明文只在用户主动点击的那一刻进入剪贴板。
 *
 * ## 失败必须自己处理
 *
 * 浏览器只在**用户手势**里允许 `navigator.clipboard.writeText`，异步兜底
 * （非 https、权限被拒、旧内核无 Clipboard API）都会 reject。调用方必须据此
 * 提示「请手动复制」并把值显示出来，否则用户点了按钮却毫无反应 —— 这正是
 * 「复制按钮点了没反应」这类最难自查的失败。
 *
 * @param {string} value 要复制的文本
 * @returns {Promise<boolean>} 是否写入成功
 */
// ⚠️ 搜索判据与模型清单**共用同一份实现**（`model-filter.js`）：两处各写一套
// 「空搜索词算命中全部」之类的约定，迟早漂移成「同一句话在两张表里搜出不同结果」。
import { isFilterActive, matchesModelQuery } from './model-filter.js';

export async function copyToClipboard(value) {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 密钥来源的展示文案。
 *
 * ⚠️ 来自环境变量时**不显示文件路径** —— 那一刻根本没有文件，显示一个假路径
 * 只会让用户去那儿找然后扑空。
 *
 * @param {{ fromEnv: boolean, path: string | null } | null | undefined} apiKey
 * @returns {string}
 */
export function gatewayApiKeyHint(apiKey) {
  if (!apiKey) return '网关尚未生成过密钥：启用一次网关即会自动生成。'
  if (apiKey.fromEnv) return '密钥来自环境变量 DSH_OPENAI_GATEWAY_API_KEY（不在文件里）。'
  return apiKey.path ? `密钥文件：${apiKey.path}` : '密钥来自环境变量。'
}

/**
 * 页头按钮的文字。
 *
 * ⚠️ 刻意**只写「网关」**（不是「网关开关」）：页头按钮排成一行，文字越长越容易
 * 把右端的「关闭」挤到第二行（`jet-hub.js` 里「供应商」按钮旁有同款注释）。
 * 完整语义由 `title` 与弹窗标题承担。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string}
 */
export function gatewayButtonLabel(status) {
  if (!status) return '网关'
  // 运行态用「●」提示，开着的按钮一眼可辨；但绝不用颜色单独承载语义
  // （`title` 与弹窗里都有文字说明）。
  return status.running ? '网关 ●' : '网关'
}

/**
 * 该模型是否接受图片输入。
 *
 * ⚠️ 判据取自**宿主回传的 `input`**（与 `/v1/models` 同一份），前端不自行推断。
 * 缺字段时按「不支持」处理：宁可少标一个（用户发图后拿到明确错误），也不要
 * 错标成支持（用户发完图才发现图被拒）。
 *
 * @param {{ input?: readonly string[] } | null | undefined} model
 * @returns {boolean}
 */
export function modelSupportsImage(model) {
  return Array.isArray(model?.input) && model.input.includes('image');
}

/**
 * 模型行上的能力标记。
 *
 * @param {{ input?: readonly string[] } | null | undefined} model
 * @returns {string} 空串表示不标任何标记
 */
export function modelCapabilityBadge(model) {
  return modelSupportsImage(model) ? '可发图片' : '';
}

/**
 * 列出模型 ID 的一行文本（每行一个，供粘贴到 agent 配置）。
 *
 * @param {Array<{ id: string }> | null | undefined} models
 * @returns {string}
 */
export function formatModelIdList(models) {
  if (!models || models.length === 0) return ''
  return models.map((model) => model.id).join('\n')
}

/**
 * 模型目录的说明文案。
 *
 * ⚠️ 空清单必须**自解释**：此前只说「还没有可用模型，登录至少一个供应商」，
 * 而真实原因可能是宿主根本没给出任何可枚举的 provider（插件加载异常）。
 * 用户照着错误提示去检查自己的登录，怎么都找不到原因。
 *
 * @param {Array<{ id: string }> | null | undefined} models
 * @param {'catalog' | 'adapters' | 'none'} [source] 目录来源
 * @returns {string}
 */
export function gatewayModelsHint(models, source) {
  if (!models || models.length === 0) {
    if (source === 'none') {
      return '拿不到任何 provider 列表，模型清单无法读取。'
        + '这不是登录问题 —— 通常是 DSH 侧的模型服务尚未就绪，重启 DSH 或稍后点「刷新」再试。';
    }
    return '还没有可用模型：登录至少一个供应商后，点「刷新」即可看到可用的模型 ID。';
  }
  const base = `共 ${models.length} 个可用模型。`
    + '有些客户端（如 ZCode）不会自动扫描模型目录，需要从这里把模型 ID 复制到它的配置里。'
    + 'ID 区分大小写；同名模型在不同供应商下也是不同模型（例如 codearts 与 buddy 各有一份 deepseek-v4.1-flash）。';
  return source === 'adapters'
    ? base + '（当前目录来自本插件已注册的适配器，可能不含 DSH 自带的模型）'
    : base;
}

/**
 * 用命令行查看目录的命令模板。
 *
 * ⚠️ 刻意**不含明文密钥**，用占位符代替：命令会进剪贴板历史、可能被贴到聊天里，
 * 把真 key 写进去等于顺手泄露。
 *
 * @param {string | null | undefined} endpoint
 * @returns {string}
 */
export function gatewayModelsCurl(endpoint) {
  const base = endpoint ? endpoint.replace(/\/v1$/, '') : 'http://127.0.0.1:8326'
  return `curl ${base}/v1/models -H "Authorization: Bearer <把你的 API Key 贴在这里>"`
}

/**
 * 思考档位对照表的**一行**（每个声明了档位的模型一行）。
 *
 * ## 这一列为什么必须存在（真实缺陷）
 *
 * 各 provider 的档位 id 是**上游自己的叫法**，而 OpenAI 协议的客户端只有固定
 * 8 档词汇（`none…ultra`，CC Switch 的档位多选器就是这 8 个）。用户只能照 DSH
 * 界面上显示的名字去填客户端，于是必然撞车：
 *
 * | 界面上看到的 | 客户端照填 | 模型真实认的 |
 * |---|---|---|
 * | LobsterAI 的 **Max** | `max` | `xhigh` |
 * | Cline 的 **Extra** | `xhigh` | `max` |
 * | TRAE 的 **Light / Extra High** | `low` / `xhigh` | `light` / `extra_high` |
 *
 * 网关现在会按强度**自动翻译**（填错不再 400），但「精确对应」仍然只有一列答案：
 * 即 `openai_efforts`。故把它渲染出来，用户抄一次就永久正确。
 *
 * ⚠️ **这张表只含「已开启」的模型**：数据来自各适配器的 `listModels`，而它按用户在
 * Jet Hub 里关掉的模型（黑名单）过滤。故表里的行数与模型选择器同源，不会出现
 * 「关掉的模型还在这里占位」。
 *
 * ⚠️ 返回 `null` 表示该模型**没有声明**档位（网关不下发该参数）。
 * 调用方必须跳过它，而不是渲染一行空表 —— 「不知道」与「一个都没有」是两件事。
 *
 * @param {{ id: string, name?: string, reasoning?: { efforts?: Array<{ id: string, name: string, canonical?: string }>, default?: string, openai_efforts?: readonly string[] } } | null | undefined} model
 * @returns {{ id: string, name: string, declared: string, fill: string, lossy: boolean } | null}
 */
export function gatewayEffortRow(model) {
  const reasoning = model?.reasoning;
  const efforts = reasoning?.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) return null;
  return {
    id: model.id,
    // 展示名留给搜索用（与模型清单的搜索共用 matchesModelQuery）。
    name: typeof model.name === 'string' ? model.name : '',
    // 两个名字都给出来：`id` 是网关实际下发的 wire 值，`name` 是 DSH 界面上的叫法
    // （用户就是照它填错的，故两列都得能对上）。
    declared: efforts.map((effort) => `${effort.id}（${effort.name}）`).join(' · '),
    fill: Array.isArray(reasoning.openai_efforts) ? reasoning.openai_efforts.join(', ') : '',
    // 「真实 id 与应填的规范名不完全一致」= 客户端侧的显示名会与 DSH 界面不同，
    // 这类行才是用户真正会看错的，值得在 UI 上标出来。
    //
    // ⚠️ **`canonical === undefined`（上游给了个没登记的私有 id，如 `turbo`）也算**：
    // 那种档位**任何规范名都表达不出来**，`fill` 列会比 `declared` 列少一档。
    // 原判据只认「canonical 与 id 不同」，于是这种行恰恰**不标徽章** ——
    // 用户看到一档填不出来的东西，却没有任何解释。
    lossy: efforts.some((effort) => effort.canonical === undefined || effort.canonical !== effort.id),
  };
}

/**
 * 全部模型的档位对照行（跳过未声明档位的模型）。
 *
 * @param {Array<object> | null | undefined} models
 * @returns {Array<{ id: string, name: string, declared: string, fill: string, lossy: boolean }>}
 */
export function gatewayEffortRows(models) {
  if (!Array.isArray(models)) return [];
  return models.map(gatewayEffortRow).filter(Boolean);
}

/**
 * 单行是否命中搜索词。
 *
 * ⚠️ **比模型清单的搜索多匹配「档位」** —— 这正是这张表最常用的查法：
 * 「哪些渠道有 `xhigh`？」「界面上的 Max 到底是哪个 id？」。
 * 故判据是「模型 id / 展示名（复用 `matchesModelQuery`，与模型清单同一口径）
 * **或**真实档位名 / 该填的规范名」。
 *
 * @param {{ id?: string, name?: string, declared?: string, fill?: string } | null | undefined} row
 * @param {string} query
 * @returns {boolean}
 */
export function matchesEffortQuery(row, query) {
  if (matchesModelQuery(row, query)) return true;
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (needle.length === 0) return true;
  return `${row?.declared ?? ''} ${row?.fill ?? ''}`.toLowerCase().includes(needle);
}

/**
 * 按搜索词过滤对照表。
 *
 * 无搜索词时**原样返回入参**（不复制、不改顺序）：与 `model-filter.js` 的
 * 「未搜索」口径一致（空串不是「搜索空串」）。
 *
 * @param {Array<object> | null | undefined} rows
 * @param {string} query
 * @returns {Array<object>}
 */
export function filterEffortRows(rows, query) {
  const list = Array.isArray(rows) ? rows : [];
  if (!isFilterActive({ query })) return list;
  return list.filter((row) => matchesEffortQuery(row, query));
}

/**
 * 对照表的说明文案。
 *
 * ⚠️ 三件事必须说清，否则用户会以为「填错了就是坏的」「表里有我没开的模型」，
 * 或者反过来「随便填」：
 * 1. 这张表**只含已开启的模型**（关掉的不会出现）；
 * 2. 填**规范名**（「客户端该填」那一列）才能精确对应；
 * 3. 填别的**也不会失败** —— 网关按强度就近翻译（本次新增的行为）。
 *
 * @param {Array<object> | null | undefined} models
 * @returns {string}
 */
export function gatewayEffortsHint(models) {
  const rows = gatewayEffortRows(models);
  if (rows.length === 0) {
    return '当前已开启的模型里没有声明思考档位的：网关不会下发该参数，一律按模型默认走。';
  }
  const lossy = rows.filter((row) => row.lossy).length;
  const enabled = Array.isArray(models) ? models.length : rows.length;
  return `当前已开启的 ${enabled} 个模型里，有 ${rows.length} 个可选思考档位`
    + `${lossy > 0 ? `，其中 ${lossy} 个的档位名与 OpenAI 客户端不同（见下方标「需对照」的行）` : ''}。`
    + '「客户端该填」那一列可以直接抄进 CC Switch / Codex 的思考等级设置，与模型真实档位一一对应。'
    // ⚠️ 别写成「填什么都不会报错」：强度序只登记了 12 个名字（8 个规范名 + 上游私有的
    // off / light / on / extra_high），`turbo` 这类未登记的写法是**真会 400** 的
    // （见 reasoning-ladder.ts 的 REASONING_EFFORT_RANK）。照实说，用户才不会去试一个
    // 必然失败的写法；错误里本来就会列出该模型可用的档位。
    + '这 8 个之外，上游私有的 off / light / on / extra_high 也能识别（按强度就近落到模型的某一档，会记日志）；'
    + '再往外的写法（如 turbo）会被拒绝，错误里会列出该模型可用的档位。'
    + '在插件里关掉的模型不会出现在这张表里。';
}

/**
 * 搜索结果为空时的提示。
 *
 * ⚠️ 空结果必须能自解释：要能区分「被搜索词筛没了」与「本来就没有声明档位的模型」，
 * 否则用户会以为网关坏了、或者以为模型没登录。
 *
 * @param {string} [query]
 * @returns {string}
 */
export function gatewayEffortsEmptyHint(query) {
  const needle = typeof query === 'string' ? query.trim() : '';
  if (needle.length === 0) return '当前没有模型声明思考档位。';
  return `没有匹配「${needle}」的模型。搜索会匹配模型 id / 展示名，也会匹配档位名`
    + '（真实 id 与 DSH 界面上的叫法都算，例如 xhigh / Max / Extra）。';
}

/**
 * 对照表的纯文本形态（供「复制」按钮写进剪贴板）。
 *
 * 与面板渲染共用同一批行，故复制到的内容与屏幕上看到的必然一致。
 *
 * @param {Array<{ id: string, declared: string, fill: string }> | null | undefined} rows
 * @returns {string}
 */
export function gatewayEffortsText(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => [
    row.id,
    `  真实档位：${row.declared}`,
    `  客户端该填：${row.fill}`,
  ].join('\n')).join('\n\n');
}

/**
 * 查看档位对照表的命令模板（同样**不含密钥**）。
 *
 * @param {string | null | undefined} endpoint
 * @returns {string}
 */
export function gatewayEffortsCurl(endpoint) {
  const base = endpoint ? endpoint.replace(/\/v1$/, '') : 'http://127.0.0.1:8326'
  return `curl ${base}/v1/reasoning-efforts -H "Authorization: Bearer <把你的 API Key 贴在这里>"`
}

/**
 * 页头按钮的 tooltip。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string}
 */
export function gatewayButtonTitle(status) {
  if (!status) return '本机 OpenAI 网关：读取状态中。'
  if (status.blockedByEnv) {
    return '本机 OpenAI 网关：已被环境变量 DSH_OPENAI_GATEWAY_ENABLED 停用，'
      + '在这里改开关不会让它监听端口。'
  }
  if (status.running) return `本机 OpenAI 网关：运行中（${gatewayEndpoint(status)}）。`
  if (status.enabled) return '本机 OpenAI 网关：已选择开启，但当前未在监听（通常是端口被占用）。'
  return '本机 OpenAI 网关：已关闭。'
}

/**
 * 网关的对外基地址，形如 `http://127.0.0.1:8326/v1`。
 *
 * ⚠️ `address` 为 `null` 时返回 `''` 而不是编造默认端口：端口可被
 * `DSH_OPENAI_GATEWAY_PORT` 改过，写死 `8326` 会让用户拿一个连不上的地址去
 * 配客户端，且这种错误在客户端侧表现为「连不上」，极难自查。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string}
 */
export function gatewayEndpoint(status) {
  const address = status?.address
  if (!address) return ''
  return `http://${address.host}:${address.port}/v1`
}

/**
 * 弹窗里的状态说明行。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string[]}
 */
export function gatewayStatusLines(status) {
  if (!status) return ['正在读取网关状态…']
  if (status.blockedByEnv) {
    return [
      '已被环境变量 DSH_OPENAI_GATEWAY_ENABLED 停用，网关不会监听端口。',
      '在下面的开关里做出的选择会被记住，但需要先取消该环境变量才会生效。',
    ]
  }
  if (status.running) {
    const endpoint = gatewayEndpoint(status)
    return [
      '网关正在运行。把外部客户端的 OpenAI 兼容地址设为下面这一行。',
      endpoint ? `地址：${endpoint}` : '',
      // ⚠️ 必须说清「两种协议同时可用」：Responses API 是后加的（2026-10-03），
      // 老用户从面板上看不出它存在，会以为网关只支持 Chat Completions。
      // ⚠️ 也**不能**说成「可切换」：两个端点同时都在，没有互斥开关。
      '同一地址同时提供两种协议：/chat/completions（OpenAI Chat Completions）'
      + '与 /responses（OpenAI Responses API）—— 用哪一套由客户端请求的路径决定。',
    ].filter(Boolean)
  }
  if (status.enabled) {
    return [
      '已选择开启，但网关当前没有在监听。',
      '最常见的原因是端口被其它程序占用 —— 换 DSH_OPENAI_GATEWAY_PORT 后重启即可。',
    ]
  }
  return ['网关已关闭，不会监听任何端口。']
}

/**
 * 开关是否可点。
 *
 * ⚠️ 被 env 停用时**禁用**而不是「点了没反应」：让用户完成一次明知无效的操作，
 * 比直接说清「这里改不动、原因是什么」更让人困惑。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {boolean}
 */
export function gatewaySwitchDisabled(status) {
  if (!status) return true
  return status.blockedByEnv
}

/**
 * 切换成功后给出的一句提示。
 *
 * @param {GatewayStatus | null | undefined} status 切换后的状态
 * @param {boolean} nextEnabled 用户想要的状态
 * @returns {string}
 */
export function gatewayToggleNotice(status, nextEnabled) {
  if (status?.blockedByEnv) {
    return '选择已保存，但 DSH_OPENAI_GATEWAY_ENABLED 仍在停用网关，取消它才会生效。'
  }
  if (!nextEnabled) return '网关已关闭，不再监听端口。'
  if (status?.running) return `网关已启动：${gatewayEndpoint(status)}`
  return '已选择开启，但网关没有在监听，请检查端口是否被占用。'
}
