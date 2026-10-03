/**
 * 回归：**全部启用账号都被目标模型限流**时，必须报「限流 + 解禁时刻」，
 * 而不是误导性的 `no usable credential; log in from the Jet Hub panel first`。
 *
 * ## 原始症状（真实缺陷，2026-10-03）
 *
 * 用户 `/compact` 连续四次失败，UI 只显示通用文案
 * 「Compaction could not produce a useful summary」；解出会话日志后发现
 * `compaction/end` 携带的真实错误是
 * `buddy: no usable credential; log in from the Jet Hub panel first`。
 *
 * 而当时 Jet Hub 里 buddy 账号**已登录、已启用**，凭据完全可用 —— 真实原因
 * 是它被 `deepseek-v4.1-flash` 的模型级限流标记挡住（解禁时刻就存在
 * `modelRateLimits` 里，插件却一个字都没往外报）。用户被指去「重新登录」，
 * 方向完全错。
 *
 * ## 链路
 *
 * 唯一启用账号被限流 → `pickBuddyCredential` 候选筛成空集 →
 * `select()` 回笼统的 `exhausted`（未锁定时 `reason` 被丢弃）→ 退到单凭据
 * ref `BUDDY_ACCESS_TOKEN`（Jet Hub 登录只写 `*_ACCOUNT_XXX`，该 ref 不存在）
 * → 适配器抛 `MISSING_CREDENTIAL`。
 *
 * ## 与既有用例的关系
 *
 * 与 `buddy-wiring.spec.ts` / `buddy-free-model-lock.spec.ts` 同款：既做
 * **行为级**验证（判据必须对），也做**源码级**接线断言（接线不能断）。
 * 后者刻意用「剥注释后的源码」判定，避免因注释里提到某符号而误判。
 *
 * ⚠️ 本补丁**只改错误语义，不改可用性**：没有账号可用就是没有，压缩该失败
 * 仍然失败。因此用例同时锁死「不绕过限流标记」「不静默换模型」两条红线。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { allAccountsRateLimitedForModel } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')
const poolSource = readFileSync(resolve(here, '../../src/account-pool.ts'), 'utf8').replace(/\r\n/g, '\n')

/** 剥掉注释后的源码。⚠️ 接线断言必须只看代码，不能因「注释里提到某符号」而误判。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const indexCode = codeOnly(indexSource)
const poolCode = codeOnly(poolSource)

const NOW = 1_791_009_000_000

/** 构造一个启用账号，可带某模型的限流时刻。 */
function account(
  id: string,
  modelRateLimits?: Record<string, number>,
  enabled = true,
): ProviderAccountEntry {
  return {
    id,
    provider: 'buddy',
    nickname: id,
    enabled,
    credentialRef: `BUDDY_ACCOUNT_${id.toUpperCase()}`,
    createdAt: 0,
    refreshable: true,
    ...modelRateLimits === undefined ? {} : { modelRateLimits },
  }
}

