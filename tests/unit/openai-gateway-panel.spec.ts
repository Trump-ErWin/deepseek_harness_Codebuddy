import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  copyToClipboard,
  formatModelIdList,
  gatewayApiKeyHint,
  gatewayButtonLabel,
  gatewayButtonTitle,
  gatewayCardExpanded,
  gatewayCardLabel,
  gatewayEndpoint,
  gatewayEffortRow,
  gatewayEffortRows,
  gatewayEffortsCurl,
  gatewayEffortsEmptyHint,
  gatewayEffortsHint,
  gatewayEffortsText,
  gatewayModelKeyOf,
  gatewayProviderOf,
  groupGatewayEntries,
  groupGatewayModels,
  GATEWAY_CARD_AUTOCOLLAPSE_AT,
  filterEffortRows,
  matchesEffortQuery,
  gatewayModelsCurl,
  gatewayModelsHint,
  gatewayStatusLines,
  gatewaySwitchDisabled,
  gatewayToggleNotice,
  modelCapabilityBadge,
  modelSupportsImage,
} from '../../plugin-src/client/openai-gateway-panel.js'
import { matchesModelQuery } from '../../plugin-src/client/model-filter.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')

const RUNNING = { enabled: true, running: true, blockedByEnv: false, address: { host: '127.0.0.1', port: 8326 } }
const OFF = { enabled: false, running: false, blockedByEnv: false, address: null }
const ENV_BLOCKED = { enabled: true, running: false, blockedByEnv: true, address: null }
const WANTED_BUT_DOWN = { enabled: true, running: false, blockedByEnv: false, address: null }

describe('本机网关面板的文案与判定', () => {
  it('按钮文字足够短，且运行中带运行态提示', () => {
    expect(gatewayButtonLabel(RUNNING)).toBe('网关 ●')
    expect(gatewayButtonLabel(OFF)).toBe('网关')
    // 页头按钮排成一行，文字过长会把右端「关闭」挤到第二行。
    expect(gatewayButtonLabel(RUNNING).length).toBeLessThanOrEqual(4)
  })

  it('状态未读取时按钮退化为「网关」而不是空白', () => {
    expect(gatewayButtonLabel(null)).toBe('网关')
    expect(gatewayButtonTitle(null)).toContain('读取状态中')
    expect(gatewayStatusLines(null)).toEqual(['正在读取网关状态…'])
  })

  it('地址只在真监听时给出，且端口取自宿主侧而非写死 8326', () => {
    const custom = { ...RUNNING, address: { host: '127.0.0.1', port: 9999 } }
    expect(gatewayEndpoint(custom)).toBe('http://127.0.0.1:9999/v1')
    // ⚠️ 端口可被 DSH_OPENAI_GATEWAY_PORT 改过；address 为空时编造 8326 会让
    // 用户拿一个连不上的地址去配客户端。
    expect(gatewayEndpoint(OFF)).toBe('')
    expect(gatewayEndpoint(WANTED_BUT_DOWN)).toBe('')
    expect(gatewayEndpoint(null)).toBe('')
  })

  it('「已选择开启但没监听」必须与「运行中」说不同的话', () => {
    // 这两种状态在 UI 上都表现为 enabled=true，只靠 enabled 推导会显示
    // 「已开启」而用户连不上。
    expect(gatewayStatusLines(RUNNING).join()).toContain('正在运行')
    expect(gatewayStatusLines(WANTED_BUT_DOWN).join()).toContain('没有在监听')
    expect(gatewayStatusLines(WANTED_BUT_DOWN).join()).toContain('端口')
  })

  it('★ 运行中必须说清「两种协议同时可用」（Responses API 是后加的，面板不说就没人知道）', () => {
    const lines = gatewayStatusLines(RUNNING).join()
    expect(lines).toContain('/chat/completions')
    expect(lines).toContain('/responses')
    // ⚠️ 措辞必须是「同时提供」，不是「可切换」：两端点同时都在，没有互斥开关。
    expect(lines).toContain('同时提供')
    expect(lines).not.toContain('切换')
  })

  it('被 env 停用时开关禁用，且明确指出原因与 env 名', () => {
    expect(gatewaySwitchDisabled(ENV_BLOCKED)).toBe(true)
    expect(gatewaySwitchDisabled(RUNNING)).toBe(false)
    expect(gatewaySwitchDisabled(OFF)).toBe(false)
    expect(gatewayButtonTitle(ENV_BLOCKED)).toContain('DSH_OPENAI_GATEWAY_ENABLED')
    expect(gatewayStatusLines(ENV_BLOCKED).join()).toContain('DSH_OPENAI_GATEWAY_ENABLED')
  })

  it('状态未读取时开关禁用，避免用户对着未知状态做操作', () => {
    expect(gatewaySwitchDisabled(null)).toBe(true)
  })

  it('切换提示如实反映「没跑起来」，不谎报成功', () => {
    expect(gatewayToggleNotice(RUNNING, true)).toContain('http://127.0.0.1:8326/v1')
    expect(gatewayToggleNotice(OFF, false)).toContain('已关闭')
    expect(gatewayToggleNotice(WANTED_BUT_DOWN, true)).toContain('端口')
    expect(gatewayToggleNotice(ENV_BLOCKED, true)).toContain('DSH_OPENAI_GATEWAY_ENABLED')
  })

  it('客户端确实接上了宿主侧的两个网关端点', () => {
    expect(source).toContain("rpcCall('gateway.getEnabled'")
    expect(source).toContain("rpcCall('gateway.setEnabled'")
  })
})

