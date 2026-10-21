/**
 * Codely 适配器单测：**目录 + 推理**（推理自 2026-10-20 起驱动官方 CLI 子进程）。
 *
 * ## 为什么这几条
 *
 * - **远端优先 / 失败回退兜底表**：回退错就是「8 个真模型变成 0 个」或
 *   「拿编译期快照冒充实时目录」；
 * - **`listAllModels()` 必须同步且非空**：`provider.status` 与
 *   `ModelCatalogSource` 不 await（冷缓存下直接读），空数组会让面板把
 *   「已关闭」判成 `total === 0` 的另一种形态；
 * - **推理侧只锁「失败必须显式、绝不静默空流」**（CLI 没装 / 没登录 / 无输出 /
 *   非文本输入）+ 「增量必须逐块透传」。成功路径的文案细节不锁（CLI 版本会变），
 *   锁的是**形状**（block-start → delta… → block-end → finish）。
 */

import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { CodelyAdapter, type CodelyAdapterOptions } from '../../src/codely-adapter.js'
import { CODERLY } from '../../src/codely-product.js'
import type { CodelyCredential } from '../../src/codely-auth.js'
import { CODERLY_CLI_PATH_ENV, type CodelyCliChild, type CodelyCliSpawner } from '../../src/codely-cli.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** `/api/model-status` 的实测报文形状（简化：只留 models[]）。 */
const REMOTE_OK = JSON.stringify({
  scope: 'public',
  models: [
    { modelGroup: 'codely-basic', status: 'operational' },
    { modelGroup: 'KIMI-K3', status: 'outage' },
  ],
})

function fakeFetch(
  impl: () => { ok: boolean; status: number; text: () => Promise<string> },
): typeof fetch {
  return (async () => impl()) as unknown as typeof fetch
}

const CREDENTIAL: CodelyCredential = {
  access_token: 'access-token-abc',
  refresh_token: 'refresh-token-abc',
  obtained_at: Date.now(),
}

function adapterWith(options: Partial<Pick<CodelyAdapterOptions, 'fetchImpl'>> = {}): CodelyAdapter {
  return new CodelyAdapter({
    credentialProvider: async () => CREDENTIAL,
    ...options,
  })
}

/**
 * 假 CLI 子进程：把给定的 stdout / stderr 当成进程输出，并在读完后触发 exit。
 *
 * ⚠️ 为什么**必须**有 timeout 兜底：正常路径监听 stdout 的 `end`，但被 kill
 *    或 readline 提前关闭时它可能不来 ⇒ 没有兜底会让整条用例挂死到超时，
 *    失败信息变成一句无意义的 "test timed out"。
 */
/**
 * 喂给 `cliEnv` 的「惰性但真实存在」的可执行文件路径。
 *
 * ## ⚠️⚠️ 为什么必须有它（2026-10-22 合并审计修 —— 5 条用例在任何干净克隆上必红）
 *
 * `runCodelyCli` 在调用 **spawner 之前**先过 `resolveCodelyCliPath` 的 `existsSync`
 * 闸门（`codely-cli.ts:159-166`）：env `DSH_CODERLY_CLI_PATH` → 硬编码的
 * `D:\Program File\Tuanjie Cowork\...\codely.exe` → 都不存在就抛
 * 「未找到官方 Codely 客户端」。
 *
 * ⇒ `fakeCli()` 只替身了 `cliSpawner`、**没替身 `existsSync`** ⇒ 闸门先抛、
 *   替身永不被调用 ⇒ 5 条用例在**没装 Codely 桌面端**的机器（= 干净克隆 / CI）
 *   **100% 必红**。实测本机：`exists=false` ⇒ 5 failed / 9 passed。
 *
 * ⚠️ 决定性对照（实测）：`DSH_CODERLY_CLI_PATH=C:\Windows\System32\cmd.exe`
 *    跑**同一份代码** ⇒ **14/14 全绿**。
 *
 * ⚠️ 刻意用 `cmd.exe`（Windows 恒存在）而**不是**真实 `codely.exe`：spawner 已被
 *   替身 ⇒ 它**绝不会被真正执行**；若指向真客户端、而某条路径漏了替身，就会在
 *   仓库 cwd 里**真起一个 `--approval-mode yolo` 的 CLI 进程**去读写文件。
 */
