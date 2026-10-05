# buddy 成长任务「一键全部完成并领取积分」— 从 0 到 1 的新增能力

> **这是什么**：给 CodeBuddy（buddy）补一整套**成长中心任务**的纯 API 自动化 ——
> 接取任务、上报判据事件、逐项领奖。原作**只有每日签到**，成长任务
> （18~23 项，含建画布、专家对话、模板、皮肤、技能、资料库点击等）**完全没有实现**。
> 已在 **2 个真实账号**上端到端验证。

---

## ⚠️ 先读这一段

本目录下的 `lib/*.js` 是**已安装插件的运行副本**，不是本仓库的构建产物：

- 本仓库 `lib/` 是 `tsc` 构建输出，且被 `.gitignore` 第5 行 `lib/` 排除；
- 本仓库 `src/` 下**没有** `buddy-growth.ts` —— 原作没有这个模块。

改动落在已安装插件目录 `~/.dsh/plugins/dsh-codearts-auth/lib/`（手写 `.js`，
不由本仓库构建）。因此放在 `contrib/` 而非 `lib/`，以免冒充构建产物。

**作者若要把这份能力并入本仓库源码**，需要先决定它的源形态：新增
`src/buddy-growth.ts` 并纳入构建，或明确以 `plugin-src/` 方式维护。
`buddy-growth-oneclick.patch` 是相对一份**中途快照**的 diff（见下），
完整文件已随目录提供，直接覆盖即可。

---

## 基线说明（重要，避免误读增量）

我最初写的基线是「改动前 8 项 / 18 函数 / 42,851 字节」—— **那是错的**，
那是我自己工作途中的快照，不是原作状态。核实原作仓库后更正如下：

| | 原作 `iJetLi/deepseek-harness-codearts` | 本增强 |
|---|---|---|
| `src/buddy-growth.ts` | **不存在** | — |
| 成长中心任务接取/完成/领奖 | **完全不存在** | 新增 |
| `src/credits.ts` 职责 | **仅每日签到**（`/v2/billing/meter/checkin-activity-status`、`/v2/billing/meter/daily-checkin`） | 不改（保留签到） |
| `plugin-src/client/jet-hub.js` 的「一键领取积分」 | **就是每日签到**，无成长任务 | 扩展为签到 + 成长任务全自动化 |

⇒ 这是一次 **0 → 1 的功能新增**，不是对既有任务矩阵的增量优化。

**唯一的真实量化对比**是文件规模：`buddy-growth.js` 从无到105,852 字节
（35 个函数 / 22 项任务映射）。中途快照（8 项 / 42,851 字节）只作为 patch 的参照点。

---

## 交付内容

### 覆盖 22 项成长任务

**对话类**（`chatEventChain` 六连事件链）
`chat_5` `playbook_prompt` `Buddy_App` `Buddy_App_QQ` `expert_5`
`Expert_team_use_3` `Expert_lighthouse` `automation_1` `RichMeow_Chat`
`Model_chat_GLM5.2` `black_cat`（夜窗）

**其它判据类**
| 任务 | 判据机制 | 实现 |
|---|---|---|
| `create_canvas` | `wbx_design_canvas_*` 遥测 | 不再新建真实画布 |
| `template_5` / `template_used` | `agent_task_created_with_template` + `template_used` JOIN chat 链 | `templateUseEventChain` |
| `Library_read` | **web 域** `web_element_click`（`library_doc_intro_click`） | `reportWebEvent` |
| `Hp_Appearance` | `appearance/set` + `appearance_skin_apply` | `setAppearanceTheme` |
| `skill_1` / `skill_installed` | `skill_info` JOIN **真实** fast-model 会话 | `chatRealSession` |
| `expert_summoned` | `expert_summoned` 召唤链（需**真实** `expert_id`） | `expertEventChain` |
| `first_chat` | 一次真实对话 | `chatRealSession` |
| `wb_wechat_oa_subscribe_task` | 微信服务号订阅 | 归 clientOnly |
| `wechat_linked` | 微信链接 | 归 clientOnly |

### 新增 17 个函数

**判据事件序列构造器（8）**
`chatEventChain` `buddyAppEventChain` `templateUseEventChain`
`playbookPromptEventChain` `automationCreateEvent` `expertEventChain`
`chatRequestSendEvent` `buildTaskEventSequence`

**上报原语（3）**
`reportTaskEvents`（按 `progress.target` 补足次数、逐轮节流）、
`reportDesktopEvents`（单次注入指纹上报；灯塔需两次独立上报故抽出）、
`reportWebEvent`（**web 域** `/v2/report` —— 资料库类判据只认 web 域，桌面域不计）

