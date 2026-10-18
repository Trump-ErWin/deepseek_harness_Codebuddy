# AutoClaw（智谱清言桌面端）provider 笔记

## 积分余额与「逐批次到期」（PR 115，2026-10-17 两轮独立审计 + 变异验证）

### ⚠️⚠️⚠️ P0：**流水的 `amount` 是「历史发放额」，不是「该批次剩余额」**

PR 115 用 `/agent-assetmgr/api/v1/ledgers_std` 的流水给每个积分包补
`deductionEndTime`，实现里把每笔 `credit` 的 `amount` **直接当 `remaining` 求和**。

**流水是历史账变**：一笔 `credit` 记的是「某时刻发放了 N 分」，此后消耗走独立的
`debit` 行，而**上游没有下发任何「该批次已消耗多少」的字段**
⇒ 拿 `amount` 当剩余额 = **拿发放上限当余额**。

⇒ **用户一旦消耗过积分，批次和就 ≠ `total_balance`**，守恒校验恒不成立 ⇒
永远回退钱包包 ⇒ **逐批次分档（含红色「临期」+ 倒计时）永不出现**，
表现为「**刚登录那会儿对、用一段时间后静默失效**」，无报错、无日志。

**必须逐格对照 `src/trae-credits.ts:378`** —— 那边是同款「条目级到期」问题，
但服务端给了 `quota.credits_limit`（上限）**与** `usage.credits_amount`（已用）
**两腿**，所以能折算 `remaining = creditsLimit - used`。
⚠️ **教训可推广：「同款问题」只共享问题形状，不共享解法是否成立**。
照抄别家的判据前先确认**它依赖的那条腿在你家也在**。

✅ 当前取舍：守恒校验当**安全网**（不守恒就回退钱包包，绝不给错数）。
⚠️ **未解决**：要让「消耗后仍能正确分档」，必须由上游下发批次剩余
（`wallet_remaining` 之类）。**在那之前不得声称本渠道已支持按批次分档**，
registry 的 `usesExpiryWindow: true` 只是「把 `windowDays` 回传下去」的**能力开关**。

⚠️ **取证不可复核**：PR 注释引用的 `scripts/probe-autoclaw-expiry.mjs`
**在本仓库不存在**（只有 `probe-autoclaw-reasoning.mjs` / `probe-autoclaw-vision.mjs`）；
`docs/audit/pr111-autoclaw-audit.md` 亦明确记载钱包接口 `wallets[]`
**没有任何时间字段**。⇒ 那句「实测 28/28 全带值、守恒 20700」**不得当作实测证据**。

### ⚠️ `display` 必须按官方口径**严格**判断（这是原报障的根）

用户报障「红色每日 0」的真正修复点在**过滤判据**，不在批次包。

| 写法 | 缺 `display` 字段时 | 后果 |
|---|---|---|
| `typeof cast.display === 'boolean' ? cast.display : true` | **fail-open，判为可见** | 「每日积分」池原样回归 ⇒ **原症状逐字复现** |
| `cast.display === true`（官方 `main.cjs readWallets`） | 判为不可见 | ✅ |

⚠️ 实测钱包响应里**每个池都带 `display`**，严格判断不会误伤真实数据；
但**不能**反过来「宽松更安全」—— 宽松正好放回 bug。

### ⚠️ 批次包名**不得**命中「当日池」名单（否则整段三档被短路）

`plugin-src/client/credit-expiry.js` 的 `DAILY_POOL_NAMES = ['每日赠送','每日积分']`
是**精确相等**匹配，而 `plugin-src/client/usage-badge.js:1459-1463` 是**先判先 return**：
`formatPoolSplitLine(...)` 非 null 就单段返回，**根本走不到**
`splitCreditsByExpiry` 的三档 + 倒计时。

⇒ 上游只要下发一条描述为「每日积分」的发放，本渠道就会被误判成 Loomy / Raccoon
那种**当日重置池**，渲染出无色的「长期 X · 每日 Y」，
**恰恰把红色临期 + 倒计时整段短路掉**，还把批次到期语义说反
（本渠道每日签到分是发放进余额、按批次到期，不是当日重置）。

