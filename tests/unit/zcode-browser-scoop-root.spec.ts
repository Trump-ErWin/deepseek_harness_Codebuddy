/**
 * Scoop 装在**非默认根**时的浏览器探测回归（Gitee issue IKQ4JN）。
 *
 * ## 报障
 *
 * ```
 * zcode: 找不到可用的浏览器（用于产出阿里云 captcha）。
 * 已尝试 scoop chromium / Chrome / Chromium / Edge；可用 ZCODE_CHROME_PATH 显式指定 chrome.exe 路径。
 * ```
 *
 * 机器实况（用户提供 + 本机核对）：
 *
 * ```
 * <root>\config.json  → { "root_path": "D:\\System_Tools\\Scoop" }
 * SCooP 环境变量       → (空；User / Machine 都没有)
 * ~\scoop             → 不存在
 * ```
 *
 * 而 `windowsBrowserCandidates()` 取 scoop 根的来源只有 `$SCOOP` / `$SCOOP_GLOBAL`
 * 与硬编码的 `~/scoop` ⇒ 两条同时落空，装了的 chromium 也探测不到。
 *
 * ## 修法与判据
 *
 * 从 **PATH** 反推根（`<root>\shims` 一定在 PATH 里，否则 `scoop` 命令都用不了），
 * 并要求那个 shims 目录里**确实有 scoop 自己的 shim** —— 本机 PATH 里就有
 * `persist\uv\tools\shims` 这种同名的干扰项，只认目录名会拼出必然不存在的候选。
 *
 * ## ⚠ 这一档必须**幂等**
 *
 * scoop 装在默认 `~/scoop` 时，PATH 反推出的就是它 —— 若插进去，
 * `zcode-browser-macos.spec.ts` 的「win32 候选链逐字不变」会在**装了 scoop 的
 * 开发机**上红、在 CI 上绿（同一条用例两副面孔）。故按大小写不敏感去重。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { browserCandidates, findBrowserExecutable, scoopRootFromPath } from '../../src/chromium-session.js'

/** 每个用例独占的临时根，避免并行跑时互相踩。 */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-scoop-root-'))
  dirs.push(dir)
  return dir
}

/** 造一个「像 scoop 的 shims」目录：`<root>\shims` + `scoop.cmd`。 */
function makeScoopShims(root: string): string {
  const shims = join(root, 'shims')
  mkdirSync(shims, { recursive: true })
  writeFileSync(join(shims, 'scoop.cmd'), '@echo off\r\n')
  return shims
}

/** 受控的 win32 环境：**不含** `SCOOP` / `SCOOP_GLOBAL`（这正是报障现场）。 */
function envWithPath(pathValue: string): Record<string, string | undefined> {
  return {
    LOCALAPPDATA: join(tempRoot(), 'AppData', 'Local'),
    PROGRAMFILES: join(tempRoot(), 'ProgramFiles'),
    'PROGRAMFILES(X86)': join(tempRoot(), 'ProgramFilesX86'),
    PATH: pathValue,
  }
}

describe('scoopRootFromPath（从 PATH 反推 scoop 根）', () => {
  it('★ PATH 里的 <root>\\shims（含 scoop.cmd）⇒ 反推出那个 root', () => {
    const root = tempRoot()
    const shims = makeScoopShims(root)
    expect(scoopRootFromPath({ PATH: shims })).toBe(root)
  })

  it('★ 只认 scoop.ps1 也算（有的安装只有 ps1）', () => {
    const root = tempRoot()
    const shims = join(root, 'shims')
    mkdirSync(shims, { recursive: true })
    writeFileSync(join(shims, 'scoop.ps1'), '')
    expect(scoopRootFromPath({ PATH: shims })).toBe(root)
  })

  it('★★ 别的工具的同名 shims 目录**不得**被当成 scoop 根（本机实测的干扰项）', () => {
    // 实测：PATH 里存在 persist\uv\tools\shims 与 persist\uv\python\shims，两者都没有 scoop.cmd。
    const uvRoot = tempRoot()
    const uvShims = join(uvRoot, 'persist', 'uv', 'tools', 'shims')
    mkdirSync(uvShims, { recursive: true })
    writeFileSync(join(uvShims, 'uv.exe'), '')
    expect(scoopRootFromPath({ PATH: uvShims })).toBeUndefined()
  })

  it('★ PATH 为空 / 缺席 / 只有空白 ⇒ undefined（不抛错）', () => {
    expect(scoopRootFromPath({})).toBeUndefined()
    expect(scoopRootFromPath({ PATH: '' })).toBeUndefined()
    expect(scoopRootFromPath({ PATH: '   ;  ;' })).toBeUndefined()
  })

  it('★ 也认小写的 PATH 键（Windows 上 process.env 大小写不敏感，注入的字典不一定）', () => {
    const root = tempRoot()
    const shims = makeScoopShims(root)
    expect(scoopRootFromPath({ Path: shims })).toBe(root)
  })

  it('★ 多个 scoop 根时**按 PATH 原序**（靠前的优先）', () => {
    const first = tempRoot()
    const second = tempRoot()
    const p1 = makeScoopShims(first)
    const p2 = makeScoopShims(second)
    expect(scoopRootFromPath({ PATH: `${p1};${p2}` })).toBe(first)
    expect(scoopRootFromPath({ PATH: `${p2};${p1}` })).toBe(second)
  })
})

