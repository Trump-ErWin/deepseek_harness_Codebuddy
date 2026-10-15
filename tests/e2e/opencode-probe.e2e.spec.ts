/**
 * opencode 匿名通道 e2e（默认跳过）。
 *
 * 闸门：`DSH_OPENCODE_E2E=1` + `DSH_OPENCODE_CHAT_E2E_CONFIRM=yes`
 * 双开关（沿用本仓库 e2e 惯例，见 tests/e2e/README.md）。
 *
 * ⚠️ 消耗匿名免费额度，故必须有显式确认开关。
 * ⚠️ 本文件**不发请求**除非双开关都开：`enabled` 为 false 时整套 suite skip。
 */
import { describe, expect, it } from 'vitest'
import { OpencodeAdapter, clearOpencodeCatalogCache } from '../../src/opencode-adapter.js'
import { listIdentitySlots } from '../../src/opencode-auth.js'
import { OPENCODE } from '../../src/opencode-product.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const enabled = process.env.DSH_OPENCODE_E2E === '1'
  && process.env.DSH_OPENCODE_CHAT_E2E_CONFIRM === 'yes'
const suite = enabled ? describe : describe.skip

/** 用匿名槽跑一次流式请求，返回拼接后的正文。 */
async function ask(model: string, text: string): Promise<string> {
  clearOpencodeCatalogCache()
  const adapter = new OpencodeAdapter({
    identitySlots: async () => listIdentitySlots([{ id: 'opencode-anon-e2e', enabled: true, apiKey: 'public' }], OPENCODE.defaultUserAgent),
  })
  const chunks: string[] = []
  const options = {
    provider: 'opencode',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    system: '',
    tools: [],
    maxTokens: 256,
    signal: AbortSignal.timeout(45_000),
  } as unknown as GenerateOptions
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
  }
  return chunks.join('')
}

suite('opencode 匿名通道 e2e', () => {
  it('完整客户端工具集通过 V2 门禁，调用还原原名，回传历史可继续对话', async () => {
    // 只检查模型产出的调用并回传模拟结果，不执行真实读文件/命令等操作。
    // ⚠️ 上游首字节实测在 3~25 秒之间波动（同一台机器同一天），故每个请求给 90 秒预算；
    // 预算太紧会把「上游慢」误报成协议回归。
    const budget = (): AbortSignal => AbortSignal.timeout(90_000)
    const tools = ['read', 'shell', 'edit', 'write', 'glob', 'grep'].map((name) => ({
      name,
      description: `客户端 ${name} 工具；read 用 file_path 读取模拟文件`,
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    }))
    const adapter = new OpencodeAdapter({
      identitySlots: async () => listIdentitySlots([{ id: 'opencode-anon-tools-e2e', enabled: true, apiKey: 'public' }], OPENCODE.defaultUserAgent),
    })
    const messages: Array<{ role: string; content: unknown[] }> = [{ role: 'user', content: [{ type: 'text', text: '请调用客户端 read 工具读取文件 /virtual/probe.txt，只调用工具，不直接回答。不要调用保留工具。' }] }]
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: 'opencode', model: 'big-pickle', messages, tools, maxTokens: 1024, signal: budget() } as unknown as GenerateOptions)) chunks.push(chunk)
    const calls = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map((chunk) => chunk.block)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'read' })
    expect(JSON.parse((calls[0] as { arguments: string }).arguments)).toEqual({ file_path: '/virtual/probe.txt' })
    const id = (calls[0] as { id: string }).id
    messages.push({ role: 'assistant', content: calls })
    messages.push({ role: 'user', content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: 'OPENCODE_V2_HISTORY_OK' }] }] })
    messages.push({ role: 'user', content: [{ type: 'text', text: '读取已成功，别再调用工具，只原样回复刚才的文件内容。' }] })
    let text = ''
    for await (const chunk of adapter.stream({ provider: 'opencode', model: 'big-pickle', messages, tools, maxTokens: 256, signal: budget() } as unknown as GenerateOptions)) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    expect(text).toContain('OPENCODE_V2_HISTORY_OK')
    // eslint-disable-next-line no-console
    console.log('[opencode e2e] 两轮真实请求均完成，工具调用还原为 read，历史回传后续对话正常')
  }, 240_000)

  it('目录可拉到（只含免费模型）', async () => {
    clearOpencodeCatalogCache()
    let remote: Response | undefined
    const adapter = new OpencodeAdapter({
      identitySlots: async () => listIdentitySlots([{ id: 'opencode-anon-e2e', enabled: true, apiKey: 'public' }], OPENCODE.defaultUserAgent),
      fetchRemoteCatalog: async (slot) => {
        remote = await fetch(`${OPENCODE.baseUrl}${OPENCODE.modelsPath}`, {
          headers: { authorization: `Bearer ${slot.apiKey}`, 'user-agent': OPENCODE.defaultUserAgent },
          signal: AbortSignal.timeout(15_000),
        })
        return remote
      },
    })
    const models = await adapter.listModels('opencode')
    // 不能让本地兜底表把远端拉取失败伪装成通过。
    expect(remote?.status).toBe(200)
    expect(models.length).toBeGreaterThan(0)
    // 匿名槽只应看到免费模型（付费模型对它是不可用的）
    expect(models.every((m) => !m.id.startsWith('claude'))).toBe(true)
  }, 30_000)

  it('伪装头被接受：发一条最小消息拿到正文', async () => {
    const text = await ask('big-pickle', '回复两个字：ok')
    expect(text.length).toBeGreaterThan(0)
  }, 60_000)

  it('V2 协议门禁未被触发（FreeTierError 说明上游契约需更新）', async () => {
    // 上一条能过就说明门禁 OK；这里显式再发一次并把错误分类打出来，
    // 便于真机排查时一眼看出是「额度」还是「形状」问题。
    try {
      const text = await ask('big-pickle', '只回复 OK，不调用任何工具。')
      expect(text.length).toBeGreaterThan(0)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console
      console.error('[opencode e2e] 真实失败信息：', message)
      throw error
    }
  }, 60_000)
})