修法：批次包名命中名单时加「（批次）」后缀。
⚠️ **不要改客户端那份名单** —— 它是**共享**判据，为一个渠道改会影响其余五家；
且名单语义是「服务端按语义分开的当日池」，本渠道的池是**按到期时刻聚合**的，
两者本就不该共用同一份名字表。

⚠️ **两份名单各存一处**（`src/**` 是 TS、`plugin-src/client/**` 是 esbuild 的 JS，
**不共享模块图**）⇒ 宿主侧副本的同步锁在
`tests/unit/autoclaw-credits.spec.ts` 的「宿主侧当日池名单副本逐字一致」那条。

### ⚠️ 守卫判据的两个血泪点（本轮审计实测）

1. **「隐藏池余额恰好为 0」会让守卫无牙**：夹具里隐藏池余额都是 0 时，
   把过滤器换成「按 `balance === 0` 剔除」（同样让隐藏池不输出）**依然全绿**
   ⇒ 对「判据是 display」**零判别力**。**必须把隐藏池余额取非 0** 才钉得住。
2. **「packages 长度为 1」区分不了两条路径**：「守恒不成立」与「流水失败」
   产出**同形**结果 ⇒ 只断言长度等于恒真残留。要断言「真被问过流水端点」
   **且**「回退包里一个 `deductionEndTime` 都没有」才有牙。

⚠️ **更要紧的一条**：原 PR 的验收夹具到期时刻距**真实当前** ~76.7 天
⇒ 落在 15 天窗口外 ⇒ 即便全绿，实际只会渲染黄色「长期」，
永远不是红色「临期 + 倒计时」——**而那正是用户诉求本体**。
⇒ 断言「`deductionEndTime` 被算出来」**不等于**断言「会变红」；
必须把批次真正喂给 `splitCreditsByExpiry` 并断言 `expiring` 与 `earliestExpiringAt`。

### ⚠️ 其余已修的小项

- **负数 `amount`（冲正/退款）一律丢弃**（判据 `<= 0` 而非 `=== 0`）：
  并进批次会让 `remaining` 变负，而客户端 `splitCreditsByExpiry` **静默 skip**
  `remaining <= 0`（`credit-expiry.js:99`）⇒ 合计与总额悄悄脱钩。
- **永久桶按描述分列**，不再用「单一累加器 + 取第一条名」的哨兵：
  哨兵初值恰等于默认名 `'其他积分'` ⇒ **首条真名恰为「其他积分」时哨兵不会被替换，
  被下一条顶掉**，活动赠送与注册奖励被混为一谈。
- **`metadata.description` 是空串时回退顶层 `description`**：`??` 不落空串
  ⇒ 原实现会把包名打成通用兜底「积分发放」。
- **兜底造包只在 `total > 0` 时做**：全部钱包 `display:false` 且零余额时
  凭空造 `remaining: 0` 的死包是纯噪声。
- **整段翻页共用一份时间预算**：原先每页各 arm 一次 15s，
  钱包 1 + 流水 5 = **最坏 90s**，超过徽标 **60s** 轮询周期 ⇒ 请求叠加。

### ⚠️ 聚合折算：`autoclawExpiry` 恒为 `NEVER`

`src/aggregate-expiry.ts` 的 `autoclawExpiry` 复用 `sharedPackageExpiry`
（取有效包 `deductionEndTime` 最小值）⇒ 走钱包包（无 `deductionEndTime`）时恒 `NEVER`。
⚠️ 这与 registry 那条「尽力而为」的注释**口径一致、不冲突**，别去改它。

⚠️ 但注意：`WIRED_EXPIRY_PROVIDERS` 里 autoclaw 的**注释**声称折算取的是
「有余额无到期 ⇒ NEVER」（`aggregate-expiry.ts:957-975`）—— 该注释描述的是
**回退路径**，两种路径都自洽，改动任一侧时同步另一侧的注释。
