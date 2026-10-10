# 库库AI（百度 GenFlowPro）provider 接入实测笔记

> 2026-10-08 起，阶段 B 的**实测事实**逐条登记在这里。
> ⚠️ 与 `docs/superpowers/specs/...-design.md` §1.5 / §4 的说法**冲突时以本文件为准**
> —— 下面是**本机跑出来的**，那份是**逆向推断的**。冲突处已逐条标注。

## 0. 只读铁律（不可违反）

- 库库AI 的 cookie 库在 `%APPDATA%\baidugenflowpro\Network\Cookies` 与
  `%APPDATA%\baidugenflowpro\Partitions\genflow-auth\Network\Cookies`。
  **绝不写那个目录** —— 写坏会让用户的 IDE 掉登录态。
  读的时候**先 `copyFileSync` 到临时目录**，再用 `new DatabaseSync(snap, { readOnly: true })`。
- 写端点（`rewardClaim` / `taskComplete` / `inviteBind` / `sendmsg`）必须经用户**显式授权**
  才发。仓库惯例是 `<PREFIX>_E2E_CONFIRM=yes` 闸门。

## 1. 登录态：**全明文，不需要 DPAPI / os_crypt**

实测（2026-10-08，两次独立复测一致）：

| 库 | 行数 | `encrypted_value` 非空 | 关键 cookie |
|---|---|---|---|
| 主库 `Network/Cookies` | 5 | **0** | `BDUSS` 192B、`BDUSS_BFESS` 192B、`STOKEN` 64B、`gfprotpl` 10B |
| `Partitions/genflow-auth/Network/Cookies` | 14 | **0** | `BAIDUID` 37B、`STOKEN` 64B、`gfprotpl` 10B、`PANPSC` 343B、`PP*` |

⇒ design doc §1.5.6 的前提**成立**：值都在明文 `value` 列，读登录态**不需要**
`Local State` 里的 `os_crypt.encrypted_key`，也不需要 `DPAPI`。
（`Local State` 确实有 `encrypted_key`，但**本 provider 用不到**。）

⚠️ **`BDUSS` 只在主库**，`STOKEN` 两库都有 ⇒ 取 cookie 要**两库合并**，不能只看主库。

## 2. `homenew` 的真实请求参数（design doc §4.2 这里**是错的**）

design doc 说公共参数是 `app_id=123971023, channel=chunlei, version 1.6.7.134`。
**实测**：

- **不传任何参数** ⇒ `HTTP 400 errno=2 show_msg="params error"`。
- 必需的**常量** query（从 IDE 自己的磁盘缓存抓到的真实 URL 得到，不是猜的）：

  ```
  clienttype=400 & app_id=123971023 & web=1 & channel=chunlei & version=1.6.8
  ```

- ⚠️ `version` 实测已是 **1.6.8**（客户端 `package.json` 的 `win_version` 是 `1.6.7.134`，
  但请求里发的是 `1.6.8`）。
- ⚠️ **`bdstoken` / `uinfo` / `uk` 都不是必需的** —— 逐个二分验证：补或不补都是 `200 errno=0`。
  （IDE 的真实 URL 里带它们，但那是引擎统一注入的，服务端并不强校验。）

⚠️ 这套公共参数由**原生引擎**（`getParamById(APP_PARAM_ID_COMMON_PARAM)`）注入，
源码里 `credits-activity-api` 传给 `http.get` 的 `params` 是**空对象** `{}`
（`var t = {}`）—— 所以**照着源码抄 `{}` 会 400**，必须照实测 URL 补常量。

`.tmp-kuku/` 里区分：`createAuthCommonParams()` 只服务**活跃上报**（`reportActivity` /
`requestUserReport`），**不是** credits 的公共参数 —— design doc §4.2 把两者混为一谈了。

## 3. 余额与任务：**两个不同的端点**