const EXISTING_INERT_EXECUTABLE = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\cmd.exe'
  : '/bin/sh'

function fakeCli(options: {
  stdout?: string
  stderr?: string
  exitCode?: number
  spawnError?: Error
}): { spawner: CodelyCliSpawner; args: () => string[] | undefined; wasKilled: () => boolean } {
  let lastArgs: string[] | undefined
  let killed = false
  const spawner: CodelyCliSpawner = (_file, args, _opts) => {
    lastArgs = [...args]
    const stdout = Readable.from([options.stdout ?? ''])
    const stderr = Readable.from([options.stderr ?? ''])
    const handlers = new Map<string, ((...args: never[]) => void)[]>()
    const emit = (event: string, ...payload: never[]): void => {
      for (const cb of handlers.get(event) ?? []) cb(...payload)
    }
    const child = {
      stdout,
      stderr,
      on(event: string, cb: (...args: never[]) => void) {
        const list = handlers.get(event) ?? []
        list.push(cb)
        handlers.set(event, list)
        return child
      },
      kill() {
        killed = true
        stdout.destroy()
        stderr.destroy()
        emit('exit', null as never)
      },
    }
    if (options.spawnError !== undefined) {
      setImmediate(() => { emit('error', options.spawnError as never) })
    } else {
      const fire = (): void => { emit('exit', (options.exitCode ?? 0) as never) }
      stdout.on('end', fire)
      setTimeout(fire, 500)
    }
    return child as unknown as CodelyCliChild
  }
  return { spawner, args: () => lastArgs, wasKilled: () => killed }
}

