/**
 * 各 provider 的**元数据与能力声明** —— 本插件里「有哪些 provider、各自有什么能力」
 * 的**唯一真相源**。
 *
 * ## ⚠️ 本文件必须零 import
 *
 * 它同时被两侧消费：
 * - **Node 宿主**（`tsc` → `lib/`）：`src/jet-hub-rpc.ts` 等读它；
 * - **浏览器客户端**（`esbuild` → `lib/client/jet-hub.js`）：
 *   `plugin-src/client/*.js` 经 `import { … } from '../../src/provider-registry.js'`
 *   直接复用它。
 *
 * 后者**已实测可行**（设计文档 §1.4）：esbuild 会把 `./x.js` 解析到同名 `x.ts`。
 * 但浏览器里没有 `node:fs` / `node:path` 等，故本文件**不得** import 任何 `node:*`。
 *
 * ## 为什么要把元数据集中到这里
 *
 * 重构前，加一个 provider 要手改 **13 处**，其中两处会**静默失效**：
 *
 * 1. **四处单测的正则断言**用 `/\{\s*id:\s*'([a-z]+)',\s*label:/g` 从客户端
 *    `PROVIDERS` 派生 id —— `[a-z]+` **不匹配连字符**。若新 provider id 写成
 *    `kuku-ai`，守卫会**静默漏掉一个 id 而照样全绿**（本仓库原注释：
 *    「保险失效比变红更糟」）。
 * 2. **`registerJetHubRpc` 的位置参数**（当时 16 个）—— 注释自陈
 *    「历史上已因少传/插队错位复发 **6 次**」。
 *
 * 本文件消除第 1 处：四处断言改为读 `PROVIDER_REGISTRY`，不再解析源码文本。
 *
 * ## 与各 product 的 `displayName` 的关系
 *
 * 本文件的 `displayName` 当前与对应 product 的 `displayName`（如
 * `src/product.ts` 的 `CodeBuddy (腾讯)`）**取值相同**，但
 * ⚠️ **没有任何断言守着这条一致性** —— 2026-10-08 之前有，那些断言在
 * 客户端 `PROVIDERS` 改为派生后**改锁 `label`** 了（见
 * `raccoon-client-panel.spec.ts` / `zcode-wiring.spec.ts`）。
 *
 * ⚠️ 且它**当前零生产消费者**：真正被读的是各 product 自己的 `displayName`。
 * ⇒ 结构与去留由 Task 11 的收尾审计定夺（选项：删掉本字段只留 `label`，
 * 或保留并补一条「与 product 逐字一致」的断言把它变成可测量的）。
 * **在那之前，不要把本字段当作契约来依赖。**
 */

/** 积分能力（原客户端 `CREDITS_CAPABILITIES` 的每一项）。 */
export interface CreditsCapability {
  /** 能否查积分余额（决定是否渲染「刷新积分」与徽章读数）。 */
  readonly balance: boolean
  /**
   * 能否每日签到领取（决定是否渲染「一键领取积分」）。
   *
   * ⚠️ **省略 = false**，且「省略」是有语义的、不是偷懒 —— 它表示
   * 「该渠道**没有可调用的签到端点**」。目前只有 `raccoon` 这样登记：
   * 实测「每日 300 积分」是**服务端按日自动发放**的（账单
   * `biz_type: 'daily_grant'`），根本没有签到接口可调；
   * 若强行写成 `dailyCheckin: false` 也能跑，但那样就**看不出作者是否想过**
   *（「忘了登记」与「确认没有端点」会长得一模一样）。故这里**刻意允许省略**，
   * 让 raccoon 那条的 `credits` 保持「缺失即缺失」。
   *
   * ⚠️ 判据一律是 `=== true`（见客户端 `supportsDailyCheckin`），
   * 故 `undefined` 与 `false` 行为**完全一致**，省略不会引入任何功能差异。
   */
  readonly dailyCheckin?: boolean
  /** 是否有**一次性**新手/登录奖励（Loomy 新手任务 / raccoon 登录奖励）。 */
  readonly onboardingTasks?: boolean
  /** 是否有**订阅额度窗口**（目前只有 Cline 有「5 小时 / 周 / 月」这一层）。 */
  readonly subscriptionQuota?: boolean
}

/**
 * 一个 provider 的元数据与能力声明。
 *
 * ⚠️ **可选项的默认语义不统一，这是刻意的**（照搬既有各表的约定，见各字段注释）：
 * - `credits.balance` **必填**（无默认，强制想清楚）；
 * - `credits.dailyCheckin` **可省略，省略 = false** —— 但省略承载语义
 *   「该渠道没有可调用的签到端点」（目前只有 raccoon 如此，见该字段注释）；
 * - `rateLimit` 省略 = **true**（限流按钮是既有 UI，默认关闭会让新 provider
 *   凭空少按钮 —— 可见的功能回退）；
 * - `accountTest` / `permanentLock` / `creditPackages` / `autoCheckinExcluded`
 *   省略 = **false**（默认关闭，避免发必然失败的请求 / 渲染无效按钮）。
 */
