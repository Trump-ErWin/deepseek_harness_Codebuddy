import { randomBytes } from 'node:crypto';
/**
 * AStudio（讯飞 AstronStudio / `cn.xfyun.acode`）—— 登录与会话态展示层。
 *
 * ## 为什么这里没有 OAuth2 / PKCE / 授权 URL / 回调（与 accio-oauth.ts 的关键差异）
 *
 * AStudio 的登录是 **Electron 客户端里的微信扫码**：bundle 内只有
 * `SSOService/wx/scanlogin/{qrcode,uids,bind}`，**不存在任何程序化续期接口**，
 * 授权页与回调都握在客户端自己手里（我们无从走完）。所以与 `accio-oauth.ts`
 * 同型的只有三件事 —— **纯函数 + 终态判定 + 账号掩码展示**。本文件做的是
 * 「导入本机既有会话」与「会话态展示」，**刻意不臆造 loginUrl**（臆造出来的 URL
 * 点了也不会生效，而 UI 会据此以为用户可以自助登录）。
 *
 * ## 三条不能按别的 provider 习惯写的实测结论
 *
 * 1. **磁盘没有任何 TTL / `expiresAt`** ⇒ {@link astudioCredentialExpiresAtMs}
 *    恒返回 `undefined` 是故意的。会话态因此只有两可显示形态：「长期有效」
 *    （服务端 `Set-Cookie: ssoSessionId=…; Max-Age=31536000`，一年且**不滑动**）
 *    与「需人工重新登录」。**绝不渲染到期倒计时**，也不做本地过期预判。
 * 2. **唯一硬终点**：SSO 会话失效时上游恒返回 **HTTP 200 + `code=80000`**
 *    「登录异常，请重新登录」。80000 已在 `ASTUDIO_SESSION_DEAD_CODES` 里，故本层
 *    把它归**终态**、一次性透出人工重登文案，**不循环重试**。
 * 3. **只读客户端文件**：`astron-session.json` 是客户端资产，本层读它、绝不写它；
 *    凭据落库一律走 DSH 凭据库（`astudio-auth.ts`）。
 *
 * ## 展示层的两条纪律
 *
 * - 手机号必须经既有 {@link maskLobsteraiPhoneTail}（只露末 2 位）掩码 —— 本层不
 *   复制第二份掩码算法（两处判据必然漂移；lobsterai 侧因露 4 位被要求整改过）。
 * - 刷新结果 `changed === false` **不是成功**：实测本家不轮换，同 token 撞 401 是
 *   确定性失败，必须与「刷新成功」分格报（见 {@link astudioSessionViewFromRefreshOutcome}）。
 *
 * ## 接线侧约定
 *
 * 接线（`jet-hub-rpc.ts` 的 `account.create`）走 `astudio-auth.ts` 的磁盘导入分支，
 * **不 import 本文件**；本文件只提供展示/掩码与终态判据。`checkAstudioSession` 的
 * `refresh` 形参按注入设计：接线侧传 `ctx.astudioAuth.refreshOnce`，不传就纯读 ——
 * 因此本层在生产路径之外天然零网络（`AstudioAuth extends Service` 的构造需要宿主
 * `ctx`，展示层无权自建服务实例，故这里用最小接口而不是 `new AstudioAuth(...)`）。
 */

import { ASTUDIO } from './astudio-product.js';
import { maskLobsteraiPhoneTail } from './lobsterai.js';
import {
  astudioCredentialExpiresAtMs,
  isAstudioSessionDeadError,
  type AstudioCredential,
  type AstudioSessionFile,
} from './astudio.js';
import {
  astudioAccountNickname,
  astudioSessionFilePath,
  isAstudioTerminalRefreshError,
  readAstudioDiskCredential,
  readAstudioSessionFile,
  extractAstudioApiKey,
  AstudioRefreshTokenExpiredError,
  type AstudioRefreshOutcome,
} from './astudio-auth.js';

/** 凭据库未接线时的默认 ref 名（与 `ASTUDIO.defaultCredentialRef` 同值）。 */
export const ASTUDIO_DEFAULT_CREDENTIAL_REF = 'ASTUDIO_ACCESS_TOKEN';

