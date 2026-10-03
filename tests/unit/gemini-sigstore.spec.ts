/**
 * Gemini `thoughtSignature` 缓存单测。
 *
 * 守的是两件**静默失败**：
 * 1. 键算法漂移（换算法 ⇒ 已有缓存全失配 ⇒ 每轮都去签重试，不报错）；
 * 2. 坏文件把整个进程的命中率打回 0（必须降级为空表，而不是抛错）。
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

  it('两侧规范化一致时才命中（canonicalArgs 是唯一口径）', () => {
    const store = new GeminiSigStore(undefined, noop)
    store.put('read_file', canonicalArgs({ path: 'a.go', mode: 'r' }), 'SIG')
    expect(store.get('read_file', canonicalArgs({ mode: 'r', path: 'a.go' }))).toBe('SIG')
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

  it('坏文件降级为空表并 warn（纯缓存，不抛错）', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(filePath(), '{ not json', 'utf-8')
    const warnings: string[] = []
    const store = new GeminiSigStore(filePath(), { warn: (message) => warnings.push(message) })
    expect(store.size).toBe(0)
    expect(warnings.some((message) => message.includes('签名缓存文件损坏'))).toBe(true)
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
})
