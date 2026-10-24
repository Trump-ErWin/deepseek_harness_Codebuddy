/**
 * `plugin-src/client/error-boundary.js` 的行为守卫（PR #10）。
 *
 * ## 为什么这条必须有（背景事故）
 *
 * 2026-10-22 真实报障：「魔塔社区的令牌我一保存，页面直接清空，切换页面无效，
 * 只能重启 dsh」。直接原因是 `probeNotice` 被写成裸字符串（渲染端读
 * `.details.length` 抛 TypeError，源头修在 `notice-shape.js`）；
 * 但用户症状那么重是因为**本插件没有任何错误边界** —— React 18 默认行为是
 * 「渲染期抛错 ⇒ 卸载整棵树」，而 `JetHubPage` 被直接注册进 `settings.section`，
 * 于是整个设置页（连同侧栏）消失。
 *
 * ⇒ `error-boundary.js` 是「影响半径」那一半修复，本文件锁它真的在拦。
 *
 * ## 为什么可以真跑（与同目录其它客户端守卫不同）
 *
 * 其它客户端模块（`jet-hub.js` / `panel-entry.js`）import 了宿主注入的 `react`
 * external，vitest 里 import 不到，只能做源码文本断言。而 `error-boundary.js`
 * **只** import `react`，没有任何宿主符号依赖 ⇒ 可以用替身 `react` 注入后真跑。
 *
 * ⚠️ 替身必须实现 `React.Component` 的**最小语义**：`constructor(props)` 里
 * 建 `this.state`、`setState`、`render`。React 的错误边界契约本身是
 * 「`getDerivedStateFromError` 返回的新 state 合并进 `this.state` 后重新
 * `render()`」，替身按这个契约实现就能验证真实语义。
 */
import { describe, expect, it, vi } from 'vitest'

/**
 * 最小 React 替身：只实现本文件需要的 class 组件 + `createElement`。
 *
 * `createElement` 返回一个**惰性描述对象**而不是立刻调用组件 —— 这样测试可以
 * 先构造树、再自己决定「渲染」谁，与真实 React 的两阶段一致。
 */
function makeFakeReact() {
  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(partial) {
      const next = typeof partial === 'function' ? partial(this.state) : partial
      this.state = { ...this.state, ...next }
    }
  }

  /** 标记：这是替身产出的元素描述（不是真 DOM）。 */
  const ELEMENT = Symbol('fake-element')

  const createElement = (type, props, ...children) => ({
    [ELEMENT]: true,
    type,
    // ⚠️ children 必须**独立**于 props 的空值判断：被测源码大量使用
    //    `createElement('div', null, text)` 这种「无属性但有子节点」的写法，
    //    第一版把 `props == null` 直接返回 `{}` ⇒ children 被整段丢弃，
    //    fallback 的提示行静默消失（4 条用例假红）。
    props: {
      ...(props === null || props === undefined ? {} : props),
      children: children.length > 0 ? children : undefined,
    },
  })

  return { React: { Component, createElement }, ELEMENT }
}

/**
 * 按 React 的语义「渲染」一个元素描述：class 组件实例化 + 调用 render；
 * 函数组件直接调用。遇到抛错就原样抛出（由调用方决定这是不是预期的）。
 */
function renderElement(element) {
  if (element === null || element === undefined) return null
  if (typeof element === 'string' || typeof element === 'number') return element
  const { type, props } = element
  if (typeof type === 'function') {
    // class 组件：原型上有 render。
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new type(props)
      // React 在首次 render 前不调 getDerivedStateFromError；这里只是普通渲染。
      return instance.render()
    }
    return type(props)
  }
  // 宿主元素（div/svg…）：返回描述本身，测试只看结构。
  return element
}

/**
 * 载入被测模块，并把它内部的 `import * as React from 'react'` 换成替身。
 *
 * ⚠️ 用 `vi.mock` 而不是改源码：源码是产物的一部分，改它就等于测了别的东西。
 */
async function loadWithFakeReact() {
  const { React, ELEMENT } = makeFakeReact()
  vi.resetModules()
  vi.doMock('react', () => ({ ...React, default: React }))
  const mod = await import('../../plugin-src/client/error-boundary.js')
  return { ...mod, React, ELEMENT }
}

