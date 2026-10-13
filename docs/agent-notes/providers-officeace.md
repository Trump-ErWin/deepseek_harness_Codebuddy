# OfficeAce（华为 MaaS / 果办）provider 笔记

> 来自 PR #89 的三轮审计（接线审计 / 展示层审计 / 对抗性审计）。
> 每条都是**实测**或**逐行核对**得出的，不是推测。

## 0. 它是什么

华为云 ModelArts MaaS 的桌面客户端「果办」背后的云端 API。第 15 个 provider，
id = `officeace`，服务名 `officeaceAuth`。登录/推理/续期/余额/倍率**五项云端直连**，
不需要安装或运行果办客户端（对抗审计逐字段核对后确认该声称成立；本地 API
降级链只存在于 `ref === undefined` 的老单账号兼容路径，生产 RPC 恒传
`credentialRef` 故走不到）。

## 1. 协议要点

| 项 | 端点 | 鉴权 |
|---|---|---|
| 登录 | 华为云 OAuth PKCE（`client_id='pdp5_for_agentarts'`，公开客户端无 secret） | code_verifier + ES256 DPoP JWT |
| 推理 | `POST {maas}/v2/chat/completions` | `Basic base64(model_app_key:secret)` |
| 续期 | `POST sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens` | refresh_token（**30 天且一次性**）|
| 余额 | `GET {base}/v1/subscription` | V11-HMAC-SHA256 |
| 倍率 | `GET {base}/v1/model-token-rates` | V11-HMAC-SHA256 |

### ⚠️ V11 签名的三条铁律（各自都曾导致 APIG.0301，别凭直觉改）

1. **GET 请求不发 `Content-Type`** —— 多这一个头，签名串多一行，服务端重算必不匹配
   （`officeace-auth.ts` 的 `signAndRequest`：`if (method === 'POST') original['Content-Type'] = contentType`）。
2. **密钥派生用 hex 字符串作 key，不是 raw bytes**：
   `HMAC(sha256, ak).update(sk)` → 拼 scope + `0x01` → 取前 32 字节 →
   **`.toString('hex')`** → 再 `Buffer.from(derivedKey, 'utf8')` 当 HMAC key。
3. **分隔符是 LF**（canonical 头行与 stringToSign），不是空格；路径**强制尾斜杠**。

### ⚠️ `expires_at` **没有**秒/毫秒混淆 —— 别"顺手"加归一化

华为 STS 的 `expiration` 是 **ISO 8601 字符串**（`IamTokenResponse.credentials.expiration: string`），
消费侧一律 `Date.parse(...)`。故 buddy / lobsterai / accio 那条 `> 1e12` 防御分支
**对 officeace 不适用**，加了反而是错。这是「同族只共享信封骨架，不共享每个字段形状」的又一例。

### ⚠️ DPoP 私钥**必须复用同一把**

`generateDpopKeyPair` 只在 `startLogin()` 调一次，私钥 JWK 持久化进凭据，
续期时 `importDpopPrivateKey(current.dpopPrivateJwk)`。换一把 ⇒ 服务端拒绝。
payload 必须齐 `{htm, htu, iat, jti}`；**无 `ath` 是正确的**（RFC 9449：没有 access token 时省略）。

## 2. ⚠️⚠️ 续期三条规则（2026-10-13 审计补齐，此前一条都没有）

**背景**：`refresh_token` **一次性**，而三条入口（定时器 `refreshAll` /
适配器 401 兜底 / `account.refresh` RPC 与积分自愈）会并发进入同一个 ref。

初版实现的三个缺陷：

| 缺陷 | 症状 |
|---|---|
| `refreshAccountCredential` **直连** `doRefreshCredential`，无锁 | 并发时先到者消费 token、后到者拿 STS5.1806；先到者写盘前被打断 ⇒ **新 token 永久丢失，只能重新登录** |
| **无任何过期判据** | 定时器每 30 分钟续期一次 ⇒ **一天烧掉 48 个一次性 token**（STS 寿命约 2 小时，根本不需要） |
| 失败时**不回读凭据** | 并发下把「他处已续成功」误判成本账号失效 ⇒ 永久标死 |

⚠️ **原先的 `refreshInFlight` 闸只加在 `refreshStoredCredential` 那条「兼容文件腿」上，
生产主路径完全绕过它** —— 这是最隐蔽的一种错法：**加了锁，但加错了一条腿**。

