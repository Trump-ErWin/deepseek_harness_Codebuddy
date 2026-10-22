/**
 * `analyzeImage` 工具守卫（2026-10-21，用户诉求）。
 *
 * ## 为什么需要这个工具
 *
 * 用户原话：「继续做到 codearts 的只有文本的模型可以通过这个工具识图」，
 * 并明确「不需要直接选择 VL 模型（IDE 也不能选择）」。
 *
 * CodeArts 的文本模型（`glm-5.3` 等）**收不了图**（实测上游
 * `InferHub.001001020.406 The request model is not multimodal`），
 * 而 IDE 是两段式：挑一个 VL 模型看图 → 把文字交给主模型。
 *
 * ## ⚠️⚠️ 本文件守的最关键一件事：图片字节**不从 options.messages 拿**
 *
 * 纯文本模型发请求时，DSH 在 dispatch 前把图换成占位文字
 *（`dsh-llm/lib/index.js:2337`），适配器看到的已是文字。
 * 故工具必须从 `session.deriveMessages()`（**未投影**的派生历史）取 `attachment` 引用。
 *
 * ## 四条守卫
 *
 * | 守卫 | 若改坏 | 判据 |
 * |---|---|---|
 * | ① 只取**最后一条** user 消息的图 | 拿全历史 ⇒ 把上几轮的图也送去分析（答错图、费额度） | 造多轮带图历史，断言只拿到最后那轮 |
 * | ② 跳过 `offloaded` 块 | 送空图给上游 | 断言被排除 |
 * | ③ 路由判据：只给 codearts 的**文本**模型 | 给 VL 模型/别家也挂 ⇒ 多余往返或必然失败 | 四组输入逐格断言 |
 * | ④ 本轮没图时返回**可操作的文案** | 抛错或空串 ⇒ 模型不知道怎么办 | 断言含「重新附上」这类出路 |
 */
import { describe, expect, it } from 'vitest'
import {
  ANALYZE_IMAGE_MAX_IMAGES,
  ANALYZE_IMAGE_TOOL,
  collectTurnImages,
  imageDataUrl,
  runAnalyzeImage,
  shouldOfferAnalyzeImage,
  type AnalyzeImageDeps,
} from '../../src/analyze-image.js'
// ⚠️ 守卫 ⑪~⑬ 直接测共享序列化层（缺陷就在那一层，不在工具里）。
import { serializeMessages } from '../../src/openai-compat.js'

/** 造一条带图的 user 消息。 */
function userWithImages(
  images: Array<{ id: string; offloaded?: boolean }>,
  text = '这是什么',
): { role: string; content: unknown[] } {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map((image) => ({
        type: 'image',
        ...image.offloaded === true ? { offloaded: true } : {},
        attachment: { attachmentId: image.id, mediaType: 'image/png', bytes: 8, width: 8, height: 8 },
      })),
    ],
  }
}

/** 造一个只提供 deriveMessages 的 exec。 */
function execWith(messages: readonly { role: string; content: unknown[] }[]) {
  return {
    signal: new AbortController().signal,
    agent: { session: { deriveMessages: () => messages } },
  }
}

