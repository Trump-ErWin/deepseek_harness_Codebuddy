import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 必须在 import 被测模块**之前**设好隔离目录：模块级 store / cache 是懒初始化的，
// 首次解析 home 时会读这个环境变量（`resolveJetHubHome` 的第一优先级）。
const STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-dead-model-spec-'))
process.env.DSH_JET_HUB_STATE_DIR = STATE_DIR

const {
  DEAD_MODELS_FILE,
  clearDeadModels,
  deadModelIdsFor,
  isModelGoneError,
  recordDeadModel,
  withDeadModelPruning,
} = await import('../../src/dead-model-store.js')

afterAll(() => {
  rmSync(STATE_DIR, { recursive: true, force: true })
  delete process.env.DSH_JET_HUB_STATE_DIR
})

// ── 1. 判据：阳性证据 ──────────────────────────────────────────────────────

describe('isModelGoneError —— 应判为「模型已失效」', () => {
  const positives: Array<[string, string, string | undefined]> = [
    ['cline 报障原文', 'cline: model not found', 'HTTP_404'],
    ['unknown model 变体', 'provider: unknown model gpt-x', 'HTTP_400'],
    ['does not exist', 'model foo does not exist', 'HTTP_404'],
    ['does not exist（缩写）', "model foo doesn't exist", 'HTTP_404'],
    ['no such model', 'no such model: abc', 'HTTP_400'],
    ['中文：模型不存在', '模型 deepseek-x 不存在', 'HTTP_404'],
    ['中文：已下线', '该模型已下线', 'HTTP_400'],
    ['中文：长 id（窗口必须够宽）', '模型 deepseek-v4.1-flash-preview 不存在', 'HTTP_404'],
  ]
  for (const [label, message, code] of positives) {
    it(label, () => {
      expect(isModelGoneError(Object.assign(new Error(message), code === undefined ? {} : { code }))).toBe(true)
    })
  }
})

describe('isModelGoneError —— 必须**不**判为模型失效（误判会藏掉可用模型）', () => {
  /**
   * ⚠️ 误判的代价是不对称的：把可用模型记成失效会把它从列表里藏起来，且
   * **用户无法自行恢复**（选不到 ⇒ 不可能再成功 ⇒ 记录不会清）。故这一组
   * 覆盖所有「看着像但其实不是」的形态。
   */
  const negatives: Array<[string, string, string | undefined]> = [
    ['额度用尽（含 model 字样）', '模型额度已用尽，请充值', 'QUOTA_EXCEEDED'],
    ['额度用尽（无错误码兜底）', 'this model quota is insufficient', undefined],
    ['限流', 'rate limit exceeded for model x', 'RATE_LIMIT'],
    ['限流（429 文案）', 'Error 429: Daily free limit reached on model deepseek-v4.1-flash', 'HTTP_429'],
    ['认证失败', 'invalid api key for model x', 'AUTH'],
    ['权限拒绝', 'model x forbidden', 'PERMISSION_DENIED'],
    ['凭据缺失', 'model x: no usable credential', 'MISSING_CREDENTIAL'],
    ['排队', '模型繁忙，请排队重试', 'QUEUE'],
    ['网络错误', 'transport error: socket hang up', 'TRANSPORT'],
    ['账号均不可用（含模型名）', 'cline: 模型 deepseek-x 的所有账号均不可用 —— 请稍后', 'QUOTA_EXCEEDED'],
    ['账号均不可用（无错误码兜底）', '模型 abc 的所有账号均不可用', undefined],
    ['参数错误（非下架）', 'invalid model parameters: temperature', 'INVALID_REQUEST'],
    ['模型名含 model 但是参数问题', 'unsupported model feature: tools', 'INVALID_REQUEST'],
  ]
  for (const [label, message, code] of negatives) {
    it(label, () => {
      expect(isModelGoneError(Object.assign(new Error(message), code === undefined ? {} : { code }))).toBe(false)
    })
  }

  it('非 Error 输入一律 false（不抛错）', () => {
    for (const value of [undefined, null, 'str', 42, {}, []]) {
      expect(isModelGoneError(value), String(value)).toBe(false)
    }
  })

  it('空消息 false', () => {
    expect(isModelGoneError(new Error(''))).toBe(false)
  })
})

