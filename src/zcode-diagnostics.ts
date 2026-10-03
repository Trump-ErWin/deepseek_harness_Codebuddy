/**
 * ZCode 的**可观测诊断**：为 `3012` 这类「只有一句话、没有第二条信息」的错误
 * 补齐排查所需的现场数据。
 *
 * ## 为什么需要它（Gitee issue IKJI0Y）
 *
 * `3012 unusual activity` 的既有文案只有**固定句 + 原始响应**。用户遇到时
 * 只能确认一件事：「我猜的请求体大概是对的」。剩下全是猜：
 *
 * - 本次是账号池里**第几个账号**？（分不清是账号自身被标记，还是恰好轮到它）
 * - 这个账号此前**成功过几次**？**最近一次成功**是什么时候？
 *   —— 这两条决定「一直如此」还是「突然开始」，两者的排查方向完全不同；
 * - **实际发出**的身份块有多少字符？首轮 user 到底带没带日期块？
 * - 本次距**上一条** zcode 请求隔了多久？（频率风控的唯一直观证据）
 *
 * ## 三条设计红线
 *
 * 1. **绝不写凭据**。账号只以「进程内自增序号」出现（{@link accountOrdinal}），
 *    不含 accountId、JWT、device_mid、账号名中的任何一个字符片段。
 *    回归用例用「凭据标识的每个子串都不得出现在文案里」来钉死这条。
 * 2. **只诊断「实际发出的请求体」**，不诊断「我们以为发出了什么」。
 *    {@link describeZcodeRequestShape} 直接读已构造好的 `system` / `messages`
 *    —— 这样一旦真出现「身份块没进去」，诊断会**如实显示 0 字符**，
 *    而不是显示常量里的 2898 把问题盖住。
 * 3. **进程级、不落盘**。与 {@link file://./captcha-requirement.ts} 同口径：
 *    `$DSH_HOME/jet-hub/state.json` 是同机多 profile 共享的 home 级文档，
 *    落盘会把一个 profile 的账号画像传染给另一个。
 */

/** 账号的进程级画像。key 与 {@link accountOrdinal} 用的是同一个。 */
interface AccountProfile {
  /** 进程内自增序号（1 起），**不含任何凭据派生信息**。 */
  ordinal: number
  /** 已发出的请求数。 */
  sent: number
  /** 拿到 HTTP 2xx 的次数。 */
  ok: number
  /** 拿到 HTTP 非 2xx 的次数。 */
  failed: number
  /** 最近一次成功时刻（毫秒）。从未成功为 undefined。 */
  lastOkAt: number | undefined
  /** 最近一次「发出请求」的时刻（毫秒）。 */
  lastSentAt: number | undefined
  /**
   * **上上条**发出请求的时刻（毫秒）—— 即「距上一条」的分母。
   *
   * ⚠⚠ 必须与 `lastSentAt` 分开存，**不能拿 `lastSentAt` 顶替**：
   * 适配器的调用顺序是「先 {@link noteZcodeRequestSent} 记本次、再在失败时
   * {@link formatZcodeDiagnostic} 诊断」，两者用的是同一个 `sentAt`
   * ⇒ 若诊断时读 `lastSentAt`，算出来恒为 `0ms`，这一项就永远没有信息量
   * （写脚本做端到端验证时真的打印出过 `距上条 0ms`）。
   */
  previousSentAt: number | undefined
}

const profiles = new Map<string, AccountProfile>()
let nextOrdinal = 1

/** 空/缺失的账号 id 归一成 `-`（与 `captchaRequirementKey` 同口径）。 */
function normalizeKey(accountId: string | undefined): string {
  return accountId === undefined || accountId === '' ? '-' : accountId
}

/**
 * 取账号的进程内序号，**首次见到时分配**（之后稳定不变）。
 *
 * ⚠ 同一个账号在多次请求里拿到同一个序号 —— 否则「本次是第几个账号」这句话
 * 会随请求变化，跨请求对比就失去意义（这正是 issue 要解决的问题）。
 */