export interface ProviderDescriptor {
  /** provider id。⚠️ **必须纯小写字母**（`^[a-z]+$`，见文件头第 1 条）。 */
  readonly id: string
  /** Jet Hub 左栏（rail）上的显示名。⚠️ 长度受 `.dim-jh-rail` 宽度算式约束。 */
  readonly label: string
  /**
   * 产品显示名。⚠️ 当前**零生产消费者、零断言**（见文件头的如实说明）——
   * 真正被读的是各 product 自己的 `displayName`。**不要**把它当契约依赖。
   */
  readonly displayName: string
  /** 图标容器的 CSS 类名（`jet-hub-styles.js` 里按它上样式）。 */
  readonly logoClass: string
  // ⚠️ **刻意没有 `icon` 字段**：图标是几百到几万字符的 base64 / SVG data URI
  //    （合计约 44 KB，条数随 provider 增删而变、不在此写死），而**宿主侧从不
  //    使用它们**。放进 registry 会让
  //    `lib/index.js` 白白背上这份体积。图标改由客户端 `PROVIDER_ICONS` 持有
  //    （见 `plugin-src/client/provider-icons.js`），并由一条单测锁「两边 id 集合相等」——
  //    「新增 provider 忘记加图标」仍会**变红**，只是大字符串不进宿主产物。

  /** 积分能力。 */
  readonly credits: CreditsCapability

  /**
   * 该渠道是否具备「模型限流」机制（服务端会因限流拒请求）。
   *
   * ⚠️ **省略 = true**（与 `credits` 的默认关闭**相反**）。理由：限流按钮
   *（重测 / 重置）是**既有 UI**，若默认关闭，将来新增 provider 时忘记登记
   * 会让老用户**凭空失去**按钮 —— 那是可见的功能回退。
   */
  readonly rateLimit?: boolean

  /** 是否支持账号卡片上的「测试」按钮（无条件真发一次请求探活）。省略 = false。 */
  readonly accountTest?: boolean

  /**
   * 余额是否**真的由多个资源包构成且有到期信息**（决定账号名 hover 是否列包）。
   *
   * ⚠️ 这不是「避免冗余」，而是**防止显示错误信息**：loomy 的 `packages` 是我们
   * 自己合成的两个条目、**没有** `deductionEndTime`，若不加门控，卡片上会出现
   *「每日赠送 4992 / 4992 永久」—— 而那笔恰恰**当天就作废**，说反了。
   */
  readonly creditPackages?: boolean

  /** 是否支持「锁定永久积分」。省略 = false。 */
  readonly permanentLock?: boolean

  /**
   * 是否按**到期时间分桶**（决定「锁定永久积分」是否回传 `windowDays`）。
   *
   * ⚠️ 判据是「是否走 `splitBuddyCreditsByExpiry`」，**不是「是不是 buddy」**：
   * TRAE 与 LobsterAI 走同一套、同样受 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 影响；
   * 而 loomy 是**服务端直接给两个命名池**、没有窗口概念，故不在内。
   */
  readonly usesExpiryWindow?: boolean

  /**
   * 每日自动签到是否**排除**该渠道。
   *
   * ⚠️ 它记的不是「谁有签到接口」，而是「谁有签到**代价**」—— 目前只有 zcode：
   * 每次领取都要现场产阿里云 captcha（web 版下会拉起 headful Chromium，
   * 且阿里云按**设备**限流 150 次/小时）。用户仍可**手动**签到。
   */
  readonly autoCheckinExcluded?: boolean

  /** 老契约（DSH ≤0.1.6）的 settings namespace；省略则不注册。 */
  readonly settingsNamespace?: string

  /**
   * 是否是一个普通「渠道」（有账号、有凭据、有积分）。
   *
   * `false` 只有 `aggregate`（聚合层不持有账号与积分，它复用各渠道的）。
   * ⚠️ 用布尔而不是「有没有 `accountExtras`」来推断：那是**巧合**而非语义。
   */
  readonly channel: boolean
}

/**
 * ⚠️ 图标字面量**不写在这里**，而在 `plugin-src/client/provider-icons.js`
 *（它们是几百到几万字符的 base64 / SVG data URI）。原设计想让 registry 持有图标，
 * 但那会让**宿主侧**的 `lib/index.js` 白白背上约 40 KB 的字面量 ——
 * 而宿主从不使用图标。
 *
 * ⇒ 折中：registry 只持有 `logoClass`（两侧都要用），图标由客户端自己的
 * `PROVIDER_ICONS` 表按 id 提供，并由一条单测锁「两边 id 集合相等」。
 * 这样「新增 provider 忘记加图标」仍会**变红**，但不会把大字符串搬进宿主产物。
 */
