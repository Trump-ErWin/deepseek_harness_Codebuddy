import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveGatewayConfig } from '../../src/openai-gateway/config.js'
import { loadOrCreateApiKey } from '../../src/openai-gateway/auth.js'

describe('OpenAI gateway config', () => {
  it('uses localhost and port 8326 by default', () => {
    expect(resolveGatewayConfig({})).toEqual({ host: '127.0.0.1', port: 8326 })
  })

  it('accepts a valid port override', () => {
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_PORT: '9382' }).port).toBe(9382)
  })

  it('rejects an invalid port override', () => {
    expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_PORT: '0' })).toThrow(/port/i)
  })

  /**
   * Issue IKL7UN：容器化部署下 host 硬编码 `127.0.0.1` 使端口映射**永不可达**
   * （容器内回环可达是假象，docker-proxy 走的是容器桥接 IP）。
   *
   * ⚠️ 默认值必须逐字节不变 —— 这是「不设置就与现在完全一致」的前提，
   * 否则本修复本身会变成一次行为变更。
   */
  it('★ 未设置 host 环境变量时默认仍是 127.0.0.1（行为零变化）', () => {
    expect(resolveGatewayConfig({}).host).toBe('127.0.0.1')
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_PORT: '9382' }).host).toBe('127.0.0.1')
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '' }).host).toBe('127.0.0.1')
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '   ' }).host).toBe('127.0.0.1')
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '127.0.0.1' }).host).toBe('127.0.0.1')
  })

  it('★ 接受具体的接口地址（容器桥接 IP / 其它回环地址），host 与 port 各自独立', () => {
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '172.21.0.8' }))
      .toEqual({ host: '172.21.0.8', port: 8326 })
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '127.0.0.2', DSH_OPENAI_GATEWAY_PORT: '9382' }))
      .toEqual({ host: '127.0.0.2', port: 9382 })
    // IPv6 具体地址：方括号是 URL 记法，**不是** listen() 的入参形态，必须剥掉。
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '::1' }).host).toBe('::1')
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '[::1]' }).host).toBe('::1')
    // 两端空白不应成为一个必然 EADDRNOTAVAIL 的 host。
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '  172.21.0.8  ' }).host).toBe('172.21.0.8')
  })

  /**
   * ⚠️ 通配地址必须**显式拒绝**，而不是静默监听全部网卡。
   *
   * 两层理由：
   * 1. README 的安全边界写着「只绑定 127.0.0.1，**不可**改成对外地址」；
   * 2. dsh 本体对 `--host 0.0.0.0` 也是硬拒绝（`dsh-web-app` 的 startup：
   *    `--host 0.0.0.0 is intentionally not supported yet for safety`）。
   *    两处姿态必须一致，否则用户会以为「Web 拒绝、网关允许」是有意的放宽。
   *
   * 判据用**URL 规范化**而不是比较字面量：`0` / `0x0` / `::0` / `0:0:0:0:0:0:0:0`
   * 在 Linux（issue 的容器场景）上都会落到同一张网卡上。
   */
  it('★ 拒绝通配地址：写出各种等价写法都不许静默监听全部网卡', () => {
    const wildcards = [
      '0.0.0.0',
      '::',
      '0:0:0:0:0:0:0:0',
      '0000:0000:0000:0000:0000:0000:0000:0000',
      '0::',
      '::0',
      '::ffff:0.0.0.0',
      '::ffff:0:0',
      '[::]',
      '[0:0:0:0:0:0:0:0]',
      '0',
      '0x0',
      '0.0',
      '0.0.0',
      '00.0.0.0',
      '0.0.0.0.',
    ]
    for (const host of wildcards) {
      expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: host }), host).toThrow(/DSH_OPENAI_GATEWAY_HOST/)
    }
  })

  it('★ 报错必须给出可操作的替代做法（否则用户只会去搜「怎么关掉这个校验」）', () => {
    let message = ''
    try {
      resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '0.0.0.0' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // ① 必须点名 env 本身，用户才知道要改哪个变量；
    expect(message).toContain('DSH_OPENAI_GATEWAY_HOST')
    // ② 必须给出做法（绑具体接口地址），而不是只说「不允许」；
    expect(message).toMatch(/具体|接口地址|hostname/)
    // ③ 容器场景正是本 issue 的来由，提示里必须能让人联想到它。
    expect(message).toMatch(/容器|桥接|eth0/i)
  })

  /**
   * ⚠️ 通配判据**不得误伤**具体地址 —— 假阴性会让「绑容器 IP」这个正解被拒。
   * 这批是本 issue 报告者真实要用的形态，逐条锁住。
   */
  it('★ 通配判据不得误伤具体地址', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '172.21.0.8', '::1', 'fe80::1', 'localhost', 'host.docker.internal']) {
      expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: host }).host, host).toBe(host)
    }
  })

  it('prefers the environment API key', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gateway-auth-'))
    // 返回结构而非裸字符串：设置页要据此显示「来自环境变量」并隐藏文件路径。
    const source = loadOrCreateApiKey(home, { DSH_OPENAI_GATEWAY_API_KEY: 'env-secret' })
    expect(source.value).toBe('env-secret')
    expect(source.fromEnv).toBe(true)
    expect(source.path).toBeNull()
  })

  it('generates and persists a key when the environment is empty', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gateway-auth-'))
    const first = loadOrCreateApiKey(home, {}).value
    const second = loadOrCreateApiKey(home, {}).value
    expect(first).toHaveLength(43)
    expect(second).toBe(first)
    expect(readFileSync(join(home, 'openai-gateway', 'api-key'), 'utf8')).toBe(first)
  })
})
