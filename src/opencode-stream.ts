/**
 * V2 响应边界：在共享 SSE 消费器建块之前还原工具名、归一缺失的 index。
 * 不能在 block-end 才还原：早期 delta 的别名或保留工具已经可能被宿主执行。
 * 名字跨帧拼接，参数仍逐帧交给消费器；未知/保留/残缺名字 fail-closed。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { FREE_LANE_GATE_TOOLS, type OpencodeRequestShape } from './opencode-messages.js'

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : undefined
}

interface CallState {
  index: number
  id?: string
  upstreamName: string
  restored: boolean
  hasArguments: boolean
}
interface ChoiceState {
  calls: CallState[]
  byId: Map<string, CallState>
  byIndex: Map<number, CallState>
  current?: CallState
  legacy?: CallState
  finished: boolean
}

export function createOpencodeFrameNormalizer(request: Pick<OpencodeRequestShape, 'toolAliases' | 'toolsDisabled'>): {
  transformFrame: (frame: RecordValue) => void
  assertComplete: () => void
} {
  const choices = new Map<number, ChoiceState>()
  const aliases = request.toolAliases
  const candidates = [...aliases.keys(), ...FREE_LANE_GATE_TOOLS]
  const fail = (detail: string): never => {
    // 不用 AUTH/QUOTA：客户端会吞掉具体文案；不标记账号、不换槽重发同一坏调用。
    throw new LlmError(`opencode: ${detail}`, 'PERMISSION_DENIED')
  }
  const stateOf = (index: number): ChoiceState => {
    let state = choices.get(index)
    if (state === undefined) {
      state = { calls: [], byId: new Map(), byIndex: new Map(), finished: false }
      choices.set(index, state)
    }
    return state
  }
  const newCall = (state: ChoiceState): CallState => {
    const call = { index: state.calls.length, upstreamName: '', restored: false, hasArguments: false }
    state.calls.push(call)
    return call
  }
  const targetOf = (state: ChoiceState, call: RecordValue): CallState => {
    const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined
    const rawIndex = Number.isSafeInteger(call.index) && (call.index as number) >= 0 ? call.index as number : undefined
    let target = id === undefined ? undefined : state.byId.get(id)
    if (target === undefined && rawIndex !== undefined) {
      target = state.byIndex.get(rawIndex)
      // 无 index 首帧后续补 index：优先按 id，否则按隐式创建序号绑定。
      const candidate = state.calls[rawIndex]
      if (target === undefined && candidate !== undefined && (id === undefined || candidate.id === undefined)) target = candidate
    }
    const fn = record(call.function)
    if (target === undefined && rawIndex === undefined && id === undefined) {
      // 带分片 name 的续传也必须回到当前调用，不能误建一条新调用。
      if (state.current !== undefined && (!state.current.restored || !fn?.name)) target = state.current
    }
    target ??= newCall(state)
    if (id !== undefined) {
      if (target.id !== undefined && target.id !== id) fail('上游工具调用身份冲突')
      target.id = id
      state.byId.set(id, target)
    }
    if (rawIndex !== undefined) {
      const existing = state.byIndex.get(rawIndex)
      if (existing !== undefined && existing !== target) fail('上游工具调用下标冲突')
      state.byIndex.set(rawIndex, target)
    }
    state.current = target
    return target
  }
  const restore = (fn: RecordValue, target: CallState): RecordValue => {
    const fragment = typeof fn.name === 'string' ? fn.name : ''
    if (fragment && fragment !== target.upstreamName) {
      if (target.restored) fail('上游在工具名称已确定后更改了名称')
      target.upstreamName += fragment
    }
    const name = target.upstreamName
    const next = { ...fn }
    delete next.name
    const exact = aliases.get(name)
    const longer = candidates.some((candidate) => candidate !== name && candidate.startsWith(name))
    target.hasArguments ||= typeof fn.arguments === 'string' && fn.arguments.length > 0
    if (exact !== undefined && (!longer || target.hasArguments || target.restored)) {
      if (!target.restored) next.name = exact
      target.restored = true
      return next
    }
    if (!longer && (FREE_LANE_GATE_TOOLS as readonly string[]).includes(name)) {
      fail(`上游调用了保留门禁工具 ${name}，已阻止执行`)
    }
    if (name && !candidates.some((candidate) => candidate.startsWith(name))) fail(`上游返回了未声明的工具名 ${name}`)
    return next
  }
  const assertState = (state: ChoiceState): void => {
    if (state.calls.some((call) => !call.restored)) fail('上游工具名称不完整，已阻止执行')
  }
  return {
    transformFrame(frame): void {
      if (!Array.isArray(frame.choices)) return
      for (const raw of frame.choices) {
        const choice = record(raw)
        if (choice === undefined) continue
        const index = Number.isSafeInteger(choice.index) ? choice.index as number : 0
        const state = stateOf(index)
        if (state.finished) {
          // 已完成 choice 的迟到帧只保留顶层 usage，不重新打开工具块。
          delete choice.delta
          continue
        }
        const delta = record(choice.delta)
        const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
        const legacy = record(delta?.function_call)
        if (request.toolsDisabled && (calls.length > 0 || legacy !== undefined
          || choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call')) {
          fail('本次请求未启用客户端工具，但上游返回了工具调用，已阻止执行')
        }
        if (delta !== undefined) {
          const normalized: RecordValue[] = calls.map((rawCall: unknown) => {
            const call = record(rawCall)
            if (call === undefined) fail('上游返回了畸形工具调用')
            const target = targetOf(state, call!)
            const fn = record(call!.function) ?? {}
            return { ...call, index: target.index, function: restore(fn, target) }
          })
          // 兼容旧 function_call 帧：统一交给共享 tool_calls 消费器，不丢参数。
          if (legacy !== undefined) {
            state.legacy ??= newCall(state)
            normalized.push({ index: state.legacy.index, id: `call_legacy_${index}`, function: restore(legacy, state.legacy) })
            delete delta.function_call
          }
          if (normalized.length > 0) delta.tool_calls = normalized
        }
        if (choice.finish_reason) {
          assertState(state)
          state.finished = true
        }
      }
    },
    assertComplete(): void {
      for (const state of choices.values()) assertState(state)
    },
  }
}

/**
 * OpenCode 专用 SSE 前置流，不改共享消费器，也不缓冲整条响应。
 * 只在完整 SSE 事件边界改写 JSON；正文/思考/usage 字段仍由共享消费器原样处理。
 * pipeThrough 保留背压与取消传播，调用方停止消费时上游连接也会被取消。
 */
