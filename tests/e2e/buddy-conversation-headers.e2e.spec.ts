/**
 * `X-Conversation-*` 三头的**真机对照凭据**（Gitee issue IKM73W）。
 *
 * ## ⚠️ 为什么这个探针不可省
 *
 * 2026-10-16 两轮审计用真实凭据实测（约 90 次请求）**证伪**了本仓库曾写进注释的
 * 结论「三头缺任一即 400/11128 `conversation id missing`」：
 * - 逐枚消融适配器构造的 **14 枚头，全部仍 200**（含这三枚）；
 * - 6 模型 × 4 请求形状 = 48 格，三头与响应状态**零关联**；
 * - 逐级剥到「连 UA / 鉴权头 / 身份头都不发」仍 200；
 * - `conversation id missing` **零次复现**（同批复现了另两句 11128）。
 *
 * 同时实测到一条**机制性结论**：上游把三头**回显**成 completion id 的种子
 * （填 `abc-123` ⇒ 回包 `"id":"abc-123"`）。
 *
 * ⚠️⚠️ **这份数据现在写进了 3 处注释与文档，但它一度与它推翻的原表享有完全相同的
 * 证据等级 —— 零。** 本仓库的规矩（见 `tests/e2e/README.md` 与
 * `src/openai-gateway/tencent-fingerprint.ts` 文件头）：
 * **单测只能锁「代码按某个范围做」，锁不住「那个范围本身对不对」**。
 * 上面两条结论都是「范围本身」，只能靠真实请求固定。
 *
 * ⇒ 本文件就是那份缺失的凭据。**任何人都能重跑它来推翻或确认上述结论。**
 *
 * ## 闸门（双重，缺一不可 —— 被拒不耗额度，但列目录仍要显式确认）
 * ```
 * DSH_BUDDY_CONV_E2E=1
 * DSH_BUDDY_CONV_E2E_CONFIRM=yes
 * ```
 *
 * ## 跑法
 * ```
 * pnpm test:e2e:buddy-conv
 * ```
 * 可用环境变量覆盖：
 * - `WB_REF` —— 凭据 ref（默认读账号池里第一个 workbuddy 账号）
 * - `WB_MODEL` —— 模型（默认 `fast-model`；⚠️ 别用 `deep-model` —— 实测 11102
 *   `service info not found`，会掩盖判据）
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { WORKBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

const E2E = process.env.DSH_BUDDY_CONV_E2E === '1'
  && process.env.DSH_BUDDY_CONV_E2E_CONFIRM === 'yes'
const suite = E2E ? describe : describe.skip

const CONV = ['x-conversation-id', 'x-conversation-request-id', 'x-conversation-message-id']
const MODEL = process.env.WB_MODEL ?? 'fast-model'

/**
 * 从 `~/.dsh/.credentials.yaml` 取某 ref 的凭据。
 *
 * ⚠️ 该文件是 **YAML**：值是**单引号包裹的 JSON 字符串**，且串内可以有**真实 LF**
 * （本仓 `scope` 字段就是多行）⇒ 直接 `JSON.parse` 原文会报
 * `Bad control character in string literal`。这里只做本探针需要的取值，不引 yaml 依赖：
 * YAML 单引号串内 `''` 表示一个字面 `'`，LF 会被折叠成空格。
 */
function credentialFor(ref: string): BuddyCredential {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const key = `${ref}:`
  const idx = text.indexOf(key)
  if (idx < 0) throw new Error(`凭据 ${ref} 未找到`)
  const body = text.slice(idx + key.length).slice(text.slice(idx + key.length).indexOf("'") + 1)
  let i = 0
  for (;; i += 1) {
    if (body[i] === "'") {
      if (body[i + 1] === "'") { i += 1; continue }
      break
    }
  }
  const raw = body.slice(0, i).replace(/''/g, "'").replace(/\r?\n\s*/g, '\\n')
  return JSON.parse(raw) as BuddyCredential
}

/** 账号池里第一个 workbuddy 账号的凭据 ref。 */
function firstWorkbuddyRef(): string {
  const state = JSON.parse(
    readFileSync(join(homedir(), '.dsh', 'jet-hub', 'state.json'), 'utf8'),
  ) as { accounts?: { provider?: string; credentialRef?: string }[] }
  const ref = (state.accounts ?? []).find((a) => a.provider === 'workbuddy')?.credentialRef
  if (ref === undefined) throw new Error('账号池里没有 workbuddy 账号')
  return ref
}

interface Case { status: number; code: string; msg: string; completionsId: string }

