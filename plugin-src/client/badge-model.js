/**
 * 用量徽标的**纯逻辑**：显示偏好 → 模式 → 折叠态那一行文案。
 *
 * ## 为什么单独成模块（而不是写在组件里）
 *
 * `usage-badge.js` 是 React 组件，而本仓库的 node_modules 里**没有 react**
 * （它是 esbuild 的 external，由宿主注入）—— 任何 import 组件的测试都跑不起来。
 * 把「该显示什么」全部搬到本模块后，三态偏好 × 三种数据形态的**每一种组合**
 * 都能被单测逐条锁死（见 `tests/unit/badge-model.spec.ts`）。
 *
 * ## 显示优先级（用户 2026-10-03 改：**余额优先**）
 *
 * | 偏好 | 行为 |
 * |---|---|
 * | `auto`（默认） | **余额优先**；没有余额读数才依次回落到窗口、套餐 |
 * | `subscription` | 窗口优先，其次套餐，最后余额（想盯百分比的人用这个档） |
 * | `credits` | 只看余额（也是套餐判定误判时的兜底开关） |
 *
 * ## ⚠️ 为什么 `auto` 从「订阅优先」改成「余额优先」（真实报障，2026-10-03）
 *
 * 用户报障：CodeBuddy 胶囊显示「个人体验版 500 / 500积分」，而设置页里明明写着
 * **可用积分 2434.96**。两者都是真的，但**回答的不是同一个问题**：
 *
 * - 套餐读数是「某一份套餐包还剩多少 / 共有多少」——它只是余额里的一份，
 *   服务端还会下发「体验版」这类样板包；拿它当读数会**少报**可用额度；
 * - 余额读数是「这个渠道**一共**还能用多少」——这才是用户看胶囊要的答案。
 *
 * 旧口径（窗口 > 套餐 > 积分）在这种「既有套餐包又有余额」的渠道上必然少报，
 * 且**看起来像数据错误**（用户原话：「图3里显示我能用的积分足足 2436.96 呢」）。
 *
 * ⚠️ 窗口与套餐读数**没有删掉**：它们仍在浮层里（逐账号明细 / 订阅额度区），
 * 且 `subscription` 档位可以随时切回去。改的只是**折叠态默认显示哪一个**。
 *
 * ⚠️ 「订阅读数存在但内容为空」（例如账号 `ok:true` 却 `windows: []`）必须
 * **回落**到下一个候选：否则徽标会显示成 `Cline · `（只有渠道名、没有数字），
 * 比显示余额更没用。
 *
 * ⚠️ 多单位**绝不跨单位求和**：ZCode 的额度是 token，其余是积分。同一渠道内
 * 单位一致，但代码里不做这个假设 —— 出现两种单位时按单位分组并列显示。
 */

import { formatUnits, unitLabel } from './credits-format.js';
import { quotaWindowsOf, quotaPercentValue, quotaTone } from './quota-format.js';

/**
 * 三态偏好的取值。
 *
 * ⚠️ 必须与宿主侧 `src/badge-preferences.ts` 的 `BADGE_PREFERENCES` 逐字一致
 * （`usage.badgePreference` 对非法值回 `bad-request`）。这条一致性由
 * `tests/unit/usage-badge-client.spec.ts` 直接 import 两边比对锁死。
 */
export const BADGE_PREFERENCES = Object.freeze(['auto', 'subscription', 'credits']);

/** 默认偏好（宿主侧的默认值必须与它相同）。 */
export const DEFAULT_BADGE_PREFERENCE = 'auto';

/**
 * 折叠态里**渠道名与读数之间**的分隔符（用户 2026-10-03 定：''供应商 • 剩余积分''）。
 *
 * ⚠️ 它是一个常量而不是各处手写的字符串：完整文案（{@link badgeView} 的 `text`，
 * 供 title / aria-label 用）由 `名字 + BADGE_SEP + 读数` 拼出，而胶囊里那三段是
 * **三个独立的 span**（名字可收缩、读数不可）。两边若各写一份字形，改一处就会
 * 出现「悬浮提示写着 • 而胶囊里是 ·」这种不一致。
 */
export const BADGE_SEP = ' • ';

