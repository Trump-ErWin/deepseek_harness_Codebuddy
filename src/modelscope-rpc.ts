/**
 * modelscope 专用 RPC 的**方法处理函数**（不是自注册端点）。
 *
 * ## ⚠️⚠️ 为什么是「被主 switch 调用」而不是「自己注册」
 *
 * 这一条是 opencode 用真实事故换来的（`src/opencode-rpc.ts` 模块头有完整记录）：
 * 它最初在这里调 `rpc.register('jet-hub', handler)`，以为能与 `jet-hub-rpc.ts`
 * 并存。真机报障：
 *
 * ```
 * 添加失败：unknown method: opencode.addAnonymous
 * ```
 *
 * 根因：**Jet Hub 只有一条通道** —— `jet-hub-rpc.ts` 的
 * `connection.fetch.register({ path: JET_HUB_API_PATH })`，它把 `call.method`
 * 交给一个穷举 `switch`，`default` 分支直接回 `unknown method` 且**不让路**。
 *
 * ⇒ 本文件只导出 {@link handleModelscopeRpc}，由 `jet-hub-rpc.ts` 的
 * `handleMethod` 在 `default` **之前**调用（对不认识的方法返回 `undefined`，
 * 让主 switch 继续匹配）。
 *
 * ## 为什么 modelscope 需要自己的方法（而不是复用 account.create）
 *
 * 魔搭的凭据是用户**手工粘贴的 API Key**，没有 OAuth 授权页 ⇒ `account.create`
 * 那条「先返回 loginUrl、后台等回调」的两步式路径对它**根本不适用**。
 * 本插件已有先例（opencode）：前端在最前面改道，直接调 provider 自己的
 * addAccount 方法。**这是本仓库第二家不跳浏览器的 provider。**
 *
 * 与 opencode 的差异（都来自协议事实，不是风格）：
 *
 * | | opencode | modelscope |
 * |---|---|---|
 * | 凭据字段 | `api_key` | `access_token`（AccountPool 身份反查要求，见 `modelscope.ts` 模块头） |
 * | 账号去重 | 按 key 尾段派生 id（同 key 复用） | 同左 |
 * | 失效模式 | 形状校验 `sk-…` | 形状校验 `ms-…`（魔搭的令牌前缀） |
 * | 匿名槽 | 有（字面量 `public`） | **没有** —— 魔搭必须持 Key 才能调用 |
 *
 * @module src/modelscope-rpc.ts
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { ProviderAccountEntry } from './types.js'
import { MODELSCOPE } from './modelscope-product.js'
import { parseModelscopeCredential } from './modelscope-auth.js'

export interface RpcModelscopeAddAccountRequest {
  apiKey: string
  nickname?: string
}

export interface RpcModelscopeAddAccountResponse {
  accountId: string
  /** true = 该 Key 之前已添加过，本次只是复用。 */
  existed: boolean
}

/** 账号池的最小依赖面（结构化类型，避免绑定具体类）。 */
export interface ModelscopePoolLike {
  listAccountsByProvider(provider: string): Array<{ id: string; enabled: boolean; credentialRef: string }>
  // ⚠️ 入参用 `ProviderAccountEntry`（而不是 `Record<string, unknown>`）：
  // 后者与 `AccountPool.addAccount(entry: ProviderAccountEntry)` **不可赋值**
  // （参数逆变，tsc 直接报 TS2345），接线处就得写断言或 any。
  addAccount(entry: ProviderAccountEntry): Promise<void>
}

/**
 * Key 形状：`ms-` 前缀 + 至少 16 位。
 *
 * ⚠️ 这只是**形状**校验（挡手滑/占位符），**不是**有效性验证：
 * 真 Key 仍要等第一次真实请求才知道。
 *
 * 形状依据：魔搭控制台的「访问令牌」页签发的 Key 形如
 * `ms-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`（SDK 文档与实测一致）。
 * ⚠️ 校验刻意**宽松**（只认前缀与最小长度）：过严会在魔搭改令牌格式时
 * 把合法 Key 挡在门外，而那是用户完全无法自救的一类失败
 * （他会反复确认自己复制对了，却永远加不进去）。
 */
