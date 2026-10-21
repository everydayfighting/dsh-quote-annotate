// dsh-quote-annotate —— Client 半区（浏览器）
// 静态化自动态插件 quote-1/pkg-19（选区引用与锚点批注 v19）
window.__ModuleLoader__.load({
  id: 'dsh-quote-annotate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let React = require('react')

    // ============ 模块级状态 ============
    let rootCtx = null
    let currentSessionId = null
    let refSeq = 0
    let pipelineAvailable = null // null=未知 false=不可用 true=可用
    // ref -> { sessionId, anchorKey, body, label } 用于点击 chip 跳回原文 / 悬停显示原文
    const refTargets = new Map()
    // ref -> { body, clipboardText } 提交时经 codec 序列化
    const refCodecs = new Map()

    // 页面内反馈 toast（点击 chip 时显示结果）
    const toastStore = {
      text: '',
      pos: null, // { left, top }
      ok: false,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(text, pos, ok) {
        this.text = text
        this.pos = pos
        this.ok = !!ok
        this.emit()
      },
      hide() {
        if (!this.text) return
        this.text = ''
        this.pos = null
        this.emit()
      },
    }

    function useToast() {
      const [, force] = React.useState(0)
      React.useEffect(() => toastStore.subscribe(() => force((v) => v + 1)), [])
      return toastStore
    }

    // ============ 选区浮动小气泡 store ============
    const selectionStore = {
      visible: false,
      text: '',
      rect: null,
      anchorKey: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(info) {
        this.visible = true
        this.text = info.text
        this.rect = info.rect
        this.anchorKey = info.anchorKey || null
        this.emit()
      },
      hide() {
        if (!this.visible) return
        this.visible = false
        this.emit()
      },
    }

    function useSelection() {
      const [, force] = React.useState(0)
      React.useEffect(() => selectionStore.subscribe(() => force((v) => v + 1)), [])
      return selectionStore
    }

    // ============ 悬浮批注编辑框 store（单条，锚定在对应文字附近） ============
    const editorStore = {
      item: null, // { sessionId, label, text, anchorKey }
      rect: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      open(item, rect) {
        this.item = item
        this.rect = rect
        this.emit()
      },
      close() {
        if (!this.item) return
        this.item = null
        this.rect = null
        this.emit()
      },
    }

    function useEditor() {
      const [, force] = React.useState(0)
      React.useEffect(() => editorStore.subscribe(() => force((v) => v + 1)), [])
      return editorStore
    }

    // ============ 引用悬停提示 store ============
    const tooltipStore = {
      visible: false,
      text: '',
      label: '',
      rect: null,
      ref: null,
      sessionId: null,
      holding: false, // 鼠标移入提示框时置真，避免移向 ✕ 的途中提示消失
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      hold(value) {
        this.holding = !!value
        this.emit()
      },
      show(info) {
        this.visible = true
        this.text = info.text
        this.label = info.label
        this.rect = info.rect
        this.ref = info.ref || null
        this.sessionId = info.sessionId || null
        this.emit()
      },
      hide() {
        if (this.holding) return
        if (!this.visible) return
        this.visible = false
        this.emit()
      },
    }

    // ============ chip 悬停 store（供 chip 右上角 ✕ 浮层定位） ============
    const chipHoverStore = {
      ref: null,
      sessionId: null,
      label: '',
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(info) {
        this.ref = info.ref || null
        this.sessionId = info.sessionId || null
        this.label = info.label || ''
        this.emit()
      },
      hide() {
        if (this.ref === null) return
        this.ref = null
        this.sessionId = null
        this.label = ''
        this.emit()
      },
    }

    function useChipHover() {
      const [, force] = React.useState(0)
      React.useEffect(() => chipHoverStore.subscribe(() => force((v) => v + 1)), [])
      return chipHoverStore
    }

    function useTooltip() {
      const [, force] = React.useState(0)
      React.useEffect(() => tooltipStore.subscribe(() => force((v) => v + 1)), [])
      return tooltipStore
    }

    // ============ 样式注入（静态包环境：直接操作 document） ============
    function insertStyleSheet(css) {
      const tag = document.createElement('style')
      tag.textContent = css
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // ============ 文本工具 ============
    function textBlocksToText(blocks, kindField, typeValue) {
      const parts = []
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b && b[kindField] === typeValue && typeof b.text === 'string' && b.text.trim() !== '') {
            parts.push(b.text.trim())
          }
        }
      }
      return parts.join('\n\n')
    }

    function clipText(text, max) {
      if (text.length <= max) return text
      return text.slice(0, max) + '\n…（已截断）'
    }

    const MAX_QUOTE = 1500
    const MAX_SELECTION = 2000

    // 从快照中提取某一轮的用户提问文本与最终 AI 回答文本
    function extractTurnTexts(snapshot, turnLoc) {
      const turn = turnLoc.turn
      const endSeq = turnLoc.end ? turnLoc.end.seq : Number.POSITIVE_INFINITY
      let prevEnd = 0
      if (snapshot.turnEnds) {
        snapshot.turnEnds.forEach((seq, t) => {
          if (typeof t === 'number' && t < turn && seq > prevEnd) prevEnd = seq
        })
      }
      const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : []
      const userParts = []
      let assistantText = ''
      let assistantSeq = -1
      for (const n of nodes) {
        if (!n || typeof n.seq !== 'number') continue
        if (n.seq <= prevEnd || n.seq > endSeq) continue
        if (n.kind === 'user' || n.kind === 'steering') {
          const text = textBlocksToText(n.content, 'type', 'text')
          if (text !== '') userParts.push(text)
        } else if (n.kind === 'assistant' && n.turn === turn && n.seq > assistantSeq) {
          assistantSeq = n.seq
          const text = textBlocksToText(n.blocks, 'kind', 'text')
          if (text !== '') assistantText = text
        }
      }
      return { userText: userParts.join('\n\n'), assistantText }
    }

    // 解析某一轮里指定类型消息行的 DOM 锚点 key（data-chat-anchor-key）
    function anchorKeyFor(snapshot, turn, kind, closingSeq) {
      try {
        if (!snapshot || !snapshot.chat || !snapshot.chat.locations || !snapshot.chat.nodes) return null
        const keys = snapshot.chat.locations.getTurn(turn) || []
        const nodes = snapshot.chat.nodes
        let fallback = null
        for (const key of keys) {
          const node = nodes.get(key)
          if (!node || node.kind !== kind) continue
          fallback = key
          if (kind === 'user') return key
          if (kind === 'assistant' && typeof closingSeq === 'number' && node.anchorSeq === closingSeq) return key
        }
        return fallback
      } catch (e) {
        return null
      }
    }

    // 按 occurrenceId 解析引用（chip 点击跳转 / 悬停提示共用）
    function resolveOccurrence(occId) {
      try {
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        if (!conversation || !conversation.input || !sessions) return null
        const trySession = (sessionId) => {
          if (!sessionId) return null
          const binding = sessions.binding(sessionId)
          if (!binding) return null
          const input = conversation.input.for(binding.ctx)
          const occurrences = input.state.getSnapshot().occurrences || []
          return occurrences.find((o) => o.occurrenceId === occId) || null
        }
        let occ = trySession(currentSessionId)
        if (!occ) {
          for (const refKey of refTargets.keys()) {
            const info = refTargets.get(refKey)
            if (!info || !info.sessionId) continue
            occ = trySession(info.sessionId)
            if (occ) break
          }
        }
        if (!occ || occ.source !== 'quote-ref') return null
        return { occ, info: refTargets.get(occ.ref) }
      } catch (e) {
        return null
      }
    }

    // ============ 链条目选择器：仅在已结束且无交付文件的回合挂载 ============
    function selectTurnQuote(owner) {
      if (!owner || !owner.turn || !owner.turn.end) return null
      const delivered = owner.turn.data ? owner.turn.data.get('deliverables') : undefined
      if (delivered && Array.isArray(delivered.produced) && delivered.produced.length > 0) return null
      return { turn: owner.turn.turn }
    }

    function rectOf(e) {
      try {
        const r = e.currentTarget.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      } catch (err) {
        return null
      }
    }

    // ============ 组件一：回合尾部的引用按钮（点击直接打开悬浮编辑框） ============
    const TurnQuoteActions = (props) => {
      // 修复(2026-10-16)：本插槽声明为 scope:"session" 的列表槽，宿主会注入会话上下文
      // （props.sessionId / props.useSession），这里顺手缓存当前会话 id，
      // 供全局的 shell.overlay 气泡使用。
      if (props.sessionId) currentSessionId = props.sessionId
      const snapshot = props.useSession((s) => s)
      const texts = React.useMemo(() => extractTurnTexts(snapshot, props.turn), [snapshot, props.turn])
      const open = (e, role, label, text) => {
        const anchorKey = anchorKeyFor(snapshot, props.turn.turn, role, props.seq)
        editorStore.open({ sessionId: props.sessionId, label, text, anchorKey }, rectOf(e))
      }
      const buttons = []
      if (texts.userText) {
        buttons.push(React.createElement('button', {
          key: 'user',
          type: 'button',
          className: 'dshq-btn',
          onClick: (e) => open(e, 'user', '引用提问 · 第 ' + (props.turn.turn + 1) + ' 轮', clipText(texts.userText, MAX_QUOTE)),
        }, '引用提问'))
      }
      if (texts.assistantText) {
        buttons.push(React.createElement('button', {
          key: 'assistant',
          type: 'button',
          className: 'dshq-btn',
          onClick: (e) => open(e, 'assistant', '引用回答 · 第 ' + (props.turn.turn + 1) + ' 轮', clipText(texts.assistantText, MAX_QUOTE)),
        }, '引用回答'))
      }
      if (buttons.length === 0) return null
      return React.createElement('div', { className: 'dshq-tail' }, buttons)
    }

    // ============ 组件二：鼠标选区浮动小气泡（点击「批注」打开悬浮编辑框） ============
    const SelectionToolbar = (props) => {
      const sel = useSelection()
      // 修复(2026-10-16)：shell.overlay 是「全局」插槽，宿主以空 props 渲染它
      // （ui-layout: renderSlot("shell.overlay", {})），条目拿不到 useSessions/sessionId。
      // 上游实现只认 props.useSessions → current 恒为 undefined → stage() 里 if (current)
      // 不成立 → 点「批注」只把气泡关掉，什么都不发生（无提示、无日志）。
      // 现按 overlay 钩子 → 作用域 props.sessionId → 会话作用域插槽缓存值 依次回退。
      const fromOverlay = typeof props.useSessions === 'function' ? props.useSessions((s) => s.current) : undefined
      const current = fromOverlay !== undefined ? fromOverlay : (props.sessionId || currentSessionId || undefined)
      if (current !== undefined) currentSessionId = current
      if (!sel.visible || !sel.rect) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      // 修改(2026-10-16)：去掉原文预览后只留【复制】+【批注】。
      // 宽度不再写死：CSS 已用 width:max-content（且取消 min-width），
      // 这里只按内容估一个宽度用于水平居中（约三个元素 + 内边距）。
      // 2026-10-21：【添加到对话】比原【批注】宽（5 字），估算宽度同步调大
      const est = 190
      const center = sel.rect.left + (sel.rect.right - sel.rect.left) / 2
      const left = Math.max(12, Math.min(center - est / 2, vw - est - 12))
      const top = sel.rect.top - 42 >= 8 ? sel.rect.top - 42 : sel.rect.bottom + 8
      const finish = () => {
        try {
          const s = window.getSelection()
          if (s && s.removeAllRanges) s.removeAllRanges()
        } catch (e) { /* ignore */ }
        selectionStore.hide()
      }
      const stage = () => {
        // 交互调整：点「批注」直接把引用写进底部输入框并聚焦，不再弹浮动编辑框
        insertQuoteDirect(props, sel)
        finish()
      }
      const copySel = () => {
        const text = clipText(sel.text, MAX_SELECTION)
        // 2026-10-16 用户确认（方案 2C + 文案）：点【复制】→ 气泡立即消失（清选区）→
        // 静默写剪贴板 → 成功后在【远离被复制文字】的位置（屏幕顶部居中，pos=null）
        // 提示「已复制到剪贴板 ✓」；失败才在同位置报错。
        finish()
        const fail = (msg) => { try { popToast(msg, null, false) } catch (e) { /* ignore */ } }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
              try { popToast('已复制到剪贴板 ✓', null, true) } catch (e) { /* ignore */ }
            }, () => fail('复制失败：浏览器拒绝了剪贴板权限'))
            return
          }
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.cssText = 'position:fixed;left:-9999px;top:0'
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
          popToast('已复制到剪贴板 ✓', null, true)
        } catch (e) {
          try { popToast('复制失败：' + (e && e.message ? e.message : String(e)), null, false) } catch (e2) { /* ignore */ }
        }
      }
      return React.createElement('div', { className: 'dshq-toolbar', style: { left, top } },
        // 2026-10-21：按钮文案调整 —— 原【批注】改为【添加到对话】（更直白地表达"写进输入框"）
        React.createElement('button', {
          type: 'button',
          className: 'dshq-btn dshq-bubble-copy dshq-pill',
          onMouseDown: (e) => e.preventDefault(),
          onClick: copySel,
        }, '复制'),
        React.createElement('button', {
          type: 'button',
          className: 'dshq-btn dshq-primary dshq-bubble-cta',
          onMouseDown: (e) => e.preventDefault(),
          onClick: stage,
        }, '添加到对话'),
      )
    }

    // ============ 组件三：悬浮批注编辑框（评论输入框元素永久驻留，复用时输入法上下文不重建） ============
    const AnnotationEditor = () => {
      const state = useEditor()
      const inputRef = React.useRef(null)
      const [comment, setComment] = React.useState('')
      const [status, setStatus] = React.useState(null)
      React.useEffect(() => {
        setComment('')
        setStatus(null)
        if (state.item && inputRef.current) {
          // 同一元素重复聚焦：输入法记住的语言模式得以保留
          inputRef.current.focus()
          // 修复(2026-10-16)：宿主在视图/标题渲染后还会移动焦点（实测 activeElement
          // 被 H2 标题抢走），一次聚焦会被覆盖 → 表现为"打开编辑框但光标不在评论框"。
          // 这里在随后的两拍再补两次聚焦；只有焦点仍在别处时才抢回。
          const again = () => {
            try {
              const el = inputRef.current
              if (!el) return
              if (document.activeElement === el) return
              el.focus()
            } catch (e) { /* ignore */ }
          }
          const t1 = setTimeout(again, 0)
          const t2 = setTimeout(again, 80)
          return () => { clearTimeout(t1); clearTimeout(t2) }
        }
      }, [state.item])
      const open = !!(state.item && state.rect)
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const item = state.item
      let left = -9999
      let top = -9999
      let w = 200
      if (open) {
        // 宽度：默认约 10 字（120px），随评论输入变宽，封顶 340px
        const quoteW = Math.min(220, item.text.length * 12 + 16)
        const inputW = Math.min(300, Math.max(140, comment.length * 13 + 44))
        w = Math.max(120, Math.min(340, Math.max(quoteW, inputW)))
        const center = state.rect.left + (state.rect.right - state.rect.left) / 2
        left = Math.max(12, Math.min(center - w / 2, vw - w - 12))
        const estH = 200
        top = state.rect.bottom + 8 + estH <= vh - 8 ? state.rect.bottom + 8 : Math.max(8, state.rect.top - estH - 8)
      }
      const insert = () => {
        if (!open || !item) return
        const res = insertQuoteIntoComposer({
          sessionId: item.sessionId,
          text: item.text,
          anchorKey: item.anchorKey,
          label: item.label,
          comment: (comment || '').trim(),
        })
        if (!res.ok) setStatus({ ok: false, text: res.message })
        else setStatus({ ok: true, text: res.message })
        editorStore.close()
      }
      const hint = pipelineAvailable === false ? '引用锚点管线不可用，将插入纯文本引用' : '插入后将生成引用锚点，点击输入框里的锚点可跳回原文'
      return React.createElement('div', {
        className: open ? 'dshq-editor' : 'dshq-editor dshq-editor-hidden',
        style: { left, top, width: w },
      },
        React.createElement('div', { className: 'dshq-editor-label' }, open ? item.label : ''),
        React.createElement('div', { className: 'dshq-editor-quote' }, open ? item.text : ''),
        React.createElement('input', {
          ref: inputRef,
          className: 'dshq-editor-input',
          value: comment,
          placeholder: '输入评论…',
          onChange: (e) => setComment(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') insert()
            if (e.key === 'Escape') editorStore.close()
          },
        }),
        status && open ? React.createElement('div', { className: status.ok ? 'dshq-editor-status dshq-ok' : 'dshq-editor-status dshq-err' }, status.text) : (open ? React.createElement('div', { className: 'dshq-editor-hint' }, hint) : null),
        React.createElement('div', { className: 'dshq-editor-actions' },
          React.createElement('button', { type: 'button', className: 'dshq-btn dshq-primary', onClick: insert }, '插入输入框'),
          React.createElement('button', { type: 'button', className: 'dshq-btn', onClick: () => editorStore.close() }, '✕'),
        ),
      )
    }

    // ============ 组件四：引用悬停提示（显示当时选中的文字） ============
    const QuoteTooltip = () => {
      const t = useTooltip()
      if (!t.visible || !t.rect) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const w = Math.min(340, Math.max(200, Math.min(t.text.length, 60) * 11 + 48))
      const estH = Math.min(200, 56 + Math.ceil(Math.min(t.text.length, 400) / 22) * 15)
      const center = t.rect.left + (t.rect.right - t.rect.left) / 2
      const left = Math.max(8, Math.min(center - w / 2, vw - w - 8))
      let top = t.rect.top - estH - 8
      if (top < 8) top = Math.min(vh - estH - 8, t.rect.bottom + 8)
      // 新增(2026-10-16 交互调整)：提示框只展示原文；删除 ✕ 移到 chip 自身右上角
      // （见 ChipDeleteButton）。放在提示框里的 ✕ 会随提示框一起消失，点不到。
      return React.createElement('div', {
        className: 'dshq-tip',
        style: { left, top, width: w },
        onMouseEnter: () => tooltipStore.hold(true),
        onMouseLeave: () => { tooltipStore.hold(false); tooltipStore.hide() },
      },
        React.createElement('div', { className: 'dshq-tip-label' }, t.label),
        React.createElement('div', { className: 'dshq-tip-quote' }, t.text),
      )
    }

    // ============ 组件六：chip 右上角的删除 ✕（2026-10-16 交互调整） ============
    // 说明：✕ 必须挂在 chip 自身，而不是悬停提示框里 —— 提示框在鼠标移开时就消失，
    // 放在那里的 ✕ 点不到。这里做一个 shell.overlay 浮层，用 rAF 实时把 ✕ 锚到
    // 当前悬停 chip 的右上角；只要鼠标仍在该 chip 上（含 ✕ 自身区域）就保持显示。
    const ChipDeleteButton = () => {
      const h = useChipHover()
      const [pos, setPos] = React.useState(null)
      React.useEffect(() => {
        if (!h.ref) { setPos(null); return undefined }
        let raf = 0
        let alive = true
        const tick = () => {
          if (!alive) return
          const chips = Array.from(document.querySelectorAll('[data-composer-chip="quote-ref"]'))
          let target = null
          for (const c of chips) {
            const labelEl = c.querySelector('[class*="_label"]')
            const txt = ((labelEl && labelEl.textContent) || c.textContent || '').replace(/^@/, '').trim()
            if (txt === h.label) { target = c; break }
          }
          if (!target) { setPos(null); raf = requestAnimationFrame(tick); return }
          const r = target.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) { setPos(null); raf = requestAnimationFrame(tick); return }
          // ✕ 落在 chip 右上角外侧（中心点外移，避免遮挡 chip 文字）
          setPos({ x: r.right - 3, y: r.top - 3, w: r.width })
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => { alive = false; cancelAnimationFrame(raf) }
      }, [h.ref, h.label])
      if (!h.ref || !pos) return null
      const remove = () => {
        const res = removeQuoteOccurrence(h.sessionId || currentSessionId, { ref: h.ref })
        chipHoverStore.hide()
        tooltipStore.hide()
        popToast(res && res.ok ? (res.message || '已删除引用') : ((res && res.message) || '删除失败'), null, !!(res && res.ok))
        if (res && res.ok) {
          refTargets.delete(h.ref)
          refCodecs.delete(h.ref)
        }
      }
      return React.createElement('button', {
        type: 'button',
        className: 'dshq-chip-x',
        title: '删除这条引用',
        style: { left: pos.x, top: pos.y },
        onMouseDown: (e) => e.preventDefault(),
        onClick: (e) => { e.preventDefault(); e.stopPropagation(); remove() },
      }, '✕')
    }

    // ============ 组件五：点击 chip 的反馈 toast（shell.overlay 条目） ============
    const FeedbackToast = () => {
      const t = useToast()
      if (!t.text || !t.pos) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const left = Math.max(12, Math.min(t.pos.left - 80, vw - 180))
      return React.createElement('div', {
        className: t.ok ? 'dshq-toast dshq-toast-ok' : 'dshq-toast dshq-toast-err',
        style: { left, top: t.pos.top + 18 },
      }, t.text)
    }

    // ============ 样式（主题令牌自适应明暗） ============
    const css = `
.dshq-tail{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;margin-left:2px}
/* 2026-10-16 样式调整：两个按钮文字色统一为主题主文字色；
   （1F）显式字体栈，不再依赖继承链。 */
.dshq-btn{appearance:none;background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-primary);font-family:var(--dsw-alias-font-ui, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);font-size:12px;line-height:1.4;padding:2px 8px;border-radius:6px;cursor:pointer;transition:background .12s ease,color .12s ease}
.dshq-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
/* 2026-10-16 样式调整：【批注】原来是品牌色实心底 + 白字，与旁边
   透明底的【复制】并排显得一深一浅很突兀。现在统一为"描边按钮"风格：
   透明底 + 主题边框 + 主题文字，主次靠边框深浅与文字色区分，跟随主题。
   2026-10-16 样式统一：两个按钮平时都是"纯文字"，鼠标悬停才浮出
   矩形 → 取消常驻描边，与【复制】保持一致。 */
.dshq-primary{background:transparent;border-color:transparent;color:var(--dsw-alias-label-primary)}
/* 2026-10-16 样式统一：hover 统一只浮出"底色矩形"，不带描边 */
.dshq-primary:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:transparent}
/* 2026-10-16：去掉原文预览后，min-width:10em 会让气泡右侧留一片空白 → 取消最小宽度 */
.dshq-toolbar{position:fixed;display:flex;align-items:center;gap:4px;min-width:0;width:max-content;max-width:min(32em,calc(100vw - 24px));font-size:12px;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 4px 14px rgba(0,0,0,.14);pointer-events:auto;box-sizing:border-box}
.dshq-toolbar-preview{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-bubble-cta{flex:none;padding:2px 8px;border-radius:999px}
/* 2026-10-16 样式统一：两个按钮统一为胶囊形（999px 圆角），
   padding 也对齐，保证高度一致。 */
.dshq-pill{flex:none;padding:2px 8px;border-radius:999px}
.dshq-close{flex:none;padding:1px 5px;opacity:.7}
.dshq-editor{position:fixed;display:flex;flex-direction:column;gap:5px;box-sizing:border-box;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:auto;font-size:12px}
.dshq-editor-hidden{opacity:0;pointer-events:none}
.dshq-editor-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-editor-quote{margin:0;padding:3px 8px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:auto}
.dshq-editor-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 8px}
.dshq-editor-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshq-editor-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8}
.dshq-editor-status{font-size:11px;line-height:1.5}
.dshq-editor-status.dshq-ok{color:var(--dsw-alias-state-success-primary)}
.dshq-editor-status.dshq-err{color:var(--dsw-alias-state-error-primary)}
.dshq-editor-actions{display:flex;justify-content:flex-end;gap:6px}
.dshq-tip{position:fixed;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 6px 18px rgba(0,0,0,.18);pointer-events:auto;z-index:2147483000;font-size:12px}
/* 新增(2026-10-16 交互调整)：标题行 + 右上角删除按钮。原来 pointer-events:none，
   提示框无法移入、✕ 点不到，这里改为可交互。 */
.dshq-tip-head{display:flex;align-items:center;gap:8px}
.dshq-tip-label{font-size:11px;color:var(--dsw-alias-label-secondary);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshq-tip-remove{flex:0 0 auto;width:18px;height:18px;line-height:1;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;display:inline-flex;align-items:center;justify-content:center}
.dshq-tip-remove:hover{background:rgba(220,60,60,.14);color:#d33}
/* 新增(2026-10-16)：chip 右上角的删除 ✕（锚定在 chip 自身，而非悬停提示框）。
   2026-10-16 调整：缩小删除按钮 → 缩到 14×14、细边框、9px 字形，
   位置略微外移到 chip 右上角外侧，尽量不遮挡 chip 文字。 */
.dshq-chip-x{position:fixed;transform:translate(-50%,-50%);width:14px;height:14px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:9px;line-height:1;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.14);z-index:2147483001}
.dshq-chip-x:hover{background:rgba(220,60,60,.14);color:#d33;border-color:rgba(220,60,60,.5)}
.dshq-tip-quote{margin:0;padding:3px 8px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;font-size:11px}
/* 修改(2026-10-16)：原来只用 outline + var(--dsw-alias-brand-primary)，该变量在
   某些主题下不存在 → 描边透明，看着"没高亮"。改为固定可见的背景脉冲 + 粗描边。 */
.dshq-flash{outline:3px solid #6f8cff !important;outline-offset:4px;border-radius:8px;background:rgba(111,140,255,.18) !important;animation:dshq-flash-pulse 2.2s ease-out 1}
@keyframes dshq-flash-pulse{0%{background:rgba(111,140,255,.42)}60%{background:rgba(111,140,255,.22)}100%{background:rgba(111,140,255,0)}}
/* 精确到"那一段文字"的高亮（CSS Highlights API） */
::highlight(dshq-quote-flash){background-color:rgba(111,140,255,.55);color:inherit;text-decoration:underline 1px}
.dshq-toast{position:fixed;max-width:240px;padding:5px 9px;border-radius:8px;font-size:11px;line-height:1.5;box-shadow:0 4px 14px rgba(0,0,0,.18);pointer-events:none;z-index:2147483000}
.dshq-toast-ok{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}
.dshq-toast-err{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
/* 根因：textarea（透明文字、absolute、inset:0）渲染在 backdrop 之后，整层盖住 chip。
   给 chip 提升 z-index 使其浮到 textarea 之上，点击才能落到 chip 上。 */
[data-occurrence]{pointer-events:auto;cursor:pointer;position:relative;z-index:1}
`

    // ============ 插件主体 ============
    // 引用管线可能晚于 apply 就绪，这里做成可重试。
    // 2026-10-21：DSH 0.2.1 起提交时会校验 source 的 codec（serializeReference），
    // 若注册没成功，发送时会报 `slash: no serializer for reference source "quote-ref"`。
    // 因此这里把成功/失败都显式打日志，不再静默。
    let pipelineRegistered = false
    function ensurePipeline() {
      if (pipelineRegistered || !rootCtx) return
      let inputTriggers
      try { inputTriggers = rootCtx.get('inputTriggers') } catch (e) { inputTriggers = undefined }
      const hasApi = !!(inputTriggers && typeof inputTriggers.registerSource === 'function')
      pipelineAvailable = hasApi
      if (!hasApi) {
        console.warn('[quote] inputTriggers 尚不可用（defined=' + (inputTriggers !== undefined) + '，keys=' +
          (inputTriggers ? Object.keys(inputTriggers).join(',') : '') + '），稍后重试')
        return
      }
      try {
        rootCtx.effect(() => inputTriggers.registerSource({
          trigger: '@',
          name: 'quote-ref',
          order: 100,
          candidates: async () => [],
          onPick: () => undefined,
          // 官方在 chip 被激活时回调本方法；返回 true 表示"已处理该手势"。
          openReference: (session, reference) => {
            try {
              const ref = reference && reference.ref
              const info = ref ? refTargets.get(ref) : undefined
              const pos = { left: Math.round(window.innerWidth / 2), top: 120 }
              if (!info) {
                popToast('跳转失败：找不到该引用的原文（刷新后引用映射会失效）', pos, false)
                return true
              }
              jumpToQuoteSource(info, pos)
              return true
            } catch (err) {
              console.error('[quote] openReference 出错', err)
              return false
            }
          },
          codec: {
            clipboardText: (ref) => (refCodecs.get(ref) ? refCodecs.get(ref).clipboardText : ''),
            serialize: (ref, signal) => {
              const hit = refCodecs.get(ref)
              if (!hit) console.warn('[quote] serialize 找不到 ref 映射: ' + ref)
              return Promise.resolve(hit ? hit.body : '')
            },
          },
        }), 'dsh-quote-annotate: quote-ref source')
        pipelineRegistered = true
        console.log('[quote] 引用锚点管线已注册（source=quote-ref，含 codec.serialize）')
      } catch (err) {
        console.error('[quote] registerSource 失败: ' + (err && err.message ? err.message : String(err)))
      }
    }
    // 修复(2026-10-16)：选区气泡在全局插槽 shell.overlay 中渲染。上游实现只认
    //   props.useSessions((s) => s.current)
    // 但本版本 sessions store 的快照只有 { ids, byId, phase, projectionsBySession }，
    // 没有 current 字段 → 解析恒为 undefined → 点「批注」只关掉气泡（无反应）。
    // 现在按下列顺序解析：宿主钩子的常见字段 → 作用域 props.sessionId →
    // uiWorkspace 的当前选择/主引用 → 会话作用域插槽（回合尾按钮）缓存值。
    function coerceSessionId(value) {
      if (typeof value === 'string' && value) return value
      if (value && typeof value === 'object') {
        if (typeof value.sessionId === 'string' && value.sessionId) return value.sessionId
        if (typeof value.id === 'string' && value.id) return value.id
        if (value.reference && typeof value.reference === 'object') {
          if (typeof value.reference.sessionId === 'string' && value.reference.sessionId) return value.reference.sessionId
          if (typeof value.reference.id === 'string' && value.reference.id) return value.reference.id
        }
      }
      return undefined
    }

    function resolveSessionId(props) {
      // 1) 宿主若提供会话 store 钩子，优先用它（不同版本字段名不同）
      if (props && typeof props.useSessions === 'function') {
        for (const pick of [(s) => s && s.current, (s) => s && s.selectedSessionId, (s) => s && s.activeSessionId]) {
          try {
            const hit = props.useSessions(pick)
            const id = coerceSessionId(hit)
            if (id) return id
          } catch (e) { /* 换下一个 */ }
        }
      }
      // 2) 插槽作用域直接给的会话 id
      const scoped = coerceSessionId(props && props.sessionId)
      if (scoped) return scoped
      // 3) 导航服务：当前主视图选择 / 主引用
      try {
        const uw = rootCtx ? rootCtx.get('uiWorkspace') : undefined
        if (uw) {
          for (const candidate of [uw.selection, uw.mainReference, uw.view && uw.view.selection]) {
            const id = coerceSessionId(candidate)
            if (id) return id
          }
        }
      } catch (e) { /* ignore */ }
      // 4) 会话作用域插槽（回合尾按钮）缓存下来的 id
      return currentSessionId || undefined
    }

    // 修改(2026-10-16)：把引用写进底部输入框后，把光标交回输入框。
    // 宿主会在视图渲染后移动焦点，所以补两次延迟聚焦，只有在焦点不在输入区时才抢。
    function focusComposer() {
      const pick = () => {
        const list = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
        return list.find((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 40 && r.height > 10
        }) || list[0]
      }
      const grab = () => {
        try {
          const el = pick()
          if (!el) return
          if (document.activeElement === el) return
          el.focus()
          if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
            el.setSelectionRange(el.value.length, el.value.length)
          }
        } catch (e) { /* ignore */ }
      }
      grab()
      setTimeout(grab, 60)
      setTimeout(grab, 200)
    }

    // 修改(2026-10-16)：气泡的「批注」不再弹浮动评论框，
    // 直接把引用写进底部输入框并把光标放到那里（评论留空，用户接着在输入框里写）。
    function insertQuoteDirect(props, sel) {
      const sessionId = resolveSessionId(props)
      if (sessionId) currentSessionId = sessionId
      if (!sessionId) {
        console.error('[quote] 无法确定当前会话（未打开会话？），引用未插入')
        return false
      }
      ensurePipeline()
      const res = insertQuoteIntoComposer({
        sessionId,
        text: clipText(sel.text, MAX_SELECTION),
        anchorKey: sel.anchorKey,
        label: '选中文字',
        comment: '',
        offset: sel.offset,
        length: sel.length,
      })
      if (!res.ok) console.warn('[quote] 直接插入失败：' + res.message)
      else console.log('[quote] 已插入引用并聚焦输入框')
      focusComposer()
      return res.ok
    }

    // 引用写入底部输入框（气泡直插与浮动编辑框共用）
    function insertQuoteIntoComposer(opts) {
      try {
        const quoteBody = opts.text.split('\n').map((line) => '> ' + line).join('\n')
        const c = opts.comment || ''
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        const inputTriggers = rootCtx ? rootCtx.get('inputTriggers') : undefined
        if (!conversation || !conversation.input || !sessions) {
          return { ok: false, message: '写入输入框失败：conversation/sessions 服务不可用' }
        }
        const binding = sessions.binding(opts.sessionId)
        if (!binding) return { ok: false, message: '写入输入框失败：会话不可用' }
        const input = conversation.input.for(binding.ctx)
        const st = input.state.getSnapshot()
        const base = (st.draft || '').replace(/[\s\u00A0]+$/, '')
        const commentTail = c === '' ? '' : '\n\n' + c
        // 2026-10-21（DSH 0.2.1 兼容）：官方提交时会用 source 的 codec.serialize 序列化
        // 每个 chip；若 source 没注册成功，发送会报
        //   slash: no serializer for reference source "quote-ref"
        // 因此这里先确保管线已注册；若仍不可用，就不插入 chip，退化为纯文本引用，
        // 保证「添加引用」这个动作本身永远可用、且绝不会让用户卡在发送失败上。
        ensurePipeline()
        if (!pipelineRegistered) {
          const plain = quoteBody + commentTail
          const fallback = (base ? base + '\n\n' : '') + plain
          try { input.setDraft(fallback) } catch (e) { return { ok: false, message: '写入输入框失败：' + (e && e.message ? e.message : String(e)) } }
          console.warn('[quote] 引用 source 未注册，已退化为纯文本引用（避免发送时 no serializer 报错）')
          return { ok: true, message: '已添加到对话（纯文本模式）' }
        }
        if (inputTriggers && typeof input.insertReference === 'function') {
          const ref = 'q' + (++refSeq)
          // chipLabel 记录官方 chip 上实际显示的标签（「引用#N」），供悬停提示反查正文
          refTargets.set(ref, { sessionId: opts.sessionId, anchorKey: opts.anchorKey || null, body: quoteBody, label: '引用#' + refSeq + (opts.label ? ' · ' + opts.label : ''), chipLabel: '引用#' + refSeq, offset: typeof opts.offset === 'number' ? opts.offset : null, length: typeof opts.length === 'number' ? opts.length : null })
          refCodecs.set(ref, { body: quoteBody, clipboardText: quoteBody })
          if (refCodecs.size > 200) {
            const oldest = refCodecs.keys().next().value
            refCodecs.delete(oldest)
            refTargets.delete(oldest)
          }
          const refObj = { source: 'quote-ref', ref, label: '引用#' + refSeq, clipboardText: quoteBody }
          // 修复(2026-10-16)：官方 insertReference 要求【非空 span】（要有一段文本被 chip
          // 替换掉）。上游实现传 {start: draft.length, end: draft.length} 的空区间，只在草稿
          // 完全为空时侥幸成功；草稿里已有内容（含已有 chip）时必然 return false，
          // 随后回退分支用 setDraft(纯文本) 又把已有 chip 一并抹掉 —— 这就是
          // "输入框只能有一个引用 chip"的真实原因。
          // 现在：先确认快照，按"末尾非空区间"插入；草稿为空时用 {0,0}（官方接受）。
          let applied = false
          let s = input.state.getSnapshot()
          // 修复(2026-10-16 关键)：坐标必须是【detect 坐标】，不能用 snapshot.draft 的长度。
          // 官方 chip 在 detect 投影里只占 1 个 U+FFFC（REFERENCE_PLACEHOLDER_RE），
          // 而 snapshot.draft 是 clipboard 投影（含 chip 的正文文本，长度完全不同）。
          // 用 draft.length 当坐标 → selectSpan 映射失败 → insertReference 返回 false，
          // 随后回退 setDraft(纯文本) 又把已有 chip 全部抹掉 —— 这就是"只能有一个 chip"。
          // 官方 detect 坐标入口：input.caretSpan()（无选区时即文档末尾）。
          let detectSpan = null
          try { detectSpan = input.caretSpan ? input.caretSpan() : null } catch (e) { detectSpan = null }
          if (detectSpan && typeof detectSpan.start === 'number') {
            applied = input.insertReference(refObj, { start: detectSpan.start, end: detectSpan.end, draftRev: s.draftRev })
            console.log('[quote] 依 detect 坐标插入', { span: { start: detectSpan.start, end: detectSpan.end }, applied })
          }
          if (!applied && s.draft.length === 0) {
            applied = input.insertReference(refObj, { start: 0, end: 0, draftRev: s.draftRev })
          }
          if (!applied) {
            // 退路：paste 在末尾落一个空格（detect 里即 +1 字符），再用 detect 坐标末位替换
            try { input.paste(' ') } catch (e) { /* ignore */ }
            s = input.state.getSnapshot()
            let detected2 = null
            try { detected2 = input.caretSpan ? input.caretSpan() : null } catch (e) { detected2 = null }
            if (detected2 && typeof detected2.start === 'number') {
              const at = detected2.end
              applied = input.insertReference(refObj, { start: Math.max(0, at - 1), end: at, draftRev: s.draftRev })
              console.log('[quote] 退路：paste+detect 末位替换', { at, applied })
            }
          }
          if (applied) {
            if (commentTail !== '') {
              const st3 = input.state.getSnapshot()
              input.setDraft(st3.draft.replace(/[ \t]+$/, '') + commentTail)
            }
            const anchorNote = opts.anchorKey ? '定位键：' + opts.anchorKey : '未定位到消息行，点击锚点可能无法跳转'
            console.log('[quote] 引用锚点已插入', { ref, applied, anchorKey: opts.anchorKey })
            return { ok: true, message: '已插入引用锚点 ✓（' + anchorNote + '）' }
          }
          refTargets.delete(ref)
          refCodecs.delete(ref)
          input.setDraft(base === '' ? quoteBody + commentTail : base + '\n\n' + quoteBody + commentTail)
          return { ok: true, message: '锚点插入未生效，已回退为纯文本引用（管线异常）' }
        }
        input.setDraft(base === '' ? quoteBody + commentTail : base + '\n\n' + quoteBody + commentTail)
        return { ok: true, message: '引用管线暂不可用，已插入纯文本引用' }
      } catch (e) {
        return { ok: false, message: '插入失败：' + (e && e.message ? e.message : String(e)) }
      }
    }

    // 新增(2026-10-16)：把 occurrence 的 clipboard 投影坐标换算成 detect 坐标。
    // 官方 chip 在 detect 文本里只占 1 个字符（U+FFFC），而 occurrence 的 offset/length
    // 与 snapshot.draft 都是 clipboard 投影（chip 按其正文字符计）。
    // 公式：detectStart = offset - Σ(前面 chip 的 length) + (前面 chip 个数)
    function detectSpanOf(occ, snap) {
      if (!snap || !occ || typeof occ.offset !== 'number') return null
      const list = (snap.occurrences || [])
        .filter((o) => o && typeof o.offset === 'number' && typeof o.length === 'number')
        .sort((a, b) => a.offset - b.offset)
      const index = list.indexOf(occ)
      if (index < 0) return null
      let plainBefore = 0   // detect 位置
      let clipAcc = 0       // 已消耗的 clipboard 前缀
      for (let i = 0; i < index; i++) {
        plainBefore += (list[i].offset - clipAcc) + 1   // chip 间普通文本 + 1 个 chip 占位
        clipAcc = list[i].offset + list[i].length
      }
      const start = (occ.offset - clipAcc) + plainBefore
      return { start, end: start + 1 }
    }

    // 新增(2026-10-16)：删除输入框里的某一条引用（悬停提示右上角 ✕ 触发）。
    // 走官方 consumeToken({kind:'span'}) —— 它内部就是 draftEditor.replaceText(span, '')，
    // 用 detect 坐标精确删除【这一个】chip。
    // 绝不能用 setDraft：那是纯文本整体重写，会把其它 chip 一起抹掉。
    function removeQuoteOccurrence(sessionId, occurrence) {
      try {
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        if (!conversation || !conversation.input || !sessions) return { ok: false, message: '删除失败：服务不可用' }
        const binding = sessions.binding(sessionId)
        if (!binding) return { ok: false, message: '删除失败：会话不可用' }
        const input = conversation.input.for(binding.ctx)
        const st = input.state.getSnapshot()
        const occ = (st.occurrences || []).find((o) => o && o.ref === occurrence.ref)
        if (!occ) return { ok: false, message: '删除失败：输入框里找不到这条引用' }
        const span = detectSpanOf(occ, st)
        if (!span) return { ok: false, message: '删除失败：无法定位该引用的编辑坐标' }
        span.draftRev = st.draftRev
        if (typeof input.consumeToken === 'function') {
          const ok = input.consumeToken({ kind: 'span', span })
          if (ok) return { ok: true, message: '已删除引用' }
        }
        // 退路：直接对 detect 区间做空串替换
        try {
          if (input.draftEditor && typeof input.draftEditor.replaceText === 'function') {
            const ok2 = input.draftEditor.replaceText(span, '')
            if (ok2) return { ok: true, message: '已删除引用' }
          }
        } catch (e) { /* ignore */ }
        return { ok: false, message: '删除失败：官方编辑器拒绝该区间' }
      } catch (e) {
        return { ok: false, message: '删除失败：' + (e && e.message ? e.message : String(e)) }
      }
    }

    // 新增(2026-10-16)：点击 chip 跳回原文并高亮。
    // 由官方钩子 openReference(source, reference) 触发（官方 Lexical 编辑器在
    // chip 被激活时回调注册该 source 的 openReference；插件原来没实现它，
    // 所以点 chip 时官方"保留编辑器原有手势"→ 表现为毫无反应）。
    let toastTimer = null
    function popToast(text, pos, ok) {
      try {
        toastStore.show(text, pos || { left: Math.round(window.innerWidth / 2), top: 120 }, ok)
        if (toastTimer) clearTimeout(toastTimer)
        toastTimer = setTimeout(() => toastStore.hide(), 2600)
      } catch (e) { /* ignore */ }
    }

    function jumpToQuoteSource(info, pos) {
      try {
        if (!info) {
          popToast('跳转失败：找不到该引用（可能已发送或被删除）', pos, false)
          return false
        }
        let anchorKey = info.anchorKey
        // 兜底：按引用正文内容反查原文行
        if (!anchorKey && info.body) {
          const probe = (info.body || '').replace(/^> /, '').slice(0, 24)
          for (const r of document.querySelectorAll('[data-chat-anchor-key]')) {
            if (probe && r.textContent && r.textContent.indexOf(probe) !== -1) {
              anchorKey = r.getAttribute('data-chat-anchor-key')
              break
            }
          }
        }
        if (!anchorKey) {
          popToast('跳转失败：没有定位键（选中时未识别到消息行）', pos, false)
          return false
        }
        let row = null
        for (const r of document.querySelectorAll('[data-chat-anchor-key]')) {
          if (r.getAttribute('data-chat-anchor-key') === anchorKey) { row = r; break }
        }
        if (!row) {
          popToast('跳转失败：原文行不在当前页面（可能已切换会话）', pos, false)
          return false
        }
        // 新增(2026-10-16)：优先按记录的字符偏移精确高亮"当时选中的那一段"，
        // 并把那一段滚到视口中央（原来只 scrollIntoView 整个 turn，位置不精确）。
        // 2026-10-16 加固：偏移可能因 DOM 重渲染/流式输出而失效，因此定位后必须
        // 校验文本；不匹配则走"跨节点文本搜索"兜底（原兜底只在单个文本节点内
        // indexOf，文字被 React 拆成多个节点时就找不到 → 表现为没精确滚到那段）。
        const wantText = (info.body || '').replace(/^> /gm, '').trim()
        const norm = (s) => (s || '').replace(/\s+/g, '')
        let range = null
        if (typeof info.offset === 'number' && info.offset >= 0) {
          const len = typeof info.length === 'number' && info.length > 0 ? info.length : Math.min(wantText.length || 120, 400)
          const cand = rangeByTextOffset(row, info.offset, len)
          if (cand) {
            const got = norm(cand.toString())
            const want = norm(wantText)
            if (!want || got.slice(0, 12) === want.slice(0, 12)) range = cand
            else console.log('[quote] 偏移定位校验不通过，改用文本搜索', { got: got.slice(0, 20), want: want.slice(0, 20) })
          }
        }
        if (!range && wantText) range = findTextRangeInRow(row, wantText)
        if (range) flashRange(row, range)
        else {
          row.scrollIntoView({ block: 'center', behavior: 'smooth' })
          row.classList.add('dshq-flash')
          setTimeout(() => row.classList.remove('dshq-flash'), 2000)
        }
        // 2026-10-16 交互调整：成功跳转不再弹 toast（"已跳转到原文"显得突兀）。
        // 跳转本身 + 原文高亮就是反馈；只有失败/异常才提示。
        console.log('[quote] 已跳转到原文', anchorKey)
        return true
      } catch (err) {
        popToast('跳转出错：' + (err && err.message ? err.message : String(err)), pos, false)
        console.error('[quote] 点击跳转出错', err)
        return false
      }
    }

    // 新增(2026-10-16)：求 (node, offset) 在 root 内的纯文本字符偏移（用 Range 精确计算）
    function textOffsetIn(root, node, offset) {
      try {
        const r = document.createRange()
        r.selectNodeContents(root)
        r.setEnd(node, offset)
        return r.toString().length
      } catch (e) {
        return null
      }
    }

    // 新增(2026-10-16)：在 root 内按字符偏移与长度还原一个 Range（用于精确高亮）
    function rangeByTextOffset(root, start, length) {
      try {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let seen = 0
        let startNode = null; let startOff = 0
        let endNode = null; let endOff = 0
        let n
        const wantEnd = start + Math.max(1, length)
        while ((n = walker.nextNode())) {
          const len = (n.textContent || '').length
          if (startNode === null && seen + len >= start) {
            startNode = n; startOff = Math.max(0, start - seen)
          }
          if (startNode !== null && seen + len >= wantEnd) {
            endNode = n; endOff = Math.max(0, wantEnd - seen)
            break
          }
          seen += len
        }
        if (!startNode) return null
        if (!endNode) { endNode = startNode; endOff = (startNode.textContent || '').length }
        const r = document.createRange()
        r.setStart(startNode, Math.min(startOff, (startNode.textContent || '').length))
        r.setEnd(endNode, Math.min(endOff, (endNode.textContent || '').length))
        return r
      } catch (e) {
        return null
      }
    }

    // 新增(2026-10-16)：在行内【跨文本节点】搜索一段文字并还原 Range。
    // React/Markdown 会把一段话拆进多个 span/文本节点，单节点 indexOf 会找不到。
    function findTextRangeInRow(root, text) {
      try {
        const nodes = []
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let n
        while ((n = walker.nextNode())) nodes.push(n)
        if (!nodes.length) return null
        // 拼接全文（保留每个节点的长度，用于反查）
        let full = ''
        const spans = []
        for (const nd of nodes) {
          const t = nd.textContent || ''
          spans.push({ node: nd, start: full.length, len: t.length })
          full += t
        }
        const probe = text.slice(0, 16)
        const at = full.indexOf(probe)
        if (at < 0) return null
        const end = Math.min(at + text.length, full.length)
        const locate = (pos) => {
          for (const s of spans) {
            if (pos >= s.start && pos <= s.start + s.len) return { node: s.node, off: pos - s.start }
          }
          return null
        }
        const s0 = locate(at)
        const s1 = locate(end)
        if (!s0 || !s1) return null
        const r = document.createRange()
        r.setStart(s0.node, s0.off)
        r.setEnd(s1.node, s1.off)
        return r
      } catch (e) {
        return null
      }
    }

    function cjkSafeLen(range) {
      try { return range.toString().length } catch (e) { return 0 }
    }

    // 新增(2026-10-16)：精确高亮 + 把目标滚动到视口中央（两次，抵消虚拟列表高度抖动）
    function flashRange(row, range) {
      const HIGHLIGHT = 'dshq-quote-flash'
      let handled = false
      try {
        if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function') {
          CSS.highlights.set(HIGHLIGHT, new Highlight(range))
          handled = true
        }
      } catch (e) { handled = false }
      if (!handled) {
        try { row.classList.add('dshq-flash') } catch (e) { /* ignore */ }
      }
      const clear = () => {
        try { if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(HIGHLIGHT) } catch (e) { /* ignore */ }
        try { row.classList.remove('dshq-flash') } catch (e) { /* ignore */ }
      }
      setTimeout(clear, 2400)

      const center = (behavior) => {
        try {
          const r = range.getBoundingClientRect()
          if (!r || (r.width === 0 && r.height === 0)) { row.scrollIntoView({ block: 'center', behavior }); return }
          const vh = window.innerHeight || 768
          const delta = (r.top + r.height / 2) - vh / 2
          if (Math.abs(delta) < 8) return
          // 就近的滚动容器（DSH 会话是内部滚动容器，不是 window）
          let sc = row.parentElement
          while (sc && sc !== document.body) {
            const style = getComputedStyle(sc)
            if (/(auto|scroll|overlay)/.test(style.overflowY) && sc.scrollHeight > sc.clientHeight + 4) break
            sc = sc.parentElement
          }
          if (sc && sc !== document.body) sc.scrollBy({ top: delta, behavior })
          else window.scrollBy({ top: delta, behavior })
        } catch (e) {
          try { row.scrollIntoView({ block: 'center', behavior }) } catch (e2) { /* ignore */ }
        }
      }
      center('smooth')
      // 虚拟列表滚动后会补渲染/改变高度，多次校正直到稳定
      // 2026-10-16 加固：偶发的"未精确滚回"问题。smooth 动画进行中若虚拟列表
      // 补渲染改变高度，之前的三次校正仍可能被覆盖 → 增加 1200ms/2000ms 的最终校正。
      setTimeout(() => center('smooth'), 320)
      setTimeout(() => center('auto'), 700)
      setTimeout(() => center('auto'), 1200)
      setTimeout(() => center('auto'), 2000)
    }

    function apply(ctx) {
      rootCtx = ctx
      const slots = ctx.get('slots')
      if (slots === undefined) {
        // 修复(2026-10-16)：原来这里静默 return，导致整个插件一点痕迹都没有。
        // 现在 plugins 对象已声明 inject: ['slots']，正常不会再走到这里。
        console.error('[quote] slots 服务不可用，插件未挂载（apply 被过早调用）')
        return
      }
      ctx.effect(() => insertStyleSheet(css), 'dsh-quote-annotate: styles')
      // 注册引用 source（提交时把占位符序列化为引用正文；空候选分组不渲染，不污染 @ 菜单）
      // 2026-10-21（DSH 0.2.1）：inputTriggers 在 apply 时通常还没就绪（实测 defined=false），
      // 因此这里除了立即尝试，还安排几次延迟重试，尽力在用户第一次点击前注册好。
      ensurePipeline()
      if (!pipelineRegistered) {
        ctx.effect(() => {
          const timers = [500, 1500, 3000, 6000, 12000].map((delay) =>
            setTimeout(() => { if (!pipelineRegistered) ensurePipeline() }, delay))
          return () => timers.forEach((t) => clearTimeout(t))
        }, 'dsh-quote-annotate: pipeline retries')
      }
      // 全局监听（选区气泡 / chip 点击跳转 / chip 悬停提示；ctx.effect 保证卸载时全部清理）
      ctx.effect(() => {
        let raf = 0
        let toastTimer = null
        let hideTimer = null
        const onKey = (e) => {
          if (e.key === 'Escape') {
            selectionStore.hide()
            toastStore.hide()
            tooltipStore.hide()
          }
        }
        const showToast = (text, pos, ok) => {
          toastStore.show(text, pos, ok)
          if (toastTimer) clearTimeout(toastTimer)
          toastTimer = setTimeout(() => toastStore.hide(), 2600)
        }
        const cancelHide = () => {
          if (hideTimer) {
            clearTimeout(hideTimer)
            hideTimer = null
          }
        }
        const scheduleHide = () => {
          if (hideTimer) return
          hideTimer = setTimeout(() => {
            hideTimer = null
            selectionStore.hide()
          }, 150)
        }
        const onScroll = () => {
          schedule()
          tooltipStore.hide()
        }
        // 用 pointerdown 捕获（比 click 更早，且不受 click 阶段任何 stopPropagation 影响）
        // 点击 chip 的跳转由官方钩子 openReference 处理（见 ensurePipeline），
        // 这里只在按下时收起悬停提示，避免与官方手势重复触发。
        const onChipPress = () => {
          try { tooltipStore.hide() } catch (err) { /* ignore */ }
        }
        // 兼容旧引用：pointerdown 只收起提示，跳转一律走官方 openReference
        // 悬停 chip：显示引用的原文
        // 修复(2026-10-16)：官方 chip 的真实 DOM 标记是
        //   <span data-composer-chip="quote-ref" data-lexical-decorator="true">
        //     <span class="…_chip" title="引用#1">@引用#1</span>
        //   </span>
        // 上游实现找的是自造的 [data-occurrence]（官方从不输出它），所以悬停永远没反应。
        // 现在按官方标记定位，并用 chip 上的「引用#N」标签反查引用正文。
        const CHIP_SEL = '[data-composer-chip="quote-ref"]'
        const infoByChipLabel = (text) => {
          const want = (text || '').replace(/^@/, '').trim()
          if (!want) return null
          let prefixHit = null
          for (const [key, info] of refTargets.entries()) {
            if (!info) continue
            if (info.chipLabel === want) return { ref: key, info }
            if (!prefixHit && typeof info.label === 'string' && info.label.startsWith(want)) prefixHit = { ref: key, info }
          }
          return prefixHit
        }
        const onChipOver = (e) => {
          try {
            const el = e.target && e.target.closest ? e.target.closest(CHIP_SEL) : null
            if (!el) return
            const labelEl = el.querySelector('[class*="_label"]') || el
            const hit = infoByChipLabel((labelEl.textContent || '').trim())
            if (!hit || !hit.info || !hit.info.body) {
              const r0 = el.getBoundingClientRect()
              tooltipStore.show({
                text: '（这条引用的原文映射已失效，刷新后会丢失）',
                label: '引用',
                rect: { left: r0.left, top: r0.top, right: r0.right, bottom: r0.bottom },
                ref: hit ? hit.ref : null,
                sessionId: hit && hit.info ? hit.info.sessionId : null,
              })
              chipHoverStore.hide()
              return
            }
            const info = hit.info
            const r = el.getBoundingClientRect()
            tooltipStore.show({
              text: (info.body || '').replace(/^> /gm, '').trim(),
              label: info.chipLabel || info.label || '引用',
              rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
              ref: hit.ref || null,
              sessionId: info.sessionId || null,
            })
            // 新增(2026-10-16)：记录悬停的 chip，供其右上角 ✕ 浮层定位
            chipHoverStore.show({
              ref: hit.ref || null,
              sessionId: info.sessionId || null,
              label: info.chipLabel || info.label || '',
            })
          } catch (err) { /* ignore */ }
        }
        const onChipOut = (e) => {
          try {
            const el = e.target && e.target.closest ? e.target.closest(CHIP_SEL) : null
            if (!el) return
            const next = e.relatedTarget
            if (next && next.closest && next.closest(CHIP_SEL)) return
            if (next && next.closest && next.closest('.dshq-chip-x')) return
            tooltipStore.hide()
            chipHoverStore.hide()
          } catch (err) { /* ignore */ }
        }
        const compute = () => {
          raf = 0
          try {
            const sel = window.getSelection()
            if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
              // 选区消失：延迟隐藏，避免流式渲染抖动导致气泡闪没
              scheduleHide()
              return
            }
            const text = (sel.toString() || '').trim()
            if (!text) {
              scheduleHide()
              return
            }
            const range = sel.getRangeAt(0)
            const node = range.commonAncestorContainer
            const host = node && node.nodeType === 1 ? node : (node ? node.parentElement : null)
            if (host && host.closest('textarea, input, [contenteditable="true"]')) {
              scheduleHide()
              return
            }
            const rect = range.getBoundingClientRect()
            if (!rect || (rect.width === 0 && rect.height === 0)) {
              scheduleHide()
              return
            }
            // 选区滚出视口（自动滚动场景）才隐藏；仍在视口内则跟随重定位
            const vh = typeof window !== 'undefined' ? window.innerHeight : 768
            if (rect.bottom < -8 || rect.top > vh + 8) {
              scheduleHide()
              return
            }
            cancelHide()
            const anchor = sel.anchorNode && sel.anchorNode.nodeType === 1 ? sel.anchorNode : (sel.anchorNode ? sel.anchorNode.parentElement : null)
            let anchorKey = null
            let rowEl = null
            if (anchor) {
              rowEl = anchor.closest('[data-chat-anchor-key]')
              if (rowEl) anchorKey = rowEl.getAttribute('data-chat-anchor-key')
            }
            // 新增(2026-10-16)：记录选中文字在原文行内的字符偏移与长度，
            // 供跳转时还原到"精确那一段"而不是整个 turn。
            let offset = null
            let length = null
            if (rowEl) {
              try {
                const r0 = sel.getRangeAt(0)
                offset = textOffsetIn(rowEl, r0.startContainer, r0.startOffset)
                length = Math.max(1, Math.min(text.length, 400))
              } catch (e) { offset = null; length = null }
            }
            selectionStore.show({
              text: clipText(text, MAX_SELECTION),
              rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              anchorKey,
              offset,
              length,
            })
          } catch (e) {
            scheduleHide()
          }
        }
        const schedule = () => {
          if (!raf) raf = requestAnimationFrame(compute)
        }
        document.addEventListener('selectionchange', schedule)
        // 滚动/缩放不再盲目隐藏：重新计算选区位置，跟随重定位（执行任务自动滚动时气泡不消失）
        document.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onChipPress, true)
        document.addEventListener('pointerover', onChipOver, true)
        document.addEventListener('pointerout', onChipOut, true)
        return () => {
          document.removeEventListener('selectionchange', schedule)
          document.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onChipPress, true)
          document.removeEventListener('pointerover', onChipOver, true)
          document.removeEventListener('pointerout', onChipOut, true)
          if (raf) cancelAnimationFrame(raf)
          if (hideTimer) clearTimeout(hideTimer)
          if (toastTimer) clearTimeout(toastTimer)
        }
      }, 'dsh-quote-annotate: global listeners')
      slots.inject('conversation.chat.turnTail', () => slots.register(
        // 修复(2026-10-16)：list 槽注册必须带 id，否则 register() 抛
        //   Error: list slot "conversation.chat.turnTail" requires options.id
        // 该异常会中断本次 apply()，使它后面 4 个 shell.overlay 注册（选区气泡、
        // 批注编辑框、chip 提示、toast）全部不执行 —— 表现为"连气泡都没有"。
        // 官方示例与后 4 个注册都带 id。
        { name: 'conversation.chat.turnTail', id: 'quote-turn-actions', select: selectTurnQuote, priority: 10 },
        TurnQuoteActions,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-selection-toolbar', order: 100 },
        SelectionToolbar,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-annotation-editor', order: 101 },
        AnnotationEditor,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-tooltip', order: 103 },
        QuoteTooltip,
      ))
      slots.inject('shell.overlay', () => slots.register(
        // 新增(2026-10-16)：chip 右上角的删除 ✕（浮层锚定到 chip，而非提示框）
        { name: 'shell.overlay', id: 'quote-chip-delete', order: 104 },
        ChipDeleteButton,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-feedback-toast', order: 102 },
        FeedbackToast,
      ))
    }

    // 修复(2026-10-16)：声明服务依赖，cordis 会等 slots 服务就绪后再调用 apply。
    // 上游实现没有 inject，apply 在 slots 尚未注册时就被调用 → 第 535 行 ctx.get('slots')
    // 拿到 undefined → 静默 return → 气泡/批注/回合按钮全部不出现且无任何报错。
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
