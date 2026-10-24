# PR：TRAE 流内 `event:error` 改走**结构化码**分类 —— 修 `1005` 被判成 `none` ⇒ 冷却 **0ms** ⇒ 换号形同虚设

单提交：

```
fix(trae): 流内 event:error 改走结构化码分类，修 1005 冷却为 0ms
```

---

## 一、为什么做

### 报障现场（2026-10-24，本机宿主）

用户界面上只有一行：

```
trae:  (code=1005)      ← 冒号后是两个空格（message 为空串）
```

右侧徽章 `QUOTA_EXCEEDED`，标题「本轮运行失败」。同一时刻宿主日志里有两条成对记录
（`~/.dsh/logs/desktop-next-*.jsonl`，`time` 为 UTC）：

```
agent.failed   error.message = "trae:  (code=****"        ← 日志脱敏，数字被打码
[jet-hub] 已记录限流: 账号 <trae-号-1> 模型 kimi-k3.1-pro 重置于 <与失败同一秒>
[jet-hub] 已记录限流: 账号 <trae-号-2> 模型 kimi-k3.1-pro 重置于 <与失败同一秒>
```

⚠️ **那两行「重置于」的时间戳就是失败发生的**同一秒** —— 也就是说限流标记写在了
**过去**，等于**没有退避**：下一次选号**立刻又选回同一个号**，两个账号都被同一模型
拒后如实抛错。用户看到的是「轮换好像不行」，实际机制是**冷却时长取到了 0**。

### 机制（一句话）

上游用 **HTTP 200 + SSE `event:error`** 下发 `code=1005`，而同一个事件里的
**`message` 是空串**。换号循环里把 `{ code, message }` 序列化成 JSON 去喂
**文案表** `classifyTraeError`：

```ts
// 旧实现（src/trae-adapter.ts 换号循环）
classifyTraeError(0, JSON.stringify({ code: streamErr.code, message: streamErr.message }))
```

而文案表的 `hard-plan` 判定**还要求 `plan` 关键词**（对齐 Go 端 `Classify`，且被
`tests/unit/trae-errors.spec.ts` 显式锁死）：

```ts
// src/trae-errors.ts PLAN_LIMIT_MARKERS
if (body.includes(marker) && (body.includes('plan') || lower.includes('plan'))) return 'hard-plan'
```

`{"code":1005,"message":""}` 里**没有 `plan` 字样** ⇒ 落到最后一行 => `'none'` ⇒
`traeCooldownFor('none')` = **0ms**。

### ⚠️ 关键设计决策（请重点审阅）：**不改** `classifyTraeError`，另开一个入口

直觉的修法是「把 1005 从文案表里解放出来」。**本 PR 刻意不这么做**，两条理由都是
仓库里已有的教训：

1. **那条限制是有理由的，而且已被用例锁死**：`tests/unit/trae-errors.spec.ts` 明确断言
   `classifyTraeError(400, '{"code":1005}') === 'client'`，注释写着「避免把无关的
   code 1005 误判成权益不足」。改文案表会打红它，且违背其意图。
2. **同仓 `zcode-adapter.ts` 的裸子串判据就是这么翻车的**：`body.includes('1005')`
   会命中边缘页里的 `<title>1005</title>` / `width:1005px`，**实测把两个完全可用的
   账号换掉并封到次日**（见其行内注释）。

⇒ 两个入口的**输入类型不同**，可信度也不同，故分开：

| 入口 | 输入 | 判据 |
|---|---|---|
| `classifyTraeError`（HTTP 层，既有） | **响应体原文** | 子串匹配；`hard-plan` 还要求 `plan` 关键词 |
| `classifyTraeStreamCode`（流内 `event:error`，新增） | **上游下发的枚举码** | 码**就是**证据，不要求 `plan`；表外码回落文案表 |

---

## 二、做了什么

