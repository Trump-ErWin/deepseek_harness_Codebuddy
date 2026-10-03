/**
 * 积分 / token 数值的**格式化**（纯函数，不依赖 react）。
 *
 * ## 为什么单独成模块
 *
 * 这四个函数原先住在 `jet-hub.js` 里，只有 Jet Hub 设置页用得到。会话输入区
 * 那枚**用量徽标**（`usage-badge.js`）同样要显示余额，而它的「折叠态一行文案」
 * 逻辑必须可单测 —— `jet-hub.js` 顶部 `import * as React from 'react'`，而
 * 本仓库的 node_modules 里**没有 react**（它是 esbuild 的 external，由宿主注入），
 * 故任何 import 它的模块在 vitest 里都跑不起来。
 *
 * 拆出来之后：
 * - `badge-model.js`（纯逻辑）能直接 import 本模块并被单测覆盖；
 * - 数值格式化的口径只有一份 —— 徽标与设置页**不可能**显示出两个不同的数字
 *   （这正是「搬出去」而不是「再写一份」的理由）。
 *
 * ## ⚠️ 单位的唯一消费点
 *
 * {@link normalizeUnit} / {@link formatUnits} / {@link unitLabel} 是 `unit` 字段的
 * 全仓消费点。加新单位（如 `credit`）时改这里，**不要**在渲染处写
 * `if (provider === 'zcode')` 那种分支 —— 那会漏掉别的 provider，且徽标与设置页
 * 会各写一份。
 *
 * ## ⚠️ 单位必须先归一，再当**分组键**用（真实缺陷，2026-10-03）
 *
 * 用户报障：WorkBuddy 国际版有**两个账号**，胶囊却显示成
 * `WorkBuddy (国际版) • 341.78积分 · 100积分`（两个数并排），账号再多就成一长串。
 *
 * 根因不是「多账号没法合计」，而是**服务端把同一个单位拼成两种写法**。实测
 * （`probe-workbuddy-units.mjs` 逐包打印原值）：
 *
 * | 账号 | 包 | `unit` 原值 |
 * |---|---|---|
 * | `…01CC739A` | Bonus Pack 241.78 / Free Plan Subscription 100 | `credit` / `credits` |
 * | `…297957E1` | Free Plan Subscription 100 | `credits` |
 *
 * 折叠态按**原始字符串**分组（`credit` ≠ `credits`）⇒ 两个账号落进两个分组 ⇒
 * 渲染成两个「积分」。而 {@link unitLabel} 把两者都显示成「积分」——**同一句话里
 * 出现两个一模一样的单位标签**，用户只能读成「把所有号的积分都列出来了」。
 *
 * ⚠️ 口径：**分组键必须与展示名同源**。凡是 {@link unitLabel} 会显示成「积分」的
 * 单位串，就必须落进同一个分组；否则文案里必然出现 `A积分 · B积分` 这种把同一
 * 单位拆成两段的形态。故分组键一律走 {@link normalizeUnit}，**不要**用原值。
 *
 * ⚠️ `token` 与积分**不可互相折算**，故仍分成两组并列显示（ZCode 是 token，其余
 * 是积分）——归一化只收敛同义写法，不跨量纲求和。
 */

/**
 * 把积分余额格式化成一行文案。
 *
 * 保留两位小数：服务端下发的精确值就是两位（如 247.87），而整数版字段
 * 会截断成 247 —— IDE 顶部显示的 "Credits Balance 347.87" 用的是精确值，
 * 这里必须对齐，否则用户会以为插件算错了。
 */
export function formatCredits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // 整数不显示多余的小数位（100 而不是 100.00），有小数才保留两位
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * 把 **token 计数**格式化成人类可读的 `xx.yyM` / `x.yyK`。
 *
 * ## ⚠ 为什么需要它（真实缺陷）
 *
 * 用户报障：「智谱 plan 给的不是积分是 tokens，应该显示 `Token: xx.yyM` 这种格式」。
 *
 * 上游 `billing/balance` 的桶里有明确单位声明（实测）：
 * ```json
 * { "meter": "model_usage", "unit_type": "token",
 *   "total_units": 100000000, "remaining_units": 94539275 }
 * ```
 * Host 侧已如实标注 `unit: 'token'`，但客户端此前**完全不消费 `unit`** ——
 * 于是界面显示 `94539275`（无单位、看起来像 1 亿积分，量级也读不出来）。
 *
 * 规则（与常见 token 展示一致）：
 *   - `>= 1e6` → `94.54M`
 *   - `>= 1e3` → `945.39K`
 *   - 其余     → 原样整数
 *
 * ⚠ 小数位**固定两位**（`94.54M` 而不是 `94.5M`）：token 余额的百位变化
 * 对用户有意义（差 0.04M = 4 万 token），一位小数会把它们抹平。
 */
export function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return String(Math.round(value));
}

/**
 * 把单位串归一到**展示口径**，返回 `'token'` 或 `'credit'`。
 *
 * ⚠️ 这不是「格式化偏好」，而是**语义等价类的代表元**：服务端对同一个单位有多种
 * 拼法（实测 `credit` / `credits` / 空串；`USD`、`积分` 等历史写法同理），而
 * {@link unitLabel} 只认 `token` 一个特例 —— 其余**全部**显示成「积分」。
 * 于是「展示口径」天然只有两类，故这里也只返回两类。
 *
 * ⚠️ **分组键（`creditGroupsOf` / `planGroupsOf`）必须用它**，不能用原值：
 * 用原值会让 `credit` 与 `credits` 各成一组，渲染出两个「积分」（见文件头表）。
 * 归一化之后，胶囊对**任意账号数**都只有一个数字 —— 这正是用户要的「一共能用」。
 *
 * ⚠️ 与宿主侧 `src/credits.ts` 的 `normalizeCreditUnit` **必须逐字等价**
 * （宿主算套餐读数、客户端算余额分组，两边不一致会出现「套餐一个单位、余额另一个」
 * 这种自相矛盾）。一致性由 `tests/unit/usage-badge-client.spec.ts` 逐项比对锁死。
 */
export function normalizeUnit(unit) {
  return unit === 'token' ? 'token' : 'credit';
}

/**
 * 按**单位**选择格式化函数。
 *
 * ⚠ 这是 `unit` 字段的唯一消费点 —— 加新单位（如 `credit`）时改这里，
 * 不要在渲染处写 `if (provider === 'zcode')` 那种分支（会漏掉别的 provider）。
 */
export function formatUnits(value, unit) {
  return normalizeUnit(unit) === 'token' ? formatTokens(value) : formatCredits(value);
}

/** 单位的展示名（账号卡片与徽标上的标签）。 */
export function unitLabel(unit) {
  return normalizeUnit(unit) === 'token' ? 'Token' : '积分';
}
