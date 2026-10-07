# dsh-codearts-auth

> **使用声明**：本项目仅供学习研究使用，请遵守各服务提供方的服务条款。

deepseek-harness 插件：统一管理多个 AI 编程服务的账号，并把它们的模型接进 DSH
的模型选择器。支持**多账号池**（同一服务登录多个账号，按可用性自动选号）与
**凭据静默续期**（到期前自动刷新，无需再次打开浏览器）。

- **14 个 provider 路由**，外加 1 个**聚合**路由（见下）
- 登录、状态、续期、积分领取**全部在 Jet Hub 设置页完成**，不注册任何斜杠命令
- 附带一个**本机 OpenAI 兼容网关**，供其它客户端复用已登录账号

> 📌 **本 README 只写「怎么用」。** 各 provider 的协议、端点、登录流程、请求头
> 构造、实测数据与事故史等**实现细节**，统一记录在不入库的内部文档
> `docs/implementation-notes.md` 中。需要改动实现或排查协议问题时读它。

---

## 目录

- [安装](#安装)
- [用法](#用法)
- [支持的渠道](#支持的渠道)
- [聚合路由](#聚合路由aggregate)
- [本机 OpenAI 网关](#本机-openai-网关)
- [用量徽标与 Token 用量](#用量徽标与-token-用量)
- [配置项](#配置项)
- [开发](#开发)

---

## 安装

该包尚未发布到 npm registry。提供两种安装方式。

### 方式一：从 git 仓库安装（推荐）

`add` 以 `git+https` 方式安装，pnpm 会运行本包的 `prepare` 脚本自动构建 `lib/`，
无需手动 `pnpm build`。

⚠️ pnpm 10 起会拦截依赖的构建脚本，必须先在 profile 的 `pnpm-workspace.yaml`
（路径形如 `~/.dsh/profiles/<name>/pnpm-workspace.yaml`）里放行；而**放行键的写法
在 pnpm 10 与 pnpm 11 之间互不兼容**，写错就装不上。

**1. 先跑一次安装**（这一次必然失败，为的是让 pnpm 打印它期望的键）：

```sh
dsh plugin --profile <name> add "https://gitee.com/iJetLi/deepseek-harness-codearts.git"
```

**2. 按第 1 步的报错选一种写法，写进 profile 的 `pnpm-workspace.yaml`。**

报 **`ERR_PNPM_INVALID_VERSION_UNION`** 的（**pnpm 10.x**）—— 只认**纯包名**键：

```yaml
allowBuilds:
  dsh-codearts-auth: true
```

报 **`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`** 的（**pnpm 11.x**）—— git 托管包
**不认**纯包名键，必须用第 1 步 pnpm 打印的**完整键（含 `#<commit>`）**：

```yaml
allowBuilds:
  dsh-codearts-auth@git+https://gitee.com/iJetLi/deepseek-harness-codearts.git#<第 1 步打印的 commit>: true
```

**两代通用（省事，但放宽了权限）**：

```yaml
dangerouslyAllowAllBuilds: true
```

它会放行该 profile 里**所有**依赖的构建脚本（不止本插件）。

**3. 重跑第 1 步的命令**：这次会拉取、构建并安装成功。之后每次升级重新 `add` 即可。

⚠️ **不要**写 `dsh-codearts-auth@git+https://gitee.com/…`（不带 `#<commit>`）——
这个"看起来最自然"的键在两代 pnpm 上都不工作。

⚠️ pnpm 11.x 的精确键里带 commit，因此**升级（重新 `add` 拉到新 commit）后该键
失效**，按新报错里的键替换即可；用 `dangerouslyAllowAllBuilds` 则不必改。

### 方式二：从源码目录安装（本地开发）

先在本仓库中构建 `lib/`，再安装为 pnpm `link:` 依赖：

```sh
pnpm build:all
dsh plugin --profile <name> install <path-to-this-repo>
```

> `dsh plugin install` 以 `link:` 方式安装，pnpm 不会为 `link:` 依赖运行
> `prepare` 脚本，因此必须先手动执行 `pnpm build:all` 生成 `lib/`。
> 注意必须用 `build:all` 而非 `build`：后者只编译宿主侧，不产出
> `lib/client/jet-hub.js`。

每次修改 `src/` 或 `plugin-src/` 后都需要重新执行 `pnpm build:all` —— dsh 启动时
不会自动重建。

### 通用说明

该包声明了 `dsh.bundle` 补丁（`cordis.patch.yml`），因此 profile 的 layer 栈会
自动拾取 `codearts-auth` 行。插件注入由 dsh base 提供的 `credentials`、
`commands` 和 `llm` 服务。

---

## 用法

**登录入口：Jet Hub 设置页的对应 provider 面板。**

⚠️ **不注册任何斜杠命令** —— 登录、状态查看、续期与积分领取统一在 Jet Hub 完成。

基本流程：

1. 打开 Jet Hub 设置页（侧边 rail 选择要用的渠道）；
2. 点「**+ 新建账号**」→ 浏览器打开授权页 → 完成登录；
3. 需要多个账号时重复第 2 步（账号池会自动选号）；
4. 回到 dsh 的模型选择器，选中该渠道的模型即可开始对话。

「+ 新建账号」是**两步式**的：先返回 `loginUrl` 由前端弹窗打开，后台再轮询换取
令牌 —— 这样不会阻塞浏览器手势窗口，弹窗不会被拦截。

账号卡片支持：**测试 / 重测 / 重置 / 停用 / 代理 / 指纹 / 删除**，以及拖拽排序
（**顺序即选号优先级**）。停用只影响自动选号，**不影响凭据续期与积分领取**。

---

## 支持的渠道

14 个 provider 路由，互不覆盖，可同时使用。

| id | 渠道 | 登录方式 | 积分能力 |
|---|---|---|---|
| `codearts` | CodeArts（华为云） | 浏览器回调 | 余额 + 每日签到 |
| `buddy` | CodeBuddy（腾讯） | 浏览器授权 + 轮询 | 余额 + 每日签到 + 成长任务 + 锁定永久积分 |
| `workbuddy` | WorkBuddy（国际版） | 同上 | 余额 + 锁定永久积分（**无签到**） |
| `lobsterai` | LobsterAI（有道） | 浏览器回调 | 余额 + 每日签到 |
| `qoder` | Qoder（阿里系） | 设备码轮询 | 余额 + 每日领取 |
| `qodercn` | Qoder 中国版 | 同上（共用实现） | 余额 + 每日领取 |
| `trae` | TRAE（字节跳动） | 浏览器回调 | 余额 + 签到 |
| `cline` | Cline | WorkOS 设备码轮询 | 余额 |
| `loomy` | Loomy（讯飞） | 短信验证码 | 余额（两个池）+ 每日额度 + 新手任务 |
| `raccoon` | Raccoon Work（商汤） | 微信扫码 / 短信 | 余额 + 一次性登录奖励 |
| `minimax` | MiniMax Code（中国版） | OAuth 设备码 + PKCE | 余额 + 每日签到 |
| `zcode` | ZCode（智谱 z.ai） | OAuth 设备码 | 余额 + 每日领取 |
| `opencode` | OpenCode | — | 余额 |
| `gemini` | Gemini Code Assist | 浏览器回调 | 余额 |

各渠道的能力与限制要点：

- **图片输入**：`buddy` / `workbuddy` / `trae`（逐模型）/ `minimax`（部分模型）支持；
  `lobsterai`、`zcode` **不支持**；其余以模型声明为准。
- **思考档位**：多数渠道支持，档位名按各渠道自己的定义下发；未声明的渠道不发送该字段。
- **`loomy`** 是唯一用**短信验证码**登录、且**不能自动续期**的渠道。
- **`zcode`** 的领取路径需要一次性验证参数，由本机浏览器环境产出（web 版需要
  chromium，桌面版用自带内核）。
- **`qoder` / `qodercn`** 共用同一套实现，差异仅在产品配置。
- **`minimax`** 是唯一的 Anthropic Messages 协议族渠道。

### 一键领取积分

在对应面板标题栏点「**一键领取积分**」，插件会**顺序**处理该面板下的所有账号
（顺序执行以避免并发请求），并**逐账号显示结果与原因**。

⚠️ 汇总**按单位分列**，不跨量纲求和 —— `ZCode` 的额度单位是 **token**、其余渠道是
**积分**，两者不可折算，因此显示成 `+100.00MToken, +100积分` 而不是加成一个数。

### 模型列表开关

每个 provider 的面板都有「**显示列表**」按钮，可逐个开关模型，控制它是否出现在
对话框的模型选择器里（**黑名单制**，默认全部显示）。开关按 provider 隔离。

### 锁定永久积分

`buddy` / `workbuddy` / `loomy` 提供「**锁定永久积分**」按钮，用来保住不会马上
作废的积分。判定规则：距扣费截止不足 15 天的算**临时**（优先消耗），其余算永久。
锁定后只消耗临时积分，用完则明确报错而不是偷偷烧掉永久积分。

---

## 聚合路由（`aggregate`）

同一个真实模型往往在**多个渠道**都能用（例如 DeepSeek V4.1 Flash 在 buddy、
codearts、cline 等都有）。聚合路由把「同一个真实模型」在各渠道的条目**归到一个
规范名下**，请求时自动挑一个渠道发出去。

**解决什么**：各家渠道送的免费额度**有到期时间**，用不完就作废。聚合层按
「**最快作废的额度优先用**」自动排序，把临期积分先烧掉。

**怎么用**：

1. 在模型选择器里选 **`aggregate`** 分组；
2. 想**不挑模型**就选该分组下的 **`auto`** —— 它用全部渠道的全部模型当候选池；
3. 想**指定模型**就选该分组下的**具体规范名**（如 `Deepseek-V4.1-Flash`）。

选中后模型名旁会附一个 **`· <渠道>`** 后缀，那是**首选渠道**（临期最早的那个）。
⚠️ 它**不是「本次实际发往的渠道」** —— 真实历史由**用量徽标**显示。

**自动切换**：某个渠道失败时会换下一个候选重试，但只在**还没吐出任何可见内容**
时才切换（已输出的内容收不回来，拼接会产生畸形回答）。

**参与轮换的渠道**：`buddy` / `workbuddy` / `loomy` / `codearts` / `zcode` /
`lobsterai` / `trae` 七家。其余渠道**暂不参与**（插件对它们的额度到期时刻没有
可靠信息，宁可少一个候选，不可把未知当可用）—— 它们仍可**直连**正常使用。

聚合有**自己的**设置面板（Jet Hub 左侧 rail 的「聚合」项），可逐条开关
「参与轮换」。它没有账号与凭据（复用各渠道的账号）。

---

## 本机 OpenAI 网关

插件启动后会在 `127.0.0.1:8326` 提供**两套**标准 OpenAI 接口，供 Pi、Continue、
Cline、OpenCode、Codex 或其他兼容客户端使用。网关复用 Jet Hub 已登录账号和现有
provider 适配器，不把上游凭据复制到客户端。

```
GET  http://127.0.0.1:8326/v1/models
GET  http://127.0.0.1:8326/v1/reasoning-efforts   ← 思考档位对照表
POST http://127.0.0.1:8326/v1/chat/completions    ← OpenAI Chat Completions
POST http://127.0.0.1:8326/v1/responses           ← OpenAI Responses API
```

⚠️ **两个端点同时可用，没有「格式开关」**：客户端用哪一套协议，由它自己请求的
路径决定。

### 拿到地址与密钥

鉴权使用 `Authorization: Bearer <网关 API Key>`。

⚠️ 因此**在浏览器地址栏直接打开这些地址会返回 401**（没有带 Bearer 头）——
这是预期行为，不是网关没启动。请用客户端或 `curl` 带上传头访问。

优先从 `DSH_OPENAI_GATEWAY_API_KEY` 读取；未设置时，插件首次启动会在 DSH home 的
`openai-gateway/api-key` 生成并持久化随机密钥，重启后保持不变。

设置页里的开关状态存在 `$DSH_HOME/jet-hub/state.json` 的 `gatewayEnabled` 字段
（缺省为启用）。它**不进**账号备份/恢复。

### 关闭网关

网关是**旁路功能**：它启动失败或被关闭，都不影响插件其余功能（登录、积分、模型
目录照常）。三种关闭方式：

| 方式 | 做法 |
|---|---|
| 环境变量 | `DSH_OPENAI_GATEWAY_ENABLED=0`（**完全不启动**，连 API Key 文件都不生成）|
| 设置页开关 | 关掉后不再监听 |
| 改端口 | `DSH_OPENAI_GATEWAY_PORT` 填非法值会记录错误并跳过启动，**不会**静默改用其它端口 |

### 安全边界

- 只绑定 `127.0.0.1`，**不可**改成对外地址 —— 注意这只挡得住远程访问，
  **同机其它用户/进程仍可连到该端口**，真正的隔离靠 API Key。
- 密钥以明文写在 `$DSH_HOME/openai-gateway/api-key`。POSIX 下的 `0600` 权限在
  **Windows 上不生效**，多用户机器请改用 `DSH_OPENAI_GATEWAY_API_KEY` 环境变量。

---

## 用量徽标与 Token 用量

### 用量徽标

会话输入区右侧、模型选择器左边有一枚薄胶囊，显示**当前渠道一共有多少可用额度**；
点开是完整浮层（逐账号明细 / 订阅窗口 / 刷新 / 签到 / 显示偏好）。
只在选中本插件渠道的模型时渲染，非本插件的模型**不渲染、不发请求**。

折叠态按 **`渠道 • 读数`** 两段显示，例如：

```
CodeBuddy (腾讯) • 2434.96积分
CodeArts (华为云) • 9499.84积分
ZCode (智谱) • 94.54MToken
```

- **默认显示余额**（一共能用的额度）；可在浮层里切换成「优先订阅」或「只看积分」。
- **多账号只显示一个数字**（所有启用账号的余额合计），不会变成一长串。
- 账号读不到时合计会**静默少报**，故胶囊会挂一个**警示角标**（`441.78积分 ⚠`）。
- 浮层里逐账号列表**按余额降序**，超过 5 个折叠成「展开其余 N 个」。

### Token 用量

点 Jet Hub 页头的「**Token 用量**」按钮查看。数据分两份：

| 数据 | 位置 | 回答的问题 | 重启后 |
|---|---|---|---|
| 实时明细 + 汇总树 | 进程内存（上限 500 条） | 每一笔长什么样、这次会话花了多少 | 清空 |
| 历史日聚合 | `~/.dsh/jet-hub/token-ledger.json` | 本周 / 本月用了多少 | **保留**（按 UTC+8 日界，90 天）|

- **计数是 wire 口径**：上游 usage 报什么记什么，不做本地估算。
- 没收到 usage（失败 / 中断）显示 `—`，与真实的 `0` **严格区分**。
- 输出速率（tok/s）的分子含思考 token。

---

## 配置项

| 项 | 位置 | 说明 |
|---|---|---|
| 账号池 | `$DSH_HOME/jet-hub/state.json` | 账号、有效期、限流标记、模型黑名单、provider 顺序 |
| 网关开关 | 同上，`gatewayEnabled` | 缺省启用 |
| 供应商显示顺序 | 同上，`providerOrder` | 纯展示偏好，拖动行调整 |
| 永久积分锁定 | `$DSH_HOME/jet-hub/*.json`（独立文档）| **不与账号池同放** —— 避免多 profile 互相覆盖 |
| Token 账本 | `~/.dsh/jet-hub/token-ledger.json` | 历史日聚合 |

### 常见环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` | 关闭 | 设为真值时，**没有已登录账号的渠道**在模型选择器里整体隐藏 |
| `DSH_OPENAI_GATEWAY_ENABLED` | `1` | 设为 `0` / `false` / `off` / `no` 时完全不启动网关 |
| `DSH_OPENAI_GATEWAY_PORT` | `8326` | 网关监听端口 |
| `DSH_OPENAI_GATEWAY_API_KEY` | 自动生成 | 网关 Bearer 密钥 |
| `DSH_REASONING_LOOP_GUARD` | 开启 | 思考死循环守卫总开关 |
| `DSH_REASONING_LOOP_AUTO_RESUME` | 开启 | 中止后是否自动补一句「继续」并重跑 |
| `DSH_REASONING_LOOP_AUTO_RESUME_MAX` | `2` | 连续自动续跑上限（最大 `10`）|
| `DSH_TRAE_CHANNELS` | `solo_work_lite,solo_agent_remote` | TRAE 要拉取的通道，**顺序即优先级** |
| `DSH_TRAE_MAX_COMPLETION_TOKENS` | `64000` | TRAE 单次输出上限（设 `0` 关闭收敛）|

更多 provider 专属变量（如 `DSH_ZCODE_INTERNAL_CARRIER`、
`DSH_TRAE_ROTATE_MACHINE_ID` 等）见内部文档。

---

## 开发

```sh
pnpm test          # 单元测试（快速，无网络，全部 mock）
pnpm typecheck     # 只做类型检查
pnpm build:all     # 完整构建（宿主 tsc + 资源拷贝 + 客户端 esbuild）
```

### 构建

- `pnpm build` — 用 tsc 将 `src/` 编译到 `lib/`。插件**宿主侧**入口是 `lib/index.js`。
- `pnpm build:client` — 用 esbuild 将 `plugin-src/client/` 打包为
  `lib/client/jet-hub.js`（Jet Hub 设置页的客户端 bundle）。
- `pnpm build:all` — 依次执行上述步骤，是完整的构建。
- `pnpm typecheck` — 只做类型检查，不产出文件。

`lib/` 已被 gitignore，因此构建是安装或运行前的必需步骤。

### E2E 测试

E2E 探针**按 provider 分列**（如 `pnpm test:e2e:codearts`、`pnpm test:e2e:buddy`、
`pnpm test:e2e:loomy`），**均有闸门、默认全部跳过** —— 需要显式设置对应环境变量
（部分还需 `..._CONFIRM=yes`）才会真正发出请求。详见 `tests/e2e/README.md`。

⚠️ 带 `-claim` / `-chat` 后缀的探针会**真实消耗额度或领取机会**，运行前请确认。

### 项目结构

| 路径 | 说明 |
|---|---|
| `src/` | TypeScript 源码（宿主侧） |
| `plugin-src/client/` | Jet Hub 客户端源码（esbuild 打包） |
| `lib/` | 编译产物（已 gitignore） |
| `tests/unit/` | 单元测试 |
| `tests/e2e/` | 端到端测试（默认跳过） |
| `docs/agent-notes/` | 逐 provider 的事故史与约定（开发向） |
| `docs/implementation-notes.md` | **全部实现细节与协议笔记（不入库）** |
| `cordis.patch.yml` | DSH bundle 补丁 |
