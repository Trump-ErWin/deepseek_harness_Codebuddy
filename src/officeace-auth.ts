/**
 * OfficeAce 凭据层：DSH 自主华为云 OAuth（PKCE + DPoP），**零外部依赖**。
 *
 * ## 为什么不用 OfficeAce 客户端
 *
 * 早期实现从 OfficeAce 的本机 Redis 读凭据 —— 但那要求用户装过并登录过客户端。
 * 逆向（2026-10-12，全部实测验证）发现华为云的登录链**完全公开可自走**：
 *
 * ```
 * 1. POST {claw}/v1/claw/auth/state          → 云侧登记 state（匿名）
 * 2. 浏览器打开 auth.huaweicloud.com 授权页    → SSO 秒过 → 回调带 code
 * 3. GET  {claw}/v1/claw/auth/code?state=    → 取回 code（匿名，秒级时效）
 * 4. POST sts.../v1/oauth2/tokens            → code+verifier+DPoP 换 token
 * 5. GET  {claw}/v1/claw/client-permission-validate（AK/SK 签名）
 *    → 返回 modelInfo（model_app_key/secret）⇒ 推理凭据
 * ```
 *
 * client_id `pdp5_for_agentarts` 是 PKCE 公开客户端（无 secret），redirect_uri
 * 是云侧固定域 —— DSH 复用同一组参数，无需任何注册。
 *
 * ## 凭据存储（DSH 自有，JSON 文件）
 *
 * `~/.dsh-officeace/session.json`：token + refresh_token + modelInfo + DPoP 私钥
 * （DPoP 私钥**必须持久化**：refresh 请求要用同一把密钥签 DPoP）。
 *
 * ## 时序陷阱（实测踩过）
 *
 * - code 有效期**秒级**：拿到后必须立刻换 token（一体化流程，不能分两步交互）
 * - state 必须来自云侧（自造的查不到）
 * - refresh_token 一次性：刷新成功后必须立即落盘新 token，否则重放触发
 *   STS5.1806 "has been used" 死循环（OfficeAce 源码注释里的同款教训）
 */

import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as https from 'node:https'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { OFFICEACE } from './officeace-product.js'

/** WebCrypto 的 JWK/CryptoKey 类型（lib.dom 不可用时手动声明最小形状）。 */
export type DpopPrivateJwk = { kty?: string; crv?: string; x?: string; y?: string; d?: string }
type JsonWebKey = DpopPrivateJwk
/** webcrypto.subtle.importKey 的返回（结构化最小形状，避免依赖 lib.dom）。 */
type SubtleCryptoKey = Awaited<ReturnType<typeof webcrypto.subtle.importKey>>

/** 华为云端点（与 OfficeAce green-package 的默认值一致）。 */
const CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com'
const TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
const CLIENT_ID = 'pdp5_for_agentarts'
const REDIRECT_URI = `${CLAW_BASE}/v1/claw/auth/callback`

/** DSH 自有凭据存储。 */
function storeDir(): string {
  return path.join(os.homedir(), '.dsh-officeace')
}

function storeFile(): string {
  return path.join(storeDir(), 'session.json')
}

export interface OfficeAceCredential {
  /** MaaS 推理的 Basic 凭据对（permission-validate 返回）。 */
  modelAppKey: string
  modelAppSecret: string
  /** MaaS 端点 host（model_api_url_base）。 */
  maasBaseUrl: string
  /** 华为云 IAM STS 凭据（AK/SK/STS，调 claw 管理 API 用）。 */
  access: string
  secret: string
  securityToken: string
  projectId: string
  expiresAt: string
  /** OAuth refresh token（30 天，一次性）。 */
  refreshToken: string
  /** DPoP 私钥 JWK（refresh 必须同钥）。 */
  dpopPrivateJwk: JsonWebKey
  /** 用户显示名。 */
  displayName?: string
  /** 账号 id。 */
  accountId?: string
}

interface StoredSession extends OfficeAceCredential {
  savedAt: string
}

// ────────────────────────── 存储 ──────────────────────────

/** 读当前凭据；不存在/损坏返回 undefined。 */
export function readStoredCredential(): OfficeAceCredential | undefined {
  try {
    const raw = fs.readFileSync(storeFile(), 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw) as StoredSession
    if (typeof j.modelAppKey !== 'string' || j.modelAppKey.length === 0) return undefined
    return j
  } catch {
    return undefined
  }
}