export function accountOrdinal(accountId: string | undefined): number {
  const key = normalizeKey(accountId)
  const existing = profiles.get(key)
  if (existing !== undefined) return existing.ordinal
  const profile: AccountProfile = {
    ordinal: nextOrdinal,
    sent: 0,
    ok: 0,
    failed: 0,
    lastOkAt: undefined,
    lastSentAt: undefined,
    previousSentAt: undefined,
  }
  nextOrdinal += 1
  profiles.set(key, profile)
  return profile.ordinal
}

/**
 * 记一次「请求已发出」。
 *
 * @param sentAt 本次的出发时刻（毫秒）。**在真正 `fetch` 之前取**，
 *   否则算出来的「距上一条」会把本次的排队/等待时间算进去。
 */
export function noteZcodeRequestSent(accountId: string | undefined, sentAt: number): void {
  const key = normalizeKey(accountId)
  accountOrdinal(accountId)
  const profile = profiles.get(key)
  if (profile === undefined) return
  profile.sent += 1
  // ⚠ 旧值下沉一格再写新的 —— 诊断要的「距上条」是**上一条**，不是本次。
  profile.previousSentAt = profile.lastSentAt
  profile.lastSentAt = sentAt
}

/** 记一次成功（拿到 HTTP 2xx）。 */
export function noteZcodeRequestOk(accountId: string | undefined, at: number): void {
  const profile = profiles.get(normalizeKey(accountId))
  if (profile === undefined) return
  profile.ok += 1
  profile.lastOkAt = at
}

/** 记一次失败（HTTP 非 2xx）。 */
export function noteZcodeRequestFailed(accountId: string | undefined): void {
  const profile = profiles.get(normalizeKey(accountId))
  if (profile === undefined) return
  profile.failed += 1
}

/**
 * 把毫秒差写成一眼能读的形态。
 *
 * ⚠ 秒以上的换算**逐档单独写过**：初版把分钟档写成
 * `${Math.floor(seconds % 60)}分…`，于是 90 秒被渲染成「30分30秒」
 * —— 分位取的是**秒的余数**而不是已算好的分钟数。
 * 这个错误是在**真实探针输出**里发现的（「最近成功 29分29秒前」），
 * 纯函数单测当时没覆盖到 ≥60 秒的区间。
 */