**判据所需动作接口（4）**
`setAppearanceTheme`（纯 set **不计分**，须再补 `appearance_skin_apply`）、
`chatRealSession`（真实 SSE 会话，正则抓服务端 32 位 hex `requestId`；
专家/技能类判据要求事件 JOIN 到真实会话）、
`fetchMarketExpertList`（专家类要求真实 `expert_id`，编造不计数）、
`claimGrowthTaskReward`（`POST /activity/growth/tasks/<code>/claim`）

**辅助（2）** `listAllGrowthTaskCodes`（扫尾补领）、`isGrowthNightWindow`

### 三个容易踩空的判据细节

1. **`requestModelId` 与 `requestModelName` 必须分离**
   `Model_chat_GLM5.2` 要求 `glm-5.2` / `GLM-5.2`（**大小写不同**），且只上报
   **单条** `chat_request_send`、`requestId` 留空回落 `conversationId`。
   我最初按「事件链 JOIN 真实会话」的思路实现，实测长期 0/1，逐字段对照后才定位到这点。

2. **服务端按 `expert_id` 按天去重**
   `Expert_team_use_3` 原先固定 1 轮，永远卡 `2/3`；须跨**不同**专家轮换补足。

3. **两个任务端点必须合并读**
   `/v2/activity/growth/tasks`（`task_code` + `accept_status` + progress）与
   `/activity/growth/tasks`（`code` + `status`，无 progress）是两族不同 schema 的任务。
   只读前者 ⇒ 后者 5 项永远进不了待办。

---

## 健壮性与可观测性

| 项 | 做法 |
|---|---|
| **时间预算** | 单账号实测 90～270s，账号多时可能撞上宿主 RPC 超时（超时上限由 `dsh-credentials` 决定，**插件不可见不可控**）。`budgetMs` 缺省 10 分钟，耗尽即**如实停住**并逐项标「未执行，点一次可继续」。实测请求数 76 → 24 |
| **僵尸账号** | 凭据被外部删除的条目归 `inactive` 而非 `failed`，否则一个僵尸条目就让整个提示染黄。注意 `mergeClaimOutcomes` 里 `failed` 优先于 `inactive`，故签到侧与成长侧须**同时**改 |
| **单任务异常隔离** | 一个任务抛异常只记该项失败，不中断整轮与其它账号 |
| **任务级报告** | 逐项带出事件数 / progress / 失败原因，并区分「需客户端手动」与「需等窗口」 |

---

## 实测（2 个真实账号）

17 项已领到账，含 `Expert_team_use_3`（2/3→3/3）、`Library_read`、`Hp_Appearance`、
`skill_1`、`Model_chat_GLM5.2`（0/1→已领）、`create_canvas`（且账号里不再留空画布）。

## 局限（如实说明，不宣称全部搞定）

1. **22 项是「有实现」，不等于「全部点亮」。**
   `first_chat` / `template_used` / `expert_summoned` / `skill_installed` 四项
   已按源码权威实现写好、事件形状已验证，但**实测 progress 未涨**，现如实标 clientOnly。
   这四项我没有 ground truth（参考源码对它们无记载或只记同名机制），
   **不敢断言做不到**，只如实报「当前推不动」。
2. **`skill_installed` 是否与 `skill_1` 共用判据未定** —— 若共用会被顺带点亮。
3. **凭据不刷新是刻意设计**：`refresh_token` 一次性轮换，按钮路径只 resolve 不刷新。
4. **单次运行全串行**（防风控），账号多时耗时长。

未覆盖：`wb_wechat_oa_subscribe_task` 与 `wechat_linked`（微信动作，需客户端）；
`black_cat` 需 23:00–08:00 窗口。

---

## 文件清单与复现

```
contrib/buddy-growth-oneclick/
├── README.md
├── buddy-growth-oneclick.patch      ← 相对中途快照的 diff
└── lib/
    ├── buddy-growth.js              ← 主实现（105,852 B / 35 函数）
    ├── buddy-growth.d.ts            ← 类型声明
    ├── jet-hub-rpc.js               ← RPC 编排（报告口径、僵尸账号归类）
    └── client/jet-hub.js            ← UI（渲染任务明细）
```

```sh
node --check lib/buddy-growth.js && node --check lib/jet-hub-rpc.js && node --check lib/client/jet-hub.js
cp -r ~/.dsh/plugins/dsh-codearts-auth/lib /tmp/lib-backup   # 先备份
cp -r lib/* ~/.dsh/plugins/dsh-codearts-auth/lib/             # 再覆盖
# Jet Hub 点「一键全部完成任务并领取积分」
```