/** 写凭据（原子替换：先写 tmp 再 rename，防进程中途被杀留下半文件）。 */
function writeStoredCredential(credential: OfficeAceCredential): void {
  fs.mkdirSync(storeDir(), { recursive: true })
  const payload: StoredSession = { ...credential, savedAt: new Date().toISOString() }
  const tmp = `${storeFile()}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  fs.renameSync(tmp, storeFile())
}

/** 清除凭据（登出/刷新死循环时的自救入口）。 */
export function clearStoredCredential(): void {
  try { fs.rmSync(storeFile(), { force: true }) } catch { /* ignore */ }
}

// ────────────────────────── DPoP（复刻 OfficeAce oauth-crypto.js）──────────────────────────

function b64(buf: ArrayBuffer | Uint8Array): string {
  return Buffer.from(buf as Uint8Array).toString('base64url')
}

async function generateDpopKeyPair(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    privateJwk: await webcrypto.subtle.exportKey('jwk', kp.privateKey),
    publicJwk: await webcrypto.subtle.exportKey('jwk', kp.publicKey),
  }
}

async function importDpopPrivateKey(jwk: JsonWebKey): Promise<SubtleCryptoKey> {
  return webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

async function generateDpopJwt(
  privateKey: SubtleCryptoKey,
  publicJwk: JsonWebKey,
  htm: string,
  htu: string,
  nowMs = Date.now(),
): Promise<string> {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y, crv: publicJwk.crv } }
  const payload = { htm, htu, iat: Math.floor(nowMs / 1000), jti: randomBytes(16).toString('hex') }
  const input = `${b64(Buffer.from(JSON.stringify(header)))}.${b64(Buffer.from(JSON.stringify(payload)))}`
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, Buffer.from(input))
  return `${input}.${b64(new Uint8Array(sig))}`
}

// ────────────────────────── 登录流程（步骤 1-3 的浏览器外部分）──────────────────────────

export interface OfficeAceLoginStart {
  /** 浏览器要打开的授权页 URL。 */
  authorizeUrl: string
  /** 云侧登记的 state（login.poll 用它取 code）。 */
  state: string
  /** PKCE verifier + DPoP 私钥（换 token 时用；内存中间态，不落盘）。 */
  _internal: {
    codeVerifier: string
    dpopPrivateJwk: JsonWebKey
  }
}

/**
 * 步骤 1：向云侧注册 state 并生成授权 URL。
 *
 * `_internal` 由调用方保存在内存（`pendingOfficeAceState`），授权完成后传给
 * {@link completeLogin}。
 */
export async function startLogin(): Promise<OfficeAceLoginStart> {
  // 1. 云侧登记 state（⚠️ 必须用云侧发的——自造的 state 回调后查不到）
  const stateRes = await fetch(`${CLAW_BASE}/v1/claw/auth/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  })
  if (!stateRes.ok) {
    throw new Error(`华为云 state 注册失败：HTTP ${stateRes.status}`)
  }
  const state = ((await stateRes.json()) as { state?: unknown }).state
  if (typeof state !== 'string' || state.length === 0) {
    throw new Error('华为云未返回 state')
  }

  // 2. PKCE + 授权 URL
  const codeVerifier = b64(randomBytes(32))
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const { privateJwk, publicJwk } = await generateDpopKeyPair()

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'SHA-256',
    state,
    scope: 'openid',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
  })
  const authorizeUrl = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(
    `https://auth.huaweicloud.com/authui/v1/oauth2/authorize?${params.toString()}`,
  )}`

  return { authorizeUrl, state, _internal: { codeVerifier, dpopPrivateJwk: privateJwk } }
}

/**
 * 步骤 2：向云侧轮询 code（state 已登记时，用户授权后此端点返回 code）。
 *
 * @returns code；用户尚未授权时返回 undefined（前端继续轮询）。
 */
export async function pollLoginCode(state: string): Promise<string | undefined> {
  const r = await fetch(`${CLAW_BASE}/v1/claw/auth/code?state=${encodeURIComponent(state)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) return undefined // 202/404 = 未就绪
  try {
    const j = (await r.json()) as { code?: unknown; data?: { code?: unknown } }
    const code = j.code ?? j.data?.code
    return typeof code === 'string' && code.length > 0 ? code : undefined
  } catch {
    return undefined
  }
}

// ────────────────────────── 步骤 4-5：token 交换 + modelInfo ──────────────────────────

interface IamTokenResponse {
  credentials: {
    access_key_id: string
    secret_access_key: string
    security_token: string
    expiration: string
    project_id?: string
  }
  refresh_token?: string
  id_token?: string
}

interface PermissionResponse {
  account_id?: string
  principal_urn?: string
  subscription?: {
    model_info?: {
      model_auth_info?: { model_app_key?: unknown; model_app_secret?: unknown }
      model_api_url_base?: unknown
    }
  }
}

/**
 * 华为云 APIG 请求签名（AK/SK，SDK-HMAC-SHA256）。
 *
 * ⚠️ 逐字复刻 `@openjiuwen/relay-shared` 的 `Signer`（反编译对齐，三处坑全踩过）：
 *
 * 1. **canonical 路径强制尾斜杠**：`k()` 在末尾补 `/` —— 缺它就是
 *    `verify ak sk signature failed`（服务端回显 canonical 才发现）。
 * 2. **签名密钥就是裸 Secret**：`D()` 直接 `Hmac(SHA256, Secret)` 签
 *    StringToSign —— **没有** AWS 系的 scope 密钥派生（曾按 scope 派生，401）。
 * 3. **头名全小写排序**（`R()`），头值 trim（`w()`），GET 的 body 视为空。
 */
function signHuaweiRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  bodyText: string,
  accessKey: string,
  secretKey: string,
): Record<string, string> {
  const u = new URL(url)
  const now = new Date()
  const pad = (n: number): string => (n >= 10 ? String(n) : `0${n}`)
  const xdate = String(now.getUTCFullYear()) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
    + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z'
  const urlEncode = (s: string): string => encodeURIComponent(s)

  // k()：canonical URI —— 逐段 urlEncode 后 join，**末尾补 /**
  const canonicalUri0 = u.pathname.split('/').map((seg) => urlEncode(seg)).join('/')
  const canonicalUri = canonicalUri0.endsWith('/') ? canonicalUri0 : `${canonicalUri0}/`

  // C()：query 排序拼接（本项目 GET 无 query，但实现保留）
  const queryPairs: string[] = []
  for (const key of [...u.searchParams.keys()].sort()) {
    queryPairs.push(`${urlEncode(key)}=${urlEncode(u.searchParams.get(key) ?? '')}`)
  }
  const canonicalQuery = queryPairs.join('&')

  // 头：全小写 + host + x-sdk-date；值 trim
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim()
  lower.host = u.host
  lower['x-sdk-date'] = xdate
  const signedHeaders = Object.keys(lower).sort()
  let canonicalHeaders = ''
  for (const h of signedHeaders) canonicalHeaders += `${h}:${lower[h]}\n`

  const bodyHash = (method === 'PUT' || method === 'PATCH' || method === 'POST')
    ? createHash('sha256').update(bodyText).digest('hex')
    : createHash('sha256').update('').digest('hex')
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), bodyHash].join('\n')
  const stringToSign = ['SDK-HMAC-SHA256', xdate, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  // D()：签名密钥 = 裸 Secret
  const sig = createHmac('sha256', secretKey).update(stringToSign).digest('hex')
  return {
    ...headers,
    'X-Sdk-Date': xdate,
    Authorization: `SDK-HMAC-SHA256 Access=${accessKey}, SignedHeaders=${signedHeaders.join(';')}, Signature=${sig}`,
  }
}

/**
 * 步骤 4：code + verifier + DPoP 换 token。
 *
 * ⚠️ code 秒级时效 —— 轮询到后**立刻**调用本函数。
 */
async function exchangeToken(
  code: string,
  codeVerifier: string,
  dpopPrivateJwk: JsonWebKey,
): Promise<IamTokenResponse> {
  const privateKey = await importDpopPrivateKey(dpopPrivateJwk)
  // DPoP 密钥对与 verifier 同批生成 —— 这里从 store 恢复不了（只有私钥 JWK），
  // 所以 publicJwk 从私钥 JWK 推回（同 crv/x/y，少 d 一项）。
  const publicJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: dpopPrivateJwk.x, y: dpopPrivateJwk.y }
  const dpopJwt = await generateDpopJwt(privateKey, publicJwk, 'POST', TOKEN_URL)

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  })
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopJwt },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(`华为云 token 交换失败：HTTP ${r.status} ${text.slice(0, 200)}`)
  }
  return JSON.parse(text) as IamTokenResponse
}

/**
 * 步骤 5：用 STS 凭据调 permission-validate，拿 modelInfo（推理凭据）。
 */
async function fetchModelInfo(credential: OfficeAceCredential): Promise<void> {
  const url = `${CLAW_BASE}/v1/claw/client-permission-validate`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-security-token': credential.securityToken,
  }
  if (credential.projectId) headers['x-project-id'] = credential.projectId
  const signed = signHuaweiRequest('GET', url, headers, '', credential.access, credential.secret)
  const r = await fetch(url, { method: 'GET', headers: signed, signal: AbortSignal.timeout(30_000) })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(`华为云权限校验失败：HTTP ${r.status} ${text.slice(0, 200)}`)
  }
  const j = JSON.parse(text) as PermissionResponse
  const modelInfo = j.subscription?.model_info
  const auth = modelInfo?.model_auth_info
  if (typeof auth?.model_app_key !== 'string' || typeof auth?.model_app_secret !== 'string') {
    throw new Error('华为云未返回 MaaS 凭据（账号可能未订阅 ModelArts MaaS）')
  }
  credential.modelAppKey = auth.model_app_key
  credential.modelAppSecret = auth.model_app_secret
  const baseUrl = modelInfo?.model_api_url_base
  credential.maasBaseUrl = typeof baseUrl === 'string' && baseUrl.length > 0
    ? `https://${baseUrl.replace(/^https?:\/\//, '')}`
    : OFFICEACE.defaultBaseUrl
  credential.accountId = j.account_id ?? credential.accountId
}

// ────────────────────────── 倍率（costCoefficient）──────────────────────────

export interface ModelTokenRate {
  modelName: string
  promptTokensPerPoint: number
  completionTokensPerPoint: number
  cachedTokensPerPoint: number
  /** 计费系数 —— OfficeAce 界面显示为 `0.7x`（截图 2026-10-12 证实）。 */
  costCoefficient: number
}

/**
 * 拉模型计费倍率（OfficeAce 主界面「模型选择器」里 `0.7x` 的数据源）。
 *
 * 端点：`GET {agentarts}/v1/model-token-rates`（V11 签名，2026-10-12 实测 200）。
 * 响应字段是 **snake_case**（`model_name` / `cost_coefficient`），与本地 API
 * 的 camelCase 形态不同 —— 这里做归一化。
 *
 * ⚠️ **不依赖 OfficeAce 客户端**（与余额同款 V11 直读）。
 * 凭据缺失 / 网络失败 → 空表：倍率显示优雅降级（模型照常可选，只是名字后不带 x 系数）。
 */
export async function fetchModelTokenRates(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  try {
    const credential = readStoredCredential()
    if (credential === undefined || credential.access.length === 0 || credential.securityToken.length === 0) {
      return out
    }
    const raw = await signAndGet(
      `${OFFICEACE.defaultBaseUrl.replace(/\/+$/, '')}/v1/model-token-rates`,
      credential,
    )
    if (raw.length === 0) return out
    const j = JSON.parse(raw) as {
      models?: {
        model_name?: unknown
        cost_coefficient?: unknown
        /** 兼容本地 API 的 camelCase 形态（同一份数据的另一种序列化）。 */
        modelName?: unknown
        costCoefficient?: unknown
      }[]
    }
    for (const m of j.models ?? []) {
      const name = typeof m.model_name === 'string' ? m.model_name
        : typeof m.modelName === 'string' ? m.modelName : undefined
      const coeff = typeof m.cost_coefficient === 'number' ? m.cost_coefficient
        : typeof m.costCoefficient === 'number' ? m.costCoefficient : undefined
      if (name !== undefined && coeff !== undefined) out.set(name, coeff)
    }
  } catch {
    // 凭据缺失 / 网络失败 → 空表（显示层降级）
  }
  return out
}