/** 会话失效（HTTP 200 + code=80000）时唯一允许透出给用户的终态文案。 */
export const ASTUDIO_MANUAL_RELOGIN_HINT =
  'AStudio 会话已失效（上游恒为 HTTP 200 + code=80000「登录异常，请重新登录」）。本客户端没有程序化续期接口，请在 AStudio 桌面端重新微信扫码登录后再试；插件侧不会循环重试。';

/** 读不到本机会话时的文案（同样归终态：只能人工登录，无法自动补）。 */
export const ASTUDIO_NO_LOCAL_SESSION_MESSAGE =
  '未找到本机 AStudio 会话（userdata\\astron-session.json 缺失，或其中没有 modelBearerToken）。请先在 AStudio 客户端登录；如需指向别处的会话文件，设置环境变量 DSH_ASTUDIO_SESSION_FILE。';

/** 有效性副标题：如实说明「长期有效」的依据，并明确不给倒计时。 */
export const ASTUDIO_SESSION_LIFETIME_NOTE =
  '长期有效：服务端 ssoSessionId 的 Max-Age=31536000（一年且不滑动），磁盘会话文件无 TTL 字段，故不显示到期倒计时。';

/**
 * 会话态展示状态。
 *
 * ⚠️ 刻意**没有** `expiring` 这一档：磁盘无 TTL 可预判，加上去只能靠编造判据
 * （`loggedInAt + 2h` 之类），而那是实测被否掉的臆造。
 */
export type AstudioSessionDisplayState = 'active' | 'needs_manual_relogin' | 'no_local_session';

/** 一行会话态视图；字段全是**已掩码/可安全展示**的字符串，不含明文凭据。 */
export interface AstudioSessionView {
  readonly provider: 'astudio';
  readonly state: AstudioSessionDisplayState;
  /** 掩码后的账号展示名（手机号只露末 2 位；真实昵称原样）。 */
  readonly account: string;
  readonly accountId: string;
  readonly uid: string;
  /** 实测为 `wechat`。 */
  readonly loginMethod: string;
  /** `'session-file'` | `'account-backend'`。 */
  readonly source: string;
  /** 磁盘 `banned` 字段（⚠️ astudio.ts 从不消费它，这里只做如实展示）。 */
  readonly banned: boolean;
  /** 恒 `undefined`：见文件头第 1 条，**不得**用于倒计时。 */
  readonly expiresAtMs?: number;
  /** 登录时刻原值（诊断用；不参与到期判定）。 */
  readonly loggedInAt: string;
  /** 可直接展示的一行状态。 */
  readonly statusLine: string;
  /** 需要人工介入时的一句话说明。 */
  readonly hint?: string;
}

