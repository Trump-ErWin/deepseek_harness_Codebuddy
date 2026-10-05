/**
 * 「Token 用量」弹窗的**取值与聚合展示逻辑**（纯函数，可单测）。
 *
 * ## 为什么单独成文件
 *
 * 与 `model-filter.js` / `tokens-per-second.js` 同理：本仓库单测环境里 react
 * 不在依赖内，组件无法渲染；聚合树的折叠/汇总/格式化判据抽成纯函数后才能
 * 用**真实断言**覆盖（组件只负责把算好的形状画出来）。
 *
 * ## 数据源
 *
 * RPC `usage.tokenLedger` → `TokenLedgerSnapshot`（`src/token-ledger.ts`）：
 * `channels[]`（渠道 → provider → 模型三级聚合）+ `totals`（全局小计）+
 * `entries[]`（最近明细，最新在前）。账本是**进程内存**，重启即丢 ——
 * 弹窗副标题必须讲清这一点，不能伪装成历史报表。
 */

/** token 数格式化：千分位；≥ 1M 用 M 单位、≥ 10K 用 K 单位（对齐 badge 口径的紧凑倾向）。 */
export function formatTokenCount(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  if (n >= 1_000_000) return trimZeros(n / 1_000_000) + 'M';
  if (n >= 10_000) return trimZeros(n / 1_000) + 'K';
  return n.toLocaleString('en-US');
}

/** 去掉小数尾随 0（2.50 → 2.5、2.00 → 2）。 */
function trimZeros(n) {
  return String(Math.round(n * 100) / 100);
}

/** 渠道显示名（`direct` = DSH 直连；`gateway` = OpenAI 网关）。 */
export function channelLabel(channel) {
  return channel === 'gateway' ? '网关' : '直连';
}

/** 渠道排序：直连在前（它是 DSH 用户的主路径），网关在后。 */
export function channelOrder(a, b) {
  return (a === 'direct' ? 0 : 1) - (b === 'direct' ? 0 : 1);
}

/**
 * 一行 token 汇总的**紧凑文本**（`↓1.2K ↑340 ⚡800 🧠56`）。
 *
 * ⚠️ 与 Cline 请求表同款约定：只渲染**有值**的段 —— 缓存/推理为 0 时整段
 * 省略，避免一排恒 0 的装饰性数字稀释真正有用的读数。
 */
export function tokenSummaryText(row) {
  if (!row || typeof row !== 'object') return '—';
  const parts = ['↓' + formatTokenCount(row.inputTokens ?? 0), '↑' + formatTokenCount(row.outputTokens ?? 0)];
  if ((row.cacheReadTokens ?? 0) > 0) parts.push('⚡' + formatTokenCount(row.cacheReadTokens));
  if ((row.cacheWriteTokens ?? 0) > 0) parts.push('✎' + formatTokenCount(row.cacheWriteTokens));
  if ((row.reasoningTokens ?? 0) > 0) parts.push('🧠' + formatTokenCount(row.reasoningTokens));
  return parts.join(' ');
}

/**
 * 明细行的 token 格（与汇总格同规则，但**未收到 usage 时显示 `—`**）。
 *
 * ⚠️ 「没收到 usage」与「用了 0」必须区分：失败行/中断行显示 `—`
 * （0 会被读成「瞬间完成、没花 token」，`cline-request-log` 同约定）。
 */
export function entryTokenText(entry) {
  if (entry?.usageReported !== true) return '—';
  return tokenSummaryText(entry);
}

/** 耗时格式化：<1s 显示毫秒，否则一位小数的秒。 */
export function formatDuration(ms) {
  const n = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
  if (n === 0) return '—';
  if (n < 1000) return n + 'ms';
  return trimZeros(n / 1000) + 's';
}

/** 时间格式化（HH:MM:SS）：明细表不需要日期（流水只覆盖最近 500 笔）。 */
export function formatEntryTime(ts) {
  const d = typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts) : null;
  if (d === null || Number.isNaN(d.getTime())) return '—';
  const pad = (x) => String(x).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/**
 * 弹窗副标题：说明账本的存在形态（进程内存、重启即丢）。
 *
 * ⚠️ 这句话是**诚实务必**：账本不持久化，如果副标题只写「Token 用量」，
 * 用户会把它当成历史统计，重启后看到归零会以为数据丢了（报障成本高）。
 */
export function ledgerSubtitle() {
  return '本机流水 · 重启后清空';
}

/**
 * 汇总卡片头：渠道名 + 请求计数。
 *
 * 0 请求的渠道不显示卡片（空状态由调用方整体处理，见 `hasAnyData`）。
 */
export function channelCardTitle(channelRow) {
  const requests = channelRow?.totals?.requests ?? 0;
  return channelLabel(channelRow?.channel) + ' · ' + requests + ' 次请求';
}

/** 全账本是否没有任何数据（空状态判据：一条明细都没有）。 */
export function hasAnyData(snapshot) {
  return (snapshot?.entries?.length ?? 0) > 0;
}

/**
 * 按当前选择的渠道过滤聚合树。
 *
 * `selected` 为 `null`（= 「全部」）时原样返回；否则只留匹配的渠道。
 * ⚠️ 过滤在**渠道级**进行（provider/模型树保持完整），弹窗的第二层浏览
 * 就是聚合树本身，不需要更细的筛选器。
 */
export function filterChannelsBySelection(channels, selected) {
  if (selected === null) return channels ?? [];
  return (channels ?? []).filter((c) => c?.channel === selected);
}