describe('凭据的展示与复制', () => {
  it('来自环境变量时不显示文件路径（那一刻根本没有文件）', () => {
    const hint = gatewayApiKeyHint({ fromEnv: true, path: null, value: 'k' })
    expect(hint).toContain('DSH_OPENAI_GATEWAY_API_KEY')
    expect(hint).not.toContain('api-key')
  })

  it('来自文件时给出准确路径，帮用户自己核对/备份', () => {
    expect(gatewayApiKeyHint({ fromEnv: false, path: 'C:/Users/Jet/.dsh/openai-gateway/api-key', value: 'k' }))
      .toContain('C:/Users/Jet/.dsh/openai-gateway/api-key')
  })

  it('尚未生成过密钥时说明「启用后自动生成」，而不是给一个必然 401 的占位串', () => {
    const hint = gatewayApiKeyHint(null)
    expect(hint).toContain('自动生成')
  })

  it('复制失败时返回 false，调用方据此退回「显示明文」而不是无声无息', async () => {
    // 无 Clipboard API（node 环境）必须返回 false 而不是抛错。
    expect(await copyToClipboard('secret')).toBe(false)
  })

  it('复制成功时返回 true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      expect(await copyToClipboard('secret')).toBe(true)
      expect(writeText).toHaveBeenCalledWith('secret')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('写剪贴板被拒（权限/非用户手势）时返回 false 而不是抛到 UI', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      expect(await copyToClipboard('secret')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('面板默认不把密钥明文渲染进 DOM，只有点「显示明文」才出现', () => {
    // 设置页会被截图/录屏/投屏，明文默认躺在屏幕上等于把凭据带出去。
    const body = source.slice(
      source.indexOf('function GatewayPanel('),
      source.indexOf('export function JetHubPage'),
    )
    // ⚠️ 用 \s 跨空白而不是 '\n' 字面量：源文件是 CRLF，字面量匹配不上。
    // 这里验的正是「明文必须被 revealed 门控」——三元里 revealed 为真才渲染 value。
    expect(body).toMatch(/revealed\s*\?\s*React\.createElement\('code'[\s\S]*?apiKey\.value/)
    // 复制走的是同一个值，避免「显示的」与「复制的」不是同一个。
    expect(body).toContain('copyToClipboard(apiKey.value)')
    // 复制失败必须退回显示明文，不能让按钮点了没反应。
    expect(body).toMatch(/setRevealed\(true\)[\s\S]{0,80}setCopied\(false\)/)
  })
})

describe('模型 ID 清单（ZCode 等不会自动扫目录的客户端靠它）', () => {
  const MODELS = [
    { id: 'codearts/GLM-5.2', name: 'GLM-5.2' },
    { id: 'codearts/glm-5.3-flash', name: 'GLM-5.3 Flash' },
    { id: 'cline/anthropic/claude-sonnet-5.5', name: 'Claude' },
  ]

  it('每行一个 ID，保持原大小写（大小写敏感，规范化会给出错误 ID）', () => {
    expect(formatModelIdList(MODELS)).toBe(
      'codearts/GLM-5.2\ncodearts/glm-5.3-flash\ncline/anthropic/claude-sonnet-5.5',
    )
  })

  it('空清单不产生空白字符串（否则「复制」按钮会复制到一个换行）', () => {
    expect(formatModelIdList([])).toBe('')
    expect(formatModelIdList(null)).toBe('')
    expect(formatModelIdList(undefined)).toBe('')
  })

  it('提示语给出数量，并点明「ID 区分大小写」这个实测踩过的坑', () => {
    const hint = gatewayModelsHint(MODELS, 'catalog')
    expect(hint).toContain('3 个')
    expect(hint).toContain('大小写')
    // 同名模型跨 provider 不是同一个 —— 用户最常见的误配来源。
    expect(hint).toContain('不同供应商')
  })

  it('⚠️ 空清单必须能自解释：区分「没登录」与「宿主没给出 provider」', () => {
    // 实机报障：用户每个 provider 都登录了，清单却是 0 个，而提示却说
    // 「还没有可用模型，登录至少一个供应商」—— 用户照着去查登录怎么都对不上。
    expect(gatewayModelsHint([], 'none')).toContain('拿不到任何 provider 列表')
    expect(gatewayModelsHint([], 'none')).toContain('这不是登录问题')
    expect(gatewayModelsHint([], 'catalog')).toContain('还没有可用模型')
  })

  it('目录来自适配器兜底时说明它可能不完整', () => {
    const hint = gatewayModelsHint(MODELS, 'adapters')
    expect(hint).toContain('已注册的适配器')
  })

  it('curl 模板含正确端口，但**绝不含**明文密钥', () => {
    const curl = gatewayModelsCurl('http://127.0.0.1:9999/v1')
    expect(curl).toContain('127.0.0.1:9999/v1/models')
    expect(curl).toContain('Authorization: Bearer')
    // ⚠️ 命令会进剪贴板历史、可能被贴进聊天里，不能把真 key 写进去。
    expect(curl).toContain('把你的 API Key 贴在这里')
  })

  it('地址栏直接打开会 401 这件事必须提前告诉用户', () => {
    expect(gatewayModelsHint(MODELS)).not.toContain('401')
    // 说明文案在面板里，单独断言渲染处带这句。
    expect(source).toContain('地址栏直接打开会返回 401')
  })

  it('面板确实渲染了清单与「复制全部 ID」按钮', () => {
    expect(source).toContain('formatModelIdList(models)')
    expect(source).toContain('handleCopyModelIds')
    expect(source).toContain('复制全部')
    // 复制失败必须展开清单让用户手动选中。
    expect(source).toMatch(/setIdsCopied\(ok\)[\s\S]{0,120}setModelsOpen\(true\)/)
  })
})

/**
 * 「哪些模型能发图片」的标记。
 *
 * 背景：用户给网关发图得到 `unsupported_content`，但他**事先无从知道**该模型
 * 支不支持图片 —— 只能撞一次错才知道。`/v1/models` 早已带 `input` 字段，只是
 * 设置页没显示。
 */
describe('模型能力标记（可发图片）', () => {
  it('input 含 image 时标记为可发图片', () => {
    expect(modelSupportsImage({ input: ['text', 'image'] })).toBe(true)
    expect(modelCapabilityBadge({ input: ['text', 'image'] })).toBe('可发图片')
  })

  it('⚠️ 缺 input / 不含 image 一律**不标**（宁可少标也不错标）', () => {
    // 错标成支持，用户发完图才发现被拒；少标则只是没提示，错误仍是明确的。
    expect(modelSupportsImage({ input: ['text'] })).toBe(false)
    expect(modelSupportsImage({})).toBe(false)
    expect(modelSupportsImage(null)).toBe(false)
    expect(modelSupportsImage(undefined)).toBe(false)
    expect(modelSupportsImage({ input: 'image' as never })).toBe(false)
    expect(modelCapabilityBadge({ input: ['text'] })).toBe('')
  })

  it('判据只看是否含 image，不因顺序或额外模态而改变', () => {
    expect(modelSupportsImage({ input: ['image'] })).toBe(true)
    expect(modelSupportsImage({ input: ['image', 'text', 'audio'] })).toBe(true)
  })

  it('清单行确实渲染了这个标记', () => {
    expect(source).toContain('modelCapabilityBadge')
    expect(source).toContain('dim-jh-modelBadge')
  })

  it('样式里有这个类，且锁住 flex: none（否则会被 id/name 挤没）', () => {
    const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
    expect(styles).toMatch(/\.dim-jh-modelBadge \{[^}]*flex: none/)
  })
})

/**
 * 思考档位对照表。
 *
 * 背景（真实缺陷）：各 provider 的档位 id 是上游私有值，而 OpenAI 协议的客户端
 * 只有固定 8 档词汇。用户照 DSH 界面上的名字填进 CC Switch（LobsterAI 的 Max →
 * `max`、Cline 的 Extra → `xhigh`、TRAE 的 Light/Extra High → `low`/`xhigh`），
 * 网关按 id 校验，全部 400 —— 整轮对话不可用，而两端都看不出原因。
 */
describe('思考档位对照表', () => {
  const TRAE = {
    id: 'trae/deepseek-v4.1-flash',
    name: 'Flash',
    reasoning: {
      efforts: [
        { id: 'light', name: 'Light', canonical: 'low' },
        { id: 'high', name: 'High', canonical: 'high' },
        { id: 'extra_high', name: 'Extra High', canonical: 'xhigh' },
      ],
      default: 'high',
      openai_efforts: ['low', 'high', 'xhigh'],
    },
  }
  /** 档位名与客户端一致的行：不该被标「需对照」。 */
  const PLAIN = {
    id: 'qoder/dfmodel',
    name: 'DeepSeek-Flash',
    reasoning: {
      efforts: [{ id: 'low', name: '低', canonical: 'low' }, { id: 'high', name: '高', canonical: 'high' }],
      openai_efforts: ['low', 'high'],
    },
  }
  const NO_EFFORT = { id: 'zcode/GLM-5.3', name: 'GLM' }

  it('★ 一行同时给出「真实档位」与「客户端该填」（只给一个都救不了用户）', () => {
    const row = gatewayEffortRow(TRAE)
    // 真实档位要把 id 与 DSH 界面上的 name 都给出来：用户就是照 name 填错的。
    expect(row?.declared).toBe('light（Light） · high（High） · extra_high（Extra High）')
    expect(row?.fill).toBe('low, high, xhigh')
    expect(row?.lossy).toBe(true)
    // 展示名要带上，搜索时才搜得到（与模型清单的搜索共用 matchesModelQuery）。
    expect(row?.name).toBe('Flash')
  })

  it('档位名与客户端一致的行不标「需对照」', () => {
    expect(gatewayEffortRow(PLAIN)?.lossy).toBe(false)
  })

  it('⚠️ 未声明档位的模型不产生行（「不知道」≠「一个都没有」）', () => {
    expect(gatewayEffortRow(NO_EFFORT)).toBeNull()
    expect(gatewayEffortRow({ id: 'x', reasoning: { efforts: [], openai_efforts: [] } })).toBeNull()
    expect(gatewayEffortRows([TRAE, NO_EFFORT, PLAIN]).map(row => row.id))
      .toEqual(['trae/deepseek-v4.1-flash', 'qoder/dfmodel'])
  })

  it('脏输入不抛错（宿主字段缺失/形态不符时面板仍要能渲染）', () => {
    expect(gatewayEffortRows(null)).toEqual([])
    expect(gatewayEffortRows(undefined)).toEqual([])
    expect(gatewayEffortRow(null)).toBeNull()
    expect(gatewayEffortRow({ id: 'x', reasoning: { efforts: 'nope' as never } })).toBeNull()
    // openai_efforts 缺失时给空串而不是 undefined（否则 UI 会渲染出 "undefined"）。
    expect(gatewayEffortRow({ id: 'x', reasoning: { efforts: [{ id: 'turbo', name: 'T' }] } })?.fill).toBe('')
    expect(gatewayEffortRow({ id: 'x', reasoning: { efforts: [{ id: 'turbo', name: 'T' }] } })?.name).toBe('')
    // ⚠️ 上游给了个**没登记**的私有 id（没有 canonical）时，这一档**任何规范名都表达
    // 出来**，`declared` 比 `fill` 多一档 —— 必须标「需对照」，否则用户看到一档填不
    // 出来的东西却没有任何解释。原判据只认「canonical 与 id 不同」，恰恰漏了这种。
    const unregistered = gatewayEffortRow({
      id: 'x',
      reasoning: {
        efforts: [{ id: 'turbo', name: 'T' }, { id: 'high', name: 'H', canonical: 'high' }],
        openai_efforts: ['high'],
      },
    })
    expect(unregistered?.fill).toBe('high')
    expect(unregistered?.lossy).toBe(true)
  })

  it('★ 说明文案：不能说「填什么都不会报错」—— 未登记的写法是真会 400 的', () => {
    const hint = gatewayEffortsHint([TRAE, PLAIN, NO_EFFORT])
    // 用户看到「14 个」时会以为网关只认得 14 个模型 —— 必须点明这是**已开启**的数量。
    expect(hint).toContain('当前已开启的 3 个模型')
    expect(hint).toContain('有 2 个可选思考档位')
    // 只有 TRAE 那行是「需对照」，数量必须如实。
    expect(hint).toContain('1 个的档位名与 OpenAI 客户端不同')
    expect(hint).toContain('按强度就近')
    expect(hint).toContain('CC Switch')
    expect(hint).toContain('关掉的模型不会出现在这张表里')
    // ⚠️ 边界必须照实说：强度序只登记了 12 个名字（8 规范名 + off/light/on/extra_high），
    // `turbo` 这类未登记的写法会被拒绝。让用户去试一个必然 400 的写法是误导。
    expect(hint).toContain('off / light / on / extra_high')
    expect(hint).toContain('会被拒绝')
    expect(hint).not.toContain('也不会报错')
  })

  it('一个模型都没声明档位时说明「网关不会下发该参数」', () => {
    expect(gatewayEffortsHint([NO_EFFORT])).toContain('不会下发该参数')
    expect(gatewayEffortsHint([])).toContain('不会下发该参数')
  })

  it('curl 模板指向对照表端点，且**绝不含**明文密钥', () => {
    const curl = gatewayEffortsCurl('http://127.0.0.1:9999/v1')
    expect(curl).toContain('127.0.0.1:9999/v1/reasoning-efforts')
    expect(curl).toContain('把你的 API Key 贴在这里')
  })

  it('面板确实渲染了对照表，且数据来自宿主的档位视图', () => {
    expect(source).toContain('gatewayEffortRows(models)')
    expect(source).toContain('gatewayEffortsHint(models)')
    expect(source).toContain('gatewayEffortsCurl(gatewayEndpoint(status))')
    expect(source).toContain('客户端该填')
    // 空表不能让用户点开一个什么都没有的区块。
    expect(source).toMatch(/disabled:\s*effortRows\.length === 0/)
  })
})

/**
 * 对照表的**搜索**（用户要求：表要能查）。
 *
 * ⚠️ 与模型清单的搜索**不是同一套判据**：那里只匹配 id/name，这里还要匹配
 * **档位名** —— 因为最常用的查法就是「哪些渠道有 xhigh？」「界面上的 Max 是哪个 id？」
 * （后者正是用户踩过的坑）。但「空搜索词 = 未搜索」的约定与它共用
 * `model-filter.js`，避免两处漂移。
 */
describe('思考档位对照表的搜索', () => {
  const ROWS = [
    gatewayEffortRow({
      id: 'trae/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash',
      reasoning: {
        efforts: [
          { id: 'light', name: 'Light', canonical: 'low' },
          { id: 'high', name: 'High', canonical: 'high' },
          { id: 'extra_high', name: 'Extra High', canonical: 'xhigh' },
        ],
        openai_efforts: ['low', 'high', 'xhigh'],
      },
    }),
    gatewayEffortRow({
      id: 'lobsterai/deepseek-flash', name: 'DeepSeek-Flash',
      reasoning: {
        efforts: [
          { id: 'off', name: '关闭', canonical: 'none' },
          { id: 'high', name: '高', canonical: 'high' },
          { id: 'xhigh', name: 'Max', canonical: 'xhigh' },
        ],
        openai_efforts: ['none', 'high', 'xhigh'],
      },
    }),
    gatewayEffortRow({
      id: 'cline/cline-free/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash',
      reasoning: {
        efforts: [
          { id: 'none', name: 'None', canonical: 'none' },
          { id: 'max', name: 'Extra', canonical: 'max' },
        ],
        openai_efforts: ['none', 'max'],
      },
    }),
  ].filter(Boolean)

  it('空搜索词 = 未搜索（返回全部，而不是筛空）', () => {
    expect(filterEffortRows(ROWS, '').length).toBe(3)
    expect(filterEffortRows(ROWS, '   ').length).toBe(3)
    expect(filterEffortRows(ROWS)).toBe(ROWS)
    expect(filterEffortRows(null, 'x')).toEqual([])
  })

  it('按模型 id / 展示名搜（与模型清单同一口径）', () => {
    expect(filterEffortRows(ROWS, 'lobsterai').map(row => row.id)).toEqual(['lobsterai/deepseek-flash'])
    expect(filterEffortRows(ROWS, 'DEEPSEEK-V4.1-FLASH').map(row => row.id))
      .toEqual(['trae/deepseek-v4.1-flash', 'cline/cline-free/deepseek-v4.1-flash'])
  })

  it('★ 按**档位名**搜（这是本表最常用的查法）', () => {
    // 真实 id
    expect(filterEffortRows(ROWS, 'light').map(row => row.id)).toEqual(['trae/deepseek-v4.1-flash'])
    expect(filterEffortRows(ROWS, 'xhigh').map(row => row.id))
      .toEqual(['trae/deepseek-v4.1-flash', 'lobsterai/deepseek-flash'])
    // DSH 界面上的叫法也要能搜到（用户就是照着它填错的）。
    // ⚠️ 子串匹配：`Max` 同时命中 Cline 的真实 id `max` —— 这是对的
    //（那一行的真实档位列写的就是 `max`），用户据两列自行区分。
    expect(filterEffortRows(ROWS, 'Max').map(row => row.id))
      .toEqual(['lobsterai/deepseek-flash', 'cline/cline-free/deepseek-v4.1-flash'])
    // `Extra` 同时命中 TRAE 的 Extra High 与 Cline 的 Extra —— 这正是「按档位名搜」
    // 该有的行为（模糊命中即可，用户自己看两行的真实 id 区分）。
    expect(filterEffortRows(ROWS, 'Extra').map(row => row.id))
      .toEqual(['trae/deepseek-v4.1-flash', 'cline/cline-free/deepseek-v4.1-flash'])
    // 该填的规范名同样算命中
    expect(filterEffortRows(ROWS, 'none').map(row => row.id))
      .toEqual(['lobsterai/deepseek-flash', 'cline/cline-free/deepseek-v4.1-flash'])
  })

  it('搜不到时返回空数组（不是抛错、也不是返回全量）', () => {
    expect(filterEffortRows(ROWS, 'banana')).toEqual([])
  })

  it('两种搜索判据的差异被锁住：档位名只在对照表里搜得到', () => {
    // 模型清单的 matchesModelQuery 只认 id/name —— 若哪天有人把对照表的搜索
    // 「顺手统一」成它，按档位名就再也搜不到了（Max / Extra 这类查法会失效）。
    expect(matchesModelQuery(ROWS[1], 'Max')).toBe(false)
    expect(matchesEffortQuery(ROWS[1], 'Max')).toBe(true)
  })
})

describe('思考档位对照表：复制与空结果文案', () => {
  const ROWS = [
    gatewayEffortRow({
      id: 'lobsterai/deepseek-flash', name: 'DeepSeek-Flash',
      reasoning: {
        efforts: [{ id: 'xhigh', name: 'Max', canonical: 'xhigh' }],
        openai_efforts: ['xhigh'],
      },
    }),
  ].filter(Boolean)

  it('复制出来的文本与屏幕上的两行一致（含模型 id）', () => {
    expect(gatewayEffortsText(ROWS)).toBe(
      'lobsterai/deepseek-flash\n  真实档位：xhigh（Max）\n  客户端该填：xhigh',
    )
  })

  it('多行之间空行分隔，且空输入返回空串（否则「复制」会复制一堆空白）', () => {
    expect(gatewayEffortsText([ROWS[0], ROWS[0]])).toContain('\n\n')
    expect(gatewayEffortsText([])).toBe('')
    expect(gatewayEffortsText(null)).toBe('')
  })

  it('★ 空结果必须能区分「被搜索词筛没了」与「本来就没有」', () => {
    expect(gatewayEffortsEmptyHint('banana')).toContain('没有匹配「banana」')
    // 要顺便教会用户能搜什么，否则他只会换个词继续试。
    expect(gatewayEffortsEmptyHint('banana')).toContain('档位名')
    expect(gatewayEffortsEmptyHint('')).toContain('没有模型声明思考档位')
    expect(gatewayEffortsEmptyHint()).toContain('没有模型声明思考档位')
  })

  it('面板接上了搜索框、复制按钮与空结果提示', () => {
    expect(source).toContain('filterEffortRows(effortRows, effortsQuery)')
    expect(source).toContain('gatewayEffortsEmptyHint(effortsQuery)')
    expect(source).toContain('gatewayEffortsText(visibleEffortRows)')
    expect(source).toContain('搜索模型 id、展示名或档位名')
    // 复制失败必须展开表格让用户手动选中（不能「点了没反应」）。
    expect(source).toMatch(/setEffortsCopied\(ok\)[\s\S]{0,120}setEffortsOpen\(true\)/)
    // 换了搜索词要复位「已复制」，否则那句提示讲的是另一批行。
    expect(source).toMatch(/setEffortsCopied\(false\)[\s\S]{0,40}\[models\.length,\s*effortsQuery\]/)
  })
})

/**
 * 「字符过长被省略号截断」是用户明确反馈的问题（2026-10-03）：
 * 对照表的内容**就是要抄的东西**，截断等于让功能失效。
 *
 * 故这里锁两条：
 * 1. 对照表**不复用**模型清单那套带 `text-overflow: ellipsis` 的类；
 * 2. 它自己的类必须允许换行（`overflow-wrap: anywhere`）且**不含**截断属性。
 */
describe('思考档位对照表的排版（不截断）', () => {
  const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
  const rule = (selector: string) => {
    const match = styles.match(new RegExp(`\\${selector} \\{([^}]*)\\}`))
    return match?.[1] ?? ''
  }

  it('⚠️ 对照表的行与文本不得使用 ellipsis / nowrap 截断', () => {
    for (const selector of ['.dim-jh-effortRow', '.dim-jh-effortHead', '.dim-jh-effortModel', '.dim-jh-effortLine']) {
      const body = rule(selector)
      expect(body, `${selector} 应有样式`).not.toBe('')
      expect(body, `${selector} 不得截断（那是用户反馈的缺陷）`).not.toContain('ellipsis')
      expect(body, `${selector} 不得 nowrap`).not.toContain('nowrap')
    }
  })

  it('长内容靠 overflow-wrap 换行，而不是被切掉', () => {
    expect(rule('.dim-jh-effortModel')).toContain('overflow-wrap: anywhere')
    expect(rule('.dim-jh-effortLine')).toContain('overflow-wrap: anywhere')
  })

  it('渲染用的类确实是新那套（用错就会重新截断）', () => {
    expect(source).toContain("className: 'dim-jh-effortRow'")
    expect(source).toContain("className: 'dim-jh-effortModel'")
    expect(source).toContain("className: 'dim-jh-effortLine'")
    // ⚠️ 模型清单那两行是 ellipsis 截断的，对照表**不能**复用它们。
    // ⚠️ 取渲染处的注释做起点（`handleCopyEfforts` 的注释里也提到这几个字，
    // 从那里切会把上面的模型清单一起圈进来）。
    const effortSection = source.slice(
      source.indexOf('// ── 思考档位对照表'),
      source.indexOf('网关只绑定 127.0.0.1'),
    )
    expect(effortSection).not.toBe('')
    expect(effortSection).not.toContain('dim-jh-modelName')
  })
})

/**
 * 「一个供应商一张卡片」（用户报障 2026-10-03）。
 *
 * 用户原话：`deepseek-account/deepseek-flash` 与 `deepseek-account/deepseek-v4-pro`
 * 这是同一家供应商 `deepseek-account` 的，却分为了两个卡片（当时是一个模型一行）。
 * 用户要的形态是「供应商 → 它名下有哪些模型」。
 *
 * ⚠️ 分组判据必须抽成纯函数才能真跑覆盖：单测环境是 `node`，react 不在依赖内。
 */
describe('按供应商分组（一个供应商一张卡片）', () => {
  const MODELS = [
    { id: 'deepseek-account/deepseek-flash', provider: 'deepseek-account', model: 'deepseek-flash', name: 'Flash' },
    { id: 'deepseek-account/deepseek-v4-pro', provider: 'deepseek-account', model: 'deepseek-v4-pro', name: 'Pro' },
    { id: 'codearts/GLM-5.2', provider: 'codearts', model: 'GLM-5.2', name: 'GLM' },
  ]

  it('★ 用户报障的那两条必须落在同一张卡片里', () => {
    const cards = groupGatewayModels(MODELS)
    const ds = cards.find(card => card.provider === 'deepseek-account')
    expect(ds?.entries.map(entry => entry.model)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    // 卡片数 = 供应商数（不是模型数）。
    expect(cards.map(card => card.provider)).toEqual(['deepseek-account', 'codearts'])
  })

  it('卡片顺序 = 目录原序（首次出现的先后），不重排', () => {
    const shuffled = [MODELS[2], MODELS[1], MODELS[0]]
    expect(groupGatewayModels(shuffled).map(card => card.provider)).toEqual(['codearts', 'deepseek-account'])
  })

  it('★ 卡片头的条数如实统计（总数 + 可发图片数）', () => {
    const cards = groupGatewayModels([
      { id: 'a/x', provider: 'a', model: 'x', name: 'X', input: ['text', 'image'] },
      { id: 'a/y', provider: 'a', model: 'y', name: 'Y', input: ['text'] },
    ])
    expect(cards[0].counts).toEqual({ total: 2, fold: 1 })
  })

  it('★ provider 缺失时按首个斜杠兜底（与网关路由同源），仍不丢行', () => {
    // 宿主字段缺失（旧版本/替身）时的降级路径：能分组，只是分组由 id 反推。
    const cards = groupGatewayModels([{ id: 'codearts/GLM-5.2', name: 'GLM' }])
    expect(cards.map(card => card.provider)).toEqual(['codearts'])
  })

  it('⚠️ 拿不到 provider（id 里没斜杠）归入「未知」卡片，**不丢行**', () => {
    // 少一个 ID 会让用户照着一份不完整的清单配客户端，故宁可单列一张卡。
    const cards = groupGatewayModels([{ id: 'bogus', name: 'B' }, ...MODELS])
    expect(cards.map(card => card.provider)).toEqual(['', 'deepseek-account', 'codearts'])
    expect(cards[0].entries).toHaveLength(1)
    // 未知那张卡要有**可解释**的标题，空标题会让用户以为界面坏了。
    expect(gatewayCardLabel('')).toContain('未标注供应商')
  })

  it('脏输入不抛错（面板在数据未就绪时也要能渲染）', () => {
    expect(groupGatewayModels(null)).toEqual([])
    expect(groupGatewayModels(undefined)).toEqual([])
    expect(groupGatewayModels('nope' as never)).toEqual([])
    expect(gatewayProviderOf(null)).toBe('')
    expect(gatewayProviderOf({ id: '/leading' })).toBe('')
  })

  it('⚠️ 不去重：同一 id 出现两次是上游的事，如实显示（去重会掩盖上游缺陷）', () => {
    const cards = groupGatewayModels([MODELS[0], MODELS[0]])
    expect(cards[0].counts.total).toBe(2)
  })

  it('★ 模型清单与档位对照表共用同一套分组判据（两处口径不可能漂移）', () => {
    // 对照行只有 provider/id/model 三个字段，groupGatewayEntries 也只依赖它们。
    const rows = [
      { id: 'trae/deepseek-v4.1-flash', provider: 'trae', model: 'deepseek-v4.1-flash', name: 'F' },
      { id: 'trae/deepseek-v4-pro', provider: 'trae', model: 'deepseek-v4-pro', name: 'P' },
      { id: 'lobsterai/deepseek-flash', provider: 'lobsterai', model: 'deepseek-flash', name: 'L' },
    ]
    expect(groupGatewayEntries(rows).map(card => card.provider)).toEqual(['trae', 'lobsterai'])
    // ⚠️ 对照表的分组必须发生在**筛出来的行**上（否则卡片头写着 8 个、里面只有 1 行）。
    expect(groupGatewayEntries(rows.slice(0, 1)).map(card => card.counts.total)).toEqual([1])
  })

  it('卡片标题走渠道名（查不到时退回 provider key，不显示空白）', () => {
    expect(gatewayCardLabel('codearts', () => 'CodeArts (华为云)')).toBe('CodeArts (华为云)')
    expect(gatewayCardLabel('codearts')).toBe('codearts')
    // 回调给出空串时也要退回 id，否则标题会是空白。
    expect(gatewayCardLabel('codearts', () => '')).toBe('codearts')
  })

  /**
   * ⚠️ 纯函数的正确性**不足以**证明面板接对了：判据还在、但没人调用（或调用了
   * 另一批数据）时，用例照样全绿。故这里额外锁三处**接线**。
   */
  it('★ 两处清单都真的走了分组卡片（模型清单 + 档位对照表）', () => {
    expect(source).toContain('groupGatewayModels(models)')
    // ⚠️ 对照表的卡片必须建在**筛出来的行**上：若建在全量 `effortRows` 上，
    // 搜索时会出现「卡片头写着 8 个、卡里只有 1 行」的自相矛盾读数。
    expect(source).toContain('groupGatewayEntries(visibleEffortRows')
    expect(source).not.toContain('groupGatewayEntries(effortRows')
    // 两种清单都渲染成卡片（同一套形态，用户不必学两种读法）。
    expect(source.match(/React\.createElement\(GatewayCards, \{/g)).toHaveLength(2)
    // 行内用短名字、复制用完整 id（两处都不能搞反）。
    expect(source).toContain('gatewayModelKeyOf(model)')
    expect(source).toContain('gatewayModelKeyOf(row)')
    expect(source).toContain('formatModelIdList(card.entries)')
  })
})

/**
 * 行内只显示**去掉供应商前缀**的模型名（用户要的「模型名显示别那么乱」）。
 *
 * 卡片头已经写明供应商，行内再重复前缀是纯噪声：实测
 * `codearts/deepseek-v4.1-flash` 这类 id 占满整行，在 `max-width: 46%` 的夹取下跌成
 * `codearts/deepse…` —— 用户既看不出模型名，也读不到能复制的 ID。
 */
describe('卡片内的模型名（去掉供应商前缀）', () => {
  it('★ 用宿主给的权威 model 字段，不靠切 id', () => {
    expect(gatewayModelKeyOf({ id: 'codearts/GLM-5.2', provider: 'codearts', model: 'GLM-5.2' }))
      .toBe('GLM-5.2')
  })

  it('⚠️ model 缺失时按前缀剥一次，剥不掉就退回完整 id（绝不返回空行）', () => {
    expect(gatewayModelKeyOf({ id: 'codearts/GLM-5.2', provider: 'codearts' })).toBe('GLM-5.2')
    // 前缀对不上（字段畸形）时不能硬切，否则会切出半个 ID。
    expect(gatewayModelKeyOf({ id: 'codearts/GLM-5.2', provider: 'other' })).toBe('codearts/GLM-5.2')
    expect(gatewayModelKeyOf({ id: 'bogus' })).toBe('bogus')
    expect(gatewayModelKeyOf(null)).toBe('')
  })

  it('⚠️ 模型名里带斜杠时只剥 provider 那一段（不是按斜杠切一半）', () => {
    expect(gatewayModelKeyOf({
      id: 'cline/anthropic/claude-sonnet-5.5', provider: 'cline', model: 'anthropic/claude-sonnet-5.5',
    })).toBe('anthropic/claude-sonnet-5.5')
  })

  it('★ 对照表行同样只显示短名字，但复制出去的仍是完整 id', () => {
    const row = gatewayEffortRow({
      id: 'trae/deepseek-v4.1-flash',
      provider: 'trae',
      model: 'deepseek-v4.1-flash',
      name: 'Flash',
      reasoning: { efforts: [{ id: 'high', name: 'High', canonical: 'high' }], openai_efforts: ['high'] },
    })
    expect(row?.model).toBe('deepseek-v4.1-flash')
    expect(row?.provider).toBe('trae')
    // ⚠️ 复制用的 `id` 必须保持完整 —— 抄一个短名字进客户端必然 404。
    expect(row?.id).toBe('trae/deepseek-v4.1-flash')
    expect(gatewayEffortsText([row!])).toContain('trae/deepseek-v4.1-flash')
  })
})

/**
 * 卡片的折叠规则。
 *
 * 网关清单是**全 provider 汇总**，Cline 一家实测近 500 条，全展开等于把弹窗
 * 撑成没法翻的长条（用户找的是「哪家有哪些模型」，不是「一次看完 500 行」）。
 */
describe('供应商卡片的折叠', () => {
  const small = { counts: { total: 3, fold: 0 } }
  const huge = { counts: { total: GATEWAY_CARD_AUTOCOLLAPSE_AT + 1, fold: 0 } }

  it('默认：小卡片展开，超过阈值的折叠（折叠是可见的，不会让人以为丢了行）', () => {
    expect(gatewayCardExpanded(small)).toBe(true)
    expect(gatewayCardExpanded(huge)).toBe(false)
    expect(gatewayCardExpanded({ counts: { total: GATEWAY_CARD_AUTOCOLLAPSE_AT } })).toBe(true)
  })

  it('★ 用户点过之后以用户为准（两个方向都要生效）', () => {
    expect(gatewayCardExpanded(huge, { toggled: true })).toBe(true)
    expect(gatewayCardExpanded(small, { toggled: false })).toBe(false)
  })

  it('★ 有搜索词时一律展开 —— 否则搜到的结果藏在折叠卡里，用户以为「搜不到」', () => {
    expect(gatewayCardExpanded(huge, { searching: true })).toBe(true)
    // ⚠️ 但用户**显式折叠过**的仍要听用户的（优先级：点过 > 搜索 > 默认）。
    expect(gatewayCardExpanded(huge, { toggled: false, searching: true })).toBe(false)
  })

  it('脏输入退化为展开（宁可多显示，也不要藏起来）', () => {
    expect(gatewayCardExpanded(null)).toBe(true)
    expect(gatewayCardExpanded({})).toBe(true)
  })
})
