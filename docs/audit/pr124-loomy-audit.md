# Gitee PR !124（loomy 凭据探测失败不得打断整轮）审计记录

- 审计分支：`pr124-loomy`（PR 提交 `2d96060` + merge master `9719ccf` = `aa31001`）
- 净改动（PR 自身）：`git diff master...HEAD` 仅 4 个文件 / +190 / −1
  - `src/loomy-adapter.ts`、`src/index.ts`、`tests/unit/loomy-adapter.spec.ts`、一个 docs
- 审计方式：**常规审计 + 对抗性审计两路 subagent 并行**（各自独立 git worktree 沙箱 +
  node_modules 目录联接）+ 主会话独立复验 + 变异验证（含红因核对与锚点自证）。
- 合并后基线：`tsc`（源码/测试）exit 0；`vitest run tests/unit/loomy` = **16 套件 / 321 passed**；
  全量连跑 3 次 = **9777 passed / 1 failed**（唯一红为基线既有的
  `jet-hub-styles-ownership`，读本机宿主 `client.js` 文本）。

## 一、结论摘要

| 维度 | 结论 |
|---|---|
| 报障根因是否成立 | ✅ 成立。只读探测端点不可用 ≠ 凭据失效，旧实现把前者当后者 ⇒ 整轮中断 |
| 修法方向 | ✅ 正确（降级为 warn + 继续用现有凭据），且与 `refreshAll()` 的**行为**同向 |
| 是否修全 | ❌ **只修了两处 `refresh()` 调用点中的一处**（P1-1） |
| 变异表是否可信 | ⚠️ 有一句不实：「反向对照两种状态都绿」—— 实测删掉终态抛错时它**会红** |
| 守卫覆盖 | ❌ **401/403 分支零覆盖**（把该分支降级后 64 条全绿） |

## 二、确认缺陷（本 PR 引入 / 未修全）

### 🔴 P1-1：401/403 分支的 `refresh()` 仍是裸调用 —— 同一错误两套判据，且阻断换号自救

**位置**：`src/loomy-adapter.ts` 的 `if (response.status === 401 || response.status === 403)` 分支
（HEAD 上约 `:893-895`）。PR 只给前置门禁（约 `:759`）加了 `try/catch`。

**实测**（同一份 stub `refresh` 抛 `Loomy 凭据探测失败：系统内部错误`）：

| 场景 | 结果 |
|---|---|
| 前置门禁分支 | 整轮**成功**，`warns=1` |
| **401/403 分支** | 整轮**失败**，`warns=0`，错误是**裸 `Error`**（无 `code`，与报障 `UNKNOWN` 同形） |

**次生后果（决定性数字）**：A 的 token 401、池里 B 完全正常时 ——
整轮失败、`getAvailableAccount` 调用 **0** 次、B **从未被尝试**。
这直接**证伪 PR 的关键断言**「真正的失效会在业务请求上以 401 / `100002` 暴露，
由本适配器的请求级换号与 `classifyLoomyFailure` 接住」—— 那条自救路径被这处漏修**阻断**。

**修法（已实测验证）**：401 分支探测失败时**不重取凭据、不重发**，直接落到下面的
`!response.ok` 换号循环（`tried` 已含 `activeAccountId`，换号从下一个号开始）。

⚠️ **不能照抄前置分支的「降级后继续重取重发」**（对抗审计 D1–D4 实测）：

| 变体 | 请求数 | 说明 |
|---|---|---|
| 无池恒 401 | 2 | 同一坏 token 被发两遍 |
| 池 + 反查失败 | 3 | 同一 token 发 3 次 |
| A 坏 B 好 | 3 | 自救成功但**白烧一次**重复请求 |
| 8 号全 401 | **9** | 首号重复一次（`LOOMY_MAX_ROTATE` 与 `tried` 兜住，**不是死循环**） |

按「不重取不重发」修法实测：A401→B 正常 ⇒ `SUCCESS`、`auth=["tok-A","tok-B"]`（不重发 A）；
8 号全 401 ⇒ 请求数 **1**；原 64 条用例全绿；`tsc` exit 0。

### 🔴 P1-2：守卫对 401 分支**零覆盖**（缺陷就藏在没有用例的路径里）

变异（锚点已自证，CRLF）：把 401 分支那处 `refresh()` 改成静默放过 ⇒
`tests/unit/loomy-adapter.spec.ts` **64 条全绿**。
⇒ PR 新增的 3 条用例只覆盖前置门禁，**完全不覆盖 401 分支**。
按本仓库口径，这不是「漏写用例」而是「修复漏了一半且无人能发现」。

### 🟠 P1-3：终态判据只认 `name`，漏掉「凭据未配置 / 凭据解析失败」

