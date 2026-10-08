<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠️ 账号备份：三种「只加不覆盖」的语义边界（选账号导出 / 合并导入 / 第三方转换）

「备份」不是单一功能，而是**四条语义互不相同的路径**共用一个端点族
（`backup.export` / `backup.import` / `backup.status`）。改动前先认清自己在哪一条上：

| 路径 | 语义 | 落点 |
|---|---|---|
| 导出全部 | 自包含快照 | `exportBackup(pool, cred)` |
| **选账号导出** | 只打包选定账号，**黑名单与锁定表仍全量** | `exportBackup(..., { accountIds })` |
| **整体还原** `replace` | 账号池 + 黑名单 + 锁定表**整体替换** | `importBackup(..., { mode: 'replace' })` |
| **合并追加** `merge` | 只追加账号，**不碰**黑名单 / 锁定表 / 他人凭据 | `importBackup(..., { mode: 'merge' })` |

⚠️ **模式必须取白名单，不能透传请求里的字符串**：
`const mode = req?.mode === 'merge' ? 'merge' : 'replace'`。
未知值会被 `?? 'replace'` 静默当成**整体替换** —— 用户以为只加一个账号，实际账号池
被清空，**不可逆**。这是本层唯一一个「写错就毁数据」的地方。

### ⚠️ 裁剪必须发生在**发请求之前**，且要裁三处

判重虽然在**后端**，但后端只知道「这份载荷里有哪些账号」，**不知道用户在界面上勾了哪几个**。
故 `plugin-src/client/backup-payload.js` 的 `trimBackupPayload()` 必须先裁：

1. `accounts` —— 只留选中 id；
2. `credentials` —— 只留被选中账号**实际引用**的 ref；
3. `disabledModels` —— 置空表（合并模式本就不消费它）。

⚠️ **第 2 条是安全边界，不是优化**：备份里那些**不在勾选范围内**的 `credentialRef`
可能已被本机现有账号占用，回写等于**覆盖现有账号的凭据**，与「只增加不覆盖」的承诺相反。

⚠️ **「全部账号」也必须裁**（不能图省事把原始载荷直接发出去）：原始载荷的
`credentials` 还含**账号池之外**的独立凭据 ref（各 provider 的默认单凭据），
那些 ref 在合并语义下同样不该被回写。

⚠️ 同理，`importBackup` 的 `merge` 分支**只写被采纳账号引用的凭据**
（`credentialsToWrite`），绝不回写 `payload.credentials` 全表。`replace` 才逐条写全表。

⚠️ **前端 `exportIds` 的三态语义不能合并**：`null` = 导出全部；
**空集 = 用户勾了但一个都没选，必须报错**；非空集 = 导出这些。
把空集当「全部」会让用户拿到一份含全部账号的文件，与「只导一个」的意图相反（**泄漏面变大**）。

### ⚠️ 合并导入的判重是**三层**，第 2 层才是关键

`importBackup` 在 `mode: 'merge'` 下依次判：

1. 池里已有的 **`id`**；
2. 池里已有的**身份**（凭据里的 `user_id` / `uid` / `userid` / `account_id`，
   `opencode` 另有 `api_key` —— 字段候选表见下）；
3. **备份文件内部**重复的 `id`（同一份文件手工编辑后可能出现两条同 id）。

⚠️⚠️ **只按 `id` 判重是不够的**：插件自己登录时 `id` 由 `shortId()` **随机**生成
（`buddy-a1b2c3d4`），而从第三方文件转换来的 id 是**确定性哈希**（见下节）。
同一个人因此有**两套 id**，只比 id 会把他重复加进池里 —— 而用户在「从别人的备份里挑
账号」时，最常见的情形恰恰是「**这个号我已经手登过了**」。这就是第 2 层存在的理由。

⚠️ **第 3 层不能省**：重复条目会在池里留下两条同 id 的账号，之后
`updateAccount` / `removeAccount` 按 id 查找**只会命中第一条**，出现「删不掉、改不动」
的**幽灵账号**。同一理由要求 `AccountPool.mergeAccounts` 内部也自带去重（两层各判一次
不算冗余：一个是「相对现有池」，一个是「相对本批次」）。

⚠️ **判不出身份时按「无法判断」跳过该条**，不要当成「不匹配」或直接报错：
凭据缺失/损坏是常态（跨版本迁移尤其），不该让一次判重失败阻断整体导入。

#### ⚠️ 身份字段候选表 `IDENTITY_FIELDS`（每个 provider 都要有归属）

