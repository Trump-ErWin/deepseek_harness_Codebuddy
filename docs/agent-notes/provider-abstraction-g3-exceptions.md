# provider 能力抽象重构（计划 1）：G3「零行为变化」例外登记

> **本文件是给评审看的**：这次重构的目标之一是 **G3 = 零行为变化**
> （见 `docs/superpowers/plans/2026-10-08-provider-capability-abstraction-p1.md`
> 的「完成后的验收」表）。
> 重构过程中有**少数几处**做不到零变化，**如实登记在此**，**不粉饰、不隐藏**。
>
> **状态（2026-10-08 已裁定）：5 处行为变更已由用户逐条复核后「全部接受」。**
> 用户裁定的原话是**接受全部 5 处**，理由是本轮逐项复核确认
> **没有一处是缺陷**，且**每处都有变异验证过的守卫**（见各条「守卫」小节）。
> 1 处（G3-2）对外文案**逐字节未变**，只是搬了位置，本就不构成行为变更。
>
> ⚠️ **接受 ≠ 无需关注**：这 5 处仍是**已知的行为差异**，本文逐条给出
> **基线 `ecbb268` → 现行**的可观测量，是为了让后人**能判断**，
> 而不是宣称它「没问题」。改动这些代码前请先读对应小节。

## 怎么读这张表

- 判据一律是「**基线与现行是否可观测地不同**」，**不是**「代码长得像不像」。
  重构会让代码必然长得不一样，拿代码形状当判据会把每处重构都误报成行为变更。
- 所有数字都是**在基线 `ecbb268` 与现行 HEAD 上用同一把尺子实测**的，
  脚本落在本地 gitignored 的 `.tmp-kuku/`（`r12-*` / `r13-*` / `r14-*`）。
- ⚠️ **每处都做了变异注入验证**：把源码改回重构前的行为，确认有用例变红
  **且点名正确的对象**。没有守卫的会当场暴露并补测（见文末「本轮查出并补上的缺口」）。

## 六处例外

| # | 位置（按符号名） | 变更 | 结论 |
|---|---|---|---|
| **G3-1** | `collectCreditBalances` 的 `catch` | 凭据 JSON 损坏时的 `message` 由**固定文案**改为**原始解析错误** | **行为变更** |
| **G3-2** | `claimUnavailableReason` 表项 | 三句 provider 专属文案**位置搬移**，措辞**逐字节未变** | **对外行为无变更** |
| **G3-3** | `account.refresh` 的分派体 | 内层 `case` 分派改为 `authOf(auths, entry.provider)` 查表；`opencode`/`aggregate` 的报错文案变了 | **行为变更**（Task 2 刻意改进） |
| **G3-4** | `onboarding.claim` 的 `impl.claim` 外层 `catch` | `loomy` 分支的错误码 `handler-failed` → `bad-request` | **行为变更**（客户端不可见） |
| **G3-5** | `unknownModelInputModalities` 接线点 | `codearts` **未知 id** 的模态由「省略」改为声明 `['text']` | **行为变更**（修内部两套判据） |
| **G3-6** | `displayNameFor` 的第二实参 | `buddy` 同名模型消歧改用**未过滤**的全量集合 | **行为变更**（修界面跳变） |

**六项结论：5 处确为行为变更，1 处（G3-2）对外文案逐字节未变、只是位置搬移。没有一处是缺陷。**
**⇒ 5 处已于 2026-10-08 获用户逐条复核后全部接受。**

---

## G3-1 · 凭据损坏时的错误文案

**变更**：基线里 5 个 provider 在 `credits.balances` 各自写「`JSON.parse` 失败 ⇒ 固定文案」，
重构后统一走共享骨架 `collectCreditBalances` 的**同一个** `catch`，
它把**原始解析错误**当 `message` 上报，不再用固定字面量。

**实测**（`'凭据解析失败'` 的出现次数）：

| 范围 | 基线 `ecbb268` | 现行 | 差 |
|---|---|---|---|
| `src/jet-hub-rpc.ts` | **8** | **3** | −5 |
| 全 `src/` 合计 | **21** | **16** | −5 |
| 各 `*-auth.ts`（11 个文件） | **13** | **13** | **0** |