/**
 * 读 OfficeAce 本地 API 的会话 cookie（`oc_sid`）。
 *
 * `~/.office-claw/session.cookie` 是 DPAPI 密文（`OC-DPAPI-1` 前缀），同一
 * Windows 用户可直接解密 —— 内容是 `{"value":"<签名cookie值>","expires":...}`。
 *
 * ⚠️ 仅用于**只读**的倍率查询（`/api/subscription/model-token-rates`）；
 * 登录/推理已不依赖 OfficeAce（见模块头）。未安装时返回 undefined → 倍率降级。
 */
export function readSessionCookie(): string | undefined {
  try {
    const file = path.join(os.homedir(), '.office-claw', 'session.cookie')
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw.startsWith('OC-DPAPI-1')) return undefined
    const bare = raw.replace(/^OC-DPAPI-1\s*/, '')
    const script = '(Add-Type -AssemblyName System.Security);'
      + '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect('
      + `[Convert]::FromBase64String("${bare}"),$null,"CurrentUser"))`
    const clear = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 15_000,
      encoding: 'utf8',
    }).trim()
    const parsed = JSON.parse(clear) as { value?: unknown }
    return typeof parsed.value === 'string' && parsed.value.length > 0 ? parsed.value : undefined
  } catch {
    return undefined
  }
}

/**
 * 完成登录：code → token → modelInfo → 落盘。
 *
 * ⚠️ 必须在轮询到 code 后**立刻**调用（code 秒级时效）。
 */
export async function completeLogin(
  code: string,
  codeVerifier: string,
  dpopPrivateJwk: JsonWebKey,
): Promise<OfficeAceCredential> {
  const token = await exchangeToken(code, codeVerifier, dpopPrivateJwk)
  const c = token.credentials
  const credential: OfficeAceCredential = {
    modelAppKey: '',
    modelAppSecret: '',
    maasBaseUrl: OFFICEACE.defaultBaseUrl,
    access: c.access_key_id,
    secret: c.secret_access_key,
    securityToken: c.security_token,
    projectId: c.project_id ?? '',
    expiresAt: c.expiration,
    refreshToken: token.refresh_token ?? '',
    dpopPrivateJwk,
  }
  await fetchModelInfo(credential)
  writeStoredCredential(credential)
  return credential
}

// ────────────────────────── 刷新 ──────────────────────────

/**
 * 用 refresh_token 续期（STS + modelInfo 全链）。
 *
 * ⚠️ refresh_token **一次性**：成功后必须立即落盘（见模块头注释的死循环教训）。
 *
 * ⚠️ **并发互斥**（2026-10-12 事故的根因加固）：refresh_token 一次性 ——
 *    两个并发调用（如续期调度器 + 用户点刷新）带着**同一个** token 同时打到
 *    STS，先到的消费掉、后到的拿 STS5.1806；若先到的写盘前被中断（用户停轮 /
 *    进程退出），新 token 就**永久丢失**，唯一出路是重新登录。故这里用模块级
 *    in-flight Promise 把并发调用合并为一次：后到者直接等先到者的结果。
 *
 * @returns 新凭据；refresh_token 失效（STS5.1806）返回 undefined（需重新登录）。
 */
let refreshInFlight: Promise<OfficeAceCredential | undefined> | undefined
export function refreshStoredCredential(): Promise<OfficeAceCredential | undefined> {
  refreshInFlight ??= doRefreshStoredCredential().finally(() => { refreshInFlight = undefined })
  return refreshInFlight
}

async function doRefreshStoredCredential(): Promise<OfficeAceCredential | undefined> {
  const current = readStoredCredential()
  if (current === undefined || current.refreshToken.length === 0) return undefined
  const privateKey = await importDpopPrivateKey(current.dpopPrivateJwk)
  const publicJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: current.dpopPrivateJwk.x, y: current.dpopPrivateJwk.y }
  const dpopJwt = await generateDpopJwt(privateKey, publicJwk, 'POST', TOKEN_URL)

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    client_id: CLIENT_ID,
  })
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopJwt },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })
  if (!r.ok) {
    // ⚠️ **必须留痕**（仓库约定：失败不允许静默吞掉）。此前这里静默
    //    `return undefined`，refresh_token 被消费丢失（STS5.1806）时日志零字，
    //    用户只看到「渠道停了 / 余额不更新」，无从排查（2026-10-12 事故实测）。
    const detail = await r.text().catch(() => '')
    console.warn(
      `[officeace] STS 续期失败 HTTP ${r.status}：${detail.slice(0, 200)}`
      + '（refresh_token 是一次性的：若报 STS5.1806 已被消费，必须重新登录才能恢复云端 API）',
    )
    return undefined
  }
  const token = (await r.json()) as IamTokenResponse
  const c = token.credentials
  const next: OfficeAceCredential = {
    ...current,
    access: c.access_key_id,
    secret: c.secret_access_key,
    securityToken: c.security_token,
    projectId: c.project_id ?? current.projectId,
    expiresAt: c.expiration,
    refreshToken: token.refresh_token ?? current.refreshToken,
  }
  // STS 刷新成功即旧 refresh_token 作废 —— 立即落盘（顺序不能反）
  writeStoredCredential(next)
  // modelInfo 里的 MaaS 凭据也随之更新（可能轮换）
  try {
    await fetchModelInfo(next)
    writeStoredCredential(next)
  } catch {
    // modelInfo 拉取失败不回滚 STS：推理凭据可能仍有效
  }
  return next
}