现已按 codearts 的同款三件套补齐（`refreshAccountCredential` 内）：

1. **per-ref `SerialQueue`**（`queueFor(refName)`，队列表上限 64，超额淘汰最早创建者）；
2. **锁内重读 + lead-time**：拿到锁时凭据可能已被上一轮换新，距过期还早时
   只对账池值、**不发请求**（`shouldRefreshNow`，lead = 1 小时）；
3. **判终态前重读**：续期被拒时先看磁盘那份 `refresh_token` 是否**已经不等于**
   本次用的那份 —— 并发下服务端烧掉的是**旧的**一份，磁盘上此刻躺着**新的、可用的**
   凭据，那是「他处已续成功」而不是「本账号失效」。

守卫：`tests/unit/officeace-refresh-guards.spec.ts`（5 条，逐条做过反向验证）。

## 3. ⚠️ 接线陷阱（新 provider 通用，此处已复发）

`src/jet-hub-rpc.ts` 的 `SELF_HEAL_REFRESHABLE_PROVIDERS` ——
officeace 初版**漏登记**，症状是「系统睡眠/挂起恢复后刷新积分报 HTTP 401、
卡片红『已过期』、窗口内无手动自救、**日志零字**」，与 issue IKKHL5 逐字相同。
STS 寿命约 2 小时，恰好落在「恢复后到定时器补触发那一轮（最多 30 分钟）」的窗口内。

⚠️ **这条不是「记得加」能解决的** —— 原有的守卫是**硬编码白名单**，
只锁住已知的 11 家，新增 provider 漏接时**零用例变红**。
现已把**守卫用例的期望值**改为**从 `PROVIDER_REGISTRY` 派生**
（`credits-balance-self-heal.spec.ts` 的
`★★ 每个「有余额能力的渠道」都必须在自愈 Set 里`），并做过反向验证：
删掉 `OFFICEACE.id` 精确点名变红。

⚠️⚠️ **但生产侧的那个 Set 仍是硬编码**（`src/jet-hub-rpc.ts` 的
`SELF_HEAL_REFRESHABLE_PROVIDERS`，形如 `new Set([...])` 字面量）——
**2026-10-13 合并审计实测确认**。两者是**两个不同的东西**：

| | 是什么 | 漏加新 provider 的后果 |
|---|---|---|
| 生产 `SELF_HEAL_REFRESHABLE_PROVIDERS` | 硬编码 `Set` | 该家**永不自愈**（症状静默、日志零字） |
| 守卫用例的**期望值** | 从 `PROVIDER_REGISTRY` 派生 | **用例变红**（把静默失效变成显式失败） |

⇒ **加新 provider 时仍必须手动往那个 `Set` 里加一行**；守卫的作用是
「忘了加就会红」，不是「加了就自动生效」。别把「期望值已派生」读成
「生产 Set 已派生」—— 那正是本节此前措辞的歧义。

同款陷阱还有 `src/jet-hub-store.ts` 的 `REF_PREFIX_TO_PROVIDER`（漏加 =
`OFFICEACE_ACCOUNT_*` 的账号在 `state.json` 缺失时静默消失）。

## 4. ⚠️ 多账号：`session.json` 共享文件是「串号」根源

凭据已改按 `credentialRef` 分文件 + 走 DSH 凭据库，但**兼容用的公共
`session.json` 仍在**（`persistLogin` 每次登录都顺手写一份）。读它的三处都会串号：

| 读点 | 症状 | 状态 |
|---|---|---|
| `account.list` 的 `expiresAt` 自愈回填 | 把**同一份**有效期写给所有缺该字段的账号（方向还可能相反） | 已修：逐账号 `ctx.credentials.resolve` |
| `officeace.status` RPC | 三个字段描述的都是「最后登录的那个账号」 | 无客户端调用方（客户端零命中），是埋好的地雷 |
| `probeOfficeAce` / `readOfficeAceCredential` | 面板门控读共享文件 | 生产路径已绕开 |

**教训**：改「单凭据 → 多凭据」时，**别只改主路径** —— 旧的单文件读取点
会一颗颗变成串号源。逐个 grep 该文件名，别凭「主路径已经改了」的印象收工。

## 5. 展示层：三档分桶与倒计时的两个真实缺陷（2026-10-13 审计）