const KEY_PATTERN = /^ms-[A-Za-z0-9_-]{16,}$/

/** 账号 id / credentialRef 由 Key 尾段派生，使重复 Key 落到同一账号。 */
export function modelscopeSlotNamesOf(apiKey: string): { id: string; refName: string } {
  const tail = apiKey.slice(-8)
  return {
    id: `${MODELSCOPE.id}-${tail.toLowerCase()}`,
    // ⚠️ 前缀必须是 `MODELSCOPE` —— `jet-hub-store.ts` 的
    // `REF_PREFIX_TO_PROVIDER` 按它反推 provider，漏登记会让
    // `MODELSCOPE_ACCOUNT_*` 的账号在 `state.json` 缺失时**静默消失**。
    refName: `MODELSCOPE_ACCOUNT_${tail.toUpperCase()}`,
  }
}

/**
 * 处理一个 modelscope RPC 方法。
 *
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（它自己的 `default`
 *          分支仍能给出 `unknown method`，语义归属清晰）。
 *
 * ⚠️ 不认识时**必须**返回 `undefined` 而不是 `{ok:false}`：主 switch 会在
 * `default` 之前调用本函数，若本函数对未知方法也回信封，别的 provider 的
 * 方法名就会被误判成「格式错误」而不是「没这个方法」。
 */
export async function handleModelscopeRpc(
  ctx: Context,
  pool: ModelscopePoolLike,
  method: string,
  payload: unknown,
): Promise<unknown> {
  const fail = (message: string) => ({ ok: false as const, error: { code: 'bad-request', message } })
  const done = <T>(value: T) => ({ ok: true as const, value })
  try {
    switch (method) {
      case 'modelscope.addAccount': {
        const req = (payload ?? {}) as RpcModelscopeAddAccountRequest
        const apiKey = typeof req.apiKey === 'string' ? req.apiKey.trim() : ''
        if (!KEY_PATTERN.test(apiKey)) {
          return fail(
            'API Key 形状不对（应以 ms- 开头、至少 20 位；'
            + '可在 https://modelscope.cn/my/myaccesstoken 生成）',
          )
        }
        const { id, refName } = modelscopeSlotNamesOf(apiKey)
        // ⚠️ 重复 Key 必须**复用**同一账号：同 Key 加两次会让用户误以为是
        // 两个独立额度桶，实际请求仍会打到同一份额度上（并在限额时一起被跳过）。
        if (pool.listAccountsByProvider(MODELSCOPE.id).some((a) => a.id === id)) {
          return done({ accountId: id, existed: true } satisfies RpcModelscopeAddAccountResponse)
        }
        const nickname = typeof req.nickname === 'string' && req.nickname.trim().length > 0
          ? req.nickname.trim()
          : `ModelScope ${apiKey.slice(-6)}`
        await ctx.credentials.set(credentialRef(refName), JSON.stringify({
          // ⚠️ 字段名必须是 `access_token`（AccountPool 身份反查用，见 modelscope.ts）。
          access_token: apiKey,
          nickname,
        }))
        await pool.addAccount({
          id,
          provider: MODELSCOPE.id,
          nickname,
          enabled: true,
          credentialRef: refName,
          // ⚠️ 魔搭**没有 refresh 端点**（API Key 是静态材料，默认长期有效），
          // 标 true 会让 UI 显示「可自动续期」——一个永远不会发生的承诺。
          refreshable: false,
          createdAt: Date.now(),
        })
        return done({ accountId: id, existed: false } satisfies RpcModelscopeAddAccountResponse)
      }

      default:
        // ⚠️ 返回 `undefined`（不是错误信封）：方法不属于 modelscope，
        // 让主 switch 继续匹配 —— 它自己的 `default` 会给出
        // `unknown method`，那才是准确的归属。
        return undefined
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** 供单测用：判断一个 ref 是否是本 provider 的账号 ref。 */
export function isModelscopeAccountRef(ref: string): boolean {
  return /^MODELSCOPE_ACCOUNT_[0-9A-Za-z]+$/.test(ref)
}

export { parseModelscopeCredential }