describe('analyzeImage：从会话历史取图', () => {
  /**
   * 守卫 ①：**只取最后一条 user 消息**里的图。
   *
   * ⚠️ 这是有判别力的关键：如果实现「遍历全部历史」，用户在多轮对话里问
   * 「这张图是什么」时，前几轮的图会被一起送去分析 —— 既慢又费额度，
   * 且模型很可能对着第一张图回答（答错图）。
   */
  it('① 只取最后一条 user 消息的图（不把上几轮的图也送去分析）', () => {
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
      userWithImages([{ id: 'old-1' }, { id: 'old-2' }], '第一轮的图'),
      { role: 'assistant', content: [{ type: 'text', text: '好' }] },
      userWithImages([{ id: 'new-1' }], '第二轮的图'),
    ]
    const images = collectTurnImages(messages)
    expect(images.map((i) => i.attachmentId)).toEqual(['new-1'])
  })

  /**
   * 守卫 ②：**跳过 `offloaded` 块**。
   *
   * ⚠️ `offloaded` 是 DSH 为省 token 做的图片卸载，字节可能已不在本地。
   * 把它送去分析只会得到一张空图（上游可能报错，也可能让模型编造）。
   */
  it('② 跳过被 offload 的图片块（字节可能已不在本地）', () => {
    const messages = [
      userWithImages([{ id: 'gone', offloaded: true }, { id: 'here' }]),
    ]
    expect(collectTurnImages(messages).map((i) => i.attachmentId)).toEqual(['here'])
  })

  /** 守卫 ②b：最后一条 user 消息**没图**时，不往前翻（避免拿上一轮凑数）。 */
  it('②b 最后一条 user 消息没有图时返回空（不拿上一轮的图凑数）', () => {
    const messages = [
      userWithImages([{ id: 'old' }], '上一轮'),
      { role: 'user', content: [{ type: 'text', text: '纯文字提问' }] },
    ]
    expect(collectTurnImages(messages)).toEqual([])
  })
})

describe('analyzeImage：路由判据', () => {
  /**
   * 守卫 ③：**只给 codearts 的、收不了图的模型**挂这个工具。
   *
   * 四格逐格断言，缺一格都可能放过真缺陷：
   * - 别家 provider → 不挂（它们图片直发上游）；
   * - codearts + VL 模型 → 不挂（自己就能看，挂上是多余往返）；
   * - codearts + 文本模型 → **挂**（这正是本工具的用途）；
   * - 路由不可判定 → 不挂（宁可少个工具，也不挂个用不了的）。
   */
  it('③ 只给 codearts 的纯文本模型挂（四格）', () => {
    const accepts = (id: string) => id === 'kimi-k2.6-vl'
    // 别家 provider
    expect(shouldOfferAnalyzeImage('buddy', 'glm-5.3', accepts)).toBe(false)
    // codearts + VL 模型
    expect(shouldOfferAnalyzeImage('codearts', 'kimi-k2.6-vl', accepts)).toBe(false)
    // codearts + 文本模型 ← 本工具的用途
    expect(shouldOfferAnalyzeImage('codearts', 'glm-5.3', accepts)).toBe(true)
    // 路由不可判定
    expect(shouldOfferAnalyzeImage(undefined, 'glm-5.3', accepts)).toBe(false)
    expect(shouldOfferAnalyzeImage('codearts', undefined, accepts)).toBe(false)
    expect(shouldOfferAnalyzeImage('codearts', '', accepts)).toBe(false)
  })

  /** 守卫 ③b：用**真实的** codearts 能力判据时，glm-5.3 命中、VL 模型不命中。 */
  it('③b 默认判据下 glm-5.3 需要工具、kimi-k2.6-vl 不需要', () => {
    expect(shouldOfferAnalyzeImage('codearts', 'glm-5.3')).toBe(true)
    expect(shouldOfferAnalyzeImage('codearts', 'kimi-k2.6-vl')).toBe(false)
    expect(shouldOfferAnalyzeImage('codearts', 'Qwen3-VL-235B')).toBe(false)
  })
})