详见 `client-ui.md`。这里只记 officeace 相关的一条：

⚠️ **TRAE 的 `active` 是硬编码 `true`**（`src/trae-credits.ts`），压根不反映是否过期。
这让 `earliestExpiringAt` 选中已过期包成为**必然可达**而非理论风险 ——
选中后 `expiryCountdown` 拿到过去时刻返回空串 ⇒ **整段倒计时消失**。
已修（选举时要求 `end > now`）。

## 5.5 ⚠️⚠️ 换账号登录：华为 authui 会静默复用会话（2026-10-13 用户报障）

> 「新建账号那个链接就自动用之前登录的账号授权了」

**根因不在授权链接参数** —— `state` / `code_challenge` 每次都是新随机值，PKCE 完整。
复用发生在**更前面一层**：浏览器里 `auth.huaweicloud.com` 的登录会话 cookie。实测三条：

| 试验 | 结果 |
|---|---|
| `authui/login.html?service=<authorize>` | **200 直接放行**（复用会话，看不到登录框）|
| authorize 里追加 `&prompt=login` | **仍 200、无重定向** ⇒ **authui 忽略该参数**，此路不通 |
| `authui/logout?service=<authorize>` | **302 先清会话**再跳 authorize；跟随后落到 `/authui/login`（注意从 `login.html` 变成 `login`）|

⇒ 只有两条路：先 logout，或**换一个 cookie jar**。

### 选「无痕窗口」而不是 logout —— 理由是作用域

实测 `logout` 的 `Set-Cookie` 有 4 条，其中：
`cloud_verify_ticket=; Max-Age=0`（清票据）+ `IAMIdentity=…; Path=/`（重写）。
**作用域是整个 `auth.huaweicloud.com` 域，不是单次授权** ⇒ 在用户日常浏览器里执行会
**连带登出华为云控制台**。无痕窗口是全新 cookie jar，天然无会话，
**既不碰用户既有会话、也不需要 logout**。

⚠️ **官方（果办）同样没解决这点**，别当参考实现：它的 `LoginPage` 用
`window.open(url, 'officeclaw-login', 'popup,…')` 开**共享 cookie** 的小窗，
「重新登录」走 `authui/logout`（`LoginCallbackPage`）。即官方也无法换账号登录。

### 实现落点与三条实测约束

客户端**做不到**无痕（`window.open` 无法请求无痕 —— 那是进程级启动参数），
故由宿主 `spawn` 浏览器可执行文件（`src/login.ts` 的 `openIncognitoWindow`）：

1. ⚠️⚠️ **不要用「app 模式」开关**（真机证伪，阻断级）：初版传了它想让窗口去掉
   地址栏，结果 360 极速浏览器 X 上显示「**域名解析错误 —— 请检查域名拼写**」——
   该浏览器把开关的值当**域名**去解析。隔离探针（本地 HTTP 服务器 + 独立
   `--user-data-dir`）证明该开关本身能被 Chromium 正确解析并发出请求
   ⇒ 是**该浏览器对它的改写**，不是 URL 编码问题（实测 28 个 `%` 序列逐字送达）。
   ⇒ 换取账号**不依赖**它，而它的失败是阻断级 ⇒ 只用无痕开关。
2. **浏览器路径必须读注册表**（`UrlAssociations\https\UserChoice` → ProgId →
   `shell\open\command`）：用户装的可能是 Chrome / Edge / 360 / Firefox，
   路径各不相同，硬编码必然错。⚠️ 三个根都要试（HKCR / HKCU\Software\Classes /
   HKLM），本机的 360 就只注册在 **HKCU\Software\Classes**。
3. **轮询不依赖浏览器 cookie**：`GET /v1/claw/auth/code?state=` 是**匿名服务端轮询**
   （实测直接返回 `AgentArts.11000004` 参数校验错，说明不需要任何身份）
   ⇒ 无痕窗口完成授权后，宿主照样拿得到 code。窗口关掉也不影响。

### ⚠️⚠️ 测试纪律：**开窗的行为测试只能放 e2e**（用户 2026-10-13 明确要求）

> 「打开浏览器窗口的测试只能放在 e2e 测试里」
> 「单元测试里不要加打开浏览器 url 的测试，打开一堆空白窗口没用，挡我视线」

