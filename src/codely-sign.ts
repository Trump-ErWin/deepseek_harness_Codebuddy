/**
 * Codely 推理网关的请求签名（`X-Codely-Signature`）。
 *
 * ## 算法（2026-10-20 实测确认，真凭据 → **200 + 非空内容**）
 *
 * ```
 * signingKey = HMAC_SHA256( HMAC_SHA256(SECRET, "codely-signing-v1"), cli_api_key )
 * sig        = HMAC_SHA256( signingKey, ["v1", pathname, ts].join("\n") ).base64url
 * header     = `v1.${ts}.${sig}`          // ts = 秒级时间戳
 * ```
 *
 * ## ⚠️⚠️ 分隔符是 **LF（`\n`）**，这三条历史坑必须留在注释里
 *
 * 1. 官方 CLI 二进制（`1.0.0-release.57`）里那段明文 JS 是
 *    `["v1", path, ts].join("|")` —— **它是未生效/旧版代码**，
 *    按它签名一定 401（我按 `|` 试过全部派生与消息串组合，17 万+ 全不中）；
 * 2. 官方 npm 包（`@unity-china/codely-cli@1.0.0-rc.60`）里是 `join("\r\n")`，
 *    但那是**转义展示**的写法，真实字节是 LF；
 * 3. 按 `\r\n` 签名 → **401**；按 `\n` 签名 → **200**（同一 key、同一 ts 实测对照）。
 *
 * ⇒ 这条差异是**一字节级**的，任何"看起来等价"的重构（改成 `join('|')`、
 *   `join(os.EOL)`、或先拼数组再 `join()` 不带参数）都会让整条通道静默失效。
 *   `tests/unit/codely-sign.spec.ts` 用固定向量把 LF 钉死。
 *
 * ## 为什么 SECRET 是硬编码常量而不是配置
 *
 * 它来自官方客户端的编译产物（`Buffer.from(hex, "hex")`），对**所有用户相同**；
 * 真正的按账号隔离靠 `cli_api_key`（每个账号自己换发）⇒ 两段派生缺一不可。
 */

import { createHmac } from 'node:crypto'

/**
 * 官方客户端的签名根密钥（32 字节，全客户端共用）。
 *
 * ⚠️ 与 npm 包 `@unity-china/codely-cli` 的 `jEf` 常量**逐字节一致**
 * （二进制里也一致），不是猜测值。
 */
export const CODELY_SIGNING_SECRET = Buffer.from(
  '406f00f74768ba0cb0cd30f097ec6c2bdacb89c61a38b7dd140838bbd0e98018',
  'hex',
)

/** 第一段派生的盐（改它 = 换协议版本）。 */
export const CODELY_SIGNING_SALT = 'codely-signing-v1'

/**
 * 推理请求的 `User-Agent`。
 *
 * ⚠️ 必须**逐字**是客户端自报的形态：实测用 `codely-vscode/4.3.0`
 * （目录端点那份）打推理会被 401，用这一份才 200。上游对 UA 有校验。
 */
export const CODELY_CLI_USER_AGENT = 'codely-cli/1.0.0-release.57 (win32; x64)'

/**
 * 派生 per-account 签名密钥：`HMAC(HMAC(SECRET, salt), cli_api_key)`。
 *
 * @param cliApiKey 换发得到的 `sk-…`（**不是** access_token）
 */
export function codelySigningKey(cliApiKey: string): Buffer {
  const stage1 = createHmac('sha256', CODELY_SIGNING_SECRET).update(CODELY_SIGNING_SALT).digest()
  return createHmac('sha256', stage1).update(cliApiKey).digest()
}

/** 归一化 pathname（签名只覆盖 path，不含 query）。 */
function pathnameOf(url: string | URL): string {
  try {
    return new URL(String(url)).pathname
  } catch {
    return String(url)
  }
}

/**
 * 计算 `X-Codely-Signature` 头的值。
 *
 * @param cliApiKey 该账号的 `cli_api_key`
 * @param target 目标 URL（只取其 `pathname`）
 * @param timestampMs 时间戳（毫秒；内部取秒）——测试注入用
 */
export function codelySignatureHeader(
  cliApiKey: string,
  target: string | URL,
  timestampMs: number = Date.now(),
): string {
  const ts = String(Math.floor(timestampMs / 1000))
  const msg = ['v1', pathnameOf(target), ts].join('\n')
  const sig = createHmac('sha256', codelySigningKey(cliApiKey)).update(msg).digest('base64url')
  return `v1.${ts}.${sig}`
}

/**
 * 构造一次已签名的推理请求头。
 *
 * `x-litellm-session-id` 是**必填**（缺它 = 400 `非法session`），
 * 但不参与签名 ⇒ 可复用同一个 id；这里按调用方传入（缺省随机 UUID）。
 */
export function signedCodelyHeaders(options: {
  cliApiKey: string
  target: string | URL
  sessionId: string
  timestampMs?: number
}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${options.cliApiKey}`,
    'User-Agent': CODELY_CLI_USER_AGENT,
    'X-Codely-Signature': codelySignatureHeader(
      options.cliApiKey,
      options.target,
      options.timestampMs,
    ),
    'x-litellm-session-id': options.sessionId,
  }
}