| 字段 | 写在哪些 provider 的凭据里 | 出处 |
|---|---|---|
| `user_id` | `buddy` / `workbuddy` / `lobsterai` / `raccoon` / `zcode` | 各自登录与续期写入点 |
| `uid` | `qoder` / `qodercn` / `trae` | 同上 |
| `userid` | `loomy`（讯飞用户 id，18 位数字串） | `LoomyCredential.userid` |
| `account_id` | `cline`（`usr-…`）/ `minimax` | 两个 `*Credential` 接口 |
| `sub` | `gemini`（OIDC `sub`，21 位数字串） | `GeminiCredential.sub` |
| `api_key` | `opencode`（**仅账号槽**，见下） | `opencode-rpc.ts` 写入的 `{api_key, nickname}` |

⚠️ **新增一个 provider 时必须通读它的凭据形状**，再决定要不要补字段。漏一个字段的
后果**不是报错**，而是那个 provider 的「**这个号我已经手登过了**」场景**必然**多出
一条重复账号 —— 判重静默退化成纯 `id` 比对，而 id 在插件侧是随机的、在第三方转换
路径里是确定性的（见下节），同一个人天然有两套 id。

⚠️ **绝不能把轮换令牌当身份**（`access_token` / `refresh_token`）：它们每次续期都会变，
拿它们当键会让**续期后的同一个账号**被判成新账号；顺带也没必要把凭据核心内容搬进键里。

⚠️ **`gemini` 只收 `sub`、不收 `email`**（两者都写在 `GeminiCredential` 顶层）：
`sub` 是 OIDC 的**稳定主体标识**（换邮箱、改昵称都不变），上游正是拿它当账号 id
用的（`gemini-auth.ts` 的 `persistLogin` 返回 `{ accountId: credential.sub }`，
`geminiAccountLabel` 则是「邮箱优先、回退 sub」，两者用途不同）；
而 `email` **会随用户改邮箱而变** —— 拿它当身份会让同一个账号在改邮箱后被判成
新账号，与上面「轮换令牌不得当身份」是同一类错误。
⚠️ **`sub` 在本仓库只有 gemini 写在凭据顶层**（minimax 那个 `sub` 是从 JWT 里解出来的、
**不落顶层字段**），故加进通用表不会让别的 provider 误命中。

⚠️ **`opencode` 必须单独处理，且匿名槽必须排除**：
- 它的凭据**只有** `api_key`（上表四个字段一个都没有）⇒ 账号槽的 `api_key` 就是身份；
- 但**匿名通道**的 `api_key` 恒为 `OPENCODE.anonymousKey`（字面量 `public`），
  **全部匿名槽共用同一个值**。上游把「多条匿名通道各走各的出口（不同出口 IP =
  不同配额桶）」当**能力**提供（见 `src/opencode-auth.ts` 的 `listIdentitySlots` 注释），
  故**不能**拿它当身份：那会把用户刻意添加的第二条匿名通道判成「已存在」而**拒绝导入**。
- 排除之后匿名槽退回纯 `id` 判重 —— 它们本就无法互相区分，这是唯一正确的口径。

### ⚠️ `AccountPool.mergeAccounts` 必须只调 `writeAccounts`

- **只调 `writeAccounts`**（黑名单取**当前**值），因此**不改**黑名单、
  也**不触碰**锁定表（它住在独立文档 `permanent-locks.json`，见本文件「锁定永久积分」一节）。
  ⇒ **不要**为了「顺手统一」把它改成调 `replaceAll`：那会连带覆盖黑名单与锁定表。
- ⚠️ **`added.length === 0` 时必须早退**（不落盘、不返回）：否则每次「全部已存在」的
  导入都会触发一次无意义的写入与目录广播。
- ⚠️ 入参同样经 `sanitizeAccounts` 归一化 —— 数据来自用户提供的文件，坏条目丢弃而不是
  写进池里**反复触发选号失败**。

### ⚠️ 第三方账号列表：识别、provider 分派、确定性 id

用户手上常见的是**别的工具**产生的 CodeBuddy 账号列表（裸数组，账号对象里直接带
`access_token` / `refresh_token`），结构与本插件备份**完全不同**。直接丢给「恢复」只会
得到「该备份文件里没有账号」（取不到 `accounts`）。转换实现在
`plugin-src/client/backup-convert.js`（纯函数，可单测）。

- ⚠️ **必须先排除本插件自己的备份**（`format` 命中即返回 `false`）：本插件备份里
  `credentials` 也是对象，按「对象里有令牌」判会**误判**。