export function normalizeOpencodeResponse(response: Response, request: Pick<OpencodeRequestShape, 'toolAliases' | 'toolsDisabled'>): Response {
  if (response.body === null) return response
  const normalizer = createOpencodeFrameNormalizer(request)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let lines: string[] = []
  let format: 'sse' | 'raw' | undefined
  const emit = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (lines.length === 0) return
    const original = lines.join('\n')
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim()
    let output = original
    if (data === '[DONE]') normalizer.assertComplete()
    else if (data) {
      let parsed: unknown
      try { parsed = JSON.parse(data) } catch { /* 非 JSON 留给共享消费器诊断。 */ }
      const frame = record(parsed)
      if (frame !== undefined) {
        normalizer.transformFrame(frame)
        const metadata = lines.filter((line) => !line.startsWith('data:'))
        output = [...metadata, `data: ${JSON.stringify(frame)}`].join('\n')
      }
    }
    controller.enqueue(encoder.encode(`${output}\n\n`))
    lines = []
  }
  const takeLines = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') emit(controller)
      else lines.push(line)
    }
  }
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      if (format === undefined && buffer.trimStart()) {
        // HTTP 200 + 裸 JSON/HTML 错误也可能不结束；立即透传给共享消费器诊断。
        format = /^[{[<]/.test(buffer.trimStart()) ? 'raw' : 'sse'
      }
      if (format === 'raw') {
        controller.enqueue(encoder.encode(buffer))
        buffer = ''
        return
      }
      takeLines(controller)
    },
    flush(controller) {
      buffer += decoder.decode()
      if (format === 'raw') {
        if (buffer) controller.enqueue(encoder.encode(buffer))
        return
      }
      takeLines(controller)
      if (buffer) lines.push(buffer.replace(/\r$/, ''))
      emit(controller)
      normalizer.assertComplete()
    },
  }))
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