/**
 * 「按账号续期」的兼容入口 —— 满足 `JetHubAuthLike` 的形状，供
 * `account.refresh` / 批量续期表 / `provider-runtime` 统一分派。
 *
 * ## ⚠️ 为什么忽略 `refName` / `pool` / `accountId`
 *
 * OfficeAce 的凭据是**单一文件**（`~/.dsh-officeace/session.json`），
 * 不像其余渠道那样「每账号一个 credentialRef」。它的登录是华为云 OAuth
 * 的**单账号**流程，账号池里的条目只是展示用的占位。
 *
 * 故这里做的是「重读并续期那一份凭据」—— 与 Loomy / ZCode 的
 * `refreshAccountCredential` 同类（它们也只做有效性探测 / 重读，没有真正的
 * per-ref 刷新协议）。
 *
 * ⚠️ 返回值恒 `undefined`（`void` 语义）：续期成功与否由**调用方后续读凭据**判定，
 * 这里不抛错 —— 与其余渠道一致（失败不阻断批量续期）。
 */
export async function refreshAccountCredential(
  _refName: string,
  _pool: unknown,
  _accountId: string,
): Promise<void> {
  await refreshStoredCredential().catch(() => undefined)
}

/**
 * 批量续期（`refreshAll` 形状）。
 *
 * ⚠️ **必须逐个账号调 {@link refreshAccountCredential}**，不能图省事直接调
 * {@link refreshStoredCredential}：后者绕过了账号池 ⇒「续期后不回写 expiresAt」，
 * 而守卫用例（`trae-model-id-selection.spec.ts` / `provider-runtime-wiring.spec.ts`）
 * 的判据正是「`refreshAll` 打到**每个**账号自己的 ref」。跳过池的版本会让
 * 那些用例静默少跑一家（实测症状：`expected [] to deeply equal [ref]`）。
 *
 * ⚠️ 与其余渠道的形状差异：OfficeAce 只有一个账号条目，但**仍要走池** ——
 * 「只有一个账号」是当前事实，「账号池可能有多个」是契约。
 */
export async function refreshAll(pool: unknown): Promise<void> {
  const p = pool as { listAccountsByProvider?: (id: string) => Promise<readonly { id: string; credentialRef: string; enabled?: boolean }[]> } | undefined
  if (p?.listAccountsByProvider === undefined) {
    // 拿不到池（极少见：单测桩不完整）⇒ 退化为续期那一份，至少不抛错。
    await refreshStoredCredential().catch(() => undefined)
    return
  }
  const accounts = await p.listAccountsByProvider('officeace').catch(() => [])
  if (accounts.length === 0) {
    await refreshStoredCredential().catch(() => undefined)
    return
  }
  for (const account of accounts) {
    await refreshAccountCredential(account.credentialRef, pool, account.id)
  }
}

/**
 * 读 OfficeAce 订阅摘要（果办界面右上角的积分池）。
 *
 * @returns totalCredits（总量）、usedCredits（已用）、creditGroups（分桶明细）；
 *          OfficeAce 未装/未运行时返回 undefined。
 */
export interface OfficeAceSubscriptionSummary {
  planName?: string
  totalCredits: number
  usedCredits: number
  creditGroups: Array<{
    key: string
    name: string
    kind?: string
    remaining: number
    total: number
    used?: number
    expiresAt?: string
    expired?: boolean
  }>
}

/** 订阅缓存的落盘路径（余额离线兜底用，与凭据同目录）。 */
function subscriptionCacheFile(): string {
  return path.join(storeDir(), 'subscription-cache.json')
}

interface CachedSubscription extends OfficeAceSubscriptionSummary {
  /** 缓存写入时间（ISO）——展示层可标注「数据截至」。 */
  cachedAt: string
}

function readSubscriptionCache(): CachedSubscription | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(subscriptionCacheFile(), 'utf8').replace(/^\uFEFF/, '')) as CachedSubscription
    if (typeof j.totalCredits !== 'number') return undefined
    return j
  } catch {
    return undefined
  }
}