function credentialField(credential: AstudioCredential | undefined, key: keyof AstudioCredential): string {
  const raw = credential === undefined || credential === null ? undefined : credential[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 磁盘 `banned` 的形态不固定（`AstudioSessionFile.banned?: boolean | string`），
 * 统一收敛成布尔。读不到会话文件时一律 `false` —— **不臆造**「被封」这种重结论。
 */
export function astudioBannedFromSessionFile(session: AstudioSessionFile | undefined): boolean {
  const raw = session === undefined || session === null ? undefined : session.banned;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    return text === 'true' || text === '1';
  }
  return false;
}

/**
 * 任意展示串的手机号掩码。
 *
 * 复用 {@link maskLobsteraiPhoneTail}：只对「像手机号」的输入生效（11 位纯数字且 1 开头，
 * 或 `3 位数字 + 星号 + 数字` 的服务端已脱敏形态），真实昵称原样返回，且幂等。
 * 账号 id / uid 也可能是手机号形态，所以本层对它们同样过一次（已是掩码串的输入不受影响）。
 */
export function maskAstudioAccountLabel(value: string): string {
  const text = (value ?? '').trim();
  if (text.length === 0) return '';
  const masked = maskLobsteraiPhoneTail(text);
  return typeof masked === 'string' && masked.trim().length > 0 ? masked.trim() : text;
}

/**
 * 会话态的纯映射：给一份凭据（或 `undefined`）出一行视图，**零网络、零写入**。
 *
 * 展示名走 {@link astudioAccountNickname} → `astudioDisplayNickname` →
 * `maskLobsteraiPhoneTail` 这条**既有**链路（只露末 2 位），本层不再算第二遍。
 */
export function astudioSessionViewFromCredential(
  credential: AstudioCredential | undefined,
  options: { fallbackLabel?: string; banned?: boolean } = {},
): AstudioSessionView {
  const fallbackLabel = (options.fallbackLabel ?? '').trim() || 'ASTUDIO';
  const banned = options.banned === true;

  if (credential === undefined || credential === null) {
    return {
      provider: 'astudio',
      state: 'no_local_session',
      account: '',
      accountId: '',
      uid: '',
      loginMethod: '',
      source: '',
      banned: false,
      expiresAtMs: undefined,
      loggedInAt: '',
      statusLine: ASTUDIO_NO_LOCAL_SESSION_MESSAGE,
      hint: ASTUDIO_MANUAL_RELOGIN_HINT,
    };
  }

  const accountId = maskAstudioAccountLabel(credentialField(credential, 'account_id'));
  const uid = maskAstudioAccountLabel(credentialField(credential, 'uid'));
  const account = maskAstudioAccountLabel(
    astudioAccountNickname(credential, accountId || fallbackLabel) || fallbackLabel,
  );
  // 恒 undefined：保留这次调用是为如实透传「本 provider 不可本地预判到期」这一契约。
  const expiresAtMs = astudioCredentialExpiresAtMs(credential);
  const loginMethod = credentialField(credential, 'login_method');
  const source = credentialField(credential, 'source');
  const loggedInAt = credentialField(credential, 'logged_in_at');
  const state: AstudioSessionDisplayState = banned ? 'needs_manual_relogin' : 'active';
  const statusLine = banned
    ? `账号已被客户端标记封禁（磁盘 banned=true），模型调用会持续失败 ⇒ ${ASTUDIO_MANUAL_RELOGIN_HINT}`
    : `已登录：${account}（登录方式=${loginMethod || 'wechat'}，凭据来源=${source || 'session-file'}）—— ${ASTUDIO_SESSION_LIFETIME_NOTE}`;

  return {
    provider: 'astudio',
    state,
    account,
    accountId,
    uid,
    loginMethod,
    source,
    banned,
    expiresAtMs,
    loggedInAt,
    statusLine,
    hint: banned ? ASTUDIO_MANUAL_RELOGIN_HINT : undefined,
  };
}

/**
 * 一次凭据/异常是否属于「只能人工重新登录」的终态（两条判据各覆盖一半）。
 *
 * {@link isAstudioTerminalRefreshError} 按 `error.name === 'RefreshTokenExpiredError'`
 * 判（**不是 instanceof**）并自带文案兜底；{@link isAstudioSessionDeadError} 命中
 * `ASTUDIO_SESSION_DEAD_CODES`（含 80000）。
 * ⚠️ 网络抖动 / 5xx / 未知业务码**都不是**终态 —— 把它们固化成「账号已死」是本仓库
 * 明令禁止的「单向门」事故形态。
 */
export function astudioSessionDeadFromError(error: unknown): boolean {
  if (error === undefined || error === null) return false;
  if (isAstudioTerminalRefreshError(error)) return true;
  const record = (typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const rawCode = record.code ?? record.status;
  const code = typeof rawCode === 'number'
    ? rawCode
    : /^-?\d+(\.\d+)?$/.test(String(rawCode ?? '').trim())
      ? Number(String(rawCode).trim())
      : Number.NaN;
  const message = typeof record.message === 'string' ? record.message : String(error);
  if (Number.isFinite(code) && isAstudioSessionDeadError(code, message)) return true;
  return isAstudioSessionDeadError(0, message);
}

/** 异常 → 会话态视图：终态归 `needs_manual_relogin`，非终态保留原视图不谎报。 */
export function astudioSessionViewFromError(
  error: unknown,
  fallback?: AstudioSessionView,
): AstudioSessionView {
  const base = fallback ?? astudioSessionViewFromCredential(undefined);
  if (!astudioSessionDeadFromError(error)) return base;
  const record = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  const reason = typeof record.message === 'string' ? record.message : String(error);
  return {
    ...base,
    state: 'needs_manual_relogin',
    statusLine: `${ASTUDIO_MANUAL_RELOGIN_HINT}（原始信息：${reason}）`,
    hint: ASTUDIO_MANUAL_RELOGIN_HINT,
  };
}

/**
 * 刷新结果 → 会话态视图（**四态分格**，不压成布尔）。
 *
 * 三格必须分开，混成一格会让 UI 谎报：
 * - `terminal === true` ⇒ 人工重登（含 code=80000 那族）：再多的定时刷新也不会成功；
 * - `fetched !== true` ⇒ 本轮压根没发远端请求（如 Cookie 拼不出）⇒ 属「未刷新」而非失败；
 * - `changed !== true` ⇒ 值没变（实测本家不轮换）⇒ 如实报「重试无意义」，
 *   **绝不能**显示成「刷新成功」；
 * - 其余 ⇒ 凭据真的更新了。
 */
export function astudioSessionViewFromRefreshOutcome(
  outcome: AstudioRefreshOutcome,
  options: { fallbackLabel?: string } = {},
): AstudioSessionView {
  const view = astudioSessionViewFromCredential(outcome.credential, options);
  if (outcome.terminal === true) {
    return {
      ...view,
      state: 'needs_manual_relogin',
      statusLine: `${ASTUDIO_MANUAL_RELOGIN_HINT}（取值判据=${outcome.via}；原因：${outcome.reason || '未提供'}）`,
      hint: ASTUDIO_MANUAL_RELOGIN_HINT,
    };
  }
  if (outcome.fetched !== true) {
    return {
      ...view,
      statusLine: `未发起凭据重取${outcome.reason.length > 0 ? `：${outcome.reason}` : ''}`,
      hint: outcome.reason.length > 0 ? outcome.reason : undefined,
    };
  }
  if (outcome.changed !== true) {
    return {
      ...view,
      statusLine: `凭据重取成功但值未变化（指纹 ${outcome.before} → ${outcome.after}；判据=${outcome.via}）⇒ 本家不轮换，重发同一请求必然同样失败`,
      hint: '这是确定性失败的信号：若此前是 401，请在 AStudio 客户端重新登录。',
    };
  }
  return {
    ...view,
    statusLine: `${view.statusLine}；凭据已更新（指纹 ${outcome.before} → ${outcome.after}；判据=${outcome.via}）`,
  };
}

/**
 * 凭据库读取入口的**最小接口**（`AstudioAuth.currentCredential` 的形状）。
 * 接线侧传 `ctx.astudioAuth`，单测传结构替身 —— 于是本层天然零网络。
 */
export interface AstudioCredentialReaderLike {
  currentCredential(refName?: string): Promise<AstudioCredential | undefined>;
}

/** 会话态读取选项；全部可选，缺省只走磁盘快路径。 */
export interface AstudioSessionStatusOptions {
  /** 环境变量视图；`DSH_ASTUDIO_SESSION_FILE` 在此覆盖会话文件路径。 */
  env?: Record<string, string | undefined>;
  /** 凭据库 ref 名，缺省 `ASTUDIO_ACCESS_TOKEN`。 */
  refName?: string;
  /** 磁盘读不到时的回落入口（接线侧 = `ctx.astudioAuth`）。 */
  auth?: AstudioCredentialReaderLike;
  /** 展示名兜底（无昵称且无账号 id 时用）。 */
  fallbackLabel?: string;
  /** 是否把凭据原值一并带回（缺省 `false`：展示层不需要明文 token）。 */
  includeCredential?: boolean;
}

export interface AstudioSessionStatus extends AstudioSessionView {
  /** 实际读取的会话文件路径（只读展示；本层不写该文件）。 */
  readonly sessionFile: string;
  readonly refName: string;
  /** 仅 `includeCredential === true` 且读到了才存在。 */
  readonly credential?: AstudioCredential;
}

function sessionFileOf(env?: Record<string, string | undefined>): string {
  try {
    return astudioSessionFilePath(env);
  } catch {
    return '';
  }
}

/**
 * 读会话态：**磁盘快路径优先**，读不到再回落凭据库。
 *
 * 两个数据源都是纯读；上游重取只由 `astudio-auth.ts` 在 HTTP 401 时触发一次，
 * 本层**不越权发起任何网络请求**（所以它也不可能是「登录」的实现）。
 */
export async function readAstudioSessionStatus(
  options: AstudioSessionStatusOptions = {},
): Promise<AstudioSessionStatus> {
  const refName = (options.refName ?? '').trim() || ASTUDIO_DEFAULT_CREDENTIAL_REF;
  const sessionFile = sessionFileOf(options.env);
  let credential: AstudioCredential | undefined;
  let banned = false;

  try {
    credential = readAstudioDiskCredential(options.env);
    if (credential === undefined) {
      // 磁盘凭据缺失（或客户端重登后写入了 banned）时补读一次原始会话文件。
      banned = astudioBannedFromSessionFile(readAstudioSessionFile(options.env));
      if (options.auth !== undefined && options.auth !== null) {
        credential = await options.auth.currentCredential(refName);
      }
    }
    const view = astudioSessionViewFromCredential(credential, {
      fallbackLabel: options.fallbackLabel,
      banned,
    });
    return {
      ...view,
      sessionFile,
      refName,
      ...(options.includeCredential === true && credential !== undefined ? { credential } : {}),
    };
  } catch (error) {
    const view = astudioSessionViewFromError(
      error,
      astudioSessionViewFromCredential(undefined, { fallbackLabel: options.fallbackLabel, banned }),
    );
    return { ...view, sessionFile, refName };
  }
}

/**
 * 单步「导入本机既有会话」：把磁盘/库里的既有登录态读成一份视图交接线侧落库。
 *
 * ⚠️ 真正的凭据库写入在 `astudio-auth.ts`（接线缺口 B 的 `importLocalSession`）；
 * 本函数刻意**不写任何东西、不发任何请求** —— 读不到就直接返回
 * `no_local_session` / `needs_manual_relogin` 终态，由 UI 提示人工登录。
 * 之所以是单步而不是 `startLogin` + `pollLogin` 两步：本家没有可展示的本地授权页
 * URL（扫码在客户端窗口里完成），轮询一个不存在的回调只会是死代码。
 */
export async function importAstudioLocalSession(
  refName?: string,
  options: AstudioSessionStatusOptions = {},
): Promise<AstudioSessionStatus> {
  return await readAstudioSessionStatus({ ...options, refName, includeCredential: true });
}

/**
 * 「检查登录态 / 需要时重取一次」的展示入口（面板按钮语义）。
 *
 * 只有传入 `refresh`（接线侧 = `ctx.astudioAuth.refreshOnce`）时才可能发远端请求；
 * 不传就退化成纯读 —— 这让单测与无凭据环境下都不会误撞网络。
 */
export async function checkAstudioSession(
  options: AstudioSessionStatusOptions & {
    refresh?: (refName: string) => Promise<AstudioRefreshOutcome>;
  } = {},
): Promise<AstudioSessionStatus> {
  const status = await readAstudioSessionStatus(options);
  if (typeof options.refresh !== 'function') return status;
  const refName = (options.refName ?? '').trim() || ASTUDIO_DEFAULT_CREDENTIAL_REF;
  try {
    const outcome = await options.refresh(refName);
    const view = astudioSessionViewFromRefreshOutcome(outcome, { fallbackLabel: options.fallbackLabel });
    return {
      ...view,
      sessionFile: status.sessionFile,
      refName,
      ...(options.includeCredential === true && outcome.credential !== undefined
        ? { credential: outcome.credential }
        : {}),
    };
  } catch (error) {
    return astudioSessionViewFromError(error, status) as AstudioSessionStatus;
  }
}

// ── 微信扫码登录与凭据交换 ──

export const ASTUDIO_SSO_BASE_URL = 'https://sso.xfyun.cn';
export const ASTUDIO_SSO_QRCODE_PATH = '/SSOService/wx/scanlogin/qrcode';
export const ASTUDIO_SSO_UIDS_PATH = '/SSOService/wx/scanlogin/uids';
export const ASTUDIO_SSO_BIND_PATH = '/SSOService/wx/scanlogin/bind';

export const ASTUDIO_INIT_APP_PATH = '/tenant-app/v2/init-app';
export const ASTUDIO_USER_INFO_PATH = '/userInfo';
export const ASTUDIO_BOT_CONFIGS_PATH = '/bot/models/configs';

export const ASTUDIO_WECHAT_FD_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

/** 生成 8 字符的随机 fd 串（官方微信扫码唯一凭证）。 */
export function generateAstudioWechatFd(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => ASTUDIO_WECHAT_FD_ALPHABET[byte % ASTUDIO_WECHAT_FD_ALPHABET.length]).join('');
}

export interface AstudioWechatQrCode {
  fd: string;
  qrUrl: string;
  expiresInMs: number;
}

/**
 * 申请微信扫码登录二维码。
 * 对接 GET https://sso.xfyun.cn/SSOService/wx/scanlogin/qrcode?fd={fd}
 */
export async function createAstudioWechatQrCode(options: {
  ssoBaseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  fd?: string;
} = {}): Promise<AstudioWechatQrCode> {
  const ssoBaseUrl = (options.ssoBaseUrl ?? ASTUDIO_SSO_BASE_URL).replace(/\/+$/, '');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fd = options.fd ?? generateAstudioWechatFd();

  const url = `${ssoBaseUrl}${ASTUDIO_SSO_QRCODE_PATH}?fd=${encodeURIComponent(fd)}`;
  const response = await fetcher(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`获取微信扫码二维码失败（HTTP ${response.status}）`);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('获取微信扫码二维码失败（响应不是 JSON）');
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const code = record.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`获取微信扫码二维码失败：${String(record.desc ?? record.message ?? code)}`);
  }
  const qrUrl = typeof record.data === 'string' ? record.data : '';
  if (!qrUrl) {
    throw new Error('获取微信扫码二维码失败：未返回二维码 URL');
  }
  return {
    fd,
    qrUrl,
    expiresInMs: 300_000,
  };
}

