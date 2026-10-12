export const DEFAULT_GATEWAY_HOST = '127.0.0.1'
export const DEFAULT_GATEWAY_PORT = 8326

export interface OpenAiGatewayConfig {
  host: string
  port: number
}

/**
 * 网关开关。只有**显式**的假值才停用，未设置时默认启用（保持既有行为）。
 *
 * ⚠️ 不能写成 `parseInt(raw) || 1` 这类形式：`'0'` 是**合法**的停用值，
 * 而 `0` 是 falsy 会被 `||` 静默换回默认值 —— 开关会「关不掉」。
 * 判定只看归一化后的字符串，与本仓库 Qoder 环境变量的同一教训同源。
 */
export function isGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DSH_OPENAI_GATEWAY_ENABLED?.trim().toLowerCase()
  if (raw === undefined || raw === '') return true
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no'
}

/**
 * 通配地址的**规范化形态**，逐个精确比较。
 *
 * ⚠️ 必须用 URL 规范化后的形态比较，**不能**比较用户写的字面量：
 * `0` / `0x0` / `0.0` / `00.0.0.0` 这些紧凑写法在 Linux 的 `inet_aton` 下都是
 * `0.0.0.0`（issue 报告者的场景正是 Linux 容器），而 IPv6 全零有
 * `::` / `::0` / `0::` / `0:0:0:0:0:0:0:0` 等任意多个等价写法。
 * 实测交叉验证（`tmp-wildcard-agreement.mjs` 式的探针，逐条绑真 socket 后用
 * `127.0.0.2` 反连确认是否绑了全部网卡）显示：**URL 规范化 + 这 3 个字面量
 * 没有假阴性** —— 每一个真会绑全部网卡的写法都落到这 3 个形态之一。
 *
 * ⚠️ 反向的假阳性（`0.0.0.0.` / `0` 等「URL 能规范化但内核解析不了」的写法）
 * 是**有意接受**的：它们本来就会以 `ENOENT` / `ENOTFOUND` 启动失败，
 * 用「通配地址」这条更清楚的报错挡住，比让用户去猜 DNS 解析失败好。
 */
const WILDCARD_HOSTS = new Set([
  '0.0.0.0',        // IPv4 全部网卡
  '[::]',           // IPv6 全部网卡（`::` / `0::` / 全零展开都规范化到这里）
  '[::ffff:0:0]',   // IPv4-mapped 全部网卡（`::ffff:0.0.0.0` 也是它）
])

/**
 * 剥掉 URL 记法的方括号。
 *
 * `server.listen()` 收的是**裸地址**（`::1`），而浏览器地址栏给的是
 * `[::1]`。用户两种都可能写/粘贴，故入口统一剥、出口统一加
 * （见 {@link formatGatewayHost}）—— 两处都用同一个助手，避免两套判据。
 *
 * 幂等地容忍多层方括号：只剥掉**配对**的最外层。
 */
export function stripHostBrackets(host: string): string {
  let value = host.trim()
  while (value.startsWith('[') && value.endsWith(']') && value.length > 2) {
    value = value.slice(1, -1).trim()
  }
  return value
}

/**
 * 把裸地址还原成**能放进 URL** 的形态（IPv6 必须加方括号）。
 *
 * ⚠️ 这是本 issue 带出来的连带缺陷：`http://${host}:${port}` 对
 * `::1` 会拼出 `http://::1:8326`，那不是一个合法 URL（端口被解析成 IPv6
 * 的一段）—— 设置页会展示一个抄不走、连不上的地址，而排障方向会跑偏到
 * 「网关没起」。凡是往 URL 里塞 host 的地方都必须过这个函数。
 */
export function formatGatewayHost(host: string): string {
  const value = stripHostBrackets(host)
  return value.includes(':') ? `[${value}]` : value
}

/** 拼网关基地址（含协议与端口）。`suffix` 传 `/v1` 之类的路径。 */
export function gatewayHttpUrl(host: string, port: number, suffix = ''): string {
  return `http://${formatGatewayHost(host)}:${port}${suffix}`
}

/**
 * 是否等价于「绑定所有网卡」的通配地址。
 *
 * ⚠️ 不能改成 `net.isIP(host) === 0 ⇒ 放行`：`[::]` / `0` / `0x0` 的
 * `net.isIP()` 都是 0，会静默从判据里漏掉（实测：`0` 与 `0x0` 在 Linux 上
 * 就是 `0.0.0.0`）。
 */
export function isWildcardHost(host: string): boolean {
  const value = stripHostBrackets(host)
  if (value === '') return true
  // 带方括号的形态 URL 能直接解析；裸 IPv6 必须先括起来（否则被当成端口）。
  try {
    return WILDCARD_HOSTS.has(new URL(`http://${formatGatewayHost(value)}/`).hostname)
  } catch {
    // URL 也规范化不了 ⇒ 它连「是个地址」都不成立，绑定时内核会给出更准确的
    // `ENOTFOUND` / `EADDRNOTAVAIL`。**不要在这里猜成通配** —— 猜错会把
    // 一个用户确实想用的主机名（如容器内的服务名）挡在启动之外。
    return false
  }
}

/**
 * 解析监听地址。
 *
 * ⚠️ `server.listen()` 收到 `[::1]` 会得到一个必然 `EADDRNOTAVAIL` 的启动
 * 失败，故这里统一剥方括号，让用户按 URL 习惯粘贴也能用。
 *
 * ⚠️ **整体取舍：只做通配地址这一条判据，不做「这个地址在本机存不存在」的
 * 预检**。理由：那需要 DNS 查询（`localhost` / `host.docker.internal` /
 * 容器里的服务名都靠它），会把一个纯函数变成异步 + 依赖网络环境的东西；
 * 而内核在 `listen()` 时给出的 `EADDRNOTAVAIL` / `ENOTFOUND` 已经是明确
 * 且带地址的报错（`server.ts` 会原文记进日志）。**别为了「更早失败」把它
 * 改成 DNS 预检**。
 */
function resolveHost(env: NodeJS.ProcessEnv): string {
  const raw = env.DSH_OPENAI_GATEWAY_HOST?.trim()
  if (raw === undefined || raw === '') return DEFAULT_GATEWAY_HOST
  const host = stripHostBrackets(raw)
  if (isWildcardHost(host)) {
    // ⚠️ 报错要给出**做法**：只说「不允许」会让人去搜「怎么绕过这个校验」，
    // 而容器场景的正解（绑容器自己的接口地址）必须写在错误里。
    throw new Error(
      `DSH_OPENAI_GATEWAY_HOST 不能是通配地址（${raw}）：绑定全部网卡会把网关暴露给整个网络，`
      + '只能靠 API Key 隔离。请填**本机某个具体接口地址** —— 容器里通常是容器自身 IP'
      + '（`hostname -i` 或 `ip -4 addr show eth0` 可查，如 172.21.0.8），'
      + '本机直连保持默认 127.0.0.1 即可。',
    )
  }
  return host
}

/** 解析本机网关配置，地址/端口错误时显式失败，避免静默换端口或静默监听全网卡。 */
export function resolveGatewayConfig(env: NodeJS.ProcessEnv = process.env): OpenAiGatewayConfig {
  const host = resolveHost(env)
  const rawPort = env.DSH_OPENAI_GATEWAY_PORT
  if (rawPort === undefined || rawPort.trim() === '') {
    return { host, port: DEFAULT_GATEWAY_PORT }
  }
  const port = Number.parseInt(rawPort, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort.trim()) {
    throw new Error('DSH_OPENAI_GATEWAY_PORT 必须是 1 到 65535 之间的整数')
  }
  return { host, port }
}
