/**
 * ZCode **边缘拦截页**的判据与错误码回归（真实故障，2026-10-06）。
 *
 * ## 现场（48 小时会话日志实证，出现 127 次）
 *
 * ```
 * zcode: HTTP 405：<!doctypehtml><html lang="zh-cn"><meta charset="utf-8">
 *        …<meta name="data-spm"content="a3c0e"><title>405</title>…
 * ```
 *
 * 同一时刻、同一凭据的对照：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | `GET  /billing/balance`（带凭据） | **200**（凭据有效） |
 * | `GET  /billing/balance`（无凭据） | 401（端点活着） |
 * | `POST /anthropic/v1/messages` | **405 + 阿里云 ESA HTML 页** |
 * | `POST /v1/messages`、`/messages`、`/anthropic/messages` | 纯文本 `404 page not found`（后端可达） |
 *
 * ⇒ 请求**没到业务层**，是边缘规则拦了推理路径。本地无可修。
 *
 * ## 本文件锁住什么
 *
 * 1. **形态判据**：HTML 文档 / `data-spm` / `<title>4xx</title>` 认出边缘页，
 *    而**后端原生纯文本 404** 与**模型正文里讨论 HTML** 都**不得**被误判。
 * 2. **错误码不可重试**：边缘页归 `PERMISSION`（与 `3012` 同档），
 *    **不能**落到 `SERVER` —— 后者在 harness 的可重试集合里 ⇒
 *    用户白等 5 轮退避（约 15.5 秒）而边缘规则不会因退避改变。
 * 3. **人话文案**：`describeUpstreamError` 对边缘页给出可行动的三句话
 *    （边缘层拦截 / 不是账号问题 / 换模型或等上游），**不倒整页 HTML**，
 *    证据窗截 80 字符；业务码与凭据文案仍优先于形态判据。
 *
 * ⚠ 反向验证：删掉 `httpErrorCodeForZcode` 里那行 `isZcodeEdgeBlockedPage` 判定 ⇒
 * 第 2 条变红（405 HTML 落回 `SERVER`）；删掉 `describeUpstreamError` 里的
 * 人话文案块 ⇒ 第 3 条变红（落到 `HTTP ${status}：…` 兜底行）。
 */
import { describe, expect, it } from 'vitest'

import { describeUpstreamError, httpErrorCodeForZcode, isZcodeEdgeBlockedPage } from '../../src/zcode-adapter.js'

/** 实测样本（阿里云 ESA 405 页，截取自真实响应）。 */
const REAL_EDGE_405 =
  '<!doctypehtml><html lang="zh-cn"><meta charset="utf-8">'
  + '<meta http-equiv="X-UA-Compatible"content="IE=edge,chrome=1">'
  + '<meta name="data-spm"content="a3c0e"><title>405</title><style>a,body{}</style>'
  + '<body>'