`src/loomy-auth.ts`：单凭据入口 `refresh()` 对「凭据未配置」抛
`RefreshTokenExpiredError`（**终态**），而按 ref 入口 `refreshAccountCredential()` 对
同一情形抛**普通 `Error`**（`凭据未配置` / `凭据解析失败`）。

生产热路径在**池里有账号时**走的是按 ref 入口 ⇒ 这两个格被 `isLoomyTerminalRefreshError` 判否
⇒ 降级继续。实测最坏形态：池账号凭据缺失、单凭据老 ref 还留着一份旧凭据时 ——
**用另一份凭据继续跑**，`warns=["…凭据未配置"]`，"该重新登录"被吞。

**修法**：`loomy-auth.ts` 那两处改抛 `RefreshTokenExpiredError`（与 `:321` 口径统一），
比在判据里补正则更干净。

## 三、被证伪 / 不实的 PR 声明

### (F)「反向对照在两种状态下都绿」—— 不实

作者只做了「撤掉修复」这一个变异（2 红，与自述一致），**没做**「删掉终态抛错」。
两路审计独立实测：删掉 `if (isLoomyTerminalRefreshError(error)) throw error`
⇒ **1 红 / 63 绿**，红因正是反向对照（`promise resolved "undefined" instead of rejecting`）。
⇒ 代码本身无问题，但 PR 描述的这句是**未验证的表述**。

### (C)「与 `refreshAll()` 同口径」—— 只对了一半

**行为**同向（`refreshAll` 遇非终态也不抛，实测 `err=(none)`）✅
**判据形式**不同：热路径用 `name ===`（`:286`），`refreshAll` 用
`instanceof RefreshTokenExpiredError`（`loomy-auth.ts:452`）。塞一个 name-only 的实例
（跨副本/双份模块的真实形态）后二者给出**相反结论**。⇒ 算**新引入的分叉**。

⚠️ 全仓现状：10+ 处用 `instanceof`，少数新代码（`astudio-auth.ts`、`refresh.ts`）用 `name`。
两种判据本就并存，本 PR 让 latter 多一处、而**同一文件内**（热路径 vs `refreshAll`）分叉。

### (E)「探测失败期间不写 `lastRefreshError`，面板不会翻成已失效」—— 空命题

`grep lastRefreshError` 在 `loomy-auth.ts` 里 6 处**全部**是 `= undefined`，没有 `= message` 分支
⇒ 该字段本就不承载错误。面板「已过期」读的是池 `expiresAt`。
⇒ 结论**成立但无意义**（PR 把一件不存在的事写成了"残余风险"）。

## 四、既有缺陷（**不是本 PR 引入**，如实归因）

以下三条在 `b5dab83`（PR 基线）上**逐一实测同样成立**，故不记为 PR 的问题，
但它们与 PR 的「放行安全」论证直接相关，必须登记：

### E-1：`100002`（HTTP 200）不被 `classifyLoomyFailure` 认，换号循环根本不进

`classifyLoomyFailure` 认 `401/403`、`14018`、`credits exhausted`、`insufficient`+钱义词、
`积分/额度/余额`+`不足/耗尽`、`quota`+`exceeded/exhausted`、`402`、`429`；其余 `other`。
实测：`text="100002" status=200` ⇒ `class:other rotate:false`（修前修后一致）。

而本仓自己的注释写着 Loomy 业务失败**恒 HTTP 200**，且换号循环写在 `if (!response.ok)` 内
⇒ 吊销以「200 + `100002`」表达时（非 SSE / SSE 内嵌 `desc` / SSE 内嵌 `message` 三形态），
**一次都不换号**，终错是 `SERVER` / `EMPTY_RESPONSE` 而不是 `AUTH`。
⇒ PR 断言 (B) 的「`100002` 由换号接住」这半边**在既有代码上就不成立**。

### E-2：终态判定作用在「池默认号」上，却用来拦截「本轮要用的号」

`src/index.ts` 的 loomy `refresh` 探测的是 `pool.getAvailableAccount(LOOMY.id, '')`，
而 `stream()` 用它决定**本轮**凭据能否继续用。二者可能不是同一个号。
实测（基线同样）：本轮要用的号完全可用，仅因**另一个号**报终态 ⇒ 整轮失败、业务请求 0 次。

### E-3：探测 60 秒是**每轮**白等，且不可 abort

`isLoomyExpired` 读本地 `expires_at`（登录时刻 +14 天，**永不被改写**）⇒ 本地判过期后
**每轮**都进探测分支并串行阻塞首 token。实测：`refresh` 永挂 ⇒ 8 秒后仍未返回、业务请求 0 次；
缩短版 `perTurnMs=[316,315,310]`（≈3× 串行）。
`probeCredential` 的 `AbortSignal.timeout` 独立于 `options.signal` ⇒ 用户点停止后**仍等满探测**。