⚠️ 消失的 5 处与上面「8 → 3」的 5 处**一一对应**，落在 `credits.claimAll`（zcode 特例）、
`credits.balances`（qoder 系特例）、`cline.quota` 三个端点之外的 5 个 provider 分支。
⚠️ `*-auth.ts` 那 13 处**基线至今逐处未变**，故**不在本项范围**（别把它们算进来）。

**代价与收益**：诊断性更强（用户能看到网关返回的 HTML 原文），
代价是**网关 HTML 原文会进 UI**。

**守卫**：把 `collectCreditBalances` 的 `catch` 改回固定字面量 ⇒ 变红 **1** 条。

## G3-2 · 三句签到文案的位置搬移

**变更**：`credits.claimAll` 段里三句 provider 专属文案
（`Cline` / `WorkBuddy 国际版` / `Raccoon Work` 的「不支持每日签到…」）
从 RPC 段**搬到** `src/provider-credits.ts` 的 `claimUnavailableReason` 表项。

**实测（载荷性判据：逐字节比对，不是比段长）**：

| 句子 | 基线 → 现行 |
|---|---|
| `Cline 不支持每日签到（其后端没有签到接口）` | ✅ **逐字节相同** |
| `WorkBuddy 国际版不支持每日签到（其后端没有签到接口）` | ✅ **逐字节相同** |
| `Raccoon Work 不支持每日签到（每日积分由服务端自动发放；登录奖励请在「新手任务」中领取）` | ✅ **逐字节相同**（现行是**多行 `+` 拼接**，拼起来与基线单行一致） |

⇒ **对外行为无变更。**

**旁证（量级参考，非判据）**：`credits.claimAll` 段长 11973 → 7902 字符；
段内 `message:` 字面量 9 → 4。⚠️ **段长是必然腐坏的快照**，只用来让人感知「确实搬走了」。

⚠️ **段长有两个口径，别混用**：「切到下一个 `case '` 」与「花括号配平切块」差 188 / 368 字符。
本文件一律用**花括号配平**口径。⚠️ 另：`unsupported provider: ${req.provider}`
两版都在（`opencode` / `aggregate` 的 `impl` 为 `undefined` 时的分支**刻意未动**）。

**守卫**：把三句里任一句改回带后缀的变体 ⇒ 红（`claim-runtime-parity.spec.ts` 的逐字 `toBe`）。
⚠️ **本轮踩过的坑**：我最初只用两份只做 `.toContain(...)` 的 spec 做变异，得到**假绿**
（后缀追加能满足 `toContain`）⇒ 必须**连同做逐字 `toBe` 的那份**一起跑。

## G3-3 · `account.refresh` 的分派形态

**变更**：由**内层 13 个 `case`** 改为 `authOf(auths, entry.provider)` 查表。

**实测（基线 `case 'account.refresh'` 块，花括号配平切块）**：

| 量 | 基线 | 现行 |
|---|---|---|
| 内层 `case` 标签 | **13** | **0** |
| `default:` | **1** | **0** |
| `authOf(...)` 登场 | 无 | **有** |
| `descriptorOf(...)` 登场 | 无 | **有** |

基线的 13 个内层标签是
`'codearts'` / `'buddy'` / `'workbuddy'`（带引号的字面量形态）
+ `LOBSTERAI.id` / `QODER.id` / `QODER_CN.id` / `TRAE.id` / `CLINE.id` / `LOOMY.id` /
`RACCOON.id` / `MINIMAX.id` / `ZCODE.id` / `GEMINI.id`（常量成员形态）。

⚠️ **量法陷阱**：只写 `case '([^']+)':` 会**只捞到带引号的 3 个**，
得出「基线只有 3 个 case」的**错误结论**。必须同时匹配 `case X.id:` 形态。

**行为变更点**：`opencode` / `aggregate` 基线落到 `default` ⇒ 报 `Unknown provider: opencode`；
现行经 `descriptorOf()` 判别 ⇒ 报「Provider opencode 不支持续期（它的凭据不是可续期类型）」。
**真未知 id 仍报 `Unknown provider:`**（两个分支都在，不是把 unknown 吞掉了）。

**守卫**：`jet-hub-rpc-auth-wiring.spec.ts` 断言两句**必须不同** ⇒ 变红 **1** 条。

## G3-4 · `loomy` 的 `onboarding.claim` 错误码

**变更**：错误码 `handler-failed` → `bad-request`。

