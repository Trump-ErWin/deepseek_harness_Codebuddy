/** TRAE 各错误类别的冷却时长（毫秒）。供 trae-adapter.ts 的轮换循环使用。
 *
 * ## 为什么按类别（2026-09-26 修）
 *
 * 原实现一律用 `TRAE_RATE_LIMIT_FALLBACK_MS`（1 小时兜底）。但错误类别的"自然恢复周期"差好几个量级：
 *   · quota-exceeded（4008，ide_credits **月度**耗尽）→ 1 小时后照样是 0 额度，
 *     耗尽的账号每小时被选回一次 ⇒ 用户看到「轮换好像不行，每次都我手动切」；
 *   · soft-rate（4011 频率超限）→ 分钟级就该恢复，1 小时反而浪费账号。
 * 所以：月度级耗尽记 7 天（覆盖到下次配额重置），频率类记 1 小时兜底。
 * 上游响应若给出明确重置时间应以那个为准；4008 没有可靠的重置字段，改的是兜底值。
 */
export const TRAE_COOLDOWN_MS: Record<string, number> = {
  /** 配额耗尽：日配额（用户确认日重置）⇒ 24 小时。 */
  'quota-exceeded': 24 * 3_600_000,
  /** Plan 权益不足：同样不会自己好，7 天。 */
  'hard-plan': 7 * 24 * 3_600_000,
  /** 频率超限：1 小时兜底。 */
  'soft-rate': 3_600_000,
  /** 404：1 小时（可能是暂时性路由问题）。 */
  'not-found': 3_600_000,
  /** 会话死亡：不靠冷却恢复（只能重登），记 0。 */
  'session-dead': 0,
  /** 5xx：1 小时。 */
  'server': 3_600_000,
  /** 4xx（其他）：1 小时。 */
  'client': 3_600_000,
  'none': 0,
}

/** 按类别取冷却时长；未知类别回落 1 小时（保守，与旧行为一致）。 */
export function traeCooldownFor(kind: string): number {
  return TRAE_COOLDOWN_MS[kind] ?? 3_600_000
}