describe('Codely 适配器：目录', () => {
  /**
   * 本团队**可访问**的兜底模型（`codely-*` 前缀）。
   *
   * ⚠️ 2026-10-20 实测：公共模型名（`DeepSeek-V4.1-Flash` / `GLM-5.3-FLASH` /
   *    `KIMI-K3`）对当前团队一律 `401 team_model_access_denied`，适配器已按
   *    id 前缀过滤（见 `catalogEntries` 的注释表）⇒ 兜底表 8 个只剩 5 个。
   */
  const accessibleFallback = CODERLY.fallbackModels.filter((m) =>
    m.id.toLowerCase().startsWith('codely-'))

  it('① 远端可用 ⇒ 用远端目录（不是编译期兜底表），且团队无权的模型被过滤', async () => {
    const adapter = adapterWith({ fetchImpl: fakeFetch(() => ({
      ok: true, status: 200, text: async () => REMOTE_OK,
    })) })
    const models = await adapter.listModels(CODERLY.id)
    // 远端给了 `codely-basic` + `KIMI-K3`；后者团队无权（401 team_model_access_denied）
    // ⇒ 目录里只应剩下前者。判据见 `catalogEntries` 的实测表。
    expect(models.map((m) => m.id)).toEqual(['codely-basic'])
  })

  it('② 远端非 200 ⇒ 回退兜底表（8 个实测模型）', async () => {
    const adapter = adapterWith({ fetchImpl: fakeFetch(() => ({
      ok: false, status: 500, text: async () => 'boom',
    })) })
    const models = await adapter.listModels(CODERLY.id)
    expect(models.length).toBe(accessibleFallback.length)
    expect(models.map((m) => m.id)).toContain('codely-core')
  })

  it('③ 远端不是 JSON ⇒ 回退兜底表（不抛错）', async () => {
    const adapter = adapterWith({ fetchImpl: fakeFetch(() => ({
      ok: true, status: 200, text: async () => '<html>维护中</html>',
    })) })
    await expect(adapter.listModels(CODERLY.id)).resolves.toHaveLength(
      accessibleFallback.length,
    )
  })

  it('④ 没有凭据 ⇒ 仍返回兜底表（目录读不到不抛错）', async () => {
    const adapter = new CodelyAdapter({ credentialProvider: async () => undefined })
    await expect(adapter.listModels(CODERLY.id)).resolves.toHaveLength(
      accessibleFallback.length,
    )
  })

  /**
   * ⑦ **没有凭据 ⇒ 零上游请求**。
   *
   * ⚠️ ④ 只断言了「结果仍是兜底表」，**没锁住请求数**：若实现改成「先打远端、
   * 失败再回退」，④ 照样绿，而用户会多收一个**注定 401 的请求**
   * （`/api/model-status` 要 Bearer，无凭据必然 401 —— 与本渠道推理那 401
   * 同形态，都是本仓库明令不发的东西）。
   *
   * ⇒ 本条把「无凭据 ⇒ 短路、直接回兜底表」钉成行为，不只是结果。
   */
  it('⑦ 没有凭据 ⇒ 零上游请求（无 Bearer 打目录端点注定 401）', async () => {
    let called = 0
    const adapter = new CodelyAdapter({
      credentialProvider: async () => undefined,
      fetchImpl: fakeFetch(() => {
        called += 1
        return { ok: false, status: 401, text: async () => 'unauthorized' }
      }),
    })
    await adapter.listModels(CODERLY.id)
    expect(called, '无凭据时不得打远端（那是注定 401 的请求）').toBe(0)
  })

  it('⑤ `listAllModels()` 同步且非空（冷缓存下 provider.status 直接读它）', () => {
    const adapter = new CodelyAdapter({})
    // ⚠️ 冷缓存下（从未跑过 `listModels`）也必须非空 —— `provider.status` 直接读它。
    expect(adapter.listAllModels().length).toBeGreaterThan(0)
  })


  it('⑥ `resolveModel` 对未知 id 也要给出非空名字', async () => {
    const adapter = new CodelyAdapter({})
    const resolved = await adapter.resolveModel(CODERLY.id, 'not-in-catalog')
    expect(resolved.name.length).toBeGreaterThan(0)
  })
})

/**
 * 推理：**驱动官方 CLI 子进程**（2026-10-20 接通）。
 *
 * ⚠️ 本组在签名密钥未取得的前提下成立：适配器自己**不发**推理 HTTP 请求
 * （那注定 401），而是让带合法签名逻辑的官方客户端去发，我们只消费输出。
 * 故这里没有「发请求」可断言，断言的是**输出转换与失败形态**。
 *
 * ⚠️ 历史提醒（防止有人把本组改回旧形态）：本组前身是「`stream()` 显式报
 * 错、零请求」两条 —— 通道接通后它们是**锁死已不存在形态的过时用例**，
 * 已按当时的注释约定删除（留着比没有更糟）。若将来改成自签 HTTP，
 * 应写「带 `X-Codely-Signature` 的真实请求」用例来替换，而不是复活旧断言。
 */