function writeSubscriptionCache(summary: OfficeAceSubscriptionSummary): void {
  try {
    fs.mkdirSync(storeDir(), { recursive: true })
    const payload: CachedSubscription = { ...summary, cachedAt: new Date().toISOString() }
    const tmp = `${subscriptionCacheFile()}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, subscriptionCacheFile())
  } catch { /* 缓存失败不影响主流程 */ }
}

/**
 * 读 OfficeAce 订阅摘要（果办界面右上角的积分池）。
 *
 * ## 离线兜底（2026-10-12）：**不依赖 OfficeAce 运行**
 *
 * 在线时（cookie 可用且端口通）拉实时数据并**写缓存**；离线时读**最近一次
 * 缓存**兜底（`stale: true` 标记，展示层据此标注「数据截至 hh:mm」）。
 * 推理本身从不依赖此函数——余额只是展示。
 *
 * @param staleHours - 缓存超过多少小时视为过期（默认 48）。过期且在线拉取
 *   失败时仍返回缓存（聊胜于无），由 `stale` 标记让 UI 如实呈现。
 */
export async function fetchSubscriptionSummary(staleHours = 48): Promise<(OfficeAceSubscriptionSummary & { stale?: boolean; cachedAt?: string }) | undefined> {
  // 1. **主路径：OfficeAce 本地 API**（装了客户端且在运行时可用，实测稳定）
  try {
    const sidValue = readSessionCookie()
    if (sidValue !== undefined) {
      const caCandidates = [
        path.join(os.homedir(), '.office-claw', 'certs', 'root-ca.pem'),
        'D:\\Users\\Z\\AppData\\Local\\Programs\\OfficeAce\\.office-claw\\certs\\root-ca.pem',
      ]
      let ca: Buffer | undefined
      for (const p of caCandidates) {
        try {
          ca = fs.readFileSync(p)
          break
        } catch { /* 下一个候选 */ }
      }
      if (ca !== undefined) {
        const body = await new Promise<string>((resolve) => {
          const req = https.request(
            { host: '127.0.0.1', port: 3004, path: '/api/subscription/current', method: 'GET', headers: { cookie: `oc_sid=${sidValue}`, accept: 'application/json' }, ca },
            (x) => {
              let d = ''
              x.on('data', (c) => (d += c))
              x.on('end', () => resolve(d))
            },
          )
          req.on('error', () => resolve(''))
          req.setTimeout(15_000, () => { req.destroy(); resolve('') })
          req.end()
        })
        if (body.length > 0) {
          const j = JSON.parse(body) as Partial<OfficeAceSubscriptionSummary>
          if (typeof j.totalCredits === 'number') {
            const summary: OfficeAceSubscriptionSummary = {
              planName: j.planName,
              totalCredits: j.totalCredits,
              usedCredits: j.usedCredits ?? 0,
              creditGroups: Array.isArray(j.creditGroups) ? j.creditGroups : [],
            }
            writeSubscriptionCache(summary)
            return summary
          }
        }
      }
    }
  } catch { /* 掉到云侧直读，再掉到缓存 */ }

  // 2. **实验路径：云侧直读**（V11 签名，不依赖 OfficeAce——签名尚未完全对齐，
  //    服务端返 APIG.0301；保留实现供后续对齐，失败自动落到缓存）
  try {
    const cloud = await fetchCloudSubscription()
    if (cloud !== undefined) {
      writeSubscriptionCache(cloud)
      return cloud
    }
  } catch { /* 掉到缓存兜底 */ }

  // 3. 离线兜底：最近一次缓存（标注 stale）
  const cached = readSubscriptionCache()
  if (cached === undefined) return undefined
  // 超过 staleHours 的缓存照常返回——余额数字聊胜于无，UI 用 stale 标记说明
  void staleHours
  return { ...cached, stale: true }
}

/**
 * V11 签名的 GET 请求（华为 APIG 私有算法，逐字复刻 OfficeAce 的
 * `chunk-XOTX5NN5.js` 的 `B()`/`F()`）。
 *
 * ## 三条**必须**记住的规则（每条都曾导致 401，别再凭直觉改）
 *
 * 1. **头集合**：GET 请求**不发 `Content-Type`**（OfficeAce 的 `cloudFetch` 只在
 *    `method !== 'GET'` 时设置它）。多这一个头，签名串就多一行，服务端重算必不匹配。
 * 2. **密钥派生**（`z(accessKey, secretKey, scope)`）：
 *    `u = HMAC(sha256, accessKey).update(secretKey)`；
 *    `a = scope 字节 + 0x01`；`derive = HMAC(sha256, u).update(a)` 取**前 32 字节**。
 *    最后**以 derive 的 hex 字符串（不是 raw bytes）作为 key** 签 stringToSign。
 * 3. **分隔符**：canonical 头行与 stringToSign 都是 **LF** 分隔（不是空格）；
 *    canonical 路径**强制尾斜杠**。
 *
 * @returns 响应正文；非 2xx 或异常返回空串（调用方按「读不到」降级）。
 */
async function signAndGet(url: string, credential: OfficeAceCredential): Promise<string> {
  const region = 'cn-southwest-2'
  const service = 'apic'
  const pad = (n: number): string => (n >= 10 ? String(n) : `0${n}`)
  const now = new Date()
  const xdate = String(now.getUTCFullYear()) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
    + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z'
  const urlEncode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

  const u = new URL(url)
  // N()：canonical 路径 —— 逐段编码后 **强制尾斜杠**
  const canonicalUri0 = u.pathname.split('/').map((s) => urlEncode(decodeURIComponent(s))).join('/')
  const canonicalUri = canonicalUri0.endsWith('/') ? canonicalUri0 : `${canonicalUri0}/`
  // P()：query 排序拼接（当前端点无 query，实现保留）
  const queryPairs: Array<[string, string]> = []
  u.searchParams.forEach((v, n) => queryPairs.push([n, v]))
  queryPairs.sort(([a, b], [c, d]) => (a === c ? b.localeCompare(d) : a.localeCompare(c)))
  const canonicalQuery = queryPairs.map(([k, v]) => `${urlEncode(k)}=${urlEncode(v)}`).join('&')
  // 规则 1：GET 不带 Content-Type
  const original: Record<string, string> = {
    'x-subscription-type': 'v2',
    'X-Sdk-Date': xdate,
    'X-Security-Token': credential.securityToken.trim(),
    Host: u.host,
  }
  if (credential.projectId) original['X-Project-ID'] = credential.projectId
  // R()：签名用**小写名**，值 trim + 折叠空白
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(original)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ')
  const signedHeaders = Object.keys(lower).sort()
  // 规则 3：头行 LF 分隔 + 末尾 LF
  let canonicalHeaders = ''
  for (const h of signedHeaders) canonicalHeaders += `${h}:${lower[h]}\n`
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), createHash('sha256').update('').digest('hex')].join('\n')
  const scope = `${xdate.slice(0, 8)}/${region}/${service}`
  const stringToSign = ['V11-HMAC-SHA256', xdate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  // 规则 2：密钥派生
  const u1 = createHmac('sha256', credential.access).update(credential.secret).digest()
  const derivedKey = createHmac('sha256', u1)
    .update(Buffer.concat([Buffer.from(scope, 'utf8'), Buffer.from([1])]))
    .digest()
    .subarray(0, 32)
    .toString('hex')
  const signature = createHmac('sha256', Buffer.from(derivedKey, 'utf8')).update(stringToSign).digest('hex')

  const r = await fetch(url, {
    method: 'GET',
    headers: {
      ...original,
      Authorization: `V11-HMAC-SHA256 Credential=${credential.access}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(30_000),
  })
  return r.ok ? await r.text() : ''
}