function formatGap(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) {
    const rest = totalSeconds % 60
    return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`
  }
  const hours = Math.floor(minutes / 60)
  const restMin = minutes % 60
  return restMin === 0 ? `${hours}小时` : `${hours}小时${restMin}分`
}

/** 「最近一次成功距今」的文案（从未成功过要如实说「无」，不写 0）。 */
function formatSinceLastOk(at: number | undefined, now: number): string {
  return at === undefined ? '从未成功过' : `${formatGap(now - at)}前`
}

/**
 * 请求体形态的实测描述 —— **读的是真正要发出去的那个对象**。
 *
 * ⚠ 这里刻意**不读** `OFFICIAL_IDENTITY_CHARS` 常量：常量只能证明
 * 「源码里写了多少字」，证明不了「线上发出去多少字」。两者一旦不一致
 * （例如某条改动把 `system` 顶掉了），只有读实际值才看得出来。
 */
export interface ZcodeRequestShape {
  /** `system` 块数组的块数（不是数组则 0）。 */
  systemBlocks: number
  /** 前两块（官方身份块）的字符数合计。 */
  identityChars: number
  /** 逐块的字符数（异常时能看出是哪一块短了）。 */
  identityBlockChars: readonly number[]
  /** 第一块（cliPrefix）的字符数。 */
  cliPrefixChars: number
  /** 首条 user 消息是否带 `<system-reminder>` 日期块。 */
  hasDateBlock: boolean
  /** 首条消息的 role（诊断「历史首条不是 user」这类异常）。 */
  firstRole: string
}

/** 取一个 system 块的 text 长度（非 text 块记 0）。 */
function blockChars(block: unknown): number {
  if (typeof block !== 'object' || block === null) return 0
  const text = (block as { text?: unknown }).text
  return typeof text === 'string' ? text.length : 0
}

/** 从已构造好的请求体里抽出形态信息。 */
export function describeZcodeRequestShape(
  system: unknown,
  messages: unknown,
): ZcodeRequestShape {
  const blocks = Array.isArray(system) ? system : []
  const identityBlockChars = blocks.slice(0, 2).map(blockChars)
  const first = Array.isArray(messages) && messages.length > 0
    ? messages[0]
    : undefined
  const firstRecord = (typeof first === 'object' && first !== null)
    ? first as { role?: unknown, content?: unknown }
    : {}
  const content = firstRecord.content
  const firstContentBlock = Array.isArray(content) && content.length > 0 ? content[0] : undefined
  const firstText = (typeof firstContentBlock === 'object' && firstContentBlock !== null)
    ? (firstContentBlock as { text?: unknown }).text
    : undefined
  return {
    systemBlocks: blocks.length,
    identityChars: identityBlockChars.reduce((sum, n) => sum + n, 0),
    identityBlockChars,
    cliPrefixChars: identityBlockChars[0] ?? 0,
    hasDateBlock: typeof firstText === 'string' && firstText.startsWith('<system-reminder>'),
    firstRole: typeof firstRecord.role === 'string' ? firstRecord.role : '(无)',
  }
}

/** 传给 {@link formatZcodeDiagnostic} 的现场快照。 */
export interface ZcodeDiagnosticInput {
  /** 本次使用的账号（只用于取序号与画像，不进文案）。 */
  accountId: string | undefined
  /** 本次请求的出发时刻（毫秒）。 */
  sentAt: number
  /** 上游 HTTP 状态码。 */
  status: number
  /** 实际发出的请求体形态。 */
  shape: ZcodeRequestShape
  /** 取当前时刻（可注入，便于单测）。 */
  now: number
}

/**
 * 把现场数据渲染成一行**不含任何凭据**的诊断摘要。
 *
 * ⚠ 字段顺序按 issue 的建议排：账号序号 → 计数 → 字符数 → 间隔 ——
 * 「最常被怀疑的」在前，「最容易被忽略的」在后。
 */
export function formatZcodeDiagnostic(input: ZcodeDiagnosticInput): string {
  const key = normalizeKey(input.accountId)
  const profile = profiles.get(key)
  const ordinal = profile?.ordinal ?? accountOrdinal(input.accountId)
  const gap = profile?.previousSentAt === undefined
    ? '—'
    : formatGap(input.sentAt - profile.previousSentAt)
  const blocks = input.shape.identityBlockChars.length > 0
    ? input.shape.identityBlockChars.join('+')
    : '无'
  return [
    `账号#${ordinal}`,
    `本进程 成功 ${profile?.ok ?? 0}/失败 ${profile?.failed ?? 0}`,
    `最近成功 ${formatSinceLastOk(profile?.lastOkAt, input.now)}`,
    `距上条 ${gap}`,
    `身份块 ${input.shape.identityChars} 字符(${blocks})`,
    `日期块 ${input.shape.hasDateBlock ? '有' : '无'}`,
    `HTTP ${input.status}`,
  ].join(' · ')
}

/**
 * 清空全部进程级状态（**只给单测的 `beforeEach` 用**）。
 *
 * ⚠ 与 `resetCaptchaRequirementMemory()` 同款：序号分配器也一并归零，
 * 否则同一进程里跑两轮用例会拿到不同的 `账号#N`，断言就得写成相对值。
 */
export function resetZcodeDiagnostics(): void {
  profiles.clear()
  nextOrdinal = 1
}