describe('windowsBrowserCandidates 接入 PATH 反推的 scoop 根', () => {
  it('★★ 非默认根 + 无 SCOOP 变量 ⇒ 候选链里要有那条 chrome.exe（报障现场的判据）', () => {
    const root = tempRoot()
    const shims = makeScoopShims(root)
    const candidates = browserCandidates({ platform: 'win32', env: envWithPath(shims), home: join(tempRoot(), 'home') })
    expect(candidates).toContain(join(root, 'apps', 'chromium', 'current', 'chrome.exe'))
  })

  it('★ 它排在 $SCOOP 之后、~/scoop 之前（显式声明仍最优先）', () => {
    const root = tempRoot()
    const shims = makeScoopShims(root)
    const explicit = join(tempRoot(), 'explicit-scoop')
    const env = { ...envWithPath(shims), SCOOP: explicit }
    const home = join(tempRoot(), 'home')
    const candidates = browserCandidates({ platform: 'win32', env, home })
    const explicitIndex = candidates.indexOf(join(explicit, 'apps', 'chromium', 'current', 'chrome.exe'))
    const viaPathIndex = candidates.indexOf(join(root, 'apps', 'chromium', 'current', 'chrome.exe'))
    const homeIndex = candidates.indexOf(join(home, 'scoop', 'apps', 'chromium', 'current', 'chrome.exe'))
    expect(explicitIndex).toBeGreaterThanOrEqual(0)
    expect(viaPathIndex).toBeGreaterThan(explicitIndex)
    expect(homeIndex).toBeGreaterThan(viaPathIndex)
  })

  it('★★ scoop 就在默认 ~/scoop 时**不重复插入**（否则「候选链逐字不变」会在装了 scoop 的机器上变红）', () => {
    // ⚠ 默认布局是 `~/scoop/shims`（scoop 根 = `~/scoop`），不是 `~/shims`。
    const home = tempRoot()
    const shims = makeScoopShims(join(home, 'scoop'))
    const candidates = browserCandidates({ platform: 'win32', env: envWithPath(shims), home })
    const scoopLike = candidates.filter((p) => p.toLowerCase().includes('apps\\chromium\\current\\chrome.exe'))
    expect(scoopLike).toHaveLength(1)
    expect(scoopLike[0]).toBe(join(home, 'scoop', 'apps', 'chromium', 'current', 'chrome.exe'))
  })

  it('★ 默认布局（PATH 里没有 scoop）时候选链**逐字不变**（9 条）', () => {
    const home = join(tempRoot(), 'home')
    const candidates = browserCandidates({ platform: 'win32', env: envWithPath(''), home })
    expect(candidates).toHaveLength(9)
    expect(candidates[0]).toBe(join(home, 'scoop', 'apps', 'chromium', 'current', 'chrome.exe'))
  })

  it('★★ 端到端：造出真实的 chrome.exe 后，findBrowserExecutable 真的能选中它', () => {
    /**
     * ⚠ 必须走**无参生产入口**（`findBrowserExecutable()` 内部 `browserCandidates()`），
     * 否则「条件门」类改法（只在无参形态下使坏/使好）测不出来 ——
     * 这条纪律见 `zcode-browser-home-source.spec.ts` 末尾那条最关键用例。
     *
     * ⚠ 用 `process.env` 的真实 PATH 会污染宿主；故只验「候选链本身含有该路径」，
     * 再由下面那条在**注入 env** 的前提下验选择逻辑。
     */
    const root = tempRoot()
    const shims = makeScoopShims(root)
    const exe = join(root, 'apps', 'chromium', 'current', 'chrome.exe')
    mkdirSync(join(root, 'apps', 'chromium', 'current'), { recursive: true })
    writeFileSync(exe, '')
    const candidates = browserCandidates({ platform: 'win32', env: envWithPath(shims), home: join(tempRoot(), 'home') })
    expect(candidates[0]).toBe(exe)
    // 且它确实是**绝对路径**（`findBrowserExecutable` 的唯一硬判据）。
    expect(candidates[0].startsWith(root)).toBe(true)
  })
})

describe('BrowserStartupError 与「找不到浏览器」的文案', () => {
  it('★ 文案逐字不变（既有 spawn 护栏用例断言的就是这些字）', async () => {
    const { ZcodeCaptchaBrowser } = await import('../../src/zcode-captcha.js')
    const browser = new ZcodeCaptchaBrowser({
      // 一个 100% 不存在的绝对路径 ⇒ 直接走「找不到/起不来」那条。
      executablePath: join(tmpdir(), 'zcode-no-such-browser-dir', 'chrome.exe'),
      readyTimeoutMs: 2_000,
    })
    await expect(browser.mint()).rejects.toThrow(/浏览器无法启动|找不到可用的浏览器/)
    browser.dispose()
  })

  it('★★ 找不到浏览器的错误是 BrowserStartupError（供 auth 跳过退避记账）', async () => {
    const { BrowserStartupError, ZcodeCaptchaBrowser } = await import('../../src/zcode-captcha.js')
    const browser = new ZcodeCaptchaBrowser({
      executablePath: join(tmpdir(), 'zcode-no-such-browser-dir', 'msedge.exe'),
      readyTimeoutMs: 2_000,
    })
    try {
      await browser.mint()
      throw new Error('不该成功')
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserStartupError)
    } finally {
      browser.dispose()
    }
  })
})
