import { createServer, request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createOpenAiGateway } from '../../src/openai-gateway/server.js'
import { disposeGatewayRuntime } from '../../src/openai-gateway/runtime.js'
import { gatewayHttpUrl } from '../../src/openai-gateway/config.js'

/**
 * Issue IKL7UN 的**端到端**回归：`DSH_OPENAI_GATEWAY_HOST` 必须真的改变内核
 * 绑定的网卡，而不只是让 `resolveGatewayConfig()` 返回一个新字符串。
 *
 * ⚠️ 为什么必须有这一层：`config` 层的用例只证明「解析出的 host 是那个值」，
 * 一个「解析对了但 server.ts 仍写死 `listen(port, '127.0.0.1')`」的实现能让
 * 那批用例全绿 —— 而那正是本 issue 的形态（配置可改、wire 不变）。
 *
 * ⚠️ **判据必须包含阴性对照**：只断言「绑 127.0.0.2 后 127.0.0.2 可达」是不够的
 * ——绑 `0.0.0.0`（或任何绑全部网卡的实现）同样能满足它。故同时断言
 * `127.0.0.1` **连不上**（实测：绑 127.0.0.2 时 127.0.0.1 得到 ECONNREFUSED，
 * 反之亦然；两者是同一回环网段里的**不同**地址）。
 */

const ENV = (host: string, port: number) => ({
  DSH_OPENAI_GATEWAY_HOST: host,
  DSH_OPENAI_GATEWAY_PORT: String(port),
  DSH_OPENAI_GATEWAY_API_KEY: 'test-key',
})

const llm = {
  listProviders: () => [],
  listModels: async () => [],
  resolveModelInfo: async () => ({}),
  stream: () => { throw new Error('not used') },
}

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** 从指定 host 连过去，返回 'ok' 或错误码（用来观察**内核**的绑定面）。 */
function probe(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const req = request(
      { host, port, path: '/v1/models', method: 'GET', timeout: 2000 },
      (response) => {
        response.resume()
        resolve(`HTTP ${response.statusCode ?? 0}`)
      },
    )
    req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
    req.on('timeout', () => { req.destroy(); resolve('timeout') })
    req.end()
  })
}

const started: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const gateway of started.splice(0)) await gateway.close()
  await disposeGatewayRuntime()
})

describe('Issue IKL7UN：网关监听地址可配', () => {
  it('★ 绑 127.0.0.2 时该地址可达，而 127.0.0.1 连不上（阴性对照）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, home: undefined, env: ENV('127.0.0.2', port) })
    started.push(gateway)
    await gateway.start()

    expect(gateway.address()).toEqual({ host: '127.0.0.2', port })
    // 真绑上了用户指定的网卡（401 = 未带 key，说明 HTTP 往返成功）。
    expect(await probe('127.0.0.2', port)).toBe('HTTP 401')
    // ⚠️ 阴性对照：若实现改成绑全部网卡，这一条会变成 HTTP 401 ⇒ 用例失败。
    expect(await probe('127.0.0.1', port)).toBe('ECONNREFUSED')
  })

  it('★ 默认（不设 host env）仍是只绑 127.0.0.1，行为零变化', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, home: undefined, env: { DSH_OPENAI_GATEWAY_API_KEY: 'test-key', DSH_OPENAI_GATEWAY_PORT: String(port) } })
    started.push(gateway)
    await gateway.start()

    expect(gateway.address()).toEqual({ host: '127.0.0.1', port })
    expect(await probe('127.0.0.1', port)).toBe('HTTP 401')
    expect(await probe('127.0.0.2', port)).toBe('ECONNREFUSED')
  })

  it('★ 通配地址必须在 listen 之前就被拒（不能先绑上去再报错）', () => {
    // 关键：`createOpenAiGateway()` 是**同步**构造的，非法 host 在这里即抛，
    // 于是「网关被通配地址静默暴露」这件事在架构上不可能发生 ——
    // 这正是拒绝通配这条判据的价值所在（只 warn 不拦的实现在这里会绿）。
    expect(() => createOpenAiGateway({ llm, home: undefined, env: ENV('0.0.0.0', 8326) })).toThrow(/DSH_OPENAI_GATEWAY_HOST/)
  })

  it('★ 监听日志印的是完整可达 URL（IPv6 也要能抄）', async () => {
    const logs: string[] = []
    const port = await freePort()
    const gateway = createOpenAiGateway({
      llm,
      home: undefined,
      env: ENV('127.0.0.2', port),
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    })
    started.push(gateway)
    await gateway.start()

    // ⚠️ 不能是 `http://${host}:${port}` 的朴素插值：host 为 IPv6 时会拼出
    // `http://::1:8326/v1`（非法 URL，抄不走）。
    expect(logs.join('\n')).toContain(`已监听 ${gatewayHttpUrl('127.0.0.2', port, '/v1')}`)
    expect(gatewayHttpUrl('::1', 8326, '/v1')).toBe('http://[::1]:8326/v1')
  })
})