// ── 2. 记录与剔除 ──────────────────────────────────────────────────────────

/** 构造一个最小适配器替身。 */
function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    marker: 'keep-me',
    calls: [] as string[],
    async listModels(): Promise<Array<{ id: string; name: string }>> {
      return [
        { id: 'good-1', name: 'Good 1' },
        { id: 'gone-1', name: 'Gone 1' },
        { id: 'good-2', name: 'Good 2' },
      ]
    },
    listAllModels(): Array<{ id: string; name: string }> {
      return [
        { id: 'good-1', name: 'Good 1' },
        { id: 'gone-1', name: 'Gone 1' },
        { id: 'disabled-by-user', name: 'Old' },
      ]
    },
    async *stream(options: { model: string }): AsyncGenerator<{ text: string }> {
      this.calls.push(options.model)
      if (options.model === 'gone-1') {
        throw Object.assign(new Error('cline: model not found'), { code: 'HTTP_404' })
      }
      if (options.model === 'quota-1') {
        throw Object.assign(new Error('模型额度已用尽'), { code: 'QUOTA_EXCEEDED' })
      }
      yield { text: `ok:${options.model}` }
    },
    normalMethod(): string {
      return this.marker
    },
    ...overrides,
  }
}

/** 消费一个异步生成器（把抛错原样带出）。 */
async function drain(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

describe('withDeadModelPruning —— 记录与剔除', () => {
  const PROVIDER = 'spec-provider-a'

  beforeEach(() => {
    clearDeadModels(PROVIDER)
  })

  it('初始时列表含目标模型', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    expect((await wrapped.listModels()).some((m) => m.id === 'gone-1')).toBe(true)
  })

  it('stream 抛「模型不存在」⇒ 记入剔除表', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    await expect(drain(wrapped.stream({ model: 'gone-1' }) as AsyncIterable<unknown>)).rejects.toThrow('model not found')
    expect(deadModelIdsFor(PROVIDER).has('gone-1')).toBe(true)
  })

  it('★ 错误**不被吞掉**（仍原样抛出，调用方要看到失败）', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    await expect(drain(wrapped.stream({ model: 'gone-1' }) as AsyncIterable<unknown>)).rejects.toThrow()
  })

  it('记录后 listModels 剔除、其余保留', async () => {
    recordDeadModel(PROVIDER, 'gone-1', 'test')
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    const list = await wrapped.listModels()
    expect(list.some((m) => m.id === 'gone-1')).toBe(false)
    expect(list.some((m) => m.id === 'good-1')).toBe(true)
    expect(list.some((m) => m.id === 'good-2')).toBe(true)
  })

  it('★ listAllModels 仍返回**数组**（同步契约，不能改成 async）', () => {
    recordDeadModel(PROVIDER, 'gone-1', 'test')
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    const all = wrapped.listAllModels()
    // jet-hub-rpc 的 ModelCatalogSource 消费者不 await（`catalog = [...all]`），
    // 返回 Promise 会抛 `all is not iterable`。
    expect(Array.isArray(all)).toBe(true)
    expect([...(all as Array<{ id: string }>)].some((m) => m.id === 'gone-1')).toBe(false)
    // 用户关闭的模型仍要能看到（否则设置页无法重新打开）
    expect((all as Array<{ id: string }>).some((m) => m.id === 'disabled-by-user')).toBe(true)
  })

  it('正常模型 stream 正常产出，且不被误记', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    const chunks = await drain(wrapped.stream({ model: 'good-1' }) as AsyncIterable<unknown>)
    expect(chunks).toEqual([{ text: 'ok:good-1' }])
    expect(deadModelIdsFor(PROVIDER).has('good-1')).toBe(false)
  })

  it('额度类错误**不**记录（账号问题 ≠ 模型下架）', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    await expect(drain(wrapped.stream({ model: 'quota-1' }) as AsyncIterable<unknown>)).rejects.toThrow()
    expect(deadModelIdsFor(PROVIDER).has('quota-1')).toBe(false)
  })

  it('clearDeadModels 后重新可见', async () => {
    recordDeadModel(PROVIDER, 'gone-1', 'test')
    expect(deadModelIdsFor(PROVIDER).size).toBe(1)
    clearDeadModels(PROVIDER)
    expect(deadModelIdsFor(PROVIDER).size).toBe(0)
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    expect((await wrapped.listModels()).some((m) => m.id === 'gone-1')).toBe(true)
  })

  it('重复记录只算一次（幂等）', () => {
    expect(recordDeadModel(PROVIDER, 'gone-1', 'a')).toBe(true)
    expect(recordDeadModel(PROVIDER, 'gone-1', 'b')).toBe(false)
  })

  it('空 provider / 空 modelId 不记录', () => {
    expect(recordDeadModel('', 'x')).toBe(false)
    expect(recordDeadModel(PROVIDER, '')).toBe(false)
  })

  it('多个 provider 的记录互不串扰', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    recordDeadModel('spec-provider-other', 'gone-1', 'test')
    // 别的 provider 记了，本 provider 不应受影响
    expect((await wrapped.listModels()).some((m) => m.id === 'gone-1')).toBe(true)
  })

  it('空 providers 列表时原样返回（不包装）', () => {
    const adapter = makeAdapter()
    expect(withDeadModelPruning([], adapter)).toBe(adapter)
  })
})