describe('ZCode 边缘拦截页判据', () => {
  it('★ 真实 ESA 405 页必须被认出', () => {
    expect(isZcodeEdgeBlockedPage(REAL_EDGE_405)).toBe(true)
    // 大小写不敏感（DOCTYPE 有大写形态）。
    expect(isZcodeEdgeBlockedPage('<!DOCTYPE HTML><html>')).toBe(true)
    // 带 `error: ` 前缀（网关把页面塞进错误字段）。
    expect(isZcodeEdgeBlockedPage('error: <html><body>502 Bad Gateway</body></html>')).toBe(true)
    // 仅靠 `<title>405</title>` 也能认出（页面被截断时）。
    expect(isZcodeEdgeBlockedPage('<title>405</title>')).toBe(true)
  })

  it('★ 不得误伤：后端原生 404 与正常 JSON 都不算边缘页', () => {
    // 后端原生形态（实测：换路径时上游回的就是这个）。
    expect(isZcodeEdgeBlockedPage('404 page not found')).toBe(false)
    expect(isZcodeEdgeBlockedPage('{"code":1005,"msg":"exceed quota limit"}')).toBe(false)
    expect(isZcodeEdgeBlockedPage('')).toBe(false)
    /**
     * ★ 关键防误伤：**模型正文里讨论 HTML** 不算边缘页。
     * 只认「文档起始」，不认正文中出现的 `<html>` 字样。
     */
    expect(isZcodeEdgeBlockedPage('要渲染页面请用 <html> 标签包住内容')).toBe(false)
    expect(isZcodeEdgeBlockedPage('The response body contains <html lang="en"> as a substring')).toBe(false)
    // `<title>200</title>` 不是 4xx。
    expect(isZcodeEdgeBlockedPage('<title>200</title>')).toBe(false)
  })

  it('★ 边缘页的错误码必须**不可重试**（不得落 SERVER）', () => {
    // 修复前这里返回 'SERVER'（在 harness 可重试集合里 ⇒ 白退避 5 次）。
    expect(httpErrorCodeForZcode(405, REAL_EDGE_405)).toBe('PERMISSION')
    // 形态判据优先于状态码：哪怕状态码是 502，只要是边缘页也不重试。
    expect(httpErrorCodeForZcode(502, '<html><body>502 Bad Gateway</body></html>')).toBe('PERMISSION')
  })

  it('★ 业务码优先于边缘判据（处置各不相同，不能被形态抢走）', () => {
    // 业务码装在任何形态里都要先命中 —— 它们的处置与「边缘拦截」完全不同。
    expect(httpErrorCodeForZcode(429, '{"code":1005,"msg":"exceed quota limit"}')).toBe('QUOTA_EXCEEDED')
    expect(httpErrorCodeForZcode(405, '{"code":3012,"msg":"unusual activity"}')).toBe('PERMISSION')
    expect(httpErrorCodeForZcode(429, '{"code":3009}')).toBe('RATE_LIMIT')
    expect(httpErrorCodeForZcode(401, '{"code":1002}')).toBe('AUTH')
  })

  it('★ 未变的行为：普通 5xx 仍可重试、400 仍是 INVALID_REQUEST', () => {
    // 这两条是「别把判据放太宽」的看守：真正的暂时性故障必须还能重试。
    expect(httpErrorCodeForZcode(503, 'service unavailable')).toBe('SERVER')
    expect(httpErrorCodeForZcode(400, 'bad request')).toBe('INVALID_REQUEST')
    expect(httpErrorCodeForZcode(429, 'slow down')).toBe('RATE_LIMIT')
  })
})

describe('describeUpstreamError 对边缘页给可读文案', () => {
  it('★ 真实 ESA 405 页必须翻成人话，不得倒原始 HTML（用户报障现场，2026-10-06）', () => {
    const text = describeUpstreamError(405, REAL_EDGE_405)
    // 说清三件事：是边缘层、不是账号/额度问题、该做什么。
    expect(text).toContain('边缘')
    expect(text).toContain('405')
    expect(text).toMatch(/没有到达业务层|未到达业务层/)
    expect(text).toMatch(/不是账号|无关/)
    // 🔴 修复前这里返回 `HTTP 405：<!doctypehtml>…` 整页 HTML —— 用户看到的乱码。
    // 证据窗只截 80 字符 ⇒ 页面深处的 `<style>` / `data-spm`（>80 字符处）不得出现。
    expect(text).not.toContain('<style')
    expect(text).not.toContain('data-spm')
    // 仍保留一小段原始响应作证据（可复核），但必须截断。
    expect(text).toContain('原始响应')
    expect(text.length).toBeLessThan(400)
  })

  it('★ 业务码仍优先于边缘文案（码与形态同现时按码报，与映射函数同序）', () => {
    expect(describeUpstreamError(405, '{"code":3012,"msg":"blocked"}')).toContain('风控')
    expect(describeUpstreamError(405, '{"code":1005,"msg":"exceed quota limit"}')).toContain('额度用尽')
    // 非 JSON 的普通错误体（不是边缘页）不受影响。
    expect(describeUpstreamError(500, 'upstream exploded')).toContain('500')
  })
})