### 接线点清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/trae-errors.ts` | 新增 `TRAE_STREAM_ERROR_KINDS`（**唯一一份**码→类别表）+ `classifyTraeStreamCode(code, message = '')` + `isRotatableTraeStreamCode(code)`（L135-199）；文件头新增「## 两个入口，别混用」节 |
| 2 | `src/trae-adapter.ts:1493` | 换号循环的**重分类**改为 `classifyTraeStreamCode(streamErr.code, streamErr.message)` |
| 3 | `src/trae-adapter.ts:1876` | 抛出点的可换号判据改用 `isRotatableTraeStreamCode(ev.errorCode)` |
| 4 | `src/trae-adapter.ts` | **删除**本地 `function isRotatableStreamError(code)`（原 1005/4008/4011 硬编码一份）—— 现在「可换号集合」与「类别表」是**同一张表**，不会再漂移 |
| 5 | `src/trae-adapter.ts:1476-1489`、`:1878` | 更正**陈旧注释**：原文写「quota-exceeded 24h、hard-plan **7d**、soft-rate **1h**」，与 `trae-cooldown-table.ts` **逐格不符**（实为 12h / 60s），并注明取值以冷却表为准 |
| 6 | `docs/agent-notes/providers-trae.md` | 新增一节，登记机制、码表、潜伏原因、未修项 |
| 7 | `tests/unit/trae-errors.spec.ts` +6 条 · `tests/unit/trae-adapter.spec.ts` +2 条 | 见下 |

码表（`TRAE_STREAM_ERROR_KINDS`）：

| 流内码 | 类别 | 冷却 | 依据 |
|---|---|---|---|
| `1005` | `hard-plan` | 12h | 与 `src/trae-credits.ts` 的 `200 + code === 1005 ⇒ PlanLimit(12h)` **同值**（那里同样**不要求** `plan` 关键词） |
| `4008` | `quota-exceeded` | 24h | 既有定义（`ide_credits` 日配额） |
| `4011` | `soft-rate` | 60s | 既有定义（频率超限） |

`4001`（模型不可调用）与 `4006`（载荷超限）**刻意不在表内** ⇒ 不换号：前者换账号也是
同一个模型被拒，后者另有专用出口（`streamErrorCode` ⇒ `CONTEXT_WINDOW_EXCEEDED`）。

### 刻意的「不改」（避免审阅时误以为漏了）

1. **`classifyTraeError` 的文案表一字未动**（理由见上）；
2. **`streamErrorCode(code)` 的 harness 归码表未动**（4006→`CONTEXT_WINDOW_EXCEEDED`、
   1005/4008→`QUOTA_EXCEEDED`、其余 `SERVER`）—— 那是**给 harness 看的**码，与本次
   「该不该换号、冷却多久」是两件事；
3. **L1480 / L1521 的 `throw new LlmError(error.message, 'QUOTA_EXCEEDED')` 未动** ——
   该码是硬编码的既有形态，改它属于**面向用户语义**的变更（1005 的真实含义是「该模型
   不被这个账号的套餐接受」而非「额度用完」），本次只在用例里把它**锁住**，另开 PR 更清楚；
4. ⚠️ **已登记未修**：流内分支**没有** HTTP 层那条 `recordsTraeRateLimit(kind)` 守卫
   （HTTP 层不记 `server`/`client` 的标记，流内会记）。本次不动 —— 能走到该分支的码
   全部来自 `TRAE_STREAM_ERROR_KINDS`、三类都该记，加守卫属**行为变更**。

---

## 三、真机取证（本次报障的现场）

| 证据 | 内容 |
|---|---|
| 宿主日志 `agent.failed` | `error.message = "trae:  (code=****"`（脱敏），两个失败会话各一条 |
| 同秒 jet-hub 限流记录 | `账号 <id> 模型 kimi-k3.1-pro 重置于 <失败同一秒>` ×2（**这正是 0ms 的直接证据**） |
| 状态文件 `~/.dsh/jet-hub/state.json` | 两个 trae 账号的 `kimi-k3.1-pro` 标记值 = 失败那一刻的毫秒时间戳（**不是** +12h） |
| 上游形态 | HTTP **200** + SSE `event:error`，`code=1005`、`message` **空串** |

