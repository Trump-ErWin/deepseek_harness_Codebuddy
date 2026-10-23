/**
 * 「面板入口」偏好的客户端状态与读写（**无 React、无组件依赖**）。
 *
 * 单独成文件是为了避开循环 import：`panel-entry.js` 需要 `JetHubPage`，
 * 而插件详情页的卡片又需要本状态 —— 三份模块若互相 import，esbuild 打包后
 * 会在模块初始化顺序上留下 TDZ 风险（真机表现是打开设置页白屏、控制台一条
 * `Cannot access 'X' before initialization`）。
 *
 * ## 取值语义
 *
 * 两个取值**严格互斥**，任一时刻只有一个入口存在：
 * - `'sidebar'` = 主导航里一行（`sidebar.panellist`），`settings.section` 注销；
 * - `'settings'` = 只剩「设置 → 插件 → Jet Hub」，主导航那一行注销。
 *
 * 模块内状态另有 `null`，表示**还没从宿主读到**（启动中）—— 它与 `'sidebar'`
 * 一样让侧栏行可见，否则每次启动那一行都会闪一下。
 *
 * 存宿主侧而不是浏览器本地存储：Web 端 origin 是 `http://127.0.0.1:<随机端口>`，
 * 换端口本地存储就清空，用户会看到「下拉自己变回默认」。客户端也不该读写浏览器存储
 * （本仓库有一条守卫在扫客户端源码里的存储 API 字面量）。
 */

/** `PanelEntry` 的两个合法取值（与宿主 `PANEL_ENTRY_VALUES` 必须逐字一致）。 */
const VALID_ENTRIES = ['sidebar', 'settings'];

/** 读不到宿主偏好时的兜底取值。 */
const FALLBACK_ENTRY = 'sidebar';

/**
 * `main` 槽的 key，同时也是 `sidebar.panellist` 的 id 与 `settings.section` 的 id。
 *
 * 宿主按「侧栏 id = 主面板 key」派发，三者不一致时界面看起来完全正常，
 * 只有点下去才会发现「面板没换」。
 */
export const JET_HUB_PANEL_KEY = 'jet-hub';

/**
 * 侧栏行在主导航里的位置。
 *
 * 现有占用：插件 0、插件市场 1、自动化任务 10、记忆系统 30 —— 取 20 落在
 * 自动化任务与记忆系统之间（Jet Hub 偏工具，不是会话入口）。
 */
export const JET_HUB_SIDEBAR_ORDER = 20;

/**
 * 读宿主偏好的超时（毫秒）。
 *
 * 超时按「仅侧栏」兜底：一次卡住的 RPC 不该把两处入口都藏掉，用户会以为插件没装好。
 */
const PANEL_ENTRY_READ_TIMEOUT_MS = 5000;

/**
 * 进程内的「面板入口」状态。
 *
 * `null` = **还没从宿主读到**（启动中）；`'sidebar'` / `'settings'` = 宿主的明确取值。
 */
let entry = null;

/** 最近一次读取是否失败（卡片据此显示降级文案，不据此禁用下拉）。 */
let readFailed = false;

/** 正在飞的那次读取（并发去重用；`null` = 没有在飞）。 */
let inflight = null;

/** 订阅者集合：卡片与两处槽位注册共用同一份状态。 */
const listeners = new Set();

/**
 * 把任意输入归一成合法取值。
 *
 * @param {unknown} raw
 * @returns {'sidebar' | 'settings' | null} 非法值返回 `null`
 */
function normalize(raw) {
  return typeof raw === 'string' && VALID_ENTRIES.includes(raw) ? raw : null;
}

/**
 * 当前取值（`null` = 还没读到宿主偏好）。
 *
 * ⚠️ 调用方要判断「该注册哪处入口」请用 {@link panelEntryShowsSidebar} /
 * {@link panelEntryShowsSettings}：它们已经把 `null` 的兜底方向算进去了。
 *
 * @returns {'sidebar' | 'settings' | null}
 */
export function panelEntry() {
  return entry;
}

/**
 * 侧栏行当前是否应当显示（`null` 视为显示）。
 *
 * @returns {boolean}
 */
export function panelEntryShowsSidebar() {
  return entry !== 'settings';
}