/**
 * 「宿主进程跑的是旧代码」的用户提示（真实故障，2026-10-02 用户报障）。
 *
 * ## 故障长什么样
 *
 * 用户在模型选择器旁看到「LobsterAI · 用量不可用」，点开弹窗里赫然写着
 * `unknown method: usage.badgePreference`。
 *
 * ## 根因不是代码，是**两侧加载时机不同**
 *
 * 宿主（Node）在**启动时**把 `lib/` 加载进内存；客户端 bundle 却是**每次请求
 * 从磁盘读**的。于是「改了代码 → 重新构建 → 刷新页面」之后，浏览器拿到了**新**
 * bundle（徽标 UI 出现了），而宿主仍在跑**旧**代码 —— `handleMethod` 落到
 * `default` 分支，回 `unknown method`。
 *
 * ⚠️ 这类失败**静默且有指向性**：用户会以为是功能坏了，实际上只需要重启一次
 * DSH。所以裸错误必须翻译成可行动的一句话（见 {@link describeBadgeError}）。
 */
export const HOST_STALE_HINT = '插件宿主未加载最新版本，请重启 DSH 后重试';

/**
 * 把 RPC 错误翻译成**用户能行动**的一句话。
 *
 * - 命中「宿主没有这个方法」⇒ 给出 {@link HOST_STALE_HINT}；
 * - 其它错误**原样透出**（凭据过期、网络失败等，它们的文案本身就有指向性）；
 * - 拿不到消息时回落到调用方给的 `fallback`。
 *
 * ⚠️ 判据要**窄**：只认 `unknown method` 这一个短语。这是宿主 `handleMethod`
 * 的 `default` 分支写死的文案（`src/jet-hub-rpc.ts`），改动它时本函数要同步；
 * 不要泛化成「含 unknown / 不支持」之类，那会把真实的参数错误也吞掉。
 */
export function describeBadgeError(error, fallback = '') {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message.includes('unknown method')) return HOST_STALE_HINT;
  return message.length > 0 ? message : fallback;
}

/**
 * 偏好的展示名（弹窗里的三态开关）。
 *
 * ⚠️ 2026-10-03 语义反转后，`auto` 与 `credits` 的含义**不再对等**：
 * - `auto` = **余额优先**（没有余额读数才回落到窗口/套餐）；
 * - `subscription` = 只看订阅（窗口 > 套餐 > 余额）；
 * - `credits` = **只看余额**（不回落到订阅 —— 它是套餐误判时的兜底开关）。
 *
 * 故 `auto` 的展示名保留「自动」（不写「优先积分」），否则三档里两档同义、
 * 用户无法从名字看出差别。真正的区别写在 title 里（见 usage-badge.js）。
 */
export const BADGE_PREFERENCE_LABELS = Object.freeze({
  auto: '自动',
  subscription: '优先订阅',
  credits: '只看积分',
});

/** 归一化偏好：未知值一律回落到默认（宿主若返回脏值，UI 不该崩）。 */
export function normalizeBadgePreference(value) {
  return BADGE_PREFERENCES.includes(value) ? value : DEFAULT_BADGE_PREFERENCE;
}

/**
 * 折叠态窗口预览：**最多两条**（优先 5 小时与本周，再多会把胶囊撑宽）。
 *
 * 排序复用设置页的「已知窗口固定顺序 + 未知窗口追加」，故两处显示顺序一致。
 * @returns `[{ type, label, percent }]`，百分比已夹取到 0–100。
 */
export function windowPreview(windows, limit = 2) {
  const list = Array.isArray(windows) ? windows : [];
  return quotaWindowsOf(list)
    .slice(0, limit)
    .map(([type, label, win]) => ({ type, label, percent: quotaPercentValue(win?.percentUsed) }));
}

/**
 * 把逐账号余额按**单位**分组求和。
 *
 * - 只有**读到数**的账号进合计（`error` 有值 → 该账号不进）；
 * - `failedCount` 单独给出，供 UI 说明「另有 N 个账号读取失败」——
 *   **不要把失败画成 0**（0 会被读成「额度用光了」）。
 *
 * @returns `{ groups: [{ unit, label, total, accountCount }], failedCount, okCount }`
 */
export function creditGroupsOf(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const byUnit = new Map();
  let failedCount = 0;
  let okCount = 0;
  for (const row of rows) {
    const balance = row?.balance;
    if (!balance || typeof balance.total !== 'number' || !Number.isFinite(balance.total)) {
      failedCount += 1;
      continue;
    }
    okCount += 1;
    // 单位从**包**上取（ZCode 是 token，其余是积分）；一个包都没有时按空串走
    // `unitLabel` 的默认（「积分」）——与账号卡片的口径一致。
    const unit = firstUnitOf(balance.packages) ?? '';
    const group = byUnit.get(unit) ?? { unit, label: unitLabel(unit), total: 0, accountCount: 0 };
    group.total += balance.total;
    group.accountCount += 1;
    byUnit.set(unit, group);
  }
  // 顺序固定：单位名排序（通常只有一个分组；多单位时顺序稳定，避免每次渲染抖动）
  const groups = [...byUnit.values()].sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  return { groups, failedCount, okCount };
}