describe('Codely 适配器：推理（驱动官方 CLI）', () => {
  /** 收集一次 `stream()` 的全部 chunk。 */
  async function collect(adapter: CodelyAdapter, options: unknown): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(options as never)) chunks.push(chunk)
    return chunks
  }

  it('① 正常流：block-start → 若干 text-delta → block-end → finish', async () => {
    const { spawner } = fakeCli({
      stdout: [
        '{"type":"init","session_id":"s1","model":"codely-basic"}',
        '{"type":"message","role":"user","content":"hi","delta":false}',
        '{"type":"message","role":"assistant","content":"你","delta":true}',
        '{"type":"message","role":"assistant","content":"好","delta":true}',
        '{"type":"result","status":"success","stats":{"total_tokens":10,"duration_ms":2000}}',
      ].join('\n'),
    })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    const chunks = await collect(adapter, {
      model: 'codely-basic',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(chunks.map((c) => c.type)).toEqual([
      'block-start', 'text-delta', 'text-delta', 'block-end', 'finish',
    ])
    // ⚠️ 增量必须逐块透传（不是只在末尾一次性给全文）：否则用户看不到流式。
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)).toEqual(['你', '好'])
    expect(chunks.at(-2)).toMatchObject({ type: 'block-end', block: { type: 'text', text: '你好' } })
  })

  it('② 多轮历史被文本化成单条 prompt（role 前缀，顺序不丢）', async () => {
    const { spawner, args } = fakeCli({ stdout: '' })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    // 空 stdout ⇒ 无内容 ⇒ 抛 EMPTY_RESPONSE；本条只关心传给 CLI 的入参。
    await collect(adapter, {
      model: 'codely-basic',
      system: '你是助手',
      messages: [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: '第二句' },
        { role: 'user', content: '第三句' },
      ],
    }).catch(() => {})
    const promptArg = args()?.find((a) => a.startsWith('--prompt=')) ?? ''
    expect(promptArg).toContain('system: 你是助手')
    expect(promptArg).toContain('user: 第一句')
    expect(promptArg).toContain('assistant: 第二句')
    expect(promptArg).toContain('user: 第三句')
    // ⚠️ 顺序：system 在最前，历史按原序。
    expect(promptArg.indexOf('system:')).toBeLessThan(promptArg.indexOf('user: 第一句'))
  })

  it('③ 图片等非文本输入 ⇒ 明确报 UNSUPPORTED_CONTENT（不静默丢弃）', async () => {
    const { spawner } = fakeCli({ stdout: '' })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    await expect(collect(adapter, {
      model: 'codely-vl',
      messages: [{ role: 'user', content: [{ type: 'image', imageId: 'i1' }] }],
    })).rejects.toThrow(/只接受文本输入/)
  })

  it('④ CLI 未产出任何内容 ⇒ 报错，而不是返回空流', async () => {
    const { spawner } = fakeCli({ stdout: '' })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    await expect(collect(adapter, {
      model: 'codely-basic',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/未产出任何内容/)
  })

  it('⑤ CLI 非 0 退出 ⇒ 报错且带上 stderr 尾部（不静默空流）', async () => {
    const { spawner } = fakeCli({ stdout: '', stderr: 'No credentials found', exitCode: 1 })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    await expect(collect(adapter, {
      model: 'codely-basic',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/No credentials found/)
  })

  it('⑥ 找不到 CLI（环境变量指向不存在的路径）⇒ 报错并给出修法', async () => {
    const { spawner } = fakeCli({ stdout: '' })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      // ⚠️ 用一份**空** env：既避开本机默认路径存在这一事实，也避开环境变量
      //    泄漏导致的用例不稳定。
      cliEnv: { [CODERLY_CLI_PATH_ENV]: 'C:\\no\\such\\codely.exe' },
    })
    await expect(collect(adapter, {
      model: 'codely-basic',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(new RegExp(CODERLY_CLI_PATH_ENV))
  })

  it('⑦ 取消 ⇒ 杀掉子进程（不留孤儿进程）', async () => {
    const { spawner, wasKilled } = fakeCli({ stdout: '' })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    const controller = new AbortController()
    const running = collect(adapter, {
      model: 'codely-basic',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })
    controller.abort()
    // ⚠️ 先断言 kill、再等收尾：反过来写时，若实现卡在流上，用例会以
    //    「超时」结束而不是报出「没杀进程」，把真实原因盖掉。
    expect(wasKilled(), '取消时必须杀掉 CLI 子进程').toBe(true)
    await running.catch(() => {})
  })
})

/**
 * ★★ **HTTP 推理路径的 chunk 形状**（2026-10-22 对抗审计补 —— 此前**整片零覆盖**）。
 *
 * ## 为什么必须用真实 `BlockAssembler` 而不是断言 chunk 序列
 *
 * 本文件原有 5 条推理用例**全走 CLI 路径**（注入了 `cliSpawner`），HTTP 路径的
 * 输出形状**一条都没断言** ⇒ 对抗审计的 7 条变异（工具 index、不下发 tools、
 * finish 分类、停滞续拉、跳过 `hasUsableToolName`…）**全部 51 passed 全绿**。
 *
 * ⇒ 判据必须是「**把适配器产出的 chunk 真的喂给 `BlockAssembler`，看它组装出什么**」，
 *   而不是断言 chunk 长什么样 —— 因为缺陷恰恰出在「chunk 看起来没问题，但
 *   Assembler 按 index 幂等把它吞了」。
 *   ⚠️ 这个手法本仓 `aggregate-adapter.spec.ts:2024` 已经用过（并实测证伪过一版判据）。
 *
 * ## 修的那个真缺陷（P0）
 *
 * 上游 `delta.tool_calls[].index` 是**工具自己的** 0 起序号，而正文固定 `index: 0`、
 * 推理固定 `1`；`BlockAssembler` 的 `block-start` **只在 index 未见过时建 partial**
 * （且不更新 `blockType`）⇒ 同 index 的第二种块被**整条吞掉**。
 *
 * 修复前实测：
 * | 形态 | 组装结果 |
 * |---|---|
 * | 正文 + 1 工具 | `[text]` ← **工具消失** |
 * | 正文 + 2 工具 | `[text, tool(c1)]` ← **丢 c0** |
 * | 只有 1 工具 | `[tool]` ✅ |
 *
 * ⚠️ 而 `finish` 仍报 `tool-calls` ⇒ 宿主以为调了工具、blocks 里一个都没有
 *   ⇒ 回合停住、工具永不执行。
 */
describe('Codely 适配器：HTTP 推理的 chunk 形状（真实 BlockAssembler 组装）', () => {
  /** 造一个 `fetch` 替身：换发 cli_api_key 返 200，推理端点返给定 SSE 帧。 */
  function sseFetch(frames: readonly string[]): typeof fetch {
    return (async (url: string) => {
      if (String(url).includes('/api/api-token/cli-api-key')) {
        return {
          ok: true,
          status: 200,
          async json() { return { cli_api_key: 'sk-test', user_id: 1 } },
        }
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame))
          controller.close()
        },
      })
      return { ok: true, status: 200, body, headers: new Headers() }
    }) as unknown as typeof fetch
  }

  /** 走完整 `stream()`，把 chunk 收下来喂真实 `BlockAssembler`。 */
  async function assemble(frames: readonly string[]): Promise<Array<{ type: string; id?: string }>> {
    // ⚠️ `BlockAssembler` 从包**公开入口**导出（`lib/index.js`）—— 子路径
    //    `@deepseek-ai/dsh-llm/lib/types/assembler.js` 被 `package.json` 的
    //    `exports` 封了，vite 静态分析会在解析阶段就报 Missing specifier。
    const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
    const adapter = new CodelyAdapter({
      credentialProvider: async () => CREDENTIAL,
      fetchImpl: sseFetch(frames),
    })
    const asm = new (BlockAssembler as never as { new (): { push(c: unknown): void; assembled(): { blocks: unknown[] } } })()
    for await (const chunk of adapter.stream({
      model: 'codely-basic',
      messages: [{ role: 'user', content: '跑两个命令' }],
      tools: [{ name: 'run', description: 'x', parameters: { type: 'object', properties: {} } }],
    } as never)) {
      asm.push(chunk)
    }
    const { blocks } = asm.assembled()
    // ⚠️ `BlockAssembler.assemble()` 产出的 tool-call 块字段是 `id` / `name` /
    //    `arguments`（**不是** `toolCallId`）—— 见 `assembler.js` 的 `assemble()`。
    return blocks as Array<{ type: string; id?: string }>
  }

  const dataFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

  it('★★ 正文 + 1 个工具 ⇒ 工具**不得**被正文吞掉（原缺陷：tools 静默消失）', async () => {
    const blocks = await assemble([
      dataFrame({ choices: [{ delta: { content: '跑两个命令。' } }] }),
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'run', arguments: '{}' } }] } }] }),
      dataFrame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ])
    const types = blocks.map((b) => b.type)
    expect(types, '正文必须在').toContain('text')
    expect(types, '⚠️⚠️ 工具调用不得被正文的 index 吞掉').toContain('tool-call')
    expect(blocks.find((b) => b.type === 'tool-call')?.id).toBe('c0')
  })

  it('★★ 正文 + 2 个工具 ⇒ 两个工具都在（原缺陷：丢第一个）', async () => {
    const blocks = await assemble([
      dataFrame({ choices: [{ delta: { content: '跑两个命令。' } }] }),
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'run', arguments: '{}' } }] } }] }),
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'run', arguments: '{}' } }] } }] }),
      dataFrame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ])
    const ids = blocks.filter((b) => b.type === 'tool-call').map((b) => b.id)
    expect(ids, '⚠️⚠️ 两个工具都必须组装出来（原缺陷丢第一个）').toEqual(['c0', 'c1'])
  })

  it('★ 只有 1 个工具、没有正文 ⇒ 仍正常（这一格原本就是对的，防回归）', async () => {
    const blocks = await assemble([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'run', arguments: '{}' } }] } }] }),
      dataFrame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ])
    expect(blocks.filter((b) => b.type === 'tool-call').map((b) => b.id)).toEqual(['c0'])
  })
})