export const PROVIDER_REGISTRY: readonly ProviderDescriptor[] = Object.freeze([
  {
    id: 'codearts',
    label: 'CodeArts (华为云)',
    displayName: 'CodeArts (华为云)',
    logoClass: 'codearts',
    credits: { balance: true, dailyCheckin: true },
    settingsNamespace: 'llm-codearts',
    channel: true,
  },
  {
    id: 'buddy',
    label: 'CodeBuddy (腾讯)',
    displayName: 'CodeBuddy (腾讯)',
    logoClass: 'buddy',
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: 'llm-buddy',
    channel: true,
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy (国际版)',
    displayName: 'WorkBuddy (国际版)',
    logoClass: 'workbuddy',
    // ⚠️ 国际版后端**没有**签到接口（内核里只有 `get-dosage-notify` 用量通知）。
    credits: { balance: true, dailyCheckin: false },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: 'llm-workbuddy',
    channel: true,
  },
  {
    id: 'lobsterai',
    label: 'LobsterAI (有道)',
    displayName: 'LobsterAI (有道)',
    logoClass: 'lobsterai',
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: 'llm-lobsterai',
    channel: true,
  },
  {
    id: 'qoder',
    label: 'Qoder',
    displayName: 'Qoder',
    logoClass: 'qoder',
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    settingsNamespace: 'llm-qoder',
    channel: true,
  },
  {
    id: 'qodercn',
    label: 'Qoder (中国版)',
    displayName: 'Qoder (中国版)',
    logoClass: 'qodercn',
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    settingsNamespace: 'llm-qodercn',
    channel: true,
  },
  {
    id: 'trae',
    label: 'TRAE (字节)',
    displayName: 'TRAE (字节)',
    logoClass: 'trae',
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: 'llm-trae',
    channel: true,
  },
  {
    id: 'cline',
    label: 'Cline',
    displayName: 'Cline',
    logoClass: 'cline',
    // ⚠️ 无签到：对整个 sidecar 二进制做字符串扫描，`checkin` / `campaign` 等
    //    均无 Cline 业务端点命中。
    // `subscriptionQuota` 是**本表唯一**具备该项的渠道（5 小时 / 周 / 月窗口）。
    credits: { balance: true, dailyCheckin: false, subscriptionQuota: true },
    settingsNamespace: 'llm-cline',
    channel: true,
  },
  {
    id: 'loomy',
    label: 'Loomy (讯飞)',
    displayName: 'Loomy (讯飞)',
    logoClass: 'loomy',
    credits: { balance: true, dailyCheckin: true, onboardingTasks: true },
    // ⚠️ Loomy **不返回限流错误**：今日赠送额度用完后，服务端继续扣永久积分且
    //    照常返回（静默降级）⇒「重测 / 重置」对它毫无意义（重测还会白烧积分）。
    rateLimit: false,
    permanentLock: true,
    // ⚠️ 不在 usesExpiryWindow：它**没有窗口概念**，服务端直接给两个命名池。
    settingsNamespace: 'llm-loomy',
    channel: true,
  },
  {
    id: 'raccoon',
    label: 'Raccoon (商汤)',
    displayName: 'Raccoon (商汤)',
    logoClass: 'raccoon',
    // ⚠️ 不登记 `dailyCheckin`，且**这不是遗漏**：实测「每日 300 积分」是服务端
    //    按日自动发放的（账单 `biz_type: 'daily_grant'`），**没有可调用的签到端点**。
    //    登记它会让用户每次点击都必然失败。
    //    `onboardingTasks` 是 3000 分的**幂等一次性**桌面端登录奖励。
    credits: { balance: true, onboardingTasks: true },
    settingsNamespace: 'llm-raccoon',
    channel: true,
  },
  {
    id: 'minimax',
    // ⚠️ 2026-10-15 加国际版（`minimaxintl`）后必须带括注，否则左栏会出现
    //    「MiniMax Code」+「MiniMax Code (国际版)」两条，用户看不出前者是国内站
    //    （与 `Qoder (中国版)` / `WorkBuddy (国际版)` 的既有命名风格一致）。
    label: 'MiniMax Code (中国版)',
    displayName: 'MiniMax Code (中国版)',
    logoClass: 'minimax',
    credits: { balance: true, dailyCheckin: true },
    settingsNamespace: 'llm-minimax',
    channel: true,
  },
  {
    /**
     * MiniMax Code **国际版**（`minimaxintl`）。
     *
     * ⚠️ 与上面的国内站**共用全部** `src/minimax*.ts` 实现（适配器 / 认证服务 /
     *    OAuth / 积分 / 消息序列化），差异只在 `src/minimax-product.ts` 的
     *    `MINIMAX_INTL` 常量里（主机 / region / ref 前缀）。
     *
     * ⚠️ **`rateLimit` 刻意不写 false**：两站共用同一个 `MinimaxAdapter`，而它
     *    自 issue IKJW32 起会写 `modelRateLimits`（额度 24h / 限流 1h）⇒ 缺省
     *    `true` 是**正确**的，且必须同时进 `probeById` 与
     *    `WRITES_RATE_LIMIT_PROVIDERS`（否则标记写进去却永远清不掉）。
     *
     * ⚠️ **验证状态如实标注**（2026-10-16 合并审计修正 —— 原文写「三项未真机验证」
     *    并指向一个**并不存在**的「未实测清单」，与 `src/minimax-product.ts`
     *    文件头的「✅ 已真机验证」互相否定）：推理路径与签到/积分端点形状
     *    **已真机验证通过**（2026-10-15，真实国际站账号；见该文件头的实测表与
     *    `tests/e2e/minimaxintl-probe.e2e.spec.ts`）。**只有兜底模型表**未按国际站
     *    远端采集（与国内站共用同一份，仅远端失败时兜底）。
     */
    id: 'minimaxintl',
    label: 'MiniMax Code (国际版)',
    displayName: 'MiniMax Code (国际版)',
    logoClass: 'minimaxintl',
    credits: { balance: true, dailyCheckin: true },
    settingsNamespace: 'llm-minimaxintl',
    channel: true,
  },
  {
    id: 'zcode',
    label: 'ZCode (智谱)',
    displayName: 'ZCode (智谱)',
    logoClass: 'zcode',
    // ⚠️ 量纲是 **token 而非积分** —— 能力矩阵回答的是「有没有这项能力」，
    //    不是「量纲是否一致」；量纲差异在面板与 RPC 层如实标注。
    credits: { balance: true, dailyCheckin: true },
    autoCheckinExcluded: true,
    settingsNamespace: 'llm-zcode',
    channel: true,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    displayName: 'OpenCode',
    logoClass: 'opencode',
    // ⚠️ `balance: true` 但语义**不是余额**而是「**通道可用性**」：Zen 没有公开的
    //    余额 API（15 个候选路径全 404），故徽标展示我们真正测得到的东西
    //    （每个通道当前是否可用、是否处于限额冷却），数据全来自本地、零网络请求。
    //    早期登记为 false 曾把**整个徽标挡死**（组件第一件事就是判这个布尔）。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 无 settingsNamespace：它不在老契约的 namespace 清单里。
    channel: true,
  },
  {
    id: 'gemini',
    label: 'Gemini Code Assist',
    displayName: 'Gemini Code Assist',
    logoClass: 'gemini',
    // ⚠️ 不登记 dailyCheckin：Cloud Code 免费线是**纯配额制**，
    //    没有可调用的签到/领取端点（签到是服务端按日自动发放的）。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 与 loomy 同值但**理由不同**：它确实会回 429、适配器也确实写
    //    `modelRateLimits`，但限流是**服务端配额窗口制** —— 本地标记清掉、
    //    重测通过，配额本身一点没恢复，下一次请求立刻又是 429。
    //    于是这组按钮只剩「白烧配额」与「把受限账号放回池里再撞一次」两种副作用。
    rateLimit: false,
    accountTest: true,
    settingsNamespace: 'llm-gemini',
    channel: true,
  },
  {
    id: 'officeace',
    label: 'OfficeAce',
    displayName: 'OfficeAce',
    logoClass: 'officeace',
    // ⚠️ **有**积分余额：数据来自云侧 `GET /v1/subscription`（V11 签名直读，
    //    与果办界面右上角同源同口径，2026-10-12 扣减实锤），**不依赖 OfficeAce 客户端**。
    //
    // ⚠️ `dailyCheckin: false` 但**该渠道确实有签到** —— 这里是**故意**不登记 true：
    //    签到走的是云侧 `POST /v1/subscription/bonus/claim`，且果办客户端的实现是
    //    「订阅页一挂载就自动领、**UI 上没有按钮**」（源码 `SubscriptionStateProvider`
    //    用「年+月+日+时」去重，每小时最多一次）。
    //    故本渠道的签到在**拉余额时自动完成**（见 `officeace-auth.ts` 的
    //    `maybeClaimBonus`）—— 登记成 true 会让面板渲染一个手动签到按钮，
    //    而它背后的 `credits.claim` RPC 对本渠道没有意义（真正的领取是自动的）。
    //    ⚠️ 语义：该字段表达「是否存在**手动**签到入口」，不是「有没有签到收益」。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 余额响应里每个积分包都带到期时间（订阅套餐包无固定到期 = 永久桶，
    //    签到 / 活动包有明确到期）⇒ 可按 `deductionEndTime` 分「永久 / 长期 / 临期」三档。
    creditPackages: true,
    // ⚠️⚠️ **2026-10-15 之前这是一个哑锁**（Gitee issue IKLTHB 第 ① 条）：
    //    登记成 true 让面板渲染出开关、并逐字承诺「这类积分用尽后将没有可用账号」，
    //    而全仓**只有** `credential-resolver.ts` 的 buddy / loomy 两个分支读过
    //    `permanentLocked()` ⇒ 开关写进 `permanent-locks.json` 后行为与关闭**完全一致**
    //    （用户照旧烧永久套餐包）。现已由 `officeace-lock.ts` 补齐执行路径
    //    （锁定 + 只剩不会近期作废的桶 ⇒ 抛错，**绝不回落池**），
    //    并由 `permanent-lock-execution.spec.ts` 守住「凡 permanentLock: true 的渠道
    //    都必须有一条真的会读锁定表的执行路径」。
    permanentLock: true,
    // ⚠️ 判据是「逐包到期时间是否距今天数 < 窗口」，与 buddy 系**同口径**
    //    （`splitOfficeAceCreditsByExpiry` 与 `splitBuddyCreditsByExpiry` 逐格同构）；
    //    窗口复用 `DSH_BUDDY_EXPIRING_WINDOW_DAYS`（默认 15 天），
    //    与 `credits.permanentLock` RPC 回传给面板的 `windowDays` **同源**
    //    （面板文案与实际筛号必须是同一个数）。
    usesExpiryWindow: true,
    // ⚠️ `rateLimit: false` 的**真实理由**（2026-10-13 合并审计实测订正）：
    //    本适配器**根本不写** `modelRateLimits`（`officeace-adapter.ts` 里
    //    `modelRateLimits` / `updateModelRateLimit` / `markLimited` **零命中**，
    //    `provider-runtime-wiring.spec.ts` 也把它登记为空数组）⇒
    //    账号永远没有标记可清 ⇒ 两个按钮点下去**零请求、零清除**（恒惰性）。
    //    ⚠️ 此前这里写的是「它确实会回 429、适配器也写 `modelRateLimits`，
    //    但限流由华为云 MaaS 侧按账号配额管理」——**那句失实**（前半个分句是错的），
    //    真实判据与 accio 同因（「根本没有这组按钮的作用对象」），
    //    与 loomy / gemini 的「会写但清不掉」**不是同一回事**。
    rateLimit: false,
    settingsNamespace: 'llm-officeace',
    channel: true,
  },
  {
    id: 'accio',
    label: 'Accio (阿里)',
    displayName: 'Accio (阿里)',
    logoClass: 'accio',
    // ⚠️ 如实登记：Accio **没有签到端点** —— 每日 200 积分由**登录**触发服务端
    //    发放（`DAILY_REWARD`，24h 有效、不累积），没有可调用的签到 API。
    //    故 `dailyCheckin` 显式写 false（省略与 false 行为一致，但显式写让
    //    「想过这件事」在代码里可见）。
    //    ⚠️ **面板里也没有「刷新每日额度」入口**（2026-10-13 修订）：早先这里写过
    //    「面板另有一个 accio 专属入口，本质是重新登录」，那条承诺**未兑现**。
    //    重新登录**既有**账号需要宿主侧新增 RPC —— 现有的 `account.create` 每次都用
    //    `${provider}-${shortId()}` 现造账号 id 与凭据 ref（`src/jet-hub-rpc.ts`），
    //    拿它当重登录用会多出一条幽灵账号、而原账号额度一点没刷新；账号的 `region`
    //    也没下发给客户端；`login.poll` 对已登录账号第一秒就返回 `done: true`。
    //    ⇒ **该入口尚未实现**，客户端只做诚实展示（三类积分桶 + 重置倒计时 +
    //    「删除该账号后重新登录」这条手动路径），不渲染任何点不动的控件。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ `rateLimit: false` —— 这里的判据是 registry 自己的落地问法：
    //    「这个按钮点下去，能不能让用户**少**受限一次？」答否即 false。
    //    accio 两条都不满足：
    //    ① 适配器**不写** `modelRateLimits`（`provider-runtime-wiring.spec.ts`
    //       的 `WRITE_SITE_FILES` 把它登记为空，并由一条用例**验证**它确实无写点）
    //       ⇒ 账号永远没有标记可清；
    //    ② `src/index.ts` 的 `probeById` 没有它的条目（该表被守卫锁成**恰好**
    //       「会写标记的家」）⇒ 点「重测」时 `retestAccount` 走到
    //       `modelIds.length === 0` 处**提前返回**：零请求、零清除。
    //    两者叠加 ⇒ 面板级的「重测所有 / 重置所有」与卡片级的两个按钮**全部恒为
    //    惰性**。那正是本仓库记录过的报障形态（「按钮响应这么快，是不是坏了」）。
    //    ⚠️ 与 loomy / gemini **理由不同**（它们是真会限流、只是按钮管辖不到）：
    //    accio 是**根本没有这组按钮的作用对象**。
    //    ⚠️ 「省略 = true 以免老用户失去按钮」那条理由**不适用于全新 provider**：
    //    accio 没有存量用户，没有「功能回退」可言。
    //    ⇒ 将来接上请求级换号 + 冷却（届时必须同时进 `probeById` 与
    //    `WRITES_RATE_LIMIT_PROVIDERS`）时，**本行要一起改回 true**。
    rateLimit: false,
    settingsNamespace: 'llm-accio',
    channel: true,
  },
  {
id: 'autoclaw',
    label: 'AutoClaw (智谱)',
    displayName: 'AutoClaw (智谱)',
    logoClass: 'autoclaw',
    credits: { balance: true, dailyCheckin: true },
    // ⚠️⚠️ **2026-10-17 审计修正：本渠道「按批次分档」是尽力而为，不是保证**。
    //
    // 事实链（三条缺一，结论就反了）：
    // ① `autoclaw-credits.ts` 用**流水批次包**替换钱包包，逐包带 `deductionEndTime`
    //    （毫秒，与 officeace / buddy 同单位）—— 钱包接口本身没有任何到期字段；
    // ② ⚠️ **流水的 `amount` 是「历史发放额」，不是「该批次当前剩余额」** ——
    //    上游**没有**「该批次已消耗多少」这一腿（对照 `trae-credits.ts` 的
    //    `remaining = creditsLimit - used`：两腿都在才算得出剩余；本渠道只有发放那一腿）。
    //    ⇒ 用户**消耗过积分后**，未过期批次之和 ≠ `total_balance`；
    // ③ 因此下游以「批次和 == `total_balance`」为**守恒安全网**，不守恒即回退钱包包
    //    （总额与长期数仍正确，只是**没有**临期档）⇒ 临期档只在恰好守恒的那次轮询出现。
    //
    // ⇒ 本行是「把 `windowDays` 回传给客户端，使分档行在有批次包时能渲染」的
    //    **能力开关**，不是数据保证。
    // ⚠️ 与 `src/aggregate-expiry.ts` 的 `autoclawExpiry` 注释口径一致：
    //    聚合折算恒为 `NEVER`（钱包包无 `deductionEndTime`），两处不冲突。
    creditPackages: true,
    // ⚠️ 与 buddy / officeace 同口径（按到期时间分桶，窗口复用
    //    `DSH_BUDDY_EXPIRING_WINDOW_DAYS`）。**必须登记**：查表分派只认这个
    //    标记回传 `windowDays`，漏登记的症状是「胶囊只有合计、没有三档带色行」
    //    —— 与 officeace 当初（`officeace 必须回传 windowDays`）同一根因。
    // ⚠️ 「每日红 + 刷新倒计时」**不适用于本渠道**：那套语义
    //    （`DAILY_POOL_NAMES = ['每日赠送','每日积分']`，**精确相等**匹配，见
    //    `plugin-src/client/credit-expiry.js`）是 Loomy / Raccoon 那种
    //    **当日重置池**（未用完随重置作废）；AutoClaw 的每日签到积分是发放进余额、
    //    按批次各自到期 —— 隐藏池（服务端 `display:false`）已在解析器滤掉，
    //    流水批次的包名取服务端描述（实测「每日签到」**不等于**「每日积分」）
    //    ⇒ 两条路径都不再命中那份名单，「每日 0」红字消失。
    usesExpiryWindow: true,
    rateLimit: false,
    settingsNamespace: 'llm-autoclaw',
    channel: true,
  },
  {
    id: 'modelscope',
    label: 'ModelScope (魔搭)',
    displayName: 'ModelScope (魔搭)',
    logoClass: 'modelscope',
    // ⚠️⚠️ **2026-10-17 更正：本条已从 `false` 改为 `true`**（带真实 Key 实测）。
    //
    // 上面那段「12 条候选路径全 404 ⇒ 没有额度查询 API」的结论**是错的**，
    // 错在**前缀**：那批探测只试过 `/api/v1/*` 与 `/v1/*`，而真端点在
    // **`/openapi/v1/`** ——
    //
    //     GET https://www.modelscope.cn/openapi/v1/magicubes/balance
    //     Authorization: Bearer <ms-…>
    //     → {"success":true,"data":{"total_balance":281,"available_balance":281,
    //        "frozen_amount":0}}
    //
    // ⚠️ 用错前缀时它落在 SPA catch-all 上（SPA 对**任何**路径都回 200 HTML ——
    //    本仓库在 accio 记过同款「假 200」），两种表现都会让人误判成「不存在」。
    //
    // ⚠️⚠️ **「它是真余额」的判据是实测会随消耗下降**，不是字段名像余额：
    //    实测 281 → 发 2 次推理（旗舰档每次扣 2 魔粒）→ 277，**恰好 -4**。
    //    对照组 `/api/v1/quota/status`（API Key 也能读）实测发 3 次推理后
    //    **逐字节不变** ⇒ 那是**任务奖励**（点赞/分享/绑定云账号），不是余额。
    //
    // ⇒ 不需要网页登录态、不需要采集 cookie、不需要起浏览器（三种认证实测：
    //    API Key 200 / 网页 cookie 200 / 无凭据 401 `InvalidAuthentication`，
    //    即它**确实在校验凭据**，符合仓库「目录能读 ≠ 凭据有效」的纪律）。
    //
    // ⚠️ **与 opencode 的关键差异**（别把两者当同一格）：opencode 的「余额」是
    // 本地派生的**通道可用性**（零网络）；魔搭是**云侧真读数**，走 `credits` 域的
    // `fetchBalanceDetailed`（三种失败的用户动作不同，故不用笼统的 `fetchBalance`）。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 无签到：额度是**每日自动刷新**（每账号 250 魔粒、UTC+8 零点重置，
    //    旗舰档每次扣 2），**没有「领取」动作、也没有签到 API**。
    //    宿主侧 credits.claimAll 仍要显式回一句可读错误（见 jet-hub-rpc.ts），
    //    否则自动签到会把它记成 **failed** 而不是 **inactive**。
    //
    // ⚠️⚠️ **登记 `rateLimit: false`（用户要求，2026-10-17）** —— 这**不是**能力缺失，
    //    是**产品取舍**，两者的区别必须留在注释里：
    //
    //    - 能力上：魔搭确实会回 429，本适配器**确实会写** `modelRateLimits`
    //      （`modelscope-adapter.ts` 的 `modelscopeRetryAfterMs`），接线层也注入了
    //      `markLimited`（`index.ts`）；
    //    - 取舍上：用户不要「重测 / 重置」两个按钮，故关掉入口。
    //
    //    ⚠️⚠️ **代价（必须如实记录）**：冷却标记**仍会写进池**，只是用户**没法用按钮
    //    清除它** ⇒ 遇到 429 后只能等它自然过期，或删掉该账号重加。
    //    ⚠️ 与 loomy / gemini / officeace / accio 的 `rateLimit: false` **不同源**：
    //    那几家是「拿不到探测材料」（点了必然报「没有探测适配器」），魔搭是
    //    「探测材料齐全但入口刻意关闭」。**别把它当成漏登记**。
    //    ⚠️ 前两行那条「不登记 rateLimit：魔搭确实会回 429…」的旧注释已被本条取代。
    rateLimit: false,
    // ⚠️ 不登记 accountTest / creditPackages / permanentLock / usesExpiryWindow
    //    —— 全部省略 = false，与能力实情一致。
    // ⚠️ 不登记 settingsNamespace：它不在老契约（≤0.1.6）的 namespace 清单里。
    channel: true,
  },
  {
    id: 'codely',
    label: 'Codely (Unity)',
    displayName: 'Codely (Unity)',
    logoClass: 'codely',
    // ⚠️⚠️ **登录已接线、推理链路未接的过渡态（2026-10-19）**：「新建账号」走
    //    设备码轮询（`src/codely-auth.ts`，与 Qoder / Cline 同款两步式，凭据落
    //    `CODELY_ACCOUNT_*`），**聊天 / 模型目录 / 续期尚未接线**。协议已从官方
    //    VS Code 插件 4.3.0 逆向 + 无凭据实探：
    //    - 设备码登录三步（已实测 200）：
    //      `POST /auth/device/initiate` `{provider:'unity', client_name:'codely-vscode',
    //      auth_from:'vscode-codely'}` → `{auth_request_token, user_code,
    //      verification_uri(_complete), interval:2, expires_in:900}`；
    //      `GET /auth/device/poll?auth_request_token=…` → pending 形状
    //      `{status:'pending', error:'authorization_pending', interval:2}`，
    //      状态机 `pending|slow_down|authorized(+authorization_code)|completed|denied|expired`
    //      （官方插件源码逐分支）；`POST /auth/device/exchange` `{authorization_code}`
    //      → `{access_token, refresh_token}`（插件源码）。
    //    - 刷新：`POST /auth/refresh` `{refresh_token}`（插件源码；**刻意未实现**，
    //      理由见 codely-auth.ts 模块头「为什么暂不实现 refresh」）。
    //    - 鉴权头：`Authorization: Bearer` + `X-User-Agent: codely-vscode/<ver>`（插件源码）。
    //    - 聊天：`POST /v1/chat/completions`（存在性已由 401/405 实测确认，报文未验证）。
    //    - 余额/积分：`/api/user/usage/summary`、`/api/points/check-in`（端点存在，未验证）。
    //
    //    ## 剩余接线清单（缺一处即静默失效，AGENTS.md 有先例）
    //    ① 本条 `channel` 改 `true`；② 删掉 `rateLimit: false`（恢复默认 true）并按实测
    //    决定 `credits.balance`；③ `src/index.ts`：import + `new CodelyAuth` +
    //    `registerCodelyLlm` + auth 注册表数组 + `JetHubAuths`（jet-hub-rpc.ts）加 `codely`
    //    键 + `refreshAccountCredential`（用 `/auth/refresh`）+ 适配器（chat/catalog）；
    //    ④ `AGGREGATE_CHANNELS`（aggregate-adapter.ts）；⑤ `SELF_HEAL_REFRESHABLE_PROVIDERS`
    //    （jet-hub-rpc.ts）；⑥ 测试侧：jet-hub-rpc-auth-wiring.spec.ts 的 `AUTH_SERVICE`
    //    表与计数、zcode-wiring.spec.ts 的豁免数组、tests/helpers/rpc-refresh.ts 的
    //    `REFRESH_PROVIDERS`、provider-registry.spec.ts 的 channel 计数与 rateLimit 清单、
    //    credits-capabilities.spec.ts 的限流清单。
    //    ⚠️ `REF_PREFIX_TO_PROVIDER`（jet-hub-store.ts）的 `CODELY` 前缀**本条已提前登记**
    //    （恢复表守卫按全量 registry 派生，channel:false 也逃不掉）。
    //
    //    ## 接线进度（2026-10-20）
    //    ⓪ 推理 ✅：**驱动官方 CLI 子进程**（签名密钥未取得，让官方客户端自己
    //       签名 —— 详见 `codely-adapter.ts` / `codely-cli.ts` 模块头）；端到端
    //       实测 4.0s 拿到非空 chunk（`codely-basic` 回复 "hello there"）。
    //    ① `channel: true` ⏸ **暂缓**（本行，2026-10-20）；`rateLimit` 见下方说明。
    //    ② `/auth/refresh` **端点已实测**（200、`refresh_token` 不轮换），实现待补。
    //    ③④⑤⑥ 见上方清单。
    //
    //    ## ⚠️ 为什么推理已通而本行仍是 `false`
    //    推理（⓪）**不依赖本开关**：适配器已注册在 `ctx.llm` 与 `modelAdapters`，
    //    端到端实测 4.0s 拿到非空 chunk ⇒ 现在选 codely 模型**就能对话**。
    //    本行只是三张派生守卫（应有 auth / 应进聚合目录 / 应可续期）的判据，
    //    翻 `true` 必须**同时**补完 ②~⑥；实测单独翻 true 会让 **14 条**守卫变红。
    //    ⇒ 推理已走纯 HTTP（`codely-sign.ts` 自签，实测 200 / 1.4s，**不需要客户端**），
    //    但 `channel: true` 会点燃 **9 个 spec / 11 条派生登记**（聚合白名单、自愈名单、
    //    auth 键位 17→18、续期表、descriptor 21→22、modelAdapters 键集合……）。
    //    2026-10-20 实测后**回滚为 false**：先补齐那批登记再一次性翻，避免红仓库。
    channel: false,
    // ⚠️ **UI 先行阶段刻意关闭限流按钮**：重测 / 重置依赖 `probeById` 里的探测适配器，
    //    本 provider 还没有 ⇒ 按钮点了必报「没有探测适配器」（可见的死按钮）。
    //    ⚠️ 与 modelscope 的 `rateLimit: false`（能力齐全、用户不要）**不同源**——
    //    这里是「材料还没有」，接线后**删除本行**（恢复缺省 true）。
    rateLimit: false,
    // ✅ `credits.balance: true`（2026-10-19 真凭据实测）：余额端点
    //    `GET /api/user/usage/summary`（Bearer + X-User-Agent）→
    //    `{remaining_points:"2400", is_exhausted:false, details:[{type:'gift_credit',…}]}`
    //    —— ⚠️ 数字是**字符串**。原语在 `src/codely-credits.ts`，接线在
    //    `provider-credits.ts`（全仓首例 balance:true + channel:false：
    //    登录与余额都是自由函数，不需要 auth 服务；provider-runtime-wiring
    //    的守卫只查已注册 runtime，codely 无 runtime 被跳过）。
    // ✅ `dailyCheckin: true`（2026-10-20 真凭据实测接通）：两步端点
    //    `POST /api/points/check-in/init`（查状态）→ `POST /api/points/check-in`
    //    （执行）均 200；幂等判据是 `init` 的 `can_check_in`，活动状态在
    //    `activity_status`。原语 `claimCodelyDailyCheckIn` 在 `src/codely-credits.ts`
    //    （端点来源是网页 dashboard 的 SPA bundle —— 官方 CLI 二进制里没有签到
    //    调用），接线在 `provider-credits.ts`（`precheckStatus: false`，内部自带
    //    init 预检）。客户端「一键领取积分」按钮与页头「一键签到」遍历都从本表
    //    派生，无需改 UI。
    credits: { balance: true, dailyCheckin: true },
  },
  {
    id: 'aggregate',
    label: '聚合 (跨渠道)',
    displayName: '聚合 (跨渠道)',
    logoClass: 'aggregate',
    // ⚠️ 如实登记为 false：它**没有自己的账号与余额** —— 复用各渠道的账号，
    //    积分与限流由各渠道自己管理。
    // ⚠️ 这不影响用量徽标：徽标对聚合的处理是「重定向到实际选中的渠道」，
    //    重定向发生在 `supportsCreditBalance` 门控**之前**。
    credits: { balance: false, dailyCheckin: false },
    channel: false,
  },
])