- ⚠️ **空的裸数组也算第三方外形**（`[]`）：它无论如何都不是合法备份，认成第三方至少能
  给出「里面没有账号」这种**可操作**的提示，而不是「备份内容不是对象」这种无从下手的报错。
  包装对象（`accounts` / `data` / `items` / `list`）同理，但**只认这几个键** ——
  否则任何 `{ foo: [] }` 都会被当成账号列表吞掉。
- ⚠️ **provider 按 JWT `iss` 的 host 分派**：含 `workbuddy` → 国际版，否则 → `buddy`。
  两者是**不同路由**，认错会把凭据发到**错误的端点**。认不出时保守回落 `buddy`（中国版最常见）。
- ⚠️ **id 必须确定性生成**（`stableShortId` = uid 的 FNV-1a 哈希），不能随机：
  这样**同一份文件导入两次，第二次全部判为「已存在」而跳过**，不堆重复账号。
  ⚠️ 哈希而非「取 uid 前 8 位」：uid 形态在不同工具里不一致（UUID / 带前缀的四十位 hex /
  纯数字），逐分支处理既啰嗦又易漏。
- ⚠️ **同批次内要再防一次 id 撞车**（重复 uid 是真实可能的：同一份文件里手工粘了两遍
  同一个人），撞了就追加 `index` 再哈希并给出 warning。
- ⚠️ **`refresh_expires_at` 的推导有优先序**：直接字段 → `auth_raw` 的
  `expiresIn`/`refreshExpiresIn` **差值**补算 → refresh_token 的 JWT `exp` 兜底。
  差值公式已实测与本机真实凭据**逐毫秒相等**（432000000ms）；JWT `exp` 比公式**早约 1 秒**
  （向下取整到秒），故**只能作兜底**。
- ⚠️ **不写 `scope`**：真实凭据里有，但插件**从不读取** `scope` 发请求（只在续期时原样带回），
  第三方文件里也没有 —— 与其猜一个可能不准的值，不如省略。缺字段不会被判为无效凭据。
- ⚠️ 转换后**不带 `permanentLocks`**、且 `disabledModels` 置空：让这份载荷即便被当成
  「整体还原」也不会改动模型开关与锁定状态。
- ⚠️ 转换路径**不询问口令**（它不是加密容器），也**不拉 `backup.status`**
  （第三方文件里没有本机账号信息，覆盖提示无意义）；并**默认落到 `merge` 模式**。

- ⚠️ **前端有个源码级守卫要绕开**：`tests/unit/model-filter.spec.ts` 有一道
  **不区分文件位置**的字符串回归墙（防止 `ModelListPanel` 的多选勾选被重新引入）。
  故 `doExport` 里的变量名刻意用 `exportIdList`，**不要**改成被禁用的那个名字。
  守卫本身是对的，不该为这里放宽。

### ⚠️ 与「永久积分锁定表」的交叉点（容易改坏，两个方向）

上游已把锁定表移出 `getStateSnapshot()`，**导出必须走 `permanentLocksSnapshot()`**
（漏改 = 备份里的锁定永远是空表）。本功能**叠加**在其上，两条约束要一起读：

- **选账号导出不得过滤锁定表**：`accountIds` 只作用于 `accounts` / `credentials`；
  锁定表与黑名单**仍全量**，产物才是一份**可整体还原的自包含快照**。
  给过滤加范围时**别顺手把锁定表也过滤掉**。
- **合并导入不得替换锁定表**：`merge` 只调 `mergeAccounts`，不传黑名单、不传锁定表，
  让池**保持当前值**（否则从别人的备份合并一个账号会**静默解锁**自己的永久积分）。

### ⚠️ 合并导入与 `pruneAccountsWithForeignDomain` 的交叉点（残余风险，2026-10-07 发现）

**结论：当前不会误删，但两个判据的语义不自洽，是一个未被测试覆盖的静默删除路径。**

`src/index.ts:333` 在启动时对 `workbuddy` 调 `pruneAccountsWithForeignDomain`，
判据是「凭据里的 `domain` **不等于** `product.apiDomain` 就删账号」。而
**`domain` 的语义是「登录时站点（token 的 `iss` 主机）」快照**，不是请求端点域名 ——
`src/buddy-adapter.ts:1958-1962` 明文写着这一点，且 `X-Domain` 实际以
`this.product.apiDomain || credential.domain` 取值，凭据里的 `domain` 只是**兜底**。

**本机实测（只读 `~/.dsh/.credentials.yaml`，20 个腾讯系账号）证明同一 provider 的
`domain` 合法地存在多种值**：

| provider | `apiDomain`（比对基准） | 凭据里实际出现的 `domain` |
|---|---|---|
| `buddy` | `copilot.tencent.com` | `www.codebuddy.cn`（12 条）、`copilot.tencent.com`（8 条） |
| `workbuddy` | `www.workbuddy.ai` | `www.workbuddy.ai`（1 条） |

