import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountOpenAiGateway } from '../../src/openai-gateway/index.js'
import { disposeGatewayRuntime } from '../../src/openai-gateway/runtime.js'

/**
 * 网关的插件接线（`src/index.ts` 的 `mountOpenAiGateway(ctx)` 一行）的回归锁。
 *
 * 核心约束（对应 P0 缺陷）：网关是**插件的旁路功能**，它的任何初始化失败
 * （端口 env 写错、DSH home 不可写、key 生成失败……）都**只允许**降级为
 * 一条日志，绝不允许把异常抛回 `apply()`——那会让整个 `codearts-auth`
 * 插件加载失败，12 个 provider 的登录/积分/模型全部不可用。
 */

interface FakeContext {
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }
  llm: unknown
  effect(fn: () => unknown, name?: string): unknown
  /**
   * ⚠️ 必须提供：`mountOpenAiGateway()` 会经 `ctx.get('attachments')` 桥接附件服务
   * （见 `makeGatewayAttachmentBridge`）。**缺了它整条启动链会在这一步抛**
   * —— 而那条抛错被刻意 catch 成一条日志（网关是旁路功能），于是用例会
   * 「通过」但**从未真的启动过网关**：任何「host/端口真的生效了吗」的断言都
   * 得不到验证（本文件新增的 IKL7UN 用例正是这么发现的）。
   */
  get(name: string): unknown
}

function makeContext(): { ctx: FakeContext; cleanups: Array<() => unknown>; logs: string[] } {
  const cleanups: Array<() => unknown> = []
  const logs: string[] = []
  const ctx: FakeContext = {
    logger: {
      info: (m) => { logs.push(`info:${m}`) },
      warn: (m) => { logs.push(`warn:${m}`) },
      error: (m) => { logs.push(`error:${m}`) },
    },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      stream: () => { throw new Error('not used in wiring tests') },
    },
    // 附件服务缺失：网关的文本能力不受影响（这是真实支持的降级路径）。
    get: () => undefined,
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  return { ctx, cleanups, logs }
}

const ENV_KEYS = [
  'DSH_OPENAI_GATEWAY_PORT',
  'DSH_OPENAI_GATEWAY_HOST',
  'DSH_OPENAI_GATEWAY_API_KEY',
  'DSH_OPENAI_GATEWAY_ENABLED',
  'DSH_JET_HUB_STATE_DIR',
] as const
let saved: Record<string, string | undefined>
let home: string

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  home = mkdtempSync(join(tmpdir(), 'dsh-gateway-wiring-'))
  process.env.DSH_JET_HUB_STATE_DIR = home
  process.env.DSH_OPENAI_GATEWAY_API_KEY = 'wiring-test-key'
  delete process.env.DSH_OPENAI_GATEWAY_PORT
  delete process.env.DSH_OPENAI_GATEWAY_HOST
  delete process.env.DSH_OPENAI_GATEWAY_ENABLED
})

afterEach(async () => {
  // runtime 是模块级单例：必须复位，否则一个用例启动的 server 会漏给下一个。
  await disposeGatewayRuntime()
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
})

