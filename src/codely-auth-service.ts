/**
 * Codely 的 auth 服务对象（供 `JetHubAuths` 与 `auth.refreshAll` 接线）。
 *
 * ## 为什么需要它
 *
 * `channel: true` 会把 Codely 纳入三张派生判据（应有 auth / 应可续期 /
 * 应进聚合目录）。其中「续期分派」要求 `authOf(auths, 'codely')` 返回一个
 * **带 `refreshAccountCredential` 的对象**，否则该渠道永不自动续期且日志零字
 * （issue IKKHL5 的形态）。
 *
 * ## 续期语义（2026-10-20 实测）
 *
 * Codely 有两层凭证：
 * - `access_token`：登录态（JWT，约 365 天），**可续期** ——
 *   `POST /auth/refresh {refresh_token}` → `{access_token, refresh_token}`，
 *   ⚠️ `refresh_token` **不轮换**（连续三次调用返回同值，实测）；
 * - `cli_api_key`：推理用（`sk-…`），**每次调用换发、无需缓存**
 *   （`fetchCodelyCliApiKey`）⇒ 本服务**不续期它**。
 *
 * ⇒ 「续期」只刷新 `access_token`，成功后写回凭据库。
 */

import {
  CODELY_API_BASE,
  CODELY_USER_AGENT_HEADER,
  readCodelyCredential,
  type CodelyCredential,
} from './codely-auth.js'

/** 凭据库最小接口（与 `readCodelyCredential` 同形）。 */
interface CredentialStoreLike {
  resolve(ref: string): Promise<{ value?: string } | undefined>
  set(ref: string, value: string): Promise<void>
}

/**
 * 用 `refresh_token` 换新的 `access_token`。
 *
 * ⚠️ 不需要 Bearer（实测：只带 JSON 头 + 身份头即可）；
 * ⚠️ 失败返回 `undefined`（调用方在续期路径上，抛错会被误报成"凭据失效"）。
 */
export async function refreshCodelyCredential(
  refreshToken: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ accessToken: string; refreshToken: string } | undefined> {
  if (refreshToken.length === 0) return undefined
  const fetcher = options.fetcher ?? fetch
  try {
    const res = await fetcher(`${CODELY_API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-User-Agent': CODELY_USER_AGENT_HEADER,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (!res.ok) return undefined
    const payload = await res.json().catch(() => undefined) as
      | { access_token?: unknown; refresh_token?: unknown }
      | undefined
    const accessToken = payload?.access_token
    if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined
    // ⚠️ 响应里的 refresh_token 与传入的相同（不轮换），缺省时沿用旧值
    const nextRefresh = typeof payload?.refresh_token === 'string' && payload.refresh_token.length > 0
      ? payload.refresh_token
      : refreshToken
    return { accessToken, refreshToken: nextRefresh }
  } catch {
    return undefined
  }
}

/**
 * Codely 的 auth 服务（`JetHubAuths.codely` 的值）。
 *
 * 刻意只做「续期 access_token + 写回凭据库」两件事：`cli_api_key` 是派生品、
 * 每请求换发，不需要缓存，也不需要回写池（池里的 `expiresAt` 跟随 access_token）。
 */
export class CodelyAuth {
  constructor(
    private readonly options: {
      credentials?: CredentialStoreLike
      fetcher?: typeof fetch
      /** 回写池条目有效期（可选；缺省不写，保持"尽力而为"）。 */
      writebackExpiry?: (accountId: string, expiresAtMs: number | undefined) => Promise<void>
    } = {},
  ) {}

  /**
   * 续期某一个账号（守卫要求的方法）。
   *
   * @param refName 凭据 ref（`codely.account.<id>` 之类，直接交给凭据库）
   * @param _accountId 池里的账号 id（用于可选的池回写）
   */
  async refreshAccountCredential(
    refName: string,
    _pool: unknown,
    accountId: string,
  ): Promise<void> {
    const store = this.options.credentials
    if (store === undefined) return
    const current = await readCodelyCredential(refName, store)
    if (current === undefined || current.refresh_token.length === 0) return
    const next = await refreshCodelyCredential(current.refresh_token, {
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
    })
    if (next === undefined) return
    const updated: CodelyCredential = {
      ...current,
      access_token: next.accessToken,
      refresh_token: next.refreshToken,
      obtained_at: Date.now(),
    }
    try {
      await store.set(refName, JSON.stringify(updated))
    } catch { /* 写回失败不阻断续期流程 */ }
    if (this.options.writebackExpiry !== undefined) {
      await this.options.writebackExpiry(accountId, expiryMsOf(next.accessToken)).catch(() => {})
    }
  }

  /**
   * 批量续期（`auth.refreshAll` 接线用）。
   *
   * ⚠️ **必须逐个账号经 `refreshOne`**（不能直接调裸函数）：否则池里的
   * `expiresAt` 不回写，界面有效期停在旧值（officeace 记过同款缺陷）。
   * ⚠️ 读池抛错/空池 ⇒ 静默返回（一个渠道的池抖动不该让整轮续期炸掉）。
   */
  async refreshAll(
    pool: unknown,
    refreshOne: (account: { id: string; credentialRef: string }) => Promise<void>,
  ): Promise<void> {
    let accounts: readonly { id: string; credentialRef: string }[] = []
    try {
      const listed = (pool as { listAccountsByProvider?: (id: string) => unknown } | undefined)
        ?.listAccountsByProvider?.('codely')
      const resolved = await listed
      if (Array.isArray(resolved)) {
        accounts = resolved as { id: string; credentialRef: string }[]
      }
    } catch {
      return
    }
    for (const account of accounts) {
      await refreshOne(account).catch(() => undefined)
    }
  }
}

/** 从 JWT 的 `exp` 取毫秒（失败返回 undefined，不编造）。 */
function expiryMsOf(jwt: string): number | undefined {
  const parts = jwt.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' && payload.exp > 0 ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}