⇒ `domain ≠ apiDomain` **并不蕴含**「凭据发不到当前端点」：buddy 那 12 条
`www.codebuddy.cn` 的账号一直是正常可用的（`www.codebuddy.cn` 是它的登录站，
见 `src/buddy.ts:26` 的 `WEBSITE_HOME`）。该判据之所以在 buddy 上没出事，
**只是因为上游恰好没对 `CODEBUDDY` 调用这个函数**（唯一调用点是 `WORKBUDDY`）。

**为什么现在仍安全**：workbuddy 的 realm 恰好就是 `www.workbuddy.ai`
（`backup-convert.spec.ts` 的样例 `iss` 即此值），与本机唯一那条真实 workbuddy
凭据一致 ⇒ **当前 0 个账号被命中**。

**为什么值得记**：
1. **合并导入放大了触发面**：本功能让「跨机搬账号」变常见，一旦导入的 workbuddy
   凭据 `iss` 与 `apiDomain` 不同（例如国际版另有 realm 主机、或将来改登录站），
   启动时会被**静默删除**——只留一行 `ctx.logger.info`，用户看到的是「账号自己没了」。
2. **`pruneAccountsWithForeignDomain` 的用例只覆盖了「domain 指向旧端点」这一形态**
   （`account-pool.spec.ts` 的 `describe('pruneAccountsWithForeignDomain')`），
   **没有**「domain 是合法登录站但 ≠ apiDomain」的反例用例。这正是 buddy 那 12 条
   账号的形态 —— 若该函数将来被推广到 `CODEBUDDY`，会一次性删掉它们全部。
3. ⚠️ **推广前必须先修判据**：应改判「端点是否可达 / `domain` 是否属于该产品的
   已知 realm 集合」，而不是与 `apiDomain` 精确比对。不要直接套用。

### 测试与反向验证

- `tests/unit/backup.spec.ts`（46 条）：选择性导出 / 合并导入三层判重 /
  `merge` 不回写其余凭据 / `replace` 兼容旧行为 / `accountsSkipped` 恒空；
  其中 7 条专管**身份字段覆盖度**（cline `account_id` / loomy `userid` /
  gemini `sub` / gemini `email` 不得当身份 / opencode 账号槽 `api_key` /
  opencode 匿名槽不判身份 / 轮换令牌不得当身份）。
- `tests/unit/backup-payload.spec.ts`（13 条）：载荷裁剪（含「不修改入参」）与账号摘要。
- `tests/unit/backup-convert.spec.ts`（28 条）：第三方识别、iss 分派、确定性 id、
  字段对齐、坏条目降级。
- `tests/unit/account-pool.spec.ts` 的 `mergeAccounts` 段（6 条）：只追加 / 跳过同 id /
  不改黑名单与锁定 / 归一化坏条目 / 文件内重复只加一次 / 全部已存在时不落盘。

⚠️（关于 `scripts/` 里的 `probe-*.mjs` / `verify-*.mjs`：按本文件「哪些入库、哪些不入库」
一节，它们是**本地指针**，新克隆的仓库里没有 —— 别照着路径去 `import`。）

⚠️ **已做反向验证**（2026-09-30 与 2026-10-02 两轮，逐条实测；还原用
「文件副本回拷 + `Get-FileHash` 比对」）：

| 变异 | 结果 |
|---|---|
| 禁用第 2 层身份判重（`identityKey` 恒 `undefined`） | `backup.spec.ts` **1 条**变红（「id 不同但 user_id 相同」） |
| 让 `merge` 回写 `payload.credentials` 全表 | `backup.spec.ts` **3 条**变红 |
| `mergeAccounts` 去掉文件内重复 id 去重 | `account-pool.spec.ts` **1 条**变红 |
| 身份字段表退回只认 `user_id` / `uid` | `backup.spec.ts` **2 条**变红（cline / loomy 身份判重） |
| 删掉 `opencode` 的 `api_key` 分支 | `backup.spec.ts` **1 条**变红（opencode 账号槽判重） |
| 去掉匿名槽排除（把 `public` 也当身份） | `backup.spec.ts` **1 条**变红（多条匿名通道被判成同一账号） |
| — | 还原后 4 个文件 **214 条全绿** |

⚠️ **做这类变异验证时不要用 `git checkout -- .` / `git restore` / `git stash`**：
本仓库经常带**未提交**的自有改动，那些命令会把它们一并抹掉。用文件副本回拷，
并用 `Get-FileHash` 比对确认还原干净。