/** 走**真实适配器**，在 `fetchImpl` 里按 `drop` 删头后转发到真实上游。 */
async function viaAdapter(
  credential: BuddyCredential, ref: string, drop: string[],
): Promise<Case> {
  let status = 0
  let body = ''
  const fetchImpl: typeof fetch = async (url, init) => {
    const h = new Headers(init?.headers as HeadersInit)
    for (const name of drop) h.delete(name)
    const res = await fetch(url, { ...init, headers: h })
    status = res.status
    body = (await res.clone().text()).slice(0, 600)
    return res
  }
  const adapter = new BuddyAdapter({
    credentialRef: ref as never,
    resolveCredential: async () => credential,
    refresh: async () => {},
    sessionId: 'conv-e2e-probe',
    product: WORKBUDDY,
    fetchImpl,
  })
  try {
    const prepared = await adapter.prepareCall('workbuddy', MODEL)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of prepared.stream({
      model: MODEL,
      messages: [{ role: 'user', content: '回复 OK' }],
      system: 'You are a helpful assistant.',
      maxTokens: 8,
    })) { /* 只为把流消费掉 */ }
  } catch {
    // 失败信息取自 HTTP 状态与报文，不取自异常 —— 判据在上游那侧。
  }
  return {
    status,
    code: /"code":(\d+)/.exec(body)?.[1] ?? '-',
    msg: /"msg":"([^"]*)"/.exec(body)?.[1] ?? '',
    completionsId: /"id":"([^"]+)"/.exec(body)?.[1] ?? '',
  }
}

suite('IKM73W：X-Conversation-* 三头的真机对照（消耗真实额度，每例 max_tokens=8）', () => {
  it('逐枚消融：每一枚头删掉后请求仍应成功', async () => {
    const ref = process.env.WB_REF ?? firstWorkbuddyRef()
    const credential = credentialFor(ref)
    console.log(`\n===== 凭据 ${ref} / 模型 ${MODEL} / 端点 ${WORKBUDDY.endpoint} =====`)

    // ⚠️ 先验基线：不删任何头。若基线就不通，后续每格都无判据（换号/额度/模型
    // 失效都会伪装成「三头必需」）⇒ 直接失败并给出可操作提示。
    const baseline = await viaAdapter(credential, ref, [])
    console.log(`\n  基线（头一枚不减）：HTTP ${baseline.status} ${baseline.code} ${baseline.msg}`)
    expect(baseline.status, `基线就不通（${baseline.code} ${baseline.msg}）—— 换账号或换模型再跑，本轮无判据`).toBe(200)

    // 逐枚消融。⚠️ **必须逐枚单独跑**：并起来删只会得到「缺这三枚仍 200」，
    // 无法区分「三枚都不需要」与「其中某几枚需要」。
    const rows: string[] = []
    for (const name of CONV) {
      const r = await viaAdapter(credential, ref, [name])
      rows.push(`  删 ${name.padEnd(28)} → HTTP ${r.status} ${r.code} ${r.msg}`)
    }
    const allThree = await viaAdapter(credential, ref, CONV)
    rows.push(`  删 三枚全删${' '.repeat(21)}→ HTTP ${allThree.status} ${allThree.code} ${allThree.msg}`)
    console.log(`\n===== 逐枚消融 =====\n${rows.join('\n')}`)

    // 这条断言就是 2026-10-16 证伪结论的可复核凭据。
    // ⚠️ 若上游将来**真的**收紧了校验（如灰度要求三头），本用例会红 ——
    // 那正是它存在的意义：把「三头是不是必需」从一次性观测变成**持续可回归**的判据。
    for (const [i, name] of CONV.entries()) {
      const r = await viaAdapter(credential, ref, [name])
      expect(r.status, `删掉 ${name} 后上游开始拒绝 ⇒ 「三头非准入必需」这条结论已失效，请更新注释与 docs/agent-notes/providers-buddy.md`).toBe(200)
      void i
    }
    expect(allThree.status, '三枚全删后上游开始拒绝 ⇒ 同上，请更新注释与文档').toBe(200)
  }, 600_000)

  it('回显：X-Conversation-ID 的值会出现在回包 id 里', async () => {
    const ref = process.env.WB_REF ?? firstWorkbuddyRef()
    const credential = credentialFor(ref)
    const marker = 'abc123'
    const convId = `${marker}${'0'.repeat(32 - marker.length)}`
    const base: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Agent-Purpose': 'conversation',
      'X-Domain': WORKBUDDY.apiDomain,
      'X-Product-Code': WORKBUDDY.productCode,
      'X-Product': WORKBUDDY.attributionName,
      'X-IDE-Name': WORKBUDDY.attributionName,
      'X-IDE-Type': WORKBUDDY.attributionName,
      'X-IDE-Version': WORKBUDDY.clientVersion,
      'User-Agent': WORKBUDDY.userAgent,
    }
    const res = await fetch(`${WORKBUDDY.endpoint}/v2/chat/completions`, {
      method: 'POST',
      headers: {
        ...base,
        Authorization: `Bearer ${credential.access_token}`,
        'X-Conversation-ID': convId,
        'X-Conversation-Request-ID': convId,
        'X-Conversation-Message-ID': convId,
      },
      body: JSON.stringify({
        model: MODEL, stream: true, max_tokens: 8,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: '回复 OK' },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    })
    const text = (await res.text()).slice(0, 600)
    const id = /"id":"([^"]+)"/.exec(text)?.[1] ?? ''
    console.log(`\n  发的 X-Conversation-ID = ${convId}`)
    console.log(`  回包 id                = ${id}`)
    console.log(`  HTTP                   = ${res.status}`)
    expect(res.status).toBe(200)
    // 机制性结论：上游拿三头当 completion id 的种子 ⇒ 从机制上就不可能是
    // 「过不了就 400」的闸门。⚠️ 若上游将来改用独立 id 生成器，本用例会红 ——
    // 那是**上游行为变更**，届时三头的「无害」前提需重新评估。
    expect(id).toContain(marker)
  }, 300_000)
})
