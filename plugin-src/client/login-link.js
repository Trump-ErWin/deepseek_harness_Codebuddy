/**
 * 「登录窗口被浏览器拦截」兜底块：可点击链接 **+ 复制按钮**。
 *
 * ## 为什么单独成文件
 *
 * 同 `openai-gateway-panel.js` / `credits-capabilities.js`：本仓库的单测环境里
 * react 不在依赖内，组件无法渲染。把状态转移与文案抽成纯函数，才能用真实断言
 * 覆盖，而不是靠源码级字符串匹配间接验证。
 *
 * ## 为什么必须有复制按钮（用户 2026-10-03 报障）
 *
 * > 授权链接没有复制按钮 / 只有链接没有复制按钮
 *
 * 这个块**只在 `window.open` 返回 null 或窗口已被关闭时**出现。用户此刻唯一
 * 能做的就是**把 URL 复制到别处打开**（换浏览器、发到手机、贴进 curl），而授权
 * URL 带 `client_id` / `scope` / `state`，长度 300+ 字符 —— 只给一个可点击链接
 * 时，用户只能手工框选，极易漏字符，拿到的就是一个「授权失败」的假象。
 *
 * ## ⚠️⚠️ 两处共用本组件，不要再各写一份
 *
 * `jet-hub.js`（通用面板，gemini 等走它）与 `zcode-card.js`（zcode 编辑卡片）
 * 是同一个兜底块的**两个副本** —— 早期两处都只有 `<a>`，用户报障后必须同时修。
 * 共用组件是唯一的防复发手段：以后谁再改形态，两处一起变；只改一处，
 * 另一个 provider 的用户照样报同一个障。
 *
 * ## ⚠️ 复制失败必须给回退
 *
 * `navigator.clipboard.writeText` 只在**用户手势**里、且是安全上下文时可用；
 * 权限被拒 / 旧内核无 Clipboard API / 非 https 一律失败。失败时若按钮毫无反应，
 * 用户会反复点击（详见 `openai-gateway-panel.js` 的 `copyToClipboard` 注释）。
 * 故失败态做两件事：按钮文案直说「请手动选中」，同时容器打上
 * `data-copy-state="failed"`，由 CSS 把链接切成 `user-select: all` —— 点一下即全选。
 */
import * as React from 'react';
import { copyToClipboard } from './openai-gateway-panel.js';

/** @typedef {'idle' | 'copied' | 'failed'} LoginLinkCopyState */

/** 复制按钮的三态。`idle` 是初值，也是链接换新后的复位值。
 *  @type {Readonly<{ idle: LoginLinkCopyState, copied: LoginLinkCopyState, failed: LoginLinkCopyState }>} */
export const LOGIN_LINK_COPY_STATE = Object.freeze({ idle: 'idle', copied: 'copied', failed: 'failed' });

/**
 * 一次复制尝试之后的下一个状态。
 *
 * ⚠️ 纯函数，且**唯一输入是 `copyToClipboard` 的返回值** —— 绝不能把「点击」
 * 本身当成功。浏览器拒绝写入时同步路径不会抛，只有返回值能区分。
 *
 * @param {boolean} ok 是否真的写进了剪贴板
 * @returns {LoginLinkCopyState}
 */
export function nextLoginLinkCopyState(ok) {
  return ok ? LOGIN_LINK_COPY_STATE.copied : LOGIN_LINK_COPY_STATE.failed;
}

/**
 * 按钮的文案与 tooltip。
 *
 * @param {LoginLinkCopyState} state
 * @returns {{ label: string, title: string }}
 */
export function loginLinkCopyView(state) {
  if (state === LOGIN_LINK_COPY_STATE.copied) {
    return {
      label: '已复制 ✓',
      title: '链接已写入剪贴板，可直接粘贴到浏览器地址栏。',
    };
  }
  if (state === LOGIN_LINK_COPY_STATE.failed) {
    return {
      label: '复制失败，请手动选中',
      // 明确给出替代动作，否则用户只会重复点同一个按钮。
      title: '浏览器拒绝了剪贴板写入（权限被拒或非安全上下文）。'
        + '链接已切换为「点一下全选」，选中后再按 Ctrl+C 即可。',
    };
  }
  return {
    label: '复制链接',
    title: '把登录链接复制到剪贴板（用于换浏览器打开、发到手机或贴进命令行）。',
  };
}

/**
 * 兜底块本体。
 *
 * ⚠️ 调用方必须用 `React.createElement(LoginFallbackNotice, props)` / `h(...)`，
 *    **不得**直接 `LoginFallbackNotice(props)` —— 那会让 hooks 挂到父组件上
 *    （本仓库已因此出过 React #310 白屏事故）。
 *
 * @param {object} props
 * @param {string} props.url 登录链接
 * @param {string} props.noticeClassName 外层提示块类名（两处皮肤不同）
 * @param {string} props.linkClassName 链接类名（两处皮肤不同）
 * @param {string} props.buttonClassName 按钮类名（两处皮肤不同）
 * @param {string} props.message 提示正文
 */
export function LoginFallbackNotice({ url, noticeClassName, linkClassName, buttonClassName, message }) {
  const [copyState, setCopyState] = React.useState(/** @type {LoginLinkCopyState} */ (LOGIN_LINK_COPY_STATE.idle));
  // ⚠️ 链接换新必须复位：换账号重登会给出**另一个** state 的授权 URL，
  //    残留的「已复制 ✓」会让用户以为新链接已经在剪贴板里。
  React.useEffect(() => {
    setCopyState(LOGIN_LINK_COPY_STATE.idle);
  }, [url]);
  const view = loginLinkCopyView(copyState);
  const handleCopy = async () => {
    setCopyState(nextLoginLinkCopyState(await copyToClipboard(url)));
  };
  return React.createElement('div', {
    className: noticeClassName,
    'data-tone': 'warn',
    role: 'alert',
  },
  React.createElement('div', null, message),
  React.createElement('div', {
    className: 'dim-jh-loginLinkRow',
    'data-copy-state': copyState,
  },
  React.createElement('a', {
    className: linkClassName,
    href: url,
    target: '_blank',
    rel: 'noopener noreferrer',
  }, url),
  React.createElement('button', {
    className: buttonClassName,
    // ⚠️ zcode 卡片走 portal 进官方「编辑」卡片，那里可能是 <form> 的子节点；
    //    不写 type 时默认 submit，点一下会连带提交表单。
    type: 'button',
    title: view.title,
    onClick: () => void handleCopy(),
  }, view.label)));
}
