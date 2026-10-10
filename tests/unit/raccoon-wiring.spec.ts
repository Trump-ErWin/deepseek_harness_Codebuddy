import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { descriptorOf } from '../../src/provider-registry.js'
import { jetHubAuthsCallKeys } from '../helpers/jet-hub-auths.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8')

/**
 * 源码级回归：新增 provider 的接线点一处都不能漏。
 * 历史缺陷正是「加了 provider 但忘了在 modelAdapters 里登记」→
 * 设置页里被关闭的模型显示成裸 id（丢倍率）。
 */
describe('Raccoon 在 index.ts 的接线', () => {
  it('导入并实例化 RaccoonAuth', () => {
    expect(indexSource).toContain("from './raccoon-auth.js'")
    expect(indexSource).toContain('new RaccoonAuth(ctx)')
  })

  it('注册 Raccoon 适配器并接收返回值', () => {
    expect(indexSource).toContain("from './raccoon-adapter.js'")
    expect(indexSource).toContain('registerRaccoonLlm(ctx,')
    expect(indexSource).toMatch(/const raccoonAdapter = registerRaccoonLlm/)
  })

  it('provider 解析用 RACCOON.id（不写死字面量）', () => {
    expect(indexSource).toContain("pool.getAvailableAccount(RACCOON.id, '')")
  })

  it('refresh 走 refreshAccountCredential（刷新解析凭据所用的那个账号）', () => {
    expect(indexSource).toMatch(/raccoon\.refreshAccountCredential\(/)
    expect(indexSource).toMatch(/available\.entry\.credentialRef/)
  })

  /**
   * ⚠️ **真实缺陷回归**（用户报障）：「凭据过期后显示过期，但是似乎是续期
   * 成功了还是没有真正的过期，我发送会话成功从 6300 扣分了。」
   *
   * 根因：续期成功后没把新的 `expiresAt` 写回账号池，而 Jet Hub UI 读的
   * 正是账号池。实测该账号 JWT `exp` 已是 15:09（有效）、账号池却是
   * 12:02（已过期），**相差 3.1 小时**。
   *
   * 判据：`index.ts` 的续期路径必须把 `pool` 与 `entry.id` 传下去，
   * 否则 `syncAccountExpiry` 无从回写。
   */
  it('⚠️ 续期调用必须传 pool 与 accountId（否则 UI 假过期）', () => {
    // 适配器的 refresh 回调 = 「发消息时按需续期」，最常触发的路径
    expect(
      indexSource,
      '适配器 refresh 回调必须传 pool + entry.id，否则账号池的 expiresAt 不会更新',
    ).toMatch(
      /refreshAccountCredential\(\s*available\.entry\.credentialRef,\s*pool,\s*available\.entry\.id,?\s*\)/,
    )
  })

  it('settings namespace 已声明（行为断言，2026-10-08 改）', () => {
    // ⚠️ 2026-10-08 改：原先是扫 `src/index.ts` 源码文本找 `'llm-raccoon'`。本次重构把
    //    13 个字面量收敛成从 `PROVIDER_REGISTRY` 派生，字面量搬家 ⇒ 文本断言变红。
    //    改为断言声明值；「index.ts 真的按它注册了」由
    //    `provider-registry-consumers.spec.ts` 的 `apply()` 行为用例守。
    expect(descriptorOf('raccoon')?.settingsNamespace).toBe('llm-raccoon')
  })

  it('加入批量续期调度', () => {
    // `(pool|p)`：逐个 await 与表驱动两种写法都接受，避免重构调度器时假失败。
    expect(indexSource).toMatch(/raccoon\.refreshAll\((?:pool|p)\)/)
  })

  it('modelAdapters 里登记了 raccoon', () => {
    // ⚠️ 2026-10-06 复审 !66：登记项经 `pruned(...)` 包装（否则 Jet Hub 拿到原始
    // 实例、「已失效模型」剔除对设置页不生效）。
    expect(indexSource).toMatch(/const modelAdapters[\s\S]*?raccoon: pruned\([^)]*,\s*raccoonAdapter\)/)
  })

  it('registerJetHubRpc 传入了 raccoon', () => {
    // ⚠️ 2026-10-08 改（Task 3）：原先这条是**相邻性正则**
    //    `/registerJetHubRpc\([\s\S]*?raccoon,[\s\S]*?modelAdapters\)/` ——
    //    它把「raccoon 键存在」与「该字面量在 modelAdapters 之前」用**书写顺序**
    //    Task 3 一度给 `registerJetHubRpc` 加了**第 5 个位置形参** `credits`，
    //    调用点变成 `… }, modelAdapters, creditsTable)` ⇒ 正则必然假失败。
    //    该形参随后在设计复审 C1 中被删除，但**本条的改法保留** —— 它守的意图
    //    （raccoon 的 auth 实例接上了）**与形参个数无关**。
    //    ⇒ 改为按 **AST** 取调用点第三个实参（auths 对象字面量）的键 ——
    //    重排 / 插键 / 加形参都不可能让它假失败，而**键真的漏了必然变红**。
    //    「端到端分派真的落到 raccoon 实例上」由行为用例守：
    //    `lobsterai-rpc-dispatch.spec.ts` 的「13 个 provider 逐个覆盖」。
    const authKeys = jetHubAuthsCallKeys(indexSource)
    expect(Object.keys(authKeys), 'raccoon 必须在 auths 命名对象里（键 = provider id）')
      .toContain('raccoon')
    expect(authKeys.raccoon, '`raccoon` 键的值必须是 raccoon 实例').toBe('raccoon')
  })

  it('fetchRemoteModels 委托给 RaccoonAuth.fetchModels', () => {
    const start = indexSource.indexOf('fetchRemoteModels: () => raccoon.fetchModels')
    expect(start).toBeGreaterThan(-1)
  })

  it('凭据类型标注为 RaccoonCredential（不是 any）', () => {
    expect(indexSource).toContain("from './raccoon.js'")
    expect(indexSource).toMatch(/RaccoonCredential/)
  })
})