/**
 * 把逐账号**套餐**读数按（包名 + 单位）归组求和。
 *
 * 为什么归组而不是只取一个账号：折叠态要显示的是**这个渠道还剩多少**，
 * 多账号下「按包名汇总」才回答得了那个问题（弹窗里再逐账号列出）。
 * 排序按剩余额度降序 ⇒ 折叠态取第一条即「最大的那份套餐」。
 *
 * @returns `[{ name, unit, label, remaining, total, accountCount, deductionEndTime }]`
 */
export function planGroupsOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byKey = new Map();
  for (const row of list) {
    const plan = row?.plan;
    if (!plan) continue;
    const unit = typeof plan.unit === 'string' ? plan.unit : '';
    const key = `${String(plan.name)}\u0000${unit}`;
    const group = byKey.get(key) ?? {
      name: String(plan.name),
      unit,
      label: unitLabel(unit),
      remaining: 0,
      total: 0,
      accountCount: 0,
      deductionEndTime: undefined,
    };
    group.remaining += Number(plan.remaining) || 0;
    group.total += Number(plan.total) || 0;
    group.accountCount += 1;
    // 取**最早**的到期时刻：多个账号同一套餐时，最该被注意的是最先作废的那份。
    const end = typeof plan.deductionEndTime === 'number' && Number.isFinite(plan.deductionEndTime)
      ? plan.deductionEndTime
      : undefined;
    if (end !== undefined && (group.deductionEndTime === undefined || end < group.deductionEndTime)) {
      group.deductionEndTime = end;
    }
    byKey.set(key, group);
  }
  return [...byKey.values()].sort((a, b) => b.remaining - a.remaining);
}

/**
 * 折叠态的完整读数：模式 + 文案 + 色调。
 *
 * @param input.providerLabel - 渠道展示名（`jet-hub.js` 的 `providerLabel()`）。
 * @param input.preference - 显示偏好（脏值会被归一化）。
 * @param input.subscription - 宿主给的订阅读数（可能缺席）。
 * @param input.accounts - 宿主给的逐账号余额（**仅启用账号**）。
 * @param input.loading - **首次读数还没回来**（`true` 时显示「读取中…」）。
 *   ⚠️ 这个入参是必需的，不是装饰：缺了它，首屏会拿空数组算出 `empty` 模式，
 *   于是徽标在读数到达前显示「未配置启用账号」——把「还没读到」说成「没有账号」，
 *   用户会以为账号丢了（真实报障，2026-10-02）。
 * @param input.failed - **首次读数失败且无任何数据**（显示「用量不可用」而不是
 *   「未配置启用账号」）：两种情况用户要做的下一步完全不同。
 * @returns `{ mode, name, detail, reading, text, tone, groups, planGroups, windows, failedCount, okCount, failureReason }`
 *   - `mode`：`'loading' | 'windows' | 'plan' | 'credits' | 'empty'`（**回落之后**的实际模式）；
 *   - `name` / `detail` / `reading`：三段内容，**分开**给渲染层（见 {@link readingOf} 的说明）；
 *     恒有 `text === composeText(name, detail, reading)`；
 *   - `text`：完整一行，用于 `title` / `aria-label`；
 *   - `tone`：`'ok' | 'warn' | 'error' | 'muted'`（徽标圆点用）。
 */