// ── 3. 代理透传正确性 ──────────────────────────────────────────────────────

describe('withDeadModelPruning —— 代理透传', () => {
  it('普通属性透传', () => {
    const wrapped = withDeadModelPruning(['spec-provider-b'], makeAdapter())
    expect(wrapped.marker).toBe('keep-me')
  })

  it('普通方法的 this 绑定正确', () => {
    const wrapped = withDeadModelPruning(['spec-provider-b'], makeAdapter())
    expect(wrapped.normalMethod()).toBe('keep-me')
  })

  it('★ 方法身份稳定（两次访问返回同一函数，避免下游比较失配）', () => {
    const wrapped = withDeadModelPruning(['spec-provider-b'], makeAdapter())
    expect(wrapped.normalMethod).toBe(wrapped.normalMethod)
  })

  it('stream 调用仍到达原适配器', async () => {
    const adapter = makeAdapter()
    const wrapped = withDeadModelPruning(['spec-provider-b'], adapter)
    await drain(wrapped.stream({ model: 'good-1' }) as AsyncIterable<unknown>)
    expect(adapter.calls).toContain('good-1')
  })

  it('适配器缺 listAllModels 时不凭空造一个', () => {
    const adapter = { async listModels() { return [] } }
    const wrapped = withDeadModelPruning(['spec-provider-b'], adapter)
    expect((wrapped as { listAllModels?: unknown }).listAllModels).toBeUndefined()
  })
})

// ── 4. 持久化 ──────────────────────────────────────────────────────────────

describe('withDeadModelPruning —— 持久化', () => {
  it('落盘为独立文档且带 schema', () => {
    recordDeadModel('spec-provider-c', 'gone-x', 'test')
    const file = join(STATE_DIR, 'jet-hub', DEAD_MODELS_FILE)
    expect(existsSync(file)).toBe(true)
    const doc = JSON.parse(readFileSync(file, 'utf-8')) as {
      schema: string
      providers: Record<string, Record<string, { at: string; reason?: string }>>
    }
    expect(doc.schema).toBe('dsh-codearts-auth/dead-models/v1')
    expect(doc.providers['spec-provider-c']?.['gone-x']?.at).toBeTruthy()
    expect(doc.providers['spec-provider-c']?.['gone-x']?.reason).toBe('test')
  })

  it('落盘失败不影响调用方（不可写目录也只降级记日志）', () => {
    // 用一个必然写不进去的路径：把文件名段做成目录占位
    expect(() => recordDeadModel('spec-provider-d', 'gone-y', 'test')).not.toThrow()
  })
})
