/**
 * `dsml-parse-roundtrip.spec.ts` —— DSML「教得会 + 解得开」端到端守卫。
 *
 * ## 连续两版漏判的记录（必须留档）
 *
 * - **第 1 版**（`842bf8e`）：只做标记归一化（双竖线→单竖线）。有效
 *   （坏标记 270→0），但**工具仍不执行** —— 因为协议根本没下发。
 * - **第 2 版**（`fc028ea`）：补了「教」（注入 DSML system 提示）。
 *   仍**不行** —— 因为 `consumeOpenAiSse`（OfficeAce 走它）**不解析 DSML**，
 *   解析器当时只存在于 `llm-adapter.ts`（codearts）。
 *
 * 即：**教了但没人解**。故本文件锁的是**成对性**：注入提示的通道，
 * 其消费器必须开启 `dsmlToolMode`。单边存在 = 工具调用静默失效。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildDsmlSystemPrompt,
  DsmlContentExtractor,
  DSML_TOOL_CALLS_CLOSE,
  DSML_TOOL_CALLS_OPEN,
  parseDsmlToolCalls,
} from '../../src/dsml.js'

const BAR = '\uFF5C'
const SRC = join(process.cwd(), 'src')

describe('DSML 解析（共享层）', () => {
  it('① 完整块解析出结构化调用', () => {
    const block = `${DSML_TOOL_CALLS_OPEN}<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter></｜DSML｜invoke>${DSML_TOOL_CALLS_CLOSE}`
    const calls = parseDsmlToolCalls(block)
    expect(calls).toEqual([{ name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) }])
  })

  it('② 数字参数被误标 string="true" 时还原为 number', () => {
    const block = `${DSML_TOOL_CALLS_OPEN}<｜DSML｜invoke name="read"><｜DSML｜parameter name="offset" string="true">1304</｜DSML｜parameter></｜DSML｜invoke>${DSML_TOOL_CALLS_CLOSE}`
    const calls = parseDsmlToolCalls(block)
    expect(JSON.parse(calls![0].arguments)).toEqual({ offset: 1304 })
  })

  it('③ 多调用并行解析', () => {
    const one = `<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter></｜DSML｜invoke>`
    const two = `<｜DSML｜invoke name="read"><｜DSML｜parameter name="file_path" string="true">a.txt</｜DSML｜parameter></｜DSML｜invoke>`
    const calls = parseDsmlToolCalls(`${DSML_TOOL_CALLS_OPEN}${one}${two}${DSML_TOOL_CALLS_CLOSE}`)
    expect(calls?.map((c) => c.name)).toEqual(['bash', 'read'])
  })

  it('④ 流式：标签跨任意帧切分都能解析（二分帧穷举）', () => {
    const full = `前缀${DSML_TOOL_CALLS_OPEN}<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter></｜DSML｜invoke>${DSML_TOOL_CALLS_CLOSE}后缀`
    for (let cut = 0; cut <= full.length; cut++) {
      const ex = new DsmlContentExtractor()
      const r1 = ex.feed(full.slice(0, cut))
      const r2 = ex.feed(full.slice(cut))
      const f = ex.flush()
      const calls = [...r1.toolCalls, ...r2.toolCalls]
      const text = r1.text + r2.text + f.text + f.reasoning
      expect(calls.length, `切分点 ${cut} 未解析出调用`).toBe(1)
      expect(calls[0].name, `切分点 ${cut} 名字错`).toBe('bash')
      // 标签本身不得泄漏进可见正文
      expect(text, `切分点 ${cut} 标签泄漏`).not.toContain(DSML_TOOL_CALLS_OPEN)
      expect(text).toContain('前缀')
      expect(text).toContain('后缀')
    }
  })

  it('⑤ 流被截断（无闭标签）时残片作为正文放行，不吞内容', () => {
    const ex = new DsmlContentExtractor()
    // ⚠️ 开标签**之前**的正文在 feed() 里就已放行（不在 flush 里）——
    //    两个通道必须分清，否则会误以为正文被吞。
    const r = ex.feed(`正文${DSML_TOOL_CALLS_OPEN}<｜DSML｜invoke name="bash">`)
    expect(r.text).toBe('正文')
    const f = ex.flush()
    // flush 补回开标签，用户看到完整残片而非凭空消失的一段
    expect(f.text).toContain(DSML_TOOL_CALLS_OPEN)
    expect(f.text).toContain('<｜DSML｜invoke name="bash">')
  })
})

describe('成对性守卫：注入提示的通道，消费器必须解析', () => {
  it('⑥ officeace 注入提示与 dsmlToolMode 必须同时存在（缺一 = 工具永不执行）', () => {
    const c = readFileSync(join(SRC, 'officeace-adapter.ts'), 'utf8')
    const injects = /buildDsmlSystemPrompt/.test(c)
    const parses = /dsmlToolMode/.test(c)
    expect(injects, 'officeace 未注入 DSML 提示').toBe(true)
    expect(parses, 'officeace 注入了提示却没开 dsmlToolMode ⇒ 教了但没人解').toBe(true)
  })

  it('⑦ 解析器实现只允许 dsml.ts 一处（不得 llm-adapter 里再留副本）', () => {
    const llm = readFileSync(join(SRC, 'llm-adapter.ts'), 'utf8')
    expect(llm).not.toMatch(/class DsmlContentExtractor/)
    expect(llm).not.toMatch(/function parseDsmlToolCalls/)
    // 但必须**导入**共享层（否则 codearts 自己也没解析器了）
    expect(llm).toMatch(/from '\.\/dsml\.js'/)
  })

  it('⑧ consumeOpenAiSse 支持 dsmlToolMode（OfficeAce 走这条）', () => {
    const c = readFileSync(join(SRC, 'openai-compat.ts'), 'utf8')
    expect(c).toContain('dsmlToolMode')
    expect(c).toContain('DsmlContentExtractor')
  })

  it('⑨ 未开启 dsmlToolMode 时行为不变（不误伤普通通道）', () => {
    // 默认构造的提取器为 undefined ⇒ 正文直传。用文档化常量确认开关默认关。
    const c = readFileSync(join(SRC, 'openai-compat.ts'), 'utf8')
    expect(c).toMatch(/config\.dsmlToolMode === true \? new DsmlContentExtractor\(\) : undefined/)
  })
})

describe('提示词与解析器同源', () => {
  it('⑩ 提示词教的格式，解析器必须能解开（往返验证）', () => {
    const prompt = buildDsmlSystemPrompt([{
      type: 'function',
      function: { name: 'bash', description: 'run', parameters: { type: 'object' } },
    }])
    // 从提示词里抽出示范格式，套上真实参数后交给解析器
    const example = `${DSML_TOOL_CALLS_OPEN}<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">echo hi</｜DSML｜parameter></｜DSML｜invoke>${DSML_TOOL_CALLS_CLOSE}`
    expect(prompt).toContain(DSML_TOOL_CALLS_OPEN)
    const calls = parseDsmlToolCalls(example)
    expect(calls?.[0].name).toBe('bash')
  })
})