export function badgeView(input) {
  const providerLabel = String(input?.providerLabel ?? 'Jet Hub');
  const preference = normalizeBadgePreference(input?.preference);
  const accounts = Array.isArray(input?.accounts) ? input.accounts : [];
  const subscription = input?.subscription;
  const loading = input?.loading === true;
  const failed = input?.failed === true;

  /**
   * 空/加载状态的统一返回（保持与成功路径同一组键，调用方不必做形状判断）。
   *
   * ⚠️ 入参是**读数**而不是整句文案：渠道名在这里补上，于是 `name` / `reading` /
   * `text` 三者**不可能**自洽不了（否则会出现「文案里有名字、`name` 是空的」
   * 这种半改状态，而胶囊只渲染 `name` + `reading`）。
   */
  const placeholder = (mode, reading, tone) => ({
    mode,
    preference,
    name: providerLabel,
    detail: '',
    reading,
    text: composeText(providerLabel, '', reading),
    tone,
    groups: [],
    planGroups: [],
    windows: [],
    failedCount: 0,
    okCount: 0,
    failureReason: '',
  });

  // 首屏：读数还没到 → 明确的「读取中…」，**不要**说成「未配置启用账号」。
  if (loading) return placeholder('loading', '读取中…', 'muted');
  // 首次读数就失败（且没有任何有效数据）→ 「用量不可用」，与「没有账号」区分开。
  if (failed && accounts.length === 0) return placeholder('empty', '用量不可用', 'error');

  const { groups, failedCount, okCount } = creditGroupsOf(accounts);
  /**
   * 窗口读数取**第一个读到数的账号**（`find(ok) ?? 第一个`）。
   *
   * 为什么不做多账号汇总：窗口是「百分比 + 重置时刻」，不同账号的重置时刻不同，
   * 汇总成一个百分比没有意义（45% 和 30% 加起来是 75%？）。弹窗里逐账号列出，
   * 折叠态只给「当前会发请求的那个账号」的读数。
   */
  const windowRows = subscription?.kind === 'windows' && Array.isArray(subscription.accounts)
    ? subscription.accounts
    : [];
  const windowAccount = windowRows.find((row) => row?.ok === true) ?? windowRows[0];
  const windows = windowAccount === undefined ? [] : windowPreview(windowAccount.windows);
  const planGroups = subscription?.kind === 'plan' ? planGroupsOf(subscription.accounts) : [];

  const failureReason = firstFailureReason(accounts);

  /**
   * 模式 = 按**偏好排出的候选顺序**里第一个有内容的（见文件头的优先级表）。
   *
   * ⚠️ 用「有序候选表 + find」而不是嵌套三元：旧写法把「偏好」与「形态」两个维度
   * 揉进一个条件表达式，加一档就要重排整棵嵌套，极易把某个组合写漏
   * （旧代码里 `wantsSubscription` 一个布尔同时承担「是否看订阅」与
   * 「是否允许回落」两义）。候选表让每种偏好**一眼可读**。
   *
   * ⚠️ 每个候选都必须判「**有内容**」而不是「存在」：账号 `ok:true` 但
   * `windows: []` / 包全失效时，订阅对象是在的、内容却是空的 ——
   * 直接选中它会显示成 `Cline · `（只有渠道名，没有数字）。
   */
  const candidates = preference === 'subscription'
    ? ['windows', 'plan', 'credits']
    : preference === 'credits'
      ? ['credits']
      : ['credits', 'windows', 'plan'];
  const hasContent = {
    credits: groups.length > 0,
    windows: windows.length > 0,
    plan: planGroups.length > 0,
  };
  const mode = candidates.find((candidate) => hasContent[candidate]) ?? 'empty';

  const { detail, reading } = readingOf({ mode, windows, planGroups, groups, accounts, failedCount });

  return {
    mode,
    preference,
    name: providerLabel,
    detail,
    reading,
    text: composeText(providerLabel, detail, reading),
    tone: toneOf({ mode, windows, planGroups, groups, accounts }),
    groups,
    planGroups,
    windows,
    failedCount,
    okCount,
    failureReason,
  };
}

/**
 * 把折叠态拆成**三段**：渠道名 → 可选的中段说明 → 读数。
 *
 * 名字与读数由 {@link badgeView} 直接给出，本函数只负责拼出**整句文案**（`text`），
 * 供 `title` / `aria-label` 与读屏使用。三者恒满足：
 *
 * ```
 * text === name + BADGE_SEP + (detail === '' ? '' : detail + ' ') + reading
 * ```
 *
 * ⚠️ 渲染层**不**用这个字符串，而是按同一组字段渲染成多个 span（见
 * {@link readingOf} 的说明）—— 两条路径共用同一份字段，故不可能显示成两样。
 */
function composeText(name, detail, reading) {
  const middle = detail === '' ? '' : `${detail} `;
  return `${name}${BADGE_SEP}${middle}${reading}`;
}