修前对照：也是等 60 秒，但给的是**失败**；修后是等 60 秒后**成功**。
⇒ 用户感受从「60s 后失败」变成「60s 后能用」，**更慢但更可用**。
建议（独立议题）：非终态探测失败后按指数退避记一个"探测退避至"，期间跳过探测直接发请求。

## 五、变异验证表（两路各自独立，结论一致）

| 变异 | 结果 | 红因 |
|---|---|---|
| M1 撤 try/catch 换回裸 `await refresh()` | **2 红** | ✅ 前两条用例 |
| M2 删 `if (isLoomyTerminalRefreshError(error)) throw error` | **1 红** | ✅ 反向对照 |
| M3 删 `this.options.warn?.(...)` | **2 红**（PR 自述 1 红） | ✅ 第 1 条断言 `warns` 长度 |
| M4 `isLoomyTerminalRefreshError` → `false` | 1 红 | ✅ 反向对照 |
| M5 `isLoomyTerminalRefreshError` → `true` | 2 红 | ✅ 两条正向 |
| **M6 把 401 分支降级** | **64 全绿** | — **零覆盖**（§P1-2） |

## 六、未验证

1. 真实上游是否会在 `100002` 之外用「HTTP 200 + 非 SSE JSON」表达吊销（stub 构造，未对真实端点取证）。
2. 60 秒的**绝对值**（用 300ms 等比测，真 60s 会撞 vitest 5s 默认超时）。
3. `warn` 文案原样带上游 message 是否真会泄漏手机号/token（构造输入，路径**全程无脱敏**）。
4. 面板端 `account.list` 的 `expiresAt` 与探测失败的真实宿主联动（只核了客户端读字段）。
5. 作者所称「全量 8401 passed」未复跑（本次合入最新 master 后 loomy 三份 105 passed）。

## 七、已在本分支实施并验证的修复

本节记录的改动**只在本地分支 `pr124-loomy`**，未推送、未回复到 Gitee PR。

| 改动 | 位置 | 守卫用例 |
|---|---|---|
| 401/403 分支探测失败改为「warn + **不重取不重发**，直接落换号循环」（终态仍抛） | `src/loomy-adapter.ts` | 新增 `★★★ 401/403 分支的探测失败也不得打断整轮` 一组 3 条（非终态放行且留 warn / **A 401 + B 正常必须换到 B 且不重发 A** / 终态反向对照） |
| `refreshAccountCredential` 的「凭据未配置 / 凭据解析失败」改抛 `RefreshTokenExpiredError` | `src/loomy-auth.ts` | 新增 `★★ 按 ref 入口的「凭据未配置」必须是终态` |

**验证**：
- `tsc`（源码 + 测试）→ exit 0
- `tests/unit/loomy-adapter.spec.ts` → **68 passed**（PR 原 64，净 +4）
- `tests/unit/loomy`（16 套件）→ 321 passed
- 全量 → **9781 passed / 1 failed**，唯一红为基线既有的 `jet-hub-styles-ownership`
  （读本机安装的宿主 `client.js`，master 上同样红）

**变异验证（每条都核对红因）**：

| 变异 | 结果 | 说明 |
|---|---|---|
| 把 401 分支精确换回裸 `await refresh()`（保留重取/反查/重发） | **新增 3 条全红** | 精确变异，既有轮换用例 0 影响 |
| 把 `if (!probeFailed)` 改成 `if (true)`（= **降级后仍重取重发**，对抗审计 D3 的白烧形态） | **只有「不重发 A」那条红** | 证明该断言逐字守住「白烧一次」，而不只是「能换号」 |
| `refreshAccountCredential` 的「凭据未配置」退回普通 `Error` | **终态判据那条红** | `expected 'Error' to be 'RefreshTokenExpiredError'` |

⚠️ **一次过程记录**：我第一版变异把整段（含 `findAccountIdByCredential` 重反查块）替换掉，
导致一条**既有**的轮换用例（`401 续期后凭据换成了别的账号`）也变红，一度像是我的修法破坏了它。
改用**精确变异**（只去掉 try/catch、保留重取/反查/重发）后该用例恢复绿
⇒ 那次红是**变异过宽**造成的假红，不是回归。这条符合本仓库既有的教训：
「用例变红」**不自动等于**红因是被测变异。

## 八、建议的后续处理顺序

1. ✅ **已修**：P1-1（401 分支）+ 覆盖它的用例（原先 M6 全绿）。
2. ✅ **已修**：P1-3（`loomy-auth.ts` 两处改抛 `RefreshTokenExpiredError`）。
3. **如实登记**：E-1 / E-2 / E-3 为既有缺陷（基线实测同样成立），另开议题；
   其中 E-1 直接削弱 PR 的安全论证，建议在 PR 描述里订正断言 (B) 的措辞。
4. **订正描述**：(F) 那句「两种状态都绿」改为「未验证」或补做该变异。