/** 让出若干个微任务轮次，等 `applyGatewayDesiredState()` 这条异步链走完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('网关的插件接线', () => {
  it('端口环境变量非法时不得把异常抛回插件 apply()', async () => {
    const { ctx, logs } = makeContext()
    process.env.DSH_OPENAI_GATEWAY_PORT = 'abc'

    expect(() => mountOpenAiGateway(ctx)).not.toThrow()
    await settle()
    expect(logs.some((line) => line.startsWith('error:'))).toBe(true)
  })

  it('DSH home 不可写时不得把异常抛回插件 apply()', async () => {
    const { ctx, logs } = makeContext()
    delete process.env.DSH_OPENAI_GATEWAY_API_KEY
    // 让 home 指向一个「已存在但不是目录」的路径，其下的 mkdir 必然失败。
    process.env.DSH_JET_HUB_STATE_DIR = join(home, 'not-a-dir')
    writeFileSync(join(home, 'not-a-dir'), 'file, not a directory')

    expect(() => mountOpenAiGateway(ctx)).not.toThrow()
    await settle()
    expect(logs.some((line) => line.startsWith('error:'))).toBe(true)
  })

  it('正常启动时注册恰好一个清理回调（apply() 只创建一次网关）', () => {
    const { ctx, cleanups } = makeContext()

    mountOpenAiGateway(ctx)

    expect(cleanups).toHaveLength(1)
  })

  it('env 显式停用时不启动网关，且必须留痕（否则用户无法排障）', async () => {
    const { ctx, logs } = makeContext()
    process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'

    mountOpenAiGateway(ctx)
    await settle()

    const { isGatewayRunning } = await import('../../src/openai-gateway/runtime.js')
    expect(isGatewayRunning()).toBe(false)
    expect(logs.some((line) => line.includes('DSH_OPENAI_GATEWAY_ENABLED'))).toBe(true)
  })

  it('持久化开关为关闭时不启动网关（设置页的期望状态优先于默认）', async () => {
    const { ctx } = makeContext()

    mountOpenAiGateway(ctx, { gatewayEnabled: () => false })
    await settle()

    const { isGatewayRunning } = await import('../../src/openai-gateway/runtime.js')
    expect(isGatewayRunning()).toBe(false)
  })

  it('env 停用优先于持久化开关：显式停用就是停用', async () => {
    const { ctx } = makeContext()
    process.env.DSH_OPENAI_GATEWAY_ENABLED = 'off'

    mountOpenAiGateway(ctx, { gatewayEnabled: () => true })
    await settle()

    const { isGatewayRunning } = await import('../../src/openai-gateway/runtime.js')
    expect(isGatewayRunning()).toBe(false)
  })

  /**
   * Issue IKL7UN 的**接线**锁：host 必须从 env 一路走到内核绑定的网卡上。
   *
   * ⚠️ 与 `openai-gateway-host-binding.spec.ts` 的分工：那里直接调
   * `createOpenAiGateway()`（验证 server 用了 host），这里走**插件真实入口**
   * `mountOpenAiGateway()` + 模块级 runtime 单例（验证 env → 配置 → 工厂 → start
   * 这条链没断）。少了这一层，「工厂里把 host 丢掉」这种改动不会被发现。
   */
  it('★ DSH_OPENAI_GATEWAY_HOST 经插件入口生效，且反映在 gatewayAddress() 上', async () => {
    const { ctx } = makeContext()
    // 127.0.0.2 是 Linux/macOS/Windows 上都存在的另一个回环地址（实测可绑），
    // 用它就不必占用真实网卡，也不会与「只绑 127.0.0.1」的实现混淆。
    process.env.DSH_OPENAI_GATEWAY_HOST = '127.0.0.2'

    mountOpenAiGateway(ctx)
    await settle()

    const { isGatewayRunning, gatewayAddress } = await import('../../src/openai-gateway/runtime.js')
    expect(isGatewayRunning()).toBe(true)
    expect(gatewayAddress()?.host).toBe('127.0.0.2')
    // 端口是 OS 分配的（未指定 PORT），只锁它是个合法端口号。
    expect(gatewayAddress()?.port).toBeGreaterThan(0)
  })

  it('★ 非法 host（通配地址）只降级为日志，绝不抛回 apply()', async () => {
    const { ctx, logs } = makeContext()
    process.env.DSH_OPENAI_GATEWAY_HOST = '0.0.0.0'

    // 与端口非法同一条契约：网关是旁路功能，它配错不能拖垮整个插件。
    expect(() => mountOpenAiGateway(ctx)).not.toThrow()
    await settle()

    const { isGatewayRunning } = await import('../../src/openai-gateway/runtime.js')
    expect(isGatewayRunning()).toBe(false)
    const text = logs.join('\n')
    expect(text).toContain('DSH_OPENAI_GATEWAY_HOST')
    // ⚠️ 日志必须说明「未启动」而不是只留一句环境变量名 —— 用户要能据此知道
    // 网关没在跑（否则会以为只是没生效而反复重启）。
    expect(text).toContain('未启动')
  })
})