describe('analyzeImage：执行路径', () => {
  /**
   * 守卫 ④：本轮没图时返回**可操作的文案**（不抛错、不返回空串）。
   *
   * ⚠️ 这条文案是**给模型看的出路**：让它去请用户重新发图，
   * 而不是反复重试这个工具（本仓对「文案本身就是出路」的错误一贯如此处理）。
   */
  it('④ 本轮没有图片时返回可操作的文案，而不是抛错或空串', async () => {
    const deps: AnalyzeImageDeps = {
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      describe: async () => '（不该被调用）',
    }
    const result = await runAnalyzeImage(execWith([{ role: 'user', content: [{ type: 'text', text: '你好' }] }]), deps)
    expect(result).toContain('没有找到图片')
    expect(result).toContain('重新附上')
  })

  /** 守卫 ⑤：**正常路径**把 data URL 交给 describe，并把结果原样返回。 */
  it('⑤ 有图时把 data URL 交给识图模型，并返回它的文字', async () => {
    let seen: readonly string[] = []
    let seenPrompt = ''
    const deps: AnalyzeImageDeps = {
      readImage: async () => ({ data: new Uint8Array([0x89, 0x50]), mediaType: 'image/png' }),
      describe: async (urls, prompt) => { seen = urls; seenPrompt = prompt; return '图里有一只猫' },
    }
    const result = await runAnalyzeImage(execWith([userWithImages([{ id: 'a' }])]), deps)
    expect(result).toBe('图里有一只猫')
    expect(seen).toHaveLength(1)
    // ⚠️ 必须是 data URL（上游只认这个形态，见 `codeartsImagePart` 的注释）。
    expect(seen[0]!.startsWith('data:image/png;base64,')).toBe(true)
    // 提示词要求「看不清就说看不清」，抑制 VL 模型编造（本仓有过幻觉实例）。
    expect(seenPrompt).toContain('不要编造')
  })

  /** 守卫 ⑥：**单张读失败不拖垮整次调用**，但要在结果里如实点名。 */
  it('⑥ 部分图片读不到字节时仍分析其余，并如实点名缺了几张', async () => {
    let calls = 0
    const deps: AnalyzeImageDeps = {
      readImage: async () => {
        calls += 1
        if (calls === 1) throw new Error('附件已被清理')
        return { data: new Uint8Array([1]), mediaType: 'image/png' }
      },
      describe: async () => '描述',
    }
    const result = await runAnalyzeImage(execWith([userWithImages([{ id: 'a' }, { id: 'b' }])]), deps)
    expect(result).toContain('描述')
    expect(result).toContain('1 张读不到字节')
  })

  /** 守卫 ⑦：**全部**读不到时给出明确出路（而不是把空数组交给上游）。 */
  it('⑦ 全部图片都读不到字节时不让上游白跑一趟', async () => {
    let describeCalled = false
    const deps: AnalyzeImageDeps = {
      readImage: async () => { throw new Error('nope') },
      describe: async () => { describeCalled = true; return '' },
    }
    const result = await runAnalyzeImage(execWith([userWithImages([{ id: 'a' }])]), deps)
    expect(describeCalled).toBe(false)
    expect(result).toContain('重新发送图片')
  })

  /** 守卫 ⑧：超过单次上限时**拒绝**（防止模型一次塞几十张把上游打爆）。 */
  it('⑧ 超过单次图片上限时拒绝并给出出路', async () => {
    const deps: AnalyzeImageDeps = {
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      describe: async () => '描述',
    }
    const many = Array.from({ length: ANALYZE_IMAGE_MAX_IMAGES + 1 }, (_, i) => ({ id: `i${i}` }))
    await expect(runAnalyzeImage(execWith([userWithImages(many)]), deps))
      .rejects.toThrow(/超过单次上限/)
  })

  /** 守卫 ⑨：`imageDataUrl` 形态（上游只认 base64 data URL）。 */
  it('⑨ imageDataUrl 产出 base64 data URL', () => {
    expect(imageDataUrl(new Uint8Array([0xff, 0x00]), 'image/webp'))
      .toBe('data:image/webp;base64,/wA=')
  })

  /** 工具名与 IDE 同名（模型在 IDE 语境下已熟悉）。 */
  it('⑩ 工具名是 analyzeImage（与 IDE 同名）', () => {
    expect(ANALYZE_IMAGE_TOOL).toBe('analyzeImage')
  })
})