/**
 * 设置节当前是否应当显示。
 *
 * ⚠️ 只有**明确读到** `'settings'` 才返回 true：`null`（还没读到）按侧栏兜底，
 * 否则启动瞬间两处都不注册，用户会看到一片空白。
 *
 * @returns {boolean}
 */
export function panelEntryShowsSettings() {
  return entry === 'settings';
}

/**
 * 最近一次「读宿主偏好」是否失败。
 *
 * ⚠️ 只用于**提示**：失败时仍按「仅侧栏」兜底、下拉仍可点 —— 与网关面板
 * 「附属字段采集失败不该把用户挡在自救路径之外」同一取向。
 *
 * @returns {boolean}
 */
export function panelEntryReadFailed() {
  return readFailed;
}

/**
 * 订阅「面板入口」状态的变化（取值与读取失败标记都会触发）。
 *
 * @param {() => void} listener
 * @returns {() => void} 取消订阅
 */
export function subscribePanelEntry(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 广播一次状态变化。**无变化时不广播**，避免卡片与两处注册无谓重算。
 *
 * @param {'sidebar' | 'settings'} nextEntry 合法取值
 * @param {boolean} nextFailed
 */
function publish(nextEntry, nextFailed) {
  if (entry === nextEntry && readFailed === nextFailed) return;
  entry = nextEntry;
  readFailed = nextFailed;
  // 复制一份再遍历：监听器里可能自己退订（例如侧栏行被撤销）。
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (caught) {
      console.error('[jet-hub] 面板入口监听器抛错', caught);
    }
  }
}

/**
 * 组装读取用的 AbortSignal；老内核没有 `AbortSignal.timeout` 就不带信号。
 *
 * @returns {AbortSignal | undefined}
 */
function readSignal() {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined;
  return AbortSignal.timeout(PANEL_ENTRY_READ_TIMEOUT_MS);
}

/**
 * 从宿主读一次「面板入口」偏好（只读，不写回）。
 *
 * 调用点有三处且**都必要**：侧栏行注册前、设置节注册前、卡片挂载时。前两处
 * 只关心取值，第三处还要把「读取失败」标记显示出来。
 *
 * ⚠️ **并发去重**：三处都在 `apply` / 挂载时立即调用，不去重就要打三次宿主 RPC，
 * 而且三次回包顺序不定会多广播两次无谓重渲染。
 *
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} rpcCall
 * @returns {Promise<'sidebar' | 'settings'>} 读到的值；失败时沿用当前状态（兜底仅侧栏）
 */
export function loadPanelEntry(rpcCall) {
  if (inflight !== null) return inflight;
  inflight = (async () => {
    try {
      const result = await rpcCall('panelEntry.get', {}, readSignal());
      const next = normalize(result?.entry);
      if (next !== null) {
        // 宿主明确给了合法值：清掉失败标记。
        publish(next, false);
      } else {
        // 回包形状不对：按读取失败处理，但仍保持当前（默认仅侧栏）方向。
        publish(entry ?? FALLBACK_ENTRY, true);
      }
    } catch (caught) {
      console.warn('[jet-hub] 读取面板入口偏好失败，按仅侧栏处理', caught);
      publish(entry ?? FALLBACK_ENTRY, true);
    } finally {
      inflight = null;
    }
    return entry ?? FALLBACK_ENTRY;
  })();
  return inflight;
}

/**
 * 写回「面板入口」偏好，并以宿主返回值更新本地状态。
 *
 * ⚠️ **不猜默认值**：只有宿主明确回合法取值才更新；失败直接抛给调用方
 * （卡片要能回滚并提示用户 —— 静默改本地状态会造成「下拉看着改了、重启后
 * 又变回来」）。
 *
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} rpcCall
 * @param {'sidebar' | 'settings'} next
 * @returns {Promise<'sidebar' | 'settings'>} 宿主确认后的值
 */
export async function setPanelEntry(rpcCall, next) {
  const result = await rpcCall('panelEntry.set', { entry: next });
  const confirmed = normalize(result?.entry);
  if (confirmed === null) {
    throw new Error('面板入口偏好没有返回合法 entry');
  }
  publish(confirmed, false);
  return confirmed;
}
