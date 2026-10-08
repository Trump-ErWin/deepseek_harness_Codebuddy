import { describe, expect, it } from 'vitest'
import {
  ALL_LOOMY_PRODUCTS, LOOMY, LOOMY_CONTEXT_WINDOW_OVERRIDES, loomyContextWindow, loomyProductById,
} from '../../src/loomy-product.js'

describe('Loomy 产品配置', () => {
  it('provider id 与展示名', () => {
    expect(LOOMY.id).toBe('loomy')
    expect(LOOMY.displayName).toBe('Loomy (讯飞)')
  })

  /**
   * ⚠️ 生产域名是 `loomyad.xunfei.cn`，**不是** `ossptest.voicecloud.cn`。
   * 后者只是 `points-config.js:16` 的代码兜底默认值（本机 points-config.json
   * 里存的正是这个误导值），实际被 `.env.prod` 覆盖。
   * 依据：`share/share-env.js:4-25` 把生产与集成两者并列写明。
   */
  it('base URL 用生产域名（不是 ossptest 测试域名）', () => {
    expect(LOOMY.apiBase).toBe('https://loomyad.xunfei.cn/api/v1')
    expect(LOOMY.accountBase).toBe('https://account.xfinfr.com')
    expect(LOOMY.apiBase).not.toContain('ossptest')
  })

  it('内置讯飞账号 AccessKey 与 appId 非空', () => {
    expect(LOOMY.accessKeyId.length).toBeGreaterThan(0)
    expect(LOOMY.accessKeySecret.length).toBeGreaterThan(0)
    expect(LOOMY.appId).toBe('GM3LOOMY')
  })

  it('默认凭据 ref 与其它 provider 隔离', () => {
    expect(LOOMY.defaultCredentialRef).toBe('LOOMY_ACCESS_TOKEN')
  })

  it('兜底模型表覆盖 8 个 chat 模型、id 唯一', () => {
    const ids = LOOMY.fallbackModels.map((m) => m.id)
    expect(ids).toHaveLength(8)
    expect(new Set(ids).size).toBe(8)
    // 与实测远端 chat 集合逐一对齐
    expect([...ids].sort()).toEqual([
      'GLM-5.3-Flash', 'Kimi-k2.6', 'MiniMax-M3', 'deepseek-v4-flash-0731',
      'mimo-v2.5', 'qwen-3.8-max', 'qwen3.8-flash', 'spark-x',
    ].sort())
  })

  it('兜底模型名已含规范化倍率（用 · 分隔）', () => {
    const byId = new Map(LOOMY.fallbackModels.map((m) => [m.id, m.name]))
    expect(byId.get('MiniMax-M3')).toBe('MiniMax M3 · x4.0')
    expect(byId.get('qwen-3.8-max')).toBe('Qwen 3.8 Max · x12.0')
    expect(byId.get('spark-x')).toBe('Spark X2.5 · x0.1')
  })

  it('loomyProductById 能查到，未知 id 返回 undefined', () => {
    expect(loomyProductById('loomy')).toBe(LOOMY)
    expect(loomyProductById('nope')).toBeUndefined()
  })

  it('ALL_LOOMY_PRODUCTS 含且仅含 LOOMY', () => {
    expect(ALL_LOOMY_PRODUCTS).toEqual([LOOMY])
  })

  /**
   * ★ 上下文窗口覆盖表（Gitee issue IKJW31）。
   *
   * 远端对 `spark-x` 虚报 1048576，真实墙 262144 ⇒ 长会话被截断。
   * 这一组锁死三条：覆盖生效、判据不被调用方的值左右、未验证条目不进表。
   */
  it('★ 覆盖表把 spark-x 钉在真实的 262144（远端声明的是 1048576）', () => {
    expect(LOOMY_CONTEXT_WINDOW_OVERRIDES['spark-x']).toBe(262_144)
    expect(loomyContextWindow('spark-x', 1_048_576)).toBe(262_144)
  })

  it('覆盖表只含**有证据**的条目，且值都是安全正整数', () => {
    // ⚠️ 别为了「看起来统一」把整表填进来：每条都必须有独立证据
    //（上游墙位 / 官方客户端本地表），否则就是拿猜测覆盖远端事实。
    expect(Object.keys(LOOMY_CONTEXT_WINDOW_OVERRIDES)).toEqual(['spark-x'])
    for (const [id, value] of Object.entries(LOOMY_CONTEXT_WINDOW_OVERRIDES)) {
      expect(Number.isSafeInteger(value), id).toBe(true)
      expect(value, id).toBeGreaterThan(0)
    }
  })

  it('⚠️ 兜底表的值与覆盖表一致（两条路径不得分叉）', () => {
    for (const model of LOOMY.fallbackModels) {
      const override = LOOMY_CONTEXT_WINDOW_OVERRIDES[model.id]
      if (override === undefined) continue
      expect(model.contextWindow, `${model.id} 兜底表未按覆盖表修正`).toBe(override)
    }
  })
})