⚠️ **诚实说明**：修复后的**同一路径真机复现未主动触发** —— 再打一次上游 1005 会让两个
账号在该模型上进入 **12h 冷却**（这正是修复的正确行为，但不是本次应当替用户决定的
副作用）。故本 PR 的判别力来自下面**变异验证过**的单元用例，而不是真机复跑。

---

## 四、测试

### 新增（8 条）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `tests/unit/trae-errors.spec.ts` | 6 | 空 `message` 的 1005 ⇒ `hard-plan`（含 `message` 缺省）；**1005 的冷却必须是 12h**；4008/4011 与冷却表逐格对齐；表外码回落文案表（含「不得凭空升级成权益不足」）；`4001`/`4006` 刻意不换号；**换号判据与类别表同源** |
| `tests/unit/trae-adapter.spec.ts` | 2 | ★★ 逐字复刻报障形状（`message: ''`）⇒ 仍换号**且**冷却 ∈ (11h, 12h]；★ 全部账号被拒时的报错文案与用户所见一致（`trae:  (code=1005)`，冒号后**两个空格**）与码 `QUOTA_EXCEEDED` |

### ⚠️ 既有用例为什么没抓到（本 PR 的叙事要点）

既有回归用例的夹具是：

```ts
{ code: 1005, message: 'plan 权益不足' }     // tests/unit/trae-adapter.spec.ts:1491
```

那个 `plan` **恰好**满足了文案表的第二腿 ⇒ 判 `hard-plan(12h)` ⇒ **0ms 那条路径
一次都没被走到**。新用例把 `message` 置空，逐字复刻现场。（原用例**保留未改** ——
它守的是另一件事：1005 也必须换号。）

### 反向验证（变异必须变红）

| 变异（锚点已自证存在） | 结果 |
|---|---|
| 把换号循环改回 `classifyTraeError(0, JSON.stringify({ code, message }))` | **1 条变红**：`AssertionError: expected 0 to be greater than 39600000`（`tests/unit/trae-adapter.spec.ts` 的新用例） |
| 把 `1005` 从 `TRAE_STREAM_ERROR_KINDS` 删掉 | **4 条变红**（`tests/unit/trae-errors.spec.ts`） |

两次变异均在 `finally` 里还原，**还原后文件哈希与变异前逐字节一致**
（`src/trae-adapter.ts` `56CAA23D…`、`src/trae-errors.ts` `EFDCE7C5…`）。

---

## 五、验证

| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit` | 通过 |
| `tsc -p tsconfig.tests.json`（`pnpm test` 的 pretest） | 通过 |
| `pnpm test` 全量 | **10578 passed / 1 failed / 18 skipped**（10597） |
| `pnpm build:all` | 通过 |
| e2e 探针 | 未跑：本次没有新增网络路径，按仓库规矩 e2e 默认跳过 |

⚠️ **那 1 条失败与本次改动无关，且不是本 PR 引入的**：
`tests/unit/jet-hub-styles-ownership.spec.ts:469`（客户端样式归属）。取证方式：把工作区
**清空到 HEAD**（`git stash`）后单独复跑该文件，**同样 1 failed / 14 passed** ⇒ 属
**既有的**、与本机环境（Node v24.21.0）相关的失败。本 PR 的四个改动文件与该用例无关。

---

## 六、说明

- 基于最新 `origin/master`（`e8d14c6`）拉分支，**单个提交**。
- 不含任何本机路径、用户名、凭据或 token —— 上面出现的宿主日志摘录里，
  账号 id 一律写成 `<id>`，且**上游错误码是公开协议字段、非隐私**。
- 回写 `docs/agent-notes/providers-trae.md`（新发现 + 未修项登记）。
