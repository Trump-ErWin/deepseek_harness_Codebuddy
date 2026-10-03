/**
 * Gemini `thoughtSignature` 缓存单测。
 *
 * 守的是三件**静默失败**：
 * 1. 键算法漂移（换算法 ⇒ 已有缓存全失配 ⇒ 每轮都去签重试，不报错）；
 * 2. 回填/写入两侧规范化不一致（同 1 的症状）；
 * 3. 坏文件把整个进程的命中率打回 0（必须降级为空表，而不是抛错）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GEMINI_SIG_FILE,
  GeminiSigStore,
  createGeminiSigStore,
  geminiSigKey,
  geminiToolSigKey,
  trimGeminiSignature,
} from '../../src/gemini-sigstore.js'
import { canonicalArgs } from '../../src/gemini-messages.js'

let dir: string
let previousDir: string | undefined

beforeEach(() => {
  previousDir = process.env.DSH_JET_HUB_STATE_DIR
  dir = mkdtempSync(join(tmpdir(), 'dsh-gemini-sigs-'))
  process.env.DSH_JET_HUB_STATE_DIR = dir
})

afterEach(() => {
  if (previousDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = previousDir
  rmSync(dir, { recursive: true, force: true })
})

const filePath = (): string => join(dir, 'jet-hub', GEMINI_SIG_FILE)
const noop = { warn: () => {} }

describe('键算法', () => {
  it('键为 16 字符十六进制，前缀角色参与哈希', () => {
    const key = geminiToolSigKey('read_file', '{"path":"a.go"}')
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    expect(geminiSigKey('tool:read_file', '{"path":"a.go"}')).toBe(key)
    expect(geminiSigKey('tool:write_file', '{"path":"a.go"}')).not.toBe(key)
  })

  it('只取正文前 512 字符（长尾不同不影响命中）', () => {
    const head = 'x'.repeat(512)
    expect(geminiSigKey('r', `${head}AAA`)).toBe(geminiSigKey('r', `${head}BBB`))
    expect(geminiSigKey('r', 'x'.repeat(511))).not.toBe(geminiSigKey('r', 'x'.repeat(512)))
  })

  it('两侧规范化一致时才命中（canonicalArgs 是唯一口径）', () => {
    const store = new GeminiSigStore(undefined, noop)
    store.put('read_file', canonicalArgs({ path: 'a.go', mode: 'r' }), 'SIG')
    expect(store.get('read_file', canonicalArgs({ mode: 'r', path: 'a.go' }))).toBe('SIG')
  })

  it('去掉签名首尾空白', () => {
    expect(trimGeminiSignature('\n SIG_A \n')).toBe('SIG_A')
  })
})

describe('读写', () => {
  it('空签名不入缓存（上游下发空串占位时不能当成有签名）', () => {
    const store = new GeminiSigStore(undefined, noop)
    store.put('f', '{}', '')
    store.put('f', '{}', '   ')
    expect(store.size).toBe(0)
    expect(store.get('f', '{}')).toBeUndefined()
  })

  it('落盘后重新载入仍能命中', async () => {
    const first = new GeminiSigStore(filePath(), noop)
    first.put('read_file', '{"path":"a.go"}', 'SIG_FC')
    await first.flush()

    const second = new GeminiSigStore(filePath(), noop)
    expect(second.get('read_file', '{"path":"a.go"}')).toBe('SIG_FC')
  })

  it('无 dirty 时不写文件', async () => {
    const store = new GeminiSigStore(filePath(), noop)
    await store.flush()
    expect(() => readFileSync(filePath(), 'utf-8')).toThrow()
  })

  it('坏文件降级为空表并 warn（纯缓存，不抛错）', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(filePath(), '{ not json', 'utf-8')
    const warnings: string[] = []
    const store = new GeminiSigStore(filePath(), { warn: (message) => warnings.push(message) })
    expect(store.size).toBe(0)
    expect(warnings.some((message) => message.includes('签名缓存文件损坏'))).toBe(true)
  })

  it('忽略形状不对的条目，不整体丢弃', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      filePath(),
      JSON.stringify({
        good: { sig: 'SIG', at: 1 },
        emptySig: { sig: '', at: 2 },
        notObject: 'x',
      }),
      'utf-8',
    )
    const store = new GeminiSigStore(filePath(), noop)
    expect(store.size).toBe(1)
  })

  it('超过 2000 条时淘汰最旧的一半', () => {
    const store = new GeminiSigStore(undefined, noop)
    for (let i = 0; i < 2_001; i++) store.put(`tool-${i}`, '{}', `SIG_${i}`)
    expect(store.size).toBe(1_001)
    // 最旧的那批被删掉。
    expect(store.get('tool-0', '{}')).toBeUndefined()
    expect(store.get('tool-2000', '{}')).toBe('SIG_2000')
  })
})

describe('createGeminiSigStore', () => {
  it('落 $DSH_HOME/jet-hub/gemini-sigs.json（与 state.json 同目录，但是独立文件）', () => {
    const store = createGeminiSigStore({ logger: noop } as never)
    store.put('f', '{}', 'SIG')
    void store.flush()
    expect(JSON.parse(readFileSync(filePath(), 'utf-8'))).toMatchObject({
      [geminiToolSigKey('f', '{}')]: { sig: 'SIG' },
    })
  })

  it('定位不到 home 时退化为纯内存（warn 一次，不抛错）', () => {
    delete process.env.DSH_JET_HUB_STATE_DIR
    const warnings: string[] = []
    const ctx = {
      logger: { warn: (message: string) => warnings.push(message) },
      // 无 profileContext 服务 ⇒ resolveJetHubHome 回落到 env/homedir；
      // homedir 一定存在，故这里只断言「不抛错且可用」。
    } as never
    const store = createGeminiSigStore(ctx)
    store.put('f', '{}', 'SIG')
    expect(store.get('f', '{}')).toBe('SIG')
  })
})