/**
 * 递归把一棵替身元素树里的**全部文本**收集成字符串。
 *
 * ⚠️ 替身的 `createElement` 把 children 放在 `props.children`（与真 React 一致），
 * 而文本既可能是 `props.children` 里的裸字符串，也可能嵌在子元素里 ⇒ 必须递归，
 * 不能只取一层（第一版只取一层，导致「错误原文」与 label 的断言全部假红）。
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && node.props) {
    collectText(node.props.children, out)
  }
  return out
}

describe('withErrorBoundary', () => {
  it('正常时原样渲染被保护的组件（不吞掉正常输出）', async () => {
    const { withErrorBoundary } = await loadWithFakeReact()

    const Inner = (props) => ({ marker: 'inner-ok', props })
    const Guarded = withErrorBoundary(Inner, { label: '测试面板' })

    // 首次渲染：getDerivedStateFromError 未被触发 ⇒ 直接透传。
    const instance = new Guarded({ rpcCall: 'x' })
    expect(instance.state.error).toBeNull()
    // ⚠️ `render()` 返回的是**元素描述**（`createElement` 是惰性的），必须再展开
    //    一层才拿到函数组件的返回值 —— 直接读 `out.marker` 会是 undefined。
    const out = renderElement(instance.render())
    expect(out.marker).toBe('inner-ok')
    expect(out.props).toEqual({ rpcCall: 'x', children: undefined })
  })

  it('★★ 渲染期抛错时**不向外抛**，而是返回一块报错面板（核心契约）', async () => {
    const { withErrorBoundary } = await loadWithFakeReact()

    const Boom = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'length')")
    }
    const Guarded = withErrorBoundary(Boom, { label: 'Jet Hub 设置页' })

    const instance = new Guarded({})

    // ① 契约入口：静态方法把 error 落进 state（React 就是这么调它的）。
    const derived = Guarded.getDerivedStateFromError(new TypeError('boom'))
    expect(derived).toHaveProperty('error')

    // ② 真实流程：渲染抛错 → React 调 getDerivedStateFromError → 再 render。
    //    这里手工模拟该流程，验证「第二次 render 不再抛，且给出 fallback」。
    //    ⚠️ 必须经 `renderElement` 展开：`render()` 只产出元素描述，真正调用
    //       `Boom` 发生在展开时（第一版直接 `instance.render()` ⇒ 收到 null，
    //       用例变成「恒不抛」，等于测不到边界）。
    let thrown = null
    try {
      renderElement(instance.render())
    } catch (caught) {
      thrown = caught
    }
    expect(thrown, '被测组件本身应当抛错（否则本用例测不到边界）').toBeInstanceOf(TypeError)

    instance.setState(Guarded.getDerivedStateFromError(thrown))
    const fallback = instance.render()
    expect(fallback, '边界没有产出 fallback 元素').not.toBeNull()
    expect(fallback.props['data-tone']).toBe('error')
    expect(fallback.props.role).toBe('alert')
  })

  it('★★ fallback 必须显示错误原文（本次事故的可诊断性）', async () => {
    const { withErrorBoundary } = await loadWithFakeReact()

    const Boom = () => {
      throw new TypeError('boom-detail-42')
    }
    const Guarded = withErrorBoundary(Boom, { label: 'Jet Hub 面板' })
    const instance = new Guarded({})
    instance.setState(Guarded.getDerivedStateFromError(new TypeError('boom-detail-42')))
    const fallback = instance.render()

    const flat = collectText(fallback).join(' | ')
    expect(flat, 'fallback 里没有露出错误原文 —— 用户将无法提供任何线索')
      .toContain('boom-detail-42')
  })

  it('⚠️ label 进 fallback 文案，且两个入口用不同 label 才分得清哪块坏了', async () => {
    const { withErrorBoundary } = await loadWithFakeReact()

    const Boom = () => {
      throw new Error('x')
    }
    const a = withErrorBoundary(Boom, { label: 'Jet Hub 设置页' })
    const b = withErrorBoundary(Boom, { label: 'Jet Hub 面板' })

    const renderFallback = (Guarded) => {
      const inst = new Guarded({})
      inst.setState(Guarded.getDerivedStateFromError(new Error('x')))
      return collectText(inst.render()).join(' | ')
    }

    expect(renderFallback(a)).toContain('Jet Hub 设置页')
    expect(renderFallback(b)).toContain('Jet Hub 面板')
    expect(renderFallback(a)).not.toBe(renderFallback(b))
  })

  it('缺 label 时有默认文案（不出现 "undefined 渲染失败"）', async () => {
    const { withErrorBoundary } = await loadWithFakeReact()
    const Boom = () => {
      throw new Error('x')
    }
    const Guarded = withErrorBoundary(Boom)
    const inst = new Guarded({})
    inst.setState(Guarded.getDerivedStateFromError(new Error('x')))
    const serialized = collectText(inst.render()).join(' | ')
    expect(serialized).not.toContain('undefined')
    expect(serialized).toContain('这个面板')
  })

  it('⚠️ componentDidCatch 只打日志、不向上抛（向上抛会让宿主再卸一次树）', async () => {
    const { withErrorBoundary } = await loadWithFakeReact()
    const Boom = () => {
      throw new Error('x')
    }
    const Guarded = withErrorBoundary(Boom, { label: '测试' })
    const inst = new Guarded({})

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => inst.componentDidCatch(new Error('boom'), { componentStack: 'at Boom' }))
        .not.toThrow()
      expect(spy, 'componentDidCatch 没有打日志 —— 线上将零线索').toHaveBeenCalled()
      const logged = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
      expect(logged, '日志里没有 componentStack').toContain('at Boom')
    } finally {
      spy.mockRestore()
    }
  })

  it('⚠️ 组件身份稳定：同一 label 两次调用产出**不同**类（各槽位必须各自持有常量）', async () => {
    const { withErrorBoundary } = await loadWithFakeReact()
    const Boom = () => null
    const A = withErrorBoundary(Boom, { label: 'L' })
    const B = withErrorBoundary(Boom, { label: 'L' })
    // 工厂每次都新建类 ⇒ 调用方**必须**在模块级持有常量，否则每次 render
    // 都换一个组件类型，React 会卸载重挂整棵子树（状态全丢）。
    expect(A).not.toBe(B)
  })

  it('displayName 可辨认（调试面板里能看出是哪一层的边界）', async () => {
    const { withErrorBoundary } = await loadWithFakeReact()
    const Named = () => null
    Named.displayName = 'NamedInner'
    const Guarded = withErrorBoundary(Named)
    expect(Guarded.displayName).toContain('withErrorBoundary')
    expect(Guarded.displayName).toContain('NamedInner')
  })
})