/**
 * ⚠️⚠️ **已拼好的 `image_url` 块必须能穿过序列化层**（2026-10-22 真实缺陷）。
 *
 * ## 缺陷经过（真机验收时发现，不是审计想出来的）
 *
 * `analyzeImage` 的识图请求由**插件自己**构造：`describeWithVision` 把图片拼成
 * 上游要的 `{type:'image_url', image_url:{url}}` 后交给 `adapter.stream()`。
 * 而共享序列化器 `userContentParts` 当时**只认 harness 原生**
 * `{type:'image', attachment}`（去 `imageUrls` 表里查字节），对 `image_url`
 * **零命中** ⇒ 该块被**静默丢弃**。
 *
 * 症状极具误导性：HTTP 200、正文正常、上游无任何报错，只是 VL 模型回答
 * 「我看不到图片」—— 因为图确实没发出去。
 *
 * 另有一处同因的门禁：`serializeMessages` 里 `imageUrls === undefined` 时
 * **整段跳过** `userContentParts`，而识图请求**不传** `imageUrls` ⇒ 即使认了
 * `image_url` 也走不到。两处必须同修。
 *
 * ## 为什么原有用例没抓到
 *
 * 它们只测 `{type:'image', attachment}` 这条路（配 `imageUrls` 表）。
 * 「已拼好的块」是**另一条入口**，没有断言 ⇒ 缺陷从缝里漏过。
 */
describe('analyzeImage：已拼好的 image_url 必须穿过序列化层（真实缺陷）', () => {
  const url = 'data:image/png;base64,iVBORw0KGgo='

  /**
   * 守卫 ⑪：**不传 `imageUrls`**（识图请求的真实形态）时，`image_url` 块仍要到达 wire。
   *
   * ⚠️ 判据是「wire 里出现了那个 url」，不是「没报错」——后者恒真。
   */
  it('⑪ 不传 imageUrls 时 image_url 块仍出现在 wire 里', () => {
    const wire = serializeMessages([{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url } },
        { type: 'text', text: '这是什么颜色？' },
      ],
    }])
    const userMessage = wire.find((m) => m['role'] === 'user') as { content: unknown }
    const parts = userMessage.content as Array<{ type: string; image_url?: { url?: string }; text?: string }>
    expect(Array.isArray(parts)).toBe(true)
    // ⚠️ 判别力就在这里：块被丢弃时 parts 里只剩 text。
    expect(parts.some((p) => p.type === 'image_url' && p.image_url?.url === url)).toBe(true)
    expect(parts.some((p) => p.type === 'text' && p.text === '这是什么颜色？')).toBe(true)
  })

  /**
   * 守卫 ⑫：**原生 `{type:'image'}` 路径逐字节不变**（回归）。
   *
   * ⚠️ 修 ⑪ 时动了 `imageUrls === undefined` 那条门禁，必须证明老路径没被带坏。
   */
  it('⑫ 原生 image 块（配 imageUrls）仍产出 image_url', () => {
    const wire = serializeMessages([{
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png' } },
        { type: 'text', text: '看图' },
      ],
    }], new Map([['att-1', url]]))
    const userMessage = wire.find((m) => m['role'] === 'user') as { content: unknown }
    const parts = userMessage.content as Array<{ type: string; image_url?: { url?: string } }>
    expect(parts.some((p) => p.type === 'image_url' && p.image_url?.url === url)).toBe(true)
  })

  /**
   * 守卫 ⑬：**纯文本消息仍是字符串形态**（上游会 400 拒收包装形态）。
   *
   * ⚠️ 这条防的是「为了修图片而把所有消息都包装成 parts」——实测上游
   * `model_param_invalid` 400 拒收整个请求。
   */
  it('⑬ 纯文本 user 消息仍保持字符串 content（不因本次修复被包装）', () => {
    const wire = serializeMessages([{ role: 'user', content: [{ type: 'text', text: '只有文字' }] }])
    const userMessage = wire.find((m) => m['role'] === 'user') as { content: unknown }
    expect(typeof userMessage.content).toBe('string')
    expect(userMessage.content).toBe('只有文字')
  })
})