⚠️ design doc §1.5.3 说 `freepoint/homenew` 回「**余额**+任务列表」。**实测错了**：
`homenew` 的 `data` 下**只有 `activities`，没有任何数值字段**（探针会显式打这一行）。

### 3.1 余额：`GET /bizapi/gfpro/getgfvipremain`

⚠️ **不在 `freepoint` 前缀下**，路径首段是 `/bizapi/`。

- 信封是 `{status:{code,msg,sLogid}, data:{…}}` —— 与 `freepoint` 的
  `{errno, show_msg, data}` **不是同一个信封**，判成功要看 `status.code === 0`。
- 积分在 `data.list[]` 里 **`assetType === 1`** 那一条的 `totalPoint`。
  ⚠️ **`totalPoint` 是字符串**（实测 `"500"`），不是数值 ⇒ 必须 `Number()`。
  ⚠️ 客户端也**按 `assetType` 取，不按 `assetName`**（`data.list.find(e => e.assetType === 1)?.totalPoint ?? 0`），
  虽然实测 `assetType=1` 的 `assetName` 恰好是 `"token"`。
- 实测资产：`1/token=500`（**这是积分**）、`2/duration=7200`、`3/scheduled_task=2`、`4/realtime_t=0`。

### 3.2 任务列表：`GET /api/genflowpro/freepoint/homenew`

信封 `{errno, show_msg, newno, request_id, server_time, data}` —— ⚠️ **信封在顶层**，
**不是** `body.data.errno`（早期版本在这里判错过一次，把 `errno=2` 误报成 ok）。

结构 `data.activities[] → tabs[] → tasks[]`，实测：

```
activity_key=genflow_free_points  activity_name=免费领积分  period_no=4
  tab_key=daily  tab_name=每日免费领
    daily_login             LOGIN             claimable=50   max=50   single=50
    daily_chat              CHAT              claimable=0    max=50   single=50
    daily_invite_visit      INVITE_VISIT      claimable=0    max=150  single=50
    daily_invite_download   INVITE_DOWNLOAD   claimable=0    max=300  single=100
```

⚠️ 新出现了一个 design doc §1.5.3 任务表里**没有**的 `daily_invite_download`
（`INVITE_DOWNLOAD`）⇒ 任务表**不能写死**，要按 `task_type` 归类。

### 3.3 单任务状态：`GET /api/genflowpro/freepoint/taskstatus?task_key=…`

design doc §1.5.3 没提这个端点。实测 `task_key` 参数**有效**（返回该任务的 `task_status`）：

```
daily_login               → errno=0  task_status="FINISHED"     （已领过）
daily_chat                → errno=0  task_status="UNFINISHED"
daily_invite_visit        → errno=0  task_status="UNFINISHED"
daily_invite_download     → errno=0  task_status="UNFINISHED"
this_key_does_not_exist   → errno=0  task_status="UNFINISHED"   （❓ 未知 key 不报错，见 §6）
```

## 4. 领积分是**写操作**（design doc §1.5.4 这里**是错的**）

⚠️ design doc §1.5.4 说「登录+对话是**服务端自动发放**，客户端从不调 `rewardClaim`」，
并把 kukuai 类比 raccoon 的「没有可调用的签到端点」。**实测推翻**：

`POST /api/genflowpro/freepoint/rewardClaim`

- **参数放 query，不是 body**。放 body 会得到
  `errno=2` + `RewardClaimReqDto.activity_key Error:Field validation for 'activity_key' failed on the 'required' tag`
  （三个字段各报一次）。客户端签名是 `post(url, headers, params)`，第三个参数才是参数。
- 参数形状（asar 逐字实测自 UI 点击处理函数）：

  ```
  activity_key = <activity.activity_key>
  period_id    = <activity.period_no>      ← ⚠️ 请求键 period_id，值取自响应字段 period_no
  task_key     = <task.task_key>
  ```

- 成功响应：`{errno:0, data:{claim_status:"SUCCESS", claimed_point:50}}`。