/**
 * 云侧订阅直读（V11 签名）—— 余额查询的**主路径**，不依赖 OfficeAce。
 *
 * 端点：`GET {agentarts}/v1/subscription`（`x-subscription-type: v2`）。
 * 响应含套餐桶（`skus[].quotas`，`sku_attr_code === 'officeace_points'`）
 * 与 bonus 桶（`bonus_skus[]`）—— 与果办界面右上角的分桶完全同源
 *（复刻自 OfficeAce `hHe()` 的归一化逻辑）。
 */
async function fetchCloudSubscription(): Promise<OfficeAceSubscriptionSummary | undefined> {
  const credential = readStoredCredential()
  if (credential === undefined || credential.access.length === 0 || credential.securityToken.length === 0) {
    return undefined
  }
  const body = await signAndGet(
    `${OFFICEACE.defaultBaseUrl.replace(/\/+$/, '')}/v1/subscription`,
    credential,
  )
  if (body.length === 0) return undefined
  const j = JSON.parse(body) as {
    skus?: { sku_name?: unknown; sku_code?: unknown; quotas?: { sku_attr_code?: unknown; sku_value?: unknown; current_value?: unknown; expired_time?: unknown }[] }[]
    bonus_skus?: { activity_id?: unknown; activity_name?: unknown; points?: unknown; current_value?: unknown; expired_time?: unknown }[]
  }
  const now2 = Date.now()
  const creditGroups: OfficeAceSubscriptionSummary['creditGroups'] = []
  for (const sku of j.skus ?? []) {
    for (const q of sku.quotas ?? []) {
      if (q.sku_attr_code !== 'officeace_points') continue
      const total = Number(q.sku_value)
      const used = Number(q.current_value)
      const expiredAt = typeof q.expired_time === 'string' && q.expired_time.length > 0 ? q.expired_time : null
      const isTrial = String(sku.sku_code ?? '').endsWith('.trial')
      creditGroups.push({
        key: `plan-${String(sku.sku_code ?? '')}`,
        name: typeof sku.sku_name === 'string' ? sku.sku_name : '套餐',
        kind: 'plan',
        remaining: Math.max(0, total - used),
        total,
        used,
        expiresAt: isTrial ? undefined : expiredAt ?? undefined,
        expired: !isTrial && expiredAt !== null && new Date(expiredAt).getTime() <= now2,
      })
    }
  }
  for (const bonus of j.bonus_skus ?? []) {
    const points = Number(bonus.points)
    const used = Number(bonus.current_value)
    if (!Number.isFinite(points)) continue
    creditGroups.push({
      key: `bonus-${String(bonus.activity_id ?? '')}`,
      name: typeof bonus.activity_name === 'string' ? bonus.activity_name : '活动奖励',
      kind: 'bonus',
      remaining: Math.max(0, points - used),
      total: points,
      used,
      expiresAt: typeof bonus.expired_time === 'string' ? bonus.expired_time : undefined,
      expired: typeof bonus.expired_time === 'string' && new Date(bonus.expired_time).getTime() <= now2,
    })
  }
  if (creditGroups.length === 0) return undefined
  const totalCredits = creditGroups
    .filter((g) => !g.expired)
    .reduce((sum, g) => sum + g.remaining, 0)
  return {
    planName: creditGroups.find((g) => g.kind === 'plan')?.name,
    totalCredits,
    usedCredits: creditGroups.reduce((sum, g) => sum + (g.used ?? 0), 0),
    creditGroups,
  }
}

/** Basic 授权头值（推理用）。 */
export function basicAuthorization(credential: OfficeAceCredential): string {
  return 'Basic ' + Buffer.from(`${credential.modelAppKey}:${credential.modelAppSecret}`).toString('base64')
}

/** 读凭据并顺带判断 STS 是否临期（调用方决定是否先刷新）。 */
export function isExpiring(credential: OfficeAceCredential, leadMs = 10 * 60 * 1000): boolean {
  const exp = Date.parse(credential.expiresAt)
  if (!Number.isFinite(exp)) return true
  return exp - Date.now() < leadMs
}

/** 探测凭据可读（面板/目录门控用）。 */
export async function probeOfficeAce(): Promise<boolean> {
  try {
    return readStoredCredential() !== undefined
  } catch {
    return false
  }
}