export interface AstudioWechatAccount {
  uid: string;
  ssoSessionId: string;
  username?: string;
}

export type AstudioWechatPollResult =
  | { status: 'pending'; message?: string }
  | { status: 'scanned'; account: AstudioWechatAccount; accounts: AstudioWechatAccount[] }
  | { status: 'unbound'; message?: string }
  | { status: 'error'; code: number | string; message: string };

/**
 * 轮询微信扫码状态。
 * 对接 GET https://sso.xfyun.cn/SSOService/wx/scanlogin/uids?fd={fd}
 * - code = -1: 未扫码
 * - code = 0: 已扫码，返回关联账号信息
 */
export async function pollAstudioWechatScan(
  fd: string,
  options: {
    ssoBaseUrl?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<AstudioWechatPollResult> {
  const ssoBaseUrl = (options.ssoBaseUrl ?? ASTUDIO_SSO_BASE_URL).replace(/\/+$/, '');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const url = `${ssoBaseUrl}${ASTUDIO_SSO_UIDS_PATH}?fd=${encodeURIComponent(fd)}`;
  let response: Response;
  let text: string;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    return {
      status: 'error',
      code: -1,
      message: `轮询微信扫码状态网络异常：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    return {
      status: 'error',
      code: response.status,
      message: `轮询微信扫码状态失败（HTTP ${response.status}）`,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      status: 'error',
      code: -1,
      message: '轮询微信扫码状态失败（响应不是 JSON）',
    };
  }

  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const rawCode = record.code;

  if (rawCode === -1 || rawCode === '-1') {
    return {
      status: 'pending',
      message: typeof record.desc === 'string' ? record.desc : '未扫码',
    };
  }

  if (rawCode === 0 || rawCode === '0') {
    const accounts: AstudioWechatAccount[] = [];
    const data = record.data;
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'object' && item !== null) {
          const it = item as Record<string, unknown>;
          const uid = String(it.uid ?? it.accountId ?? '').trim();
          const ssoSessionId = String(it.ssoSessionId ?? it.sso_session_id ?? '').trim();
          const username = typeof it.username === 'string' ? it.username : undefined;
          if (uid && ssoSessionId) {
            accounts.push({ uid, ssoSessionId, username });
          }
        }
      }
    } else if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.infoList)) {
        for (const item of obj.infoList) {
          if (typeof item === 'object' && item !== null) {
            const it = item as Record<string, unknown>;
            const uid = String(it.uid ?? it.accountId ?? '').trim();
            const ssoSessionId = String(it.ssoSessionId ?? it.sso_session_id ?? '').trim();
            const username = typeof it.username === 'string' ? it.username : undefined;
            if (uid && ssoSessionId) {
              accounts.push({ uid, ssoSessionId, username });
            }
          }
        }
      }
    }
    if (accounts.length === 0) {
      return {
        status: 'unbound',
        message: typeof record.desc === 'string' ? record.desc : '已扫码但未关联账号',
      };
    }
    return {
      status: 'scanned',
      account: accounts[0],
      accounts,
    };
  }

  return {
    status: 'error',
    code: (typeof rawCode === 'number' || typeof rawCode === 'string') ? rawCode : -1,
    message: typeof record.desc === 'string' ? record.desc : String(rawCode),
  };
}

/**
 * 确认绑定微信登录会话。
 * 对接 POST https://sso.xfyun.cn/SSOService/wx/scanlogin/bind
 */
export async function bindAstudioWechatSession(
  fd: string,
  account: AstudioWechatAccount,
  options: {
    ssoBaseUrl?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: boolean; message?: string }> {
  const ssoBaseUrl = (options.ssoBaseUrl ?? ASTUDIO_SSO_BASE_URL).replace(/\/+$/, '');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const params = new URLSearchParams({
    fd,
    accountId: account.uid,
    ...(account.ssoSessionId ? { ssoSessionId: account.ssoSessionId } : {}),
    isNew: 'false',
  });
  const url = `${ssoBaseUrl}${ASTUDIO_SSO_BIND_PATH}`;
  let response: Response;
  let text: string;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      message: `绑定微信登录会话网络异常：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `绑定微信登录会话失败（HTTP ${response.status}）`,
    };
  }

  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (body.code === 0 || body.code === '0' || body.flag === true) {
      return { ok: true };
    }
    return { ok: false, message: String(body.desc ?? body.message ?? body.code) };
  } catch {
    return { ok: true };
  }
}