/**
 * ★★ **远端目录「读到了但被团队前缀过滤成空」必须回退兜底表**（2026-10-22 对抗审计 P1）。
 *
 * ## 修的那个真缺陷
 *
 * `catalogEntries()` 只判 `remoteModels === undefined` 才用兜底表，**没有**
 * 「远端读到但过滤后为空」这条腿 ⇒ 上游改命名、或该团队只被授权公共模型时，
 * 过滤结果 `[]` ⇒ **兜底表永不生效** ⇒ `listModels()` / `listAllModels()` 双双返回空。
 *
 * 实测（远端下发 `[{modelGroup:'DeepSeek-V4.1-Flash'},{modelGroup:'GLM-5.3-FLASH'}]`）：
 * 修复前 `listModels = []`、`listAllModels = []`；而「远端下发空数组」那格是正确回退的
 * ⇒ **「读到了但过滤后为空」与「模型全下架」同形**，面板显示「0 个模型」，
 * 与本仓反复记录的「空返回与无账号同形」完全同型，且**无日志无报错**。
 */
describe('Codely 适配器：远端目录全被团队前缀过滤掉 ⇒ 回退兜底表', () => {
  it('★★ 远端只下发公共模型 ⇒ 目录不得为空（回退兜底表 + 留一行 warn）', async () => {
    const warnings: string[] = []
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/api/model-status')) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              scope: 'public',
              models: [
                { modelGroup: 'DeepSeek-V4.1-Flash', status: 'operational' },
                { modelGroup: 'GLM-5.3-FLASH', status: 'operational' },
              ],
            })
          },
        }
      }
      return { ok: false, status: 404, async text() { return '' } }
    }) as unknown as typeof fetch
    const adapter = new CodelyAdapter({
      credentialProvider: async () => CREDENTIAL,
      fetchImpl,
      warn: (message: string) => { warnings.push(message) },
    })

    // ⚠️ 先触发一次目录读取（远端「成功」但不含任何 codely-* 前缀）。
    await adapter.listModels({} as never).catch(() => undefined)
    const all = adapter.listAllModels()
    expect(all.length, '⚠️⚠️ 目录不得为空（原缺陷：过滤成空后兜底表不生效）').toBeGreaterThan(0)
    expect(all.every((m) => m.id.toLowerCase().startsWith('codely-')), '回退的必须是兜底表里的 codely-* 模型').toBe(true)
    expect(warnings.some((w) => w.includes('过滤')), '必须留一行 warn（否则线上「0 个模型」且无日志）').toBe(true)
  })
})