**实测证据（2026-10-08，已获用户显式授权）**：

| | 之前 | 之后 |
|---|---|---|
| 积分余额（`getgfvipremain`） | **500** | **550** |
| `daily_login` 的 `task_status` | `UNFINISHED` | `FINISHED` |
| `daily_login` 的 `claimable_point` | 50 | 0 |

⇒ 余额真的 +50，任务状态真的翻转。**「服务端自动发放」不成立。**

### 4.1 `autoClaim` **不是**自动发放机制

asar 里 `autoClaim` 只有 **3 处命中，全部在 UI 对象构造里**（
`...s ? { autoClaim: !0 } : {}`，`s = Ji.has(task_type)`，`Ji = new Set(['LOGIN','CHAT'])`），
**没有任何读取方、没有任何发请求的路径**。它只是「这个任务会自动领取」的**展示标记**。

⇒ **不要**照它实现「免调用领取」。领取只能靠调 `rewardClaim`。

## 5. IDE 的登录机制：**cookie 登录，不是 OAuth**

实测（asar 逐字）：

```
lo = "https://passport.baidu.com/v3/login/api/auth"   ← 登录窗口加载的就是这个网页登录页
po = "persist:genflow-auth"                            ← 专用 partition
mo = ["BDUSS","BDUSS_BFESS","PTOKEN","PTOKEN_BFESS","PASS_STOKEN","STOKEN"]
```

三步：

1. 受管控 webview 打开 `passport.baidu.com/v3/login/api/auth`（**网页**登录页，非 OAuth 授权页）；
2. 从 `persist:genflow-auth` partition 读 cookie；
3. **若没有 `STOKEN`**：用 `bduss + ptoken` POST 回 `login/api/auth`，
   取响应里的 `stoken_list.genflowpro`（`Ar()`，失败抛 `GET_STOKEN_EMPTY` / `GET_STOKEN_FAILED:<n>`）。

⇒ **没有 OAuth 的 `client_id` / `redirect_uri` / `authorization_code` 交换**
（asar 里搜到的 `OAUTH_*` 全属于 MCP skill 的 `authType`，与此无关）。

⚠️ 三步**都不依赖 IDE**：换成我们自己的 headful Chromium 打开同一个 passport URL 即可。
⚠️ 实测本机 cookie **没有 `PTOKEN`/`PASS_STOKEN`**（只有 `BDUSS`/`STOKEN`）
⇒ 第 3 步的「换 STOKEN」**首版可以省掉**（`STOKEN` 已在 cookie 里）。

## 6. 尚未查清（下一步要解决）

- **U-A**：`taskstatus` 对**未知 `task_key`** 也回 `UNFINISHED`（不报错）
  ⇒ 不能靠它判「任务不存在」，只能拿它刷新已知任务。
- **U-B**：`period_no` 会随活动周期变（实测 `4`）⇒ 不能缓存，每次领取都要用**当次**
  `homenew` 返回的值。
- **U-C**：`errno=151004`（无活动）在本机**没有复现**（当前有活动）⇒
  「无活动」这条分支只能按 asar 源码实现（`i = 151004` ⇒ 返回 `e.data ?? {activities:[]}`），
  **无法实测**。要在用例里如实标注这一点。
- **U-D**：对话协议（`/wenchain/genflowpro/model/list`、`sendmsg`、
  `sse/msgexchange` 的帧形状与结束判据）**尚未取得** —— 这是 B3 的决策门。

## 7. 相关文件

- 只读探针：`scripts/probe-kuku-credits.mjs`（`scripts/` 已 gitignore，仅本地）
- 领分实测脚本：`.tmp-kuku/r15-claim-login.mjs`（`.tmp-kuku/` 已 gitignore）
- 设计文档（**部分结论已被本文件推翻**）：
  `docs/superpowers/specs/2026-10-08-provider-capability-abstraction-design.md` §1.5 / §4