export interface CompleteAstudioLoginOptions {
  fetcher?: typeof fetch;
  authBaseUrl?: string;
  timeoutMs?: number;
}

/**
 * 凭据交换与会话初始化（completeLogin）。
 * 使用微信扫码获得的 ssoSessionId 依次完成：
 * 1. POST /tenant-app/v2/init-app 会话初始化；
 * 2. GET /userInfo 获取用户信息与昵称；
 * 3. GET /bot/models/configs 换取模型推理 access_token（modelBearerToken）；
 * 组装并返回完整的 AstudioCredential。
 */
export async function completeAstudioLogin(
  account: AstudioWechatAccount,
  options: CompleteAstudioLoginOptions = {},
): Promise<AstudioCredential> {
  const fetcher = options.fetcher ?? fetch;
  const authBaseUrl = (options.authBaseUrl ?? ASTUDIO.authBaseUrl).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 15_000;
  const cookie = `ssoSessionId=${account.ssoSessionId}; sso_sessionid=${account.ssoSessionId}; account_id=${account.uid}; token=${account.ssoSessionId}`;

  // ① init-app
  try {
    await fetcher(`${authBaseUrl}${ASTUDIO_INIT_APP_PATH}`, {
      method: 'POST',
      headers: { Accept: 'application/json', Cookie: cookie },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // 忽略 init-app 非阻塞异常
  }

  // ② userInfo
  let nickname: string | undefined = account.username;
  try {
    const userRes = await fetcher(`${authBaseUrl}${ASTUDIO_USER_INFO_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Cookie: cookie },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (userRes.ok) {
      const userBody = await userRes.json() as Record<string, unknown>;
      const userData = (typeof userBody.data === 'object' && userBody.data !== null ? userBody.data : userBody) as Record<string, unknown>;
      const candidate = String(userData.nickname ?? userData.mobile ?? userData.username ?? '').trim();
      if (candidate) {
        nickname = candidate;
      }
    }
  } catch {
    // userInfo 降级
  }

  // ③ bot/models/configs 换取模型推理 api_key (modelBearerToken)
  const configsRes = await fetcher(`${authBaseUrl}${ASTUDIO_BOT_CONFIGS_PATH}`, {
    method: 'GET',
    headers: { Accept: 'application/json', Cookie: cookie },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!configsRes.ok) {
    throw new Error(`获取模型配置与推理凭据失败（HTTP ${configsRes.status}）`);
  }
  const configsText = await configsRes.text();
  let configsBody: unknown;
  try {
    configsBody = JSON.parse(configsText);
  } catch {
    throw new Error('获取模型配置与推理凭据失败（响应不是 JSON）');
  }

  const pick = extractAstudioApiKey(configsBody);
  if (!pick.apiKey) {
    throw new AstudioRefreshTokenExpiredError(
      `无法从 AStudio 账号后端获取推理凭据：${pick.reason || '无可用 api_key'}`,
    );
  }

  const credential: AstudioCredential = {
    access_token: pick.apiKey,
    account_id: account.uid,
    uid: account.uid,
    nickname: nickname || account.uid,
    sso_session_id: account.ssoSessionId,
    token: account.ssoSessionId,
    login_method: 'wechat',
    logged_in_at: new Date().toISOString(),
    source: 'account-backend',
  };

  return credential;
}