/**
 * 折叠态的**三段内容**（渠道名与两段读数）。
 *
 * ## 为什么把「名字」与「读数」拆开返回（真实报障，2026-10-03）
 *
 * 用户报障：胶囊显示成 `LobsterAI (有道) · 合计 …`，**后面的数字被截掉了**。
 *
 * 根因不在宽度，而在结构：原先整句是**一个** `overflow: hidden` 的 span，省略号
 * 从右往左吃 —— 而被吃掉的那一段恰恰是用户唯一想看的东西（还剩多少）。渠道名
 * 反而完整保留。故这里拆成独立字段，渲染层再给**不同的收缩权重**。
 *
 * ## 口径（用户 2026-10-03 定）
 *
 * ```
 * WorkBuddy (国际版) • 200积分
 * LobsterAI (有道) • 842.06积分
 * ```
 *
 * - 分隔符是 {@link BADGE_SEP}（` • `），不是原来的 ` · `（那个仍用于**读数内部**
 *   的多段分隔，如 `5 小时 6% · 本周 2%`）；
 * - 积分模式下**去掉「合计」**：胶囊只有一行，那个词占位却不提供信息，多账号明细
 *   与合计都在弹窗里逐条列出（节标题右侧的 `合计 ${sum}` 仍在）；
 * - 数值与单位**之间不留空格**（`200积分` 而不是 `200 积分`）—— 与用户给的
 *   样例逐字一致，也省下每个单位约 3px（胶囊按 px 计费）。
 *
 * @returns `{ detail, reading }`
 *   - `detail`：中段说明（**只有套餐模式**有值 —— 包名如 `Free Plan Subscription`；
 *     它在渲染层是**最先**被省略的那个，因为数字比包名重要）。其余模式为空串；
 *   - `reading`：真正的读数，渲染层**最后**才动它。
 */
function readingOf({ mode, windows, planGroups, groups, accounts, failedCount }) {
  if (mode === 'windows') {
    // 窗口读数分不出「说明」与「数值」：`5 小时 6%` 是一个整体，拆开会出现
    // 「5 小时」被单独留下而百分号被截的荒唐结果。故整段进 reading。
    const parts = windows.map((win) => `${win.label} ${win.percent}%`);
    return { detail: '', reading: parts.join(' · ') };
  }
  if (mode === 'plan') {
    const best = planGroups[0];
    const range = `${formatUnits(best.remaining, best.unit) ?? '?'} / ${formatUnits(best.total, best.unit) ?? '?'}`;
    // ⚠️ 包名进 detail、`剩余 / 总量 + 单位` 进 reading：包名（多为
    // `Free Plan Subscription` 这类样板字）比数字长得多且信息量低。
    return { detail: best.name, reading: `${range}${best.label}` };
  }
  if (mode === 'credits') {
    // `group.label` 就是 unitLabel(unit)（'积分' / 'Token'），故直接贴紧数值。
    const parts = groups.map((group) => `${formatUnits(group.total, group.unit) ?? '?'}${group.label}`);
    return { detail: '', reading: parts.join(' · ') };
  }
  // empty：区分「没有启用账号」与「全部读取失败」——两者给用户的下一步完全不同。
  return { detail: '', reading: accounts.length > 0 && failedCount > 0 ? '用量不可用' : '未配置启用账号' };
}

/** 徽标色调（圆点）。 */
function toneOf({ mode, windows, planGroups, groups, accounts }) {
  if (mode === 'windows') {
    // 取最紧张的那个窗口：任一窗口快满就该提示（与额度条同一套三档）。
    return quotaTone(Math.max(...windows.map((win) => win.percent)));
  }
  if (mode === 'plan') return planGroups[0].remaining > 0 ? 'ok' : 'warn';
  if (mode === 'credits') {
    return groups.some((group) => group.total > 0) ? 'ok' : 'warn';
  }
  return accounts.length > 0 ? 'error' : 'muted';
}

/** 第一个失败原因（徽标 title / 弹窗副标题用），没有失败时返回空串。 */
function firstFailureReason(accounts) {
  for (const row of accounts) {
    if (typeof row?.error === 'string' && row.error.length > 0) return row.error;
  }
  return '';
}

/** 首个声明了单位的包的单位（与 `credits-format.js` 的口径一致）。 */
function firstUnitOf(packages) {
  if (!Array.isArray(packages)) return undefined;
  const hit = packages.find((pkg) => pkg && typeof pkg.unit === 'string' && pkg.unit.length > 0);
  return hit === undefined ? undefined : hit.unit;
}

/**
 * 「更新于 2026/10/1 16:39:32」的时间戳。
 *
 * 时间戳**含日期**：宿主是长生命周期进程，只给时钟会让「昨天读的」
 * 看起来像刚刚读的。⚠️ 与设置页请求记录列用的 `formatStamp` **不同**（那个是
 * 「今天只给时钟」的表格列口径），两者用途不同故不合并。
 */
export function formatUpdatedAt(ms) {
  // ⚠️ 判据是「正数」而不是 `Number.isFinite(date.getTime())`：后者对 `undefined`
  // 会得到 `new Date(0)`（1970/1/1）并照样判为有效 —— 徽标就会显示
  // 「更新于 1970/1/1 08:00:00」。缺失时刻必须回空串，由调用方决定显示什么。
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  const at = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}