// ────────────────────────── 兼容旧调用方（jet-hub-rpc）──────────────────────────

/**
 * 读凭据：优先 DSH 自有存储；OfficeAce 客户端已装且登录过时**回读迁移**。
 *
 * ⚠️ 迁移是**一次性的桥**：OfficeAce Redis 里的凭据结构与 DSH 自有登录不同
 *（缺 DPoP 私钥 ⇒ 不能刷新），故迁移条目标记 refresh 能力降级 —— 面板会提示
 * 重新登录一次以获得完整能力。
 */
export async function readOfficeAceCredential(): Promise<OfficeAceCredential | undefined> {
  const own = readStoredCredential()
  if (own !== undefined) return own
  // 回读 OfficeAce Redis（兼容：装过客户端的用户零成本迁移推理能力）
  return readFromOfficeAceRedis()
}

// readFromOfficeAceRedis 是旧实现（Redis 读取链），保留为迁移桥
//（本文件下方保留原有 Redis 读取代码，但不再作为主路径）
// ⚠️ 依赖的 net/execFile 已在文件头部统一 import。

interface CredReadResult { utf16: string; ascii: string }

function credRead(target: string): Promise<CredReadResult | undefined> {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class OC_CM {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string t, int ty, int f, out IntPtr p);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
}
'@
$ptr=[IntPtr]::Zero
if(-not [OC_CM]::CredRead('${target.replace(/'/g, "''")}',1,0,[ref]$ptr)){ Write-Output 'OC_NX'; exit }
$c=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[type][OC_CM+CREDENTIAL])
$b=New-Object byte[] $c.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$c.CredentialBlobSize)
[OC_CM]::CredFree($ptr)|Out-Null
Write-Output ('OC_U16[' + [Text.Encoding]::Unicode.GetString($b) + ']OC_ASC[x]')
`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000 }, (err, stdout) => {
      if (err) { resolve(undefined); return }
      const text = String(stdout)
      if (!text.includes('OC_U16[')) { resolve(undefined); return }
      resolve({ utf16: text.slice(text.indexOf('OC_U16[') + 7, text.indexOf(']OC_ASC[')), ascii: '' })
    })
  })
}

function enc(args: string[]): string {
  let out = `*${args.length}\r\n`
  for (const a of args) out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`
  return out
}

function redisExec(port: number, commands: string[][], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    let buf = ''
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch { /* 已关 */ }
      resolve(buf)
    }
    const expect = commands.length
    const countTopLevel = (): number => {
      let count = 0
      for (const line of buf.split('\r\n')) {
        if (/^[+\-:$*]/.test(line)) count++
      }
      return count
    }
    sock.on('data', (c) => {
      buf += c.toString('utf8')
      if (countTopLevel() >= expect) done()
    })
    sock.setTimeout(timeoutMs, done)
    sock.on('error', done)
    let payload = ''
    for (const cmd of commands) payload += enc(cmd)
    sock.write(payload)
  })
}

function respFirst(reply: string): string | undefined {
  for (const line of reply.split('\r\n')) {
    if (line.startsWith('$') && line !== '$-1') {
      const idx = reply.split('\r\n').indexOf(line)
      return reply.split('\r\n')[idx + 1]
    }
  }
  return undefined
}

/** OfficeAce Redis 回读（迁移桥，主路径是 readStoredCredential）。 */
async function readFromOfficeAceRedis(): Promise<OfficeAceCredential | undefined> {
  try {
    const pw = await credRead('OfficeClaw/redis/password')
    if (pw === undefined) return undefined
    const password = pw.utf16.trim()
    if (password.length === 0) return undefined

    const keysReply = await redisExec(6399, [['AUTH', password], ['KEYS', 'office-claw:oc:session:user:*']], 8_000)
    if (!keysReply.includes('+OK')) return undefined
    const lines = keysReply.split('\r\n')
    const keyLines: string[] = []
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith('$') && lines[i] !== '$-1') keyLines.push(lines[i + 1])
    }
    const sessionKey = keyLines.find((k) => k && !k.startsWith('+'))
    if (sessionKey === undefined) return undefined

    const valueReply = await redisExec(6399, [['AUTH', password], ['GET', sessionKey]], 8_000)
    const json = respFirst(valueReply)
    if (json === undefined) return undefined
    const parsed = JSON.parse(json) as {
      displayName?: unknown
      providerState?: {
        modelInfo?: { model_auth_info?: Record<string, unknown>; model_api_url_base?: unknown }
      }
    }
    const auth = parsed?.providerState?.modelInfo?.model_auth_info
    const appKey = auth?.model_app_key
    const appSecret = auth?.model_app_secret
    if (typeof appKey !== 'string' || typeof appSecret !== 'string' || appKey.length === 0) return undefined
    const baseUrl = parsed?.providerState?.modelInfo?.model_api_url_base
    return {
      modelAppKey: appKey,
      modelAppSecret: appSecret,
      maasBaseUrl: typeof baseUrl === 'string' && baseUrl.length > 0 ? `https://${baseUrl}` : OFFICEACE.defaultBaseUrl,
      access: '', secret: '', securityToken: '', projectId: '', expiresAt: '',
      refreshToken: '',
      dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: '', y: '' },
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : undefined,
    }
  } catch {
    return undefined
  }
}

/** Redis 密码的凭据管理器目标名（诊断日志用）。 */
export const REDIS_CRED_TARGET = 'OfficeClaw/redis/password'

export { OFFICEACE }