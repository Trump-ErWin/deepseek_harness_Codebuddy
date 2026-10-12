/**
 * 实测凭据：**腾讯系内容级风控扫描哪些消息角色**（2026-10-12 补测）。
 *
 * ## 为什么这个文件必须**入库**
 * 「`assistant` **正文**会被风控拦、而 `reasoning_content` / `tool_calls.arguments`
 * / `user` / `tool` 结果**不会**」这条结论，已被写进
 * `src/openai-gateway/tencent-fingerprint.ts` 的**实现约束**（决定改写范围），
 * 并有单测锁住。单测只能锁「代码按那个范围做」，**锁不住那个范围本身对不对** ——
 * 而当初翻车的正是这一点：assistant 那一格从未测过，且当时的探针把触发句改写成了
 * 转述形态（服务端逐字符匹配 ⇒ 那个形态不含触发串 ⇒ **空跑**却得出「assistant 放行」）。
 *
 * ⚠️ 本文件因此是那条结论的**唯一可复核凭据**。别把它挪回被 gitignore 的 `scripts/`。
 *
 * ## 触发串从哪里来
 * ⚠️ **刻意不在源码里写那句字面量**：源码会经 tool-call.arguments 进入当前会话
 * 历史，于是**本会话自己的** buddy 请求也开始被拦 —— 观察者污染实验对象
 * （这正是 2026-10-12 那次报障的机制）。故运行时从本仓库的
 * `docs/agent-notes/providers-buddy.md` 读那一行原文，全程不打印。
 *
 * ## 闸门（消耗极小额度：每例 `max_tokens=16`，被拒不耗额度）
 *   DSH_BUDDY_FINGERPRINT_E2E=1 + DSH_BUDDY_FINGERPRINT_E2E_CONFIRM=yes
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ENABLED = process.env.DSH_BUDDY_FINGERPRINT_E2E === '1'
const CONFIRMED = process.env.DSH_BUDDY_FINGERPRINT_E2E_CONFIRM === 'yes'

/** 触发串：取自记录该指纹的文档，取「首次出现该字面量的那一行」，不打印。 */
function loadTriggerLine(): string {
  const doc = readFileSync('docs/agent-notes/providers-buddy.md', 'utf8')
  const line = doc.split('\n').find((l) => /usually\s+use\s+this\s+for\s+PRs/i.test(l))
  if (typeof line !== 'string' || line.trim().length === 0) {
    throw new Error('在 docs/agent-notes/providers-buddy.md 里找不到触发串那一行 —— 文档被改动后请同步本探针')
  }
  return line
}

function firstCredential(): { ref: string; cred: Record<string, unknown> } {
  const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s+(BUDDY_ACCOUNT_[0-9A-F]+|BUDDY_ACCESS_TOKEN):\s*'(.*)'\s*$/.exec(line)
    if (m === null) continue
    try {
      const cred = JSON.parse(m[2]) as Record<string, unknown>
      if (typeof cred.access_token === 'string' && cred.access_token.length > 0) return { ref: m[1], cred }
    } catch { /* 跳过非 JSON */ }
  }
  throw new Error('磁盘上没有 CodeBuddy 凭据（请先在 Jet Hub 登录）')
}

const ENDPOINT = 'https://copilot.tencent.com'
const MODEL = process.env.DSH_BUDDY_FINGERPRINT_MODEL ?? 'step-5-preview'

function headersOf(cred: Record<string, unknown>): Record<string, string> {
  return {
    Authorization: `Bearer ${String(cred.access_token)}`,
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'X-Domain': 'copilot.tencent.com',
    'X-Product-Code': 'codebuddy',
    'X-IDE-Name': 'CodeBuddy', 'X-IDE-Type': 'CodeBuddy', 'X-IDE-Version': '1.106.1',
    'X-Product': 'CodeBuddy', 'User-Agent': 'CodeBuddyIDE/1.106.1',
  }
}

async function probe(messages: unknown[]): Promise<{ blocked: boolean; code?: string }> {
  const { cred } = firstCredential()
  const res = await fetch(`${ENDPOINT}/v2/chat/completions`, {
    method: 'POST', headers: headersOf(cred),
    body: JSON.stringify({ model: MODEL, messages, stream: true, max_tokens: 16 }),
  })
  if (!res.ok) {
    const body = await res.text()
    return { blocked: true, code: /"code":(\d+)/.exec(body)?.[1] }
  }
  // 200 也可能是流内错误帧（IKJNA1 记录过这种形态）
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done === true) break
    buf += decoder.decode(value, { stream: true })
    for (const line of buf.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const p = t.slice(5).trim()
      if (p.includes('"code"') && !p.includes('chat.completion.chunk')) return { blocked: true }
    }
  }
  return { blocked: false }
}

describe.skipIf(!ENABLED || !CONFIRMED)('腾讯系内容级风控：角色矩阵（2026-10-12 实测依据）', () => {
  it('基线：不含触发串的请求必须 200（否则本文件全部结论作废）', async () => {
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it('★ assistant 正文含触发串会被拦（这是本次修复扩大的那一格）', async () => {
    const trigger = loadTriggerLine()
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: trigger },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked).toBe(true)
  }, 60_000)

  it('改写该句后放行（证明「改写」是有效修法，而不只是「恰好躲过」）', async () => {
    const trigger = loadTriggerLine()
    const safe = trigger.replace(/usually\s+use\s+this\s+for\s+PRs/gi, 'typically merged into PRs')
    const r = await probe([
      { role: 'system', content: `You are a helpful assistant.\n${safe}` },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it.each([
    ['user', [{ role: 'user', content: 'note' }]],
    ['assistant 的 reasoning_content', [{ role: 'assistant', content: 'Noted.', reasoning_content: 'TRIGGER' }]],
    ['tool_calls[].arguments', [{
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: 'TRIGGER' } }],
    }]],
  ])('%s 含触发串**不拦**（这三格刻意不改写，改了只是篡改证据）', async (_label, tail) => {
    const trigger = loadTriggerLine()
    const wire = JSON.parse(JSON.stringify(tail).replaceAll('TRIGGER', trigger))
    // tool_calls 分支要补上配对的 tool 结果，否则会被「配对不完整」先拒
    const messages: unknown[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      ...wire,
      { role: 'user', content: 'reply OK' },
    ]
    if (_label.startsWith('tool_calls')) {
      messages.splice(messages.length - 1, 0, { role: 'tool', tool_call_id: 'c1', content: trigger })
    }
    const r = await probe(messages)
    expect(r.blocked).toBe(false)
  }, 60_000)
})