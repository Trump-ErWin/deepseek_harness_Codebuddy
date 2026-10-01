import { afterEach, describe, expect, it } from 'vitest'

import { startZcodeBridge, type ZcodeBridgeHandle } from '../../src/zcode-bridge.js'
import { ZCODE, type ZcodeRemoteModelLike } from '../../src/zcode-product.js'

/**
 * ⚠ **本地桥的模型目录缓存不得被兜底表污染**（审查发现的第 10 个消费点）。
 *
 * 原实现是 `remoteModels = fetched.length > 0 ? fetched : product.fallbackModels`
 * —— 一次失败就把兜底表写进缓存，此后 `/health`、`/v1/models` 以及**启动期**
 * `syncPiAiMirror` 的 `bridge.models()`（它决定镜像 route 里能选哪些模型）
 * 就**永久**停在兜底表上：用户登录 / 网络恢复后也不会更新，只能重启 DSH。
 *
 * 兜底表是纯本地、零成本现算的，没有任何理由缓存它。
 */
describe('zcode 本地桥的模型目录缓存（★ 兜底表不进缓存）', () => {
  const handles: ZcodeBridgeHandle[] = []

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.close()
  })

  async function make(
    fetchRemoteModels: () => Promise<ZcodeRemoteModelLike[]>,
  ): Promise<ZcodeBridgeHandle> {
    const handle = await startZcodeBridge({
      fetchRemoteModels,
      mintCaptcha: async () => 'captcha',
      resolveCredential: async () => undefined,
      // 目录路径不发上游请求；给个桩以免意外外连。
      fetchImpl: (async () => new Response('', { status: 500 })) as never,
    })
    handles.push(handle)
    return handle
  }

  const remote: ZcodeRemoteModelLike[] = [{
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: true,
  }]

  it('★ 首次失败 ⇒ 用兜底表，但**不**写进缓存（恢复后能重拉）', async () => {
    let calls = 0
    const handle = await make(async () => {
      calls += 1
      if (calls === 1) throw new Error('network down')
      return remote
    })

    // 第一次：上游挂 ⇒ 兜底表（界面不能空着）。
    const first = await handle.models()
    expect(first.length).toBe(ZCODE.fallbackModels.length)

    // 第二次：上游恢复 ⇒ 必须拿到**真远端**目录（旧实现这里仍是兜底表）。
    const second = await handle.models()
    expect(second.map((m) => m.id)).toEqual(['GLM-5.3-Flash'])
    expect(calls).toBe(2)
  })

  it('★ 远端返回空数组时同样不落缓存', async () => {
    let calls = 0
    const handle = await make(async () => {
      calls += 1
      return calls === 1 ? [] : remote
    })
    expect((await handle.models()).length).toBe(ZCODE.fallbackModels.length)
    expect((await handle.models()).map((m) => m.id)).toEqual(['GLM-5.3-Flash'])
  })

  it('★ 成功后被缓存（不破坏既有「成功即缓存」约定）', async () => {
    let calls = 0
    const handle = await make(async () => {
      calls += 1
      return remote
    })
    await handle.models()
    await handle.models()
    await handle.modelIds()
    expect(calls).toBe(1)
    expect(await handle.modelIds()).toEqual(['GLM-5.3-Flash'])
  })

  it('★ 桥上报的模型表会被镜像 route 采用（含窗口与档位）', async () => {
    const withReasoning: ZcodeRemoteModelLike[] = [{
      ...remote[0]!,
      reasoningLevels: ['low', 'high', 'max'],
      defaultReasoningLevel: 'max',
    }]
    const handle = await make(async () => withReasoning)
    const models = await handle.models()
    expect(models[0]?.contextWindow).toBe(1_000_000)
    expect(models[0]?.reasoningLevels).toEqual(['low', 'high', 'max'])
  })
})