**根因**：基线 `onboarding.claim` 的 `loomy` 分支**没有 `try/catch`**
（`raccoon` 分支则自己 catch 回 `bad-request`）⇒ loomy 的异常直接上抛到外层，
被包成 `handler-failed`。现行统一在 `impl.claim` 外 `catch` ⇒ `bad-request` + 服务端原文。

**用户可见影响：零** —— 客户端只渲染 `message`，而 `message` 逐字未变。
变化的是**机器可读的错误码**（调用方若按码分支会受影响）。

**守卫**：把 `impl.claim` 外那处 `catch` 去掉 ⇒ 变红 **1** 条
（⚠️ 本轮实测出它**当时零守卫**，已补测 —— 见文末）。

## G3-5 · `codearts` 未知 id 的模态

**变更**：统一为声明 `['text']`。

**根因**：同一家**内部两套判据** —— `listModels` 恒声明 `['text']`，
而 `resolveModel` 对未知 id **省略**该字段。同一份数据两个入口给不同答案。

⚠️ 该家由 `src/llm-adapter.ts` 服务（该文件的 `PROVIDER` 常量 = `'codearts'`），
**没有** `src/codearts-adapter.ts`（该文件不存在）——
按文件名找会把这条记错位置。

⚠️ **为什么这个字段的三态重要**：`inputModalities` 的**省略 = 未知**、
`['text']` = **明确不支持**。把「未知」写成「明确不支持」会让图片**静默发不出去**；
反过来会让图片**发到不支持的服务端**。故这处「统一」是把「未知」误写成「否定」的方向，
**需要人来判断是否接受**。

**守卫**：把接线点改回省略 ⇒ 变红 **1** 条。

## G3-6 · `buddy` 同名模型的消歧集合

**变更**：`displayNameFor(model, listed)` → `displayNameFor(model, all)`。

**根因**：基线 `src/buddy-adapter.ts` **两处** `displayNameFor` 调用用了**不同**集合
（一处未过滤、一处已过滤）⇒ 拉黑一个同名模型后，界面名字会**跳变**。

**实测**：`bareName` 这个键基线 **0** 次 → 现行 **2** 次；
基线确有 `displayNameFor(model, listed)`，现行是 `displayNameFor(model, all)`。

**反证已锁**：过滤集合下 `Hy3 · X` → `Hy3` **跳变**；现行两态都是 `Hy3 · X`。

**守卫**：把第二实参改回 `listed` ⇒ 变红 **1** 条。

---

## 另有一处**已获用户裁定接受**（不在上面 6 处内）

`credits.status` 对 5 家由 `bad-request` → `ok:true + status:null`。
用户已明确裁定**接受**，并一并修正了 plan 的错误前提。

---

## 本轮查出并补上的覆盖缺口（登记 ≠ 有守卫）

⚠️ 我此前写过「**每处都有锁定用例**」—— **这句话原文是错的**。
本轮**没有把它当结论照抄**，而是逐项做变异注入，当场查出：

- **G3-4 当时零守卫**：把 loomy 那处 `catch` 改成基线形态 ⇒ **红 0 / 绿 190**。
  现已补上守卫（同一变异 ⇒ 红 1）。

⇒ **教训（已写进本仓库的规则）**：**有守卫类断言必须逐项变异验证**。
「登记了一处例外」与「这处例外有守卫」是**两件事**，不能因为前者写了就假定后者成立。

⚠️ 另一条同源教训：**变异结果必须连同「跑了哪些 spec」一起记录**。
G3-2 的变异我最初只跑了两份做 `.toContain(...)` 的 spec，得到**假绿**；
加上那份做逐字 `toBe` 的后才是红。⇒ 手写的 spec 清单本身就是一件**测量工具**，
而测量工具也会失效。

---

## 相关文件（都不入库，仅本地保留）

本文件是**结论**。推导过程、逐项变异脚本与原始输出在：

- `.superpowers/sdd/pr-p1-description.md` —— 面向 PR 的完整描述（含逐项取证表）
- `.superpowers/sdd/task-11-checklist.md` —— 收尾清单与各轮实测记录
- `.tmp-kuku/r1*-*.mjs` —— 反向验证/变异脚本

⚠️ **本文件里的数字同样是快照**，会随代码演进而腐坏。
怀疑某个数时**重新实测**，不要引用本文件的数字当权威。
