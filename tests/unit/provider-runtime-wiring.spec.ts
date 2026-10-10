/**
 * ⚠️ **能力注册表的接线**：`src/index.ts` 真的把 13 个 auth 接到了**对的** provider id 上。
 *
 * ## 与 `jet-hub-rpc-auth-wiring.spec.ts` 的分工（**别把两者合并**）
 *
 * 本 Task（Task 2）之后，`account.refresh` 的分派走的是 `registerJetHubRpc` 的
 * **`auths` 形参**（`authOf(auths, entry.provider)`），**不是**全局注册表。
 * 因此两处接线是**两件不同的事**，各有一条防线：
 *
 * | 接线 | 守卫文件 | 走什么路径 |
 * |---|---|---|
 * | `auths` 命名对象（`registerJetHubRpc` 的实参） | `jet-hub-rpc-auth-wiring.spec.ts` | 真跑 `apply()` + `account.refresh` |
 * | 能力注册表（`provider-runtime.ts` 的 Map） | **本文件** | 真跑 `apply()` + `runtimeOf(id).auth.refreshAccount` |
 *
 * ⚠️ 本文件**不是**「重复的守卫」：它覆盖的代码段（`src/index.ts` 的注册块）
 * 在 `jet-hub-rpc-auth-wiring.spec.ts` 里**零覆盖** —— 把那段的
 * `['qodercn', qoderCn]` 改成 `['qodercn', qoder]`，那一整个文件照样全绿。
 * 反之亦然。已做反向验证（见 Task 2 报告 Step 8）。
 *
 * ## 为什么注册表也要有行为守卫
 *
 * 注册表的消费点是**拿不到 `auths` 形参**的跨模块场景（Task 5 的
 * `aggregate-expiry.ts`、Task 8 的 `account-probe.ts`）。它同样会「某个 id 接错
 * 实例」—— 而症状是「中国版账号在用国际版凭据续期」这类**历史复发 6 次**的形态。
 * 表里写错一行不会有任何编译错误（两个值类型相同），故必须有行为用例。
 *
 * ## 断言方式：跑**真实 `apply()`**，逐个比对**实例身份**
 *
 * 每个 auth 都由基类构造函数 `ctx.provide('<productId>Auth', this)` 暴露，
 * 故可以从 `apply()` 建出来的 ctx 上**取回真实例**，再断言
 * `runtimeOf(id).auth` 分派到的就是它。
 *
 * ⚠️ 这比「表里写的是哪个变量名」强：它同时覆盖
 * ①表漏了一行（该 id 取不到 runtime）、②表把两个 id 接到同一个实例、
 * ③`apply()` 里注册代码块的位置错了（比如放在实例创建之前）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index.js'
import { clearProviderRuntimes, registeredRuntimeIds, runtimeOf } from '../../src/provider-runtime.js'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'

/**
 * 13 个**可续期** provider → 它在 `ctx` 上的服务名。
 *
 * ⚠️ 两个易错点：
 * - `codearts` 的服务名是 `codeartsAuth`，但 `src/index.ts` 里的**变量名**是 `service`；
 * - `qodercn` 的服务名是 **`qodercnAuth`** —— 服务名由 `${product.id}Auth`
 *   派生，而该 id 刻意不带连字符（见 `qoder-product.ts`）。
 *
 * ⚠️ **本表是实测出来的，不是从注释推出来的**：`AGENTS.md` 与 `src/index.ts`
 * 的注释都写作 `qoderCnAuth`（驼峰），那是**错的**。本文件用真跑 `apply()` 的
 * 探针逐个取回验证过：`ctx.qoderCnAuth` 是 `undefined`，真实名是 `ctx.qodercnAuth`。
 * 该注释的错法正是本文件存在的理由：**服务名不可凭注释推断**。
 */
const AUTH_SERVICE_OF: ReadonlyArray<readonly [string, string]> = [
  ['codearts', 'codeartsAuth'],
  ['buddy', 'buddyAuth'],
  ['workbuddy', 'workbuddyAuth'],
  ['lobsterai', 'lobsteraiAuth'],
  ['qoder', 'qoderAuth'],
  ['qodercn', 'qodercnAuth'],
  ['trae', 'traeAuth'],
  ['cline', 'clineAuth'],
  ['loomy', 'loomyAuth'],
  ['raccoon', 'raccoonAuth'],
  ['minimax', 'minimaxAuth'],
  ['zcode', 'zcodeAuth'],
  ['gemini', 'geminiAuth'],
]

/**
 * 跑一次**真实 `apply()`**。
 *
 * ⚠️ **必须先清空注册表**：`provider-runtime.ts` 的 Map 是**模块级**的，而
 * `apply()` 每次调用都会建**一批新的** auth 实例。若不清空，第二次 `apply()`
 * 的注册会因「保留先注册者」被全部跳过，`runtimeOf()` 指向的是**上一个 ctx**
 * 的实例 —— 断言会以一条**看起来莫名其妙**的方式失败。
 */
function applyOnce(): Context {
  clearProviderRuntimes()
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', new FakeCommands() as never)
  ctx.provide('llm', new FakeLlm() as never)
  ctx.provide('settings', new FakeSettings() as never)
  apply(ctx)
  return ctx
}

class FakeCredentials {
  async resolve(): Promise<undefined> { return undefined }
  async describe() { return { configured: false, writable: true } }
  async set(): Promise<void> {}
  async unset(): Promise<void> {}
}
class FakeCommands {
  register() { return () => {} }
}
class FakeLlm {
  registerConfigurableProviders() { return { replace: () => {} } }
  registerAdapter() { return { replace: () => {} } }
  async listModels(): Promise<never[]> { return [] }
}
class FakeSettings {
  register(): void {}
  describe(): Array<{ ns: string }> { return [] }
}

afterEach(() => { clearProviderRuntimes() })