/** 按 id 取声明；未知返回 `undefined`（调用方决定报错措辞）。 */
export function descriptorOf(id: string): ProviderDescriptor | undefined {
  return PROVIDER_REGISTRY.find((d) => d.id === id)
}

/**
 * 派生出客户端 `CREDITS_CAPABILITIES` 的同形结构。
 *
 * ⚠️ 只拷贝**已声明**的可选字段（不用 `undefined` 占位）：既有断言用的是
 * `toEqual`，而 `toEqual` 会忽略 `undefined` 属性 —— 但显式写 `undefined`
 * 在快照/序列化场景下仍可能产生差异，保持"缺失即缺失"最安全。
 */
export function creditCapabilitiesOf(): Record<string, CreditsCapability> {
  const out: Record<string, CreditsCapability> = {}
  for (const d of PROVIDER_REGISTRY) {
    // ⚠️ **每一条都要 `Object.freeze`**（2026-10-08 复审修复）：重构前
    // `credits-capabilities.js` 是**逐条手写的字面量**、每条各自带
    // `Object.freeze({…})`，改成派生时只保住了外层的 `Object.freeze(creditCapabilitiesOf())` ——
    // 那只冻结**外层容器**（键不可增删），**内层条目仍可被改写**。
    // 同一文件另外两张派生表（`RATE_LIMIT_CAPABILITIES` /
    // `ACCOUNT_TEST_CAPABILITIES`）各自都留着 `Object.freeze({…})`，
    // 三张表必须同款 —— 本仓库的约定是「保险失效比变红更糟」：
    // 静默失效的守卫比没有守卫更危险（它会让人以为已经守住了）。
    out[d.id] = Object.freeze({
      balance: d.credits.balance,
      // ⚠️ `dailyCheckin` 也是**可省略**字段（见 `CreditsCapability` 的注释：
      //    raccoon 刻意不登记它），故按本函数「缺失即缺失」的规则一并条件拷贝
      //    —— 这样「raccoon 没有签到端点」这件事在派生表里也是**可见的缺失**，
      //    而不是一个与 `false` 无法区分的 `undefined`。
      //    判据侧一律 `=== true`（`supportsDailyCheckin`），故行为不变。
      ...d.credits.dailyCheckin === undefined ? {} : { dailyCheckin: d.credits.dailyCheckin },
      ...d.credits.onboardingTasks === undefined ? {} : { onboardingTasks: d.credits.onboardingTasks },
      ...d.credits.subscriptionQuota === undefined ? {} : { subscriptionQuota: d.credits.subscriptionQuota },
    })
  }
  return out
}