这是我**真实污染过用户桌面**两次换来的纪律：

1. **单测里直接调 `openIncognitoWindow`**：初版写
   `expect(() => openIncognitoWindow('https://example.invalid')).not.toThrow()`，
   想验「不抛错、返回 boolean」。该函数**会真的 spawn 浏览器** ⇒
   每跑一次 `pnpm test` 就在用户桌面弹一个 `example.invalid` 窗口。
2. **间接污染（更隐蔽）**：`officeace-rpc-multi-account.spec.ts` 走的是**真实的
   `account.create` RPC**，其桩数据里带
   `authorizeUrl: 'https://auth.huaweicloud.com/stub'`。接线后宿主就真去打开那个
   桩 URL ⇒ 全量测试一跑，用户桌面多出一堆 **`auth.huaweicloud.com/stub`**
   空白窗口。**根因不是那个用例写错了**（它的桩完全合理），而是**被测代码
   在测试环境下产生了真实副作用**。

**修法是两层的，缺一不可**：

1. **被测代码加测试断路器**：`openIncognitoWindow` 开头
   `if (process.env.NODE_ENV === 'test') return false`。
   ⚠️ 判据必须按**运行环境**，**不能按 URL 特征打补丁**（`if (url.includes('stub'))`）
   —— 换个用例换个 URL 立刻复发。
   ⚠️ 返回 `false` 而不是抛错：调用方据此走正常回退分支，断言形态与生产一致。
2. **真开窗的验证移到 `tests/e2e/`**，带闸门
   （`DSH_OFFICEACE_E2E=1`，见 `pnpm test:e2e:officeace`），**默认跳过** ——
   与 `login.e2e.spec.ts` 同款范式（`describe.runIf(E2E)`）。

**守卫**：`tests/unit/officeace-incognito-login.spec.ts` 的
⑩（测试断路器存在）与 ⑪（本文件不得 import `src/login.js`，且 e2e 版本必须存在）。

### 另一条源码级断言的教训

⚠️ **判据要避开字符串字面量**：⑪ 的第一版写成「剥注释后匹配
`openIncognitoWindow(` 调用形态」，结果扫到了**同一文件里另一条用例的字符串
字面量**（它断言 `jet-hub-rpc.ts` 的源码文本）而恒红。⇒ 只锚定 **import 语句**
（没 import 就必然调不到真实实现，精确且不会假失败）。

## 5.7 ⚠️⚠️ 模型列表为空 = 打错了 host（`maasBaseUrl` 是死字段，2026-10-13 真机实测）

**用户报障**：「provider 列表里有 OfficeAce、我也加了账号，但**对话中选择模型的
列表里看不到 OfficeAce 的模型**」。

**根因**：适配器一律打硬编码的 `OFFICEACE.defaultBaseUrl`
（`https://officeace.cn-southwest-2.huaweicloud-agentarts.com`），
而华为**按账号下发专属网关**（本机是 `modelgw-0004.officeace.cn-southwest-2...`）。
同一个 Basic 凭据实测：

| host | `/v2/models` | `/v2/chat/completions` |
|---|---|---|
| `officeace…`（硬编码，修复前）| **401** `APIG.1009 AppKey or AppSecret is invalid` | **401** |
| `modelgw-0004.officeace…`（凭据里）| **200** | **200** |

**后果链（全程零日志）**：`probe` 401 ⇒ `listModels` 返回 `[]` ⇒ 选择器空分组；
而空返回与「无账号」**同形** ⇒ 目录门控把**整个 provider 隐藏**。

⚠️ **`maasBaseUrl` 一直都在凭据里**（`fetchModelInfo` 从云侧 `model_api_url_base`
取），只是**从没被读过** —— 典型「写了不读的死字段」。我在 PR #89 审计时**已登记
这条为已知缺口，却低估了它**（当时判为「影响有限，若账号被分到别的 region 才暴露」）。
真机证明：**它就是主路径**，而且**默认域对新账号直接 401**。
⇒ **教训：写进凭据却没人读的字段，要按「可能已经是主路径」对待，而不是按注释里的
推断定性。** 这条缺口当时只要跑一次真实的 `listModels` 就会暴露。

**修法**（`src/officeace-adapter.ts` 的 `maasBaseUrlOf`）：
推理/探测三处（probe、stream 首发、401 重试）改用 **`credential.maasBaseUrl`**，
缺失时回退 `defaultBaseUrl`（老凭据零行为变化）；尾斜杠规范化。

⚠️ **只改 Basic 鉴权的推理面**。V11 签名那套（`/v1/subscription`、
`/v1/model-token-rates`）实测**两个 host 都存在且都要求 IAM 签名**
（返回 `failed parse aksk format` 而非 404/DNS 错）⇒ 它们是**管理面 API**，
**不要**「为统一」一起改 —— 会把余额与倍率一起打挂。

**守卫**：`tests/unit/officeace-base-url.spec.ts`（9 条：纯函数边界 / 端到端
mock fetch 断言 probe 与推理真打账号域 / 缺字段回退 / **范围守卫**防误改 V11）。
已反向验证：改回硬编码 ⇒ 行为断言与源码断言**各自精确变红**。

## 5.6 ⚠️⚠️ DSML 工具调用是**闭环**：只「教」不「解」= 工具永不执行（2026-10-13）

DeepSeek-V4 系模型走 DSML 而非标准 `tool_calls`（理由见 `src/dsml.ts` 头注：
标准 `tool_calls` 的参数需一次性打包，会撞 APIG ~60s 空闲断连）。

⚠️ **这条协议由插件负责收发，宿主不参与**。实测宿主 bundle（116 MB
`app.asar`）用 `findstr` 搜 `DsmlContentExtractor` / `parseDsmlToolCalls` /
`DSML_TOOL_CALLS_OPEN` —— **全部零命中**，只有标准 `tool_calls`。

故一个通道要用 DSML，必须**两半都接**：

| 一半 | 做什么 | 落点 |
|---|---|---|
| **教** | 不发 `tools` 字段，改把 schema 注入 system 提示 | `buildDsmlSystemPrompt` |
| **解** | 把正文里的 DSML 块摘出来转成结构化 tool-call | `DsmlContentExtractor` |

⚠️ **只接「教」的后果**：模型写出的 DSML 整段当**正文**显示，工具
**永不执行** —— 用户看到的是标签文本而不是执行结果，且日志里那条
assistant 消息只有 `reasoning` + `text` 两块、**没有任何 `tool/call` 记录**。

这正是本通道**合并初期的真实状态**：`officeace-adapter.ts` 注入了提示且
`toolsPayload = undefined`（模型只会写 DSML），而它走的 `consumeOpenAiSse`
（`openai-compat.ts`）**不解析 DSML** —— 解析器当时只存在于
`llm-adapter.ts`（CodeArts 专用），本通道复用不到。

这跟当初**漏注入** `buildDsmlSystemPrompt` 是**同一个病根**：
协议实现散落，换个通道就漏一半。

### 修法：协议实现只有一份，收发成对

- 解析器（状态机 + `parseDsmlToolCalls` + 标量还原）**下沉到 `src/dsml.ts`**，
  与提示词同处一层；`llm-adapter.ts` 改从共享层导入，删本地副本。
- `consumeOpenAiSse` 新增可选 `dsmlToolMode`：正文 delta 先过提取器，
  解析出的调用复用既有 tool-call 注册/发射路径（wire 下标取**负数**，
  与标准 `tool_calls` 的 0/1/2… 隔离，不抢槽位）。**默认关闭**，
  关闭时行为与从前逐字节一致；收尾 flush 把未闭合残片放行，不吞内容。
- `officeace-adapter.ts` 由**同一个 `dsmlMode` 开关**同时驱动两半
  （注入提示 + 传 `dsmlToolMode`）—— 单边存在就等于没修。

### ⚠️⚠️ OfficeAce **默认不走 DSML**（2026-10-13 三次事故后决定）

> ⚠️ 这里的「三次事故」是**当时**的计数；当天晚些又发生第四次
> （「聚合 provider 很快就结束了没有原因」），见下方「第四次事故」。
> 两者根因同族：协议实现散落，换个通道/换个笔误就漏一半。

`officeace-adapter.ts` 的 `dsmlMode` **默认 `false`**，只有
`OFFICEACE_DSML=1` 且模型匹配 `needsDsmlToolMode` 时才为真。