describe('全部账号被模型限流时，报限流而非「未登录」', () => {
  describe('判据（行为级）', () => {
    it('唯一启用账号被该模型限流 → 命中，并给出解禁时刻', () => {
      const reset = NOW + 3_600_000
      const got = allAccountsRateLimitedForModel(
        [account('a', { 'deepseek-v4.1-flash': reset })],
        'deepseek-v4.1-flash',
        NOW,
      )
      expect(got).toEqual({ resetAtMs: reset, accountCount: 1 })
    })

    it('多个账号全被限流 → 取**最早**解禁时刻（用户最该等的那一个）', () => {
      const got = allAccountsRateLimitedForModel(
        [
          account('a', { m: NOW + 9_000_000 }),
          account('b', { m: NOW + 1_000_000 }),
          account('c', { m: NOW + 5_000_000 }),
        ],
        'm',
        NOW,
      )
      expect(got).toEqual({ resetAtMs: NOW + 1_000_000, accountCount: 3 })
    })

    it('只要有一个账号不受该模型限制，整体就不成立（候选非空，轮不到本函数）', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW + 1000 }), account('b')],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('账号限制的是**别的**模型时不算命中（限流是「账号 × 模型」维度）', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { 'other-model': NOW + 1000 })],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('解禁时刻已过（now >= resetAt）不算命中', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW })],
        'm',
        NOW,
      )).toBeUndefined()
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW - 1 })],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('resetAt 为 0 视为「不受限」（与选号侧判据一致）', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: 0 })],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('空 modelId 直接不判定 —— 否则会把「未登录」误报成「限流」', () => {
      // 选号侧约定：空 modelId 不做限流过滤（`if (modelId.length === 0) return true`）。
      // 本函数必须同口径，否则「没有传模型」这种普通情形会被误报。
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW + 1000 })],
        '',
        NOW,
      )).toBeUndefined()
    })

    it('存在 modelRateLimits[""] 脏键时，空 modelId 仍不判定（守卫不能省）', () => {
      // ⚠️ 这条才真正锁住 `modelId.length === 0` 早退：`updateModelRateLimit`
      // **不校验** modelId，理论上可落下空串键。没有该守卫时，下面这组数据会
      // 被判成「全部限流」并上报给用户（反向验证：删掉守卫 → 本用例变红）。
      expect(allAccountsRateLimitedForModel(
        [account('a', { '': NOW + 1000 })],
        '',
        NOW,
      )).toBeUndefined()
    })

    it('没有启用账号时不判定（那是「未登录」，不是「限流」）', () => {
      // ℹ️ 本条与「循环不执行 → earliest 保持 undefined」同义，属**边界说明**
      // 而非可区分的回归保护（反向验证：删掉早退守卫它照样通过）。
      // 保留是为了锁死对外行为：空列表绝不能报成「全部限流」。
      expect(allAccountsRateLimitedForModel([], 'm', NOW)).toBeUndefined()
    })
  })

  describe('接线（源码级）', () => {
    it('两个 provider 的兜底路径都插入了限流判定', () => {
      expect(indexCode).toContain('throwIfAllAccountsRateLimited(CODEBUDDY, modelId)')
      expect(indexCode).toContain('throwIfAllAccountsRateLimited(WORKBUDDY, modelId)')
    })

    it('判定必须**先于**单凭据 ref 兜底 —— 否则仍会降级成 MISSING_CREDENTIAL', () => {
      // ⚠️ 锚点必须是**真正的兜底调用**，不能只搜 ref 名：`BUDDY_CREDENTIAL_REF`
      // 在文件更早处（import 与 `credentialRef(...)` 注册）也出现过，搜名字会
      // 命中错位置（写用例时实测到：check=12308 反而大于 fallback=751）。
      const checkCallOrder = (product: string, fallbackCall: string) => {
        const check = indexCode.indexOf(`throwIfAllAccountsRateLimited(${product}, modelId)`)
        const fallback = indexCode.indexOf(fallbackCall)
        expect(check).toBeGreaterThan(-1)
        expect(fallback).toBeGreaterThan(-1)
        expect(check).toBeLessThan(fallback)
      }
      checkCallOrder('CODEBUDDY', 'ctx.credentials.resolve(credentialRef(BUDDY_CREDENTIAL_REF))')
      checkCallOrder('WORKBUDDY', 'ctx.credentials.resolve(credentialRef(WORKBUDDY.defaultCredentialRef))')
    })

    it('判定放在 getAvailableAccount 兜底**之后**（池里还有号时不该报限流）', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      expect(fnStart).toBeGreaterThan(-1)
      for (const product of ['CODEBUDDY', 'WORKBUDDY']) {
        const available = indexCode.indexOf(`getAvailableAccount(${product}.id, modelId ?? '', picked.tried)`)
        const check = indexCode.indexOf(`throwIfAllAccountsRateLimited(${product}, modelId)`)
        expect(available).toBeGreaterThan(-1)
        // 先问池 → 池也没号 → 才判限流。
        expect(available).toBeLessThan(check)
      }
    })

    it('只统计**启用**账号 —— 停用账号不参与自动选号，算进来会误报', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      expect(fnBody.slice(0, end)).toContain('.filter(a => a.enabled)')
    })

    it('抛的是 QUOTA_EXCEEDED，而不是让它继续降级成 MISSING_CREDENTIAL', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      expect(fnBody.slice(0, end)).toContain("'QUOTA_EXCEEDED'")
      expect(fnBody.slice(0, end)).toContain('new LlmError(')
    })

    it('文案里带解禁时刻与「无需重新登录」，否则用户仍会去重登', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      const block = fnBody.slice(0, end)
      expect(block).toContain('toLocaleString')
      expect(block).toContain('无需重新登录')
    })

    it('判据复用 account-pool 的纯函数，不在 index.ts 里重写一遍', () => {
      expect(indexCode).toContain('allAccountsRateLimitedForModel')
      expect(poolCode).toMatch(/export function allAccountsRateLimitedForModel\(/)
    })
  })

  describe('不削弱既有语义（回归保护）', () => {
    it('判据与选号侧同口径：缺标记 / 0 / 已过期都算不受限', () => {
      const fnStart = poolCode.indexOf('export function allAccountsRateLimitedForModel')
      expect(fnStart).toBeGreaterThan(-1)
      const body = poolCode.slice(fnStart, fnStart + 2000)
      expect(body).toContain('resetAt === undefined')
      expect(body).toContain('resetAt === 0')
      expect(body).toContain('now >= resetAt')
    })

    it('限流标记仍然照常写入 —— 本补丁只读标记，不删不改', () => {
      // 红线：绝不能让「报错更清楚」演变成「绕开限流」。写标记的路径必须原样保留。
      expect(poolCode).toContain('async updateModelRateLimit(')
      const adapterSource = readFileSync(resolve(here, '../../src/buddy-adapter.ts'), 'utf8')
      expect(adapterSource).toContain('updateModelRateLimit')
    })

    it('未命中判定时静默返回，原有的 MISSING_CREDENTIAL 路径保持可用', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      expect(fnBody.slice(0, end)).toContain('if (limited === undefined) return')
      // 单凭据兜底仍在（老数据兼容路径），只是排到判定之后。
      expect(indexCode).toContain('const resolved = await ctx.credentials.resolve')
    })
  })
})