describe('★ index.ts 的能力注册表接线（行为断言，替代源码文本断言）', () => {
  /**
   * ★★ **本文件的核心**：逐个 provider 驱动注册表里的续期入口，
   * 断言**恰好它自己那个**服务实例被调用。
   *
   * ⚠️ **必须逐个真调一次**才算证明身份：`runtime.auth.refreshAccount` 是
   *    `index.ts` 里包的闭包，**无法与 ctx 上的实例直接 `toBe` 比较**
   *   （闭包每次 apply 都是新的）。故做法是：给 13 个服务各装一个 spy，
   *    调**某一个** id 的 `refreshAccount`，断言**恰好**它自己的服务被调到。
   *
   * ⚠️ 这一步是**不可替代**的：只断言「refreshAccount 是函数」的版本
   *    在 `['qodercn', qoder]` 错位下**照样全绿** —— 那是同义反复。
   */
  it('13 个 auth 逐个接到**自己那个** provider id 上（错位即红，且点名是哪个）', async () => {
    const ctx = applyOnce()

    const spies = new Map<string, ReturnType<typeof vi.spyOn>>()
    for (const [provider, serviceName] of AUTH_SERVICE_OF) {
      const service = (ctx as unknown as Record<string, unknown>)[serviceName]
      expect(service, `ctx.${serviceName} 不存在：auth 服务未注册`).toBeDefined()
      spies.set(
        provider,
        vi.spyOn(service as never, 'refreshAccountCredential' as never).mockResolvedValue(undefined as never),
      )
    }

    for (const [provider] of AUTH_SERVICE_OF) {
      const runtime = runtimeOf(provider)
      expect(runtime, `provider "${provider}" 未注册到能力注册表`).toBeDefined()
      expect(runtime?.auth, `provider "${provider}" 没有 auth 域`).toBeDefined()

      for (const spy of spies.values()) spy.mockClear()
      // 传 ref / pool / id 三个实参：本用例只关心**哪个实例**被调到。
      await runtime!.auth!.refreshAccount(`${provider.toUpperCase()}_ACCOUNT_X`, {} as never, 'x-1')

      // ⚠️ 核心断言：**恰好一个**服务被调到，且就是它自己那个。
      const called = [...spies.entries()].filter(([, spy]) => spy.mock.calls.length > 0)
      expect(
        called.map(([id]) => id),
        `provider "${provider}" 的续期没有分派到它自己的实例` +
        `（实际调到了：${called.map(([id]) => id).join(',') || '无'}）`,
      ).toEqual([provider])
    }
  })

  it('两站账号各刷各的（用真实 apply() 的实例，驱动注册表）', async () => {
    // ⚠️ 这条与上面那条**互补**：那条逐个 provider 断言「只有自己」，
    //    这条专打**同族串接**这个历史复发 6 次的形态，且同时断言
    //    「国际版那次没碰中国版」（上面的循环只断言「恰好一个」，
    //    若两个键**互换**值，上面那条会报 qoder 与 qodercn 都错，
    //    本条则把「CN 串到国际版」这个方向单独点名）。
    const ctx = applyOnce()
    const intl = ctx.qoderAuth as unknown as { refreshAccountCredential: unknown }
    const cn = ctx.qodercnAuth as unknown as { refreshAccountCredential: unknown }
    const intlSpy = vi.spyOn(intl as never, 'refreshAccountCredential' as never)
    const cnSpy = vi.spyOn(cn as never, 'refreshAccountCredential' as never)

    const runtime = runtimeOf('qodercn')
    expect(runtime?.auth).toBeDefined()
    // 传一个不会被解析到的 ref：`refreshAccountCredential` 会因凭据不存在而抛错，
    // 但**「哪个实例被调用」**这件事已经发生，正是本条要断言的。
    await runtime!.auth!.refreshAccount('QODERCN_ACCOUNT_SPEC', {} as never, 'cn-1')
      .catch(() => {})

    expect(cnSpy, '中国版账号没有分派到 qodercnAuth').toHaveBeenCalledTimes(1)
    expect(intlSpy, '中国版账号串到了国际版 qoderAuth').not.toHaveBeenCalled()
  })

  it('注册表覆盖 13 个可续期 provider，且**不含** opencode / aggregate / auto', () => {
    applyOnce()
    const ids = registeredRuntimeIds().sort()
    expect(ids).toEqual(AUTH_SERVICE_OF.map(([id]) => id).sort())
    // opencode 凭据是静态 API key，没有续期概念 ⇒ 刻意不注册（见设计文档 §3.3）。
    expect(ids).not.toContain('opencode')
    // aggregate / auto 是虚拟 provider，无账号无凭据。
    expect(ids).not.toContain('aggregate')
    expect(ids).not.toContain('auto')
  })

  /**
   * ⚠️ **本条的证明力来自「引用同一性」**：`descriptorOf(id)` 返回的是
   * `PROVIDER_REGISTRY` 里那个**冻结的同一个对象**。断言 `toBe` 而不是
   * `toEqual`，故它同时证明「注册段没有另造一份 descriptor」——
   * 那正是「改 registry 不生效」这类静默失效的形态（Task 1b 的主题）。
   */
  it('每个注册项都带**同源**的 descriptor（消费方无需二次查 registry）', () => {
    applyOnce()
    for (const [provider] of AUTH_SERVICE_OF) {
      const runtime = runtimeOf(provider)
      expect(runtime?.descriptor, provider).toBe(descriptorOf(provider))
    }
  })

  /**
   * ⚠️ 这条守的是**生产**语义，不是测试便利：宿主重启插件 fiber 时新 apply 与
   * 旧 dispose 交错，第二次注册必然发生。抛错会让整个插件加载失败
   *（`llm-register-compat.ts` 模块头记录的实测事故）。
   *
   * ⚠️ **不清空注册表**地再跑一次 `apply()`：这正是竞态的形状 ——
   *    `applyOnce()` 会先 clear，那就不叫重复注册了。
   */
  it('重复 apply() 不抛错（fiber 重启竞态：保留先注册者、跳过本次）', () => {
    const first = applyOnce()
    const firstBuddy = first.buddyAuth
    expect(firstBuddy).toBeDefined()
    expect(runtimeOf('buddy')?.auth).toBeDefined()

    // 第二个 ctx 同样要备齐服务替身，否则抛的是
    // `Cannot read properties of undefined (reading 'registerAdapter')`
    //（与注册表无关的另一类失败），会把这条用例变成**测不到目标**的假绿。
    const second = new Context()
    second.provide('credentials', new FakeCredentials() as never)
    second.provide('commands', new FakeCommands() as never)
    second.provide('llm', new FakeLlm() as never)
    second.provide('settings', new FakeSettings() as never)
    expect(() => apply(second)).not.toThrow()

    // ⚠️ 保留的是**先注册者**（第一个 ctx 的实例），不是后来者 ——
    //    这正是「先注册者静默失效」不会发生的那一半证据。
    expect(runtimeOf('buddy')?.descriptor).toBe(descriptorOf('buddy'))
    expect(second.buddyAuth).not.toBe(firstBuddy)
    // 第二次 apply 的实例**确实**建出来了（否则上面那条 `not.toBe` 是同义反复）。
    expect(second.buddyAuth).toBeDefined()
  })

  /**
   * ⚠️ `src/index.ts` 对缺失声明只记 `warn` 并 `continue`（不抛错），
   * 故「清单里写了一个 registry 没有的 id」会**静默少一个 provider**。
   * 这条把它变成红的。
   */
  it('注册清单里的每个 id 都在 registry 里有声明（防清单与 registry 漂移）', () => {
    applyOnce()
    const declared = new Set(PROVIDER_REGISTRY.map((d) => d.id))
    for (const [provider] of AUTH_SERVICE_OF) {
      expect(declared.has(provider), `registry 缺少声明：${provider}`).toBe(true)
    }
    // 反方向：registry 里**该有 auth 服务**的 provider 一个都不能漏进注册表。
    //
    // ⚠️ 判据用 `channel`（「有没有账号 / 凭据 / 积分」）**减去一个显式豁免**，
    //    而**不用** `settingsNamespace`：那个字段虽然恰好能筛出同样 13 个 id，
    //    但它是**巧合而非语义**（它表示老契约 settings namespace；opencode 恰好
    //    是唯一没有它的 `channel` provider）—— 本仓库 AGENTS.md 明确反对用
    //    巧合字段推断语义（原话见 `jet-hub-rpc-auth-wiring.spec.ts` 的
    //    `AUTH_EXEMPT` 注释）。用巧合字段的代价是：哪天给 opencode 补一个
    //    namespace，这条会**静默**把 opencode 算进「该注册」而红得莫名其妙。
    //
    // ⚠️ 豁免**只有** opencode 一个，且理由与上面三条 `not.toContain` **不同**：
    //    那三条断言「注册表里没有它」，这条断言「它**本来就不该有**」——
    //    前者可能因为清单漏写而通过，后者才把「漏写」变成红的。
    const shouldRegister = PROVIDER_REGISTRY
      .filter((d) => d.channel && d.id !== 'opencode')
      .map((d) => d.id)
      .sort()
    expect(shouldRegister, 'channel 集合变了，请复核 opencode 豁免是否仍成立').toHaveLength(13)
    expect(
      registeredRuntimeIds().sort(),
      'registry 里有账号的 provider 必须都注册进能力注册表（左侧多出 = 清单里多了僵尸项，' +
      '右侧多出 = registry 里有而清单漏登记）',
    ).toEqual(shouldRegister)
  })
})