| 开关 | 「教」= 注入 `buildDsmlSystemPrompt` | 「解」= 传 `dsmlToolMode` | 请求体 |
|---|---|---|---|
| 默认（未设 env）| ✗ | ✗ | 发标准 `tools` 字段 |
| `OFFICEACE_DSML=1` | ✓（且不发 `tools`）| ✓ | 只发注入的 system 提示 |

**为何默认关**：DSML 把工具协议从「框架保证的结构化字段」降级成「模型自觉
遵守的文本约定」，而 `deepseek-v4.1-flash` 经本渠道**无法稳定遵循** —— 三轮
迭代（注入提示 → 大小写判定 → `calls` 别名兼容）全部到位后，模型仍在同一轮
里混写 `<｜DSML｜tool_calls>` 与 `<｜DSML｜ calls>`；更常见的是**压根不发工具
调用**，只输出「我这就去查：」然后结束（用户视角 = 「Agent 不干活」）。
两害相权：标准 `tools` 字段下**工具必定可用**，超时风险留给需要它的场景权衡。

⚠️ 故本节描述的「解析接线」在**默认配置下不执行** —— 它是为
`OFFICEACE_DSML=1` 那条路径准备的。**codearts 通道不受本开关影响**，
`needsDsmlToolMode` 在那边仍是恒开（见 `llm-adapter.ts`）。

### 守卫

行为级（**真喂 SSE 流、断言 chunk**）：
`tests/unit/dsml-consume-wiring.spec.ts` —— 这是**唯一**能证明接线通了的守卫。

- ① / ②：开启时解析出 tool-call、关闭时**逐字节**保持旧行为（对照）。
- ③：逐字符分帧（标签必然跨帧，只测整块等于没测）。
- ④ / ⑤：开标签**别名**端到端；⑤ 专门覆盖 `\s*` 的**多空白**形态
  （`<｜DSML｜␣␣calls>` / `\t` / U+3000）—— 枚举式保留候选会在此提前放行。
- ⑥ / ⑦：`<thought>` 内容归位到 reasoning；未闭合时残片也须放行。
- ⑧：**正文死循环命中后到达的 DSML 调用仍须执行**。
- ⑨：纯 DSML 响应不得留下孤儿 `block-start(text)`。
- ⑩：上游不合规的 `index:-1` 不得与 DSML 的负数下标撞车。
- ⑪：名字不可用的调用一个 chunk 都不发（报 max-tokens 而非静默 stop）。

源码级（强度有限，只能防「整段协议被删」）：
`tests/unit/dsml-parse-roundtrip.spec.ts` 的 ⑥（**剥注释后**断言
`buildDsmlSystemPrompt(` 与 `dsmlToolMode: true` 各≥2 处）、⑦⑧⑨。

⚠️ **两组的强度差异必须如实标注**：源码 grep **挡不住「删掉接线、保留注释」**
—— 2026-10-13 审计实测，删掉 `openai-compat.ts` 里
`if (dsmlExtractor !== undefined) {…}` **整块**后，当时的入库用例**全部仍绿**
（只有钉住构造那一行的 ⑨ 才红）。这正是必须另立行为级 spec 的原因。

⚠️ 与 §6 的 `reasoning-delta` 归一化缺口是**两件事**：那条是「标记写坏了要修」，
本条是「协议根本没接全」。

### ⚠️⚠️⚠️ 第四次事故（2026-10-13 晚，用户报障「聚合 provider 很快就结束了没有原因」）

**现场取证**（真实会话 `session-bac90b72`，逐字样本）：

| seq | provider/model | 观感 |
|---|---|---|
| 17 / 34 | `aggregate/deepseek-v4-1-flash` | reasoning + 一句正文，`finish=stop`，**零 tool-call**，usage 全 0 |
| 47 | `codearts/deepseek-v4.1-flash` | text 块**整段是 DSML 原文**（690 字符） |

**根因不是「协议没接」，而是「协议接了但读不出这一种笔误」**：
模型输出的是

```
<｜DSML｜ calls>\n<｜DSML｜ invoke name="pwsh">\n<｜DSML｜ parameter name="command" string="true">…</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>
```

`｜DSML｜` 之后**带空格**，且不只在 `calls` 上 —— `invoke` / `parameter` 同样中招。
而当时 `feed()` 的归一正则 `(<\/?)｜DSML｜\s*(?:tool_)?calls>` **只覆盖
`tool_calls` / `calls` 一种名字** ⇒ `indexOf(DSML_INVOKE_OPEN_PREFIX)`
恒不命中 ⇒ `parseDsmlToolCalls` 返回**空数组** ⇒ `in-dsml` 分支把它当
「解析成功但无调用」⇒ **整段工具调用被静默丢弃**。

⇒ 症状与「无报错中断」同型，且**比标签泄漏更糟**：用户连「模型写了什么」
都看不到（那 690 字符不是泄漏，是同一根因在**整帧**路径下的另一种表现）。

⚠️ **这条与 §5.6 前三版是同一个病根的第四种形态**：协议定义散落、
换个通道/换个笔误就漏一半。修法仍是**收归一处**（`normalizeDsmlText`）。

**本轮修的 4 条真缺陷**（均反向验证，见 `scripts/reverse-verify-dsml.mjs`）：

1. **`invoke` / `parameter` 的空白形态从未被归一** ⇒ 内容凭空消失。
   新增 `normalizeDsmlLabel`（对**任意**标签名压空白，名字规则与
   `normalizeDsmlText` 同源）。
2. **`parseDsmlToolCalls` 的空数组被当「解析成功」** ⇒ `in-dsml` 分支
   静默丢块。改为 `parsed === undefined || parsed.length === 0` 一并放行原文。
3. **`parseDsmlInvoke` 在整块上搜 `name=`** ⇒ 模型漏写 invoke 的 name 时，
   第一个 `name=` 命中 **parameter 名** ⇒ 工具名变成 `command` /
   `path` / `pattern` ⇒ `unknown tool "command"`。改为只在 invoke 开标签内找。
4. **`fixDsmlMarkers` 的 `DSML` 后前视漏了字母** ⇒ `<｜DSML｜｜invoke`
   （右侧双竖线后紧跟 `i`）**一条都修不了**，只修左侧、留下半修形态。
   前视补上协议标签名首字母 `[tcip]`（`t`ool_calls / `c`alls /
   `i`nvoke / `p`arameter / `t`hought）；**不泛化成任意字母**，否则
   `DSMLX` 这类普通词重新被误伤。

**顺带修的两条判据缺口**（都在 `isDsmlLabelPrefix`，均为本轮自伤后修复）：

- 第二段写成 `｜{2,}` 只认双竖线 ⇒ **漏掉规范单竖线形态**（多空白别名走的路）
  ⇒ 标签被提前放行（`dsml-consume-wiring` ⑤ 实测变红）。改回 `｜+`。
- `DSML` 四字符本身会被拆帧切开（逐字符时 `<｜D`、`<｜DS`…），
  加第一段 `^<｜{0,3}$` 纯竖线判据 + 第二段 `D(?:S(?:M(?:L)?)?)?` 逐级可选。

**新增守卫**：`tests/unit/dsml-label-forms.spec.ts`（23 条，**行为级**）。
灵魂是**二分帧 + 逐字符穷举**，样本直接抄**真实会话原文**（自造 fixture
曾在真实数据上失效，见 `session-replay.spec.ts` 的建立理由）。

⚠️ **`aggregate` 为何也中招**：它只是**透传** `options`（含 `tools`）给
`ctx.llm.stream({ provider: target.provider, model: target.realId })`，
下层 codearts 注入了 DSML 提示、模型写 DSML、解析器读不出 ⇒
**聚合层零改动也照样中招**。即：这类缺陷的排查不能停在聚合层。


## 6. 待办 / 已知缺口

- **`maasBaseUrl` 是死字段**：写了从不读。若某账号的 `model_api_url_base`
  与默认值不同，请求会打到错误的 host。修法：适配器改用它并加默认值兜底。
- **`fetchModelTokenRates` 读共享 `session.json`** ⇒ 多账号下倍率取「最后登录那个」。
  影响低（倍率是账号级静态配置，取不到时空表降级），但它与 §4 是同一类。
- **V11 `scope` 硬编码 `cn-southwest-2` / `apic`**：当前与 URL 一致故正确，
  但没有守卫 —— 账号若被分配到别的 region，签名 scope 与 Host 都会错。
- **`reasoning-delta` 未接 DSML 归一化**：11 处思考链出口全发原文，
  守卫清单里也没登记。见 `protocol-wire.md`。
- **`login.poll` 的 `done:false, error` 客户端零消费** ⇒ 用户看到「转圈 5 分钟」。
