/* =========================================================
   <RichTextEditor> — composer for Markdown / HTML / Plain.

   Mirrors the backend's BodyFormat contract:
     · HTML      → WYSIWYG (contenteditable) — bold IS bold, lists are
                   real lists, tables are real tables. Word-style toolbar:
                   block style, B / I / U / S, text colour, highlight,
                   bullets, numbered, quote, code, alignment, link,
                   image, table picker (grid), HR, clear-format.
     · MARKDOWN  → textarea + syntax-inserting toolbar + Write/Preview tabs
     · PLAIN     → bare textarea

   The output goes to the server as-is. The OWASP sanitiser on the
   backend (see RichTextService) protects whatever the editor emits.
   ========================================================= */
import React from 'react'
import { Icon } from './ui.jsx'
import { uiPrompt } from './Dialog.jsx'
import { renderByFormat, detectFormat, renderSafeHtml } from '../lib/richtext.js'

const FORMATS = [
  { key:'HTML',     label:'Rich',     desc:'WYSIWYG editor — formatting, colours, tables, images.' },
  { key:'MARKDOWN', label:'Markdown', desc:'Source-style Markdown (GitHub-Flavoured) with a live preview tab.' },
  { key:'PLAIN',    label:'Plain',    desc:'No formatting — line breaks preserved.' },
]

/* ----- MD-mode toolbar (text-inserting) ---------------------------------- */
const MD_TOOLS = [
  { key:'bold',   icon:'bold',   title:'Bold (⌘B)',        wrap:['**','**'] },
  { key:'italic', icon:'italic', title:'Italic (⌘I)',      wrap:['*','*'] },
  { key:'strike', icon:'strike', title:'Strikethrough',     wrap:['~~','~~'] },
  { key:'code',   icon:'code',   title:'Inline code (⌘E)',  wrap:['`','`'] },
  { sep:true },
  { key:'h2',     label:'H2',    title:'Heading 2',         prefix:'## ' },
  { key:'h3',     label:'H3',    title:'Heading 3',         prefix:'### ' },
  { key:'quote',  icon:'quote2', title:'Block quote',       prefix:'> ' },
  { sep:true },
  { key:'ul',     icon:'ulist',  title:'Bulleted list',     prefix:'- ' },
  { key:'ol',     icon:'olist',  title:'Numbered list',     prefix:'1. ' },
  { sep:true },
  { key:'link',   icon:'link',   title:'Insert link (⌘K)',  action:'link' },
  { key:'image',  icon:'image',  title:'Insert image',      action:'image' },
  { key:'pre',    icon:'codeblock', title:'Code block',     action:'pre' },
  { key:'table',  icon:'table',  title:'Insert table',      action:'table' },
  { key:'hr',     icon:'hr',     title:'Horizontal rule',   action:'hr' },
]

/* ----- WYSIWYG palettes --------------------------------------------------
   IMPORTANT: every stylistic choice that the legacy execCommand would
   emit as `style="…"` (colour, highlight, font size, alignment) is
   applied here as a CSS CLASS instead. The backend's OWASP sanitiser
   strips the `style=` attribute but KEEPS `class=`, so what the author
   sees in the editor is what they get on the published research page.
   The classes themselves are defined in styles-richtext.css. */
const TEXT_COLORS = [
  { cls:'tc-ink',     val:'#0b1a16' },
  { cls:'tc-soft',    val:'#3c4f49' },
  { cls:'tc-muted',   val:'#7a8783' },
  { cls:'tc-light',   val:'#cdc4ad' },
  { cls:'tc-rose',    val:'#c2453f' },
  { cls:'tc-brass',   val:'#bd9344' },
  { cls:'tc-emerald', val:'#0e6b54' },
  { cls:'tc-blue',    val:'#3f6a8a' },
  { cls:'tc-brown',   val:'#7a4a2a' },
  { cls:'tc-deep',    val:'#5a2a1a' },
  { cls:'tc-bright',  val:'#159a76' },
  { cls:'tc-white',   val:'#ffffff' },
]
const HIGHLIGHT_COLORS = [
  { cls:'',           val:'transparent', none:true },   // remove highlight
  { cls:'hl-yellow',  val:'#fff59d' },
  { cls:'hl-green',   val:'#a5d6a7' },
  { cls:'hl-blue',    val:'#90caf9' },
  { cls:'hl-coral',   val:'#ffab91' },
  { cls:'hl-pink',    val:'#ce93d8' },
  { cls:'hl-cream',   val:'#f4ead0' },
  { cls:'hl-orange',  val:'#ffe0b2' },
]
/* Font sizes as actual pixel values — the picker button shows the current
   size number (like MS Word), and each dropdown row is rendered at its own
   size so the author sees a true preview. */
const FONT_SIZES = [
  { cls:'fs-12', label:'12', hint:'small caption' },
  { cls:'fs-14', label:'14', hint:'compact body' },
  { cls:'',      label:'16', hint:'default body' },
  { cls:'fs-18', label:'18', hint:'large body' },
  { cls:'fs-20', label:'20', hint:'subhead' },
  { cls:'fs-24', label:'24', hint:'heading' },
  { cls:'fs-30', label:'30', hint:'large heading' },
  { cls:'fs-36', label:'36', hint:'display' },
  { cls:'fs-48', label:'48', hint:'feature' },
  { cls:'fs-60', label:'60', hint:'hero' },
  { cls:'fs-72', label:'72', hint:'banner' },
  { cls:'fs-96', label:'96', hint:'poster' },
]
const FONT_FAMILIES = [
  { cls:'',         label:'Serif (default)', family:'var(--serif)' },
  { cls:'ff-sans',  label:'Sans-serif',      family:'var(--sans)'  },
  { cls:'ff-mono',  label:'Monospace',       family:'var(--mono)'  },
]

/* class-group regexes used by the apply / cleanup / active-state helpers */
const GROUP_RE = {
  color: /^tc-/,
  hl:    /^hl-/,
  size:  /^fs-/,
  font:  /^ff-/,
}
const BLOCK_GROUP_RE = {
  align: /^align-/,
}
const BLOCKS = new Set(['P','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','LI','PRE','TD','TH','DIV'])

/* ======================================================================== */
/*  WYSIWYG (HTML mode)                                                     */
/* ======================================================================== */

function execCmd(cmd, arg) {
  try { return document.execCommand(cmd, false, arg) } catch { return false }
}

/* Image wrap modes — like MS Word. CSS classes; matched in styles-richtext.css. */
const IMG_WRAP = [
  { cls:'',               icon:'alignJustify', title:'In line with text' },
  { cls:'img-wrap-left',  icon:'alignLeft',    title:'Wrap left (text on the right)' },
  { cls:'img-wrap-right', icon:'alignRight',   title:'Wrap right (text on the left)' },
  { cls:'img-block',      icon:'alignCenter',  title:'Top and bottom (centred block)' },
  { cls:'img-behind',     icon:'eye',          title:'Behind text (watermark)' },
]
const IMG_SIZES = [
  { cls:'img-sm', label:'S', title:'Small (25%)' },
  { cls:'img-md', label:'M', title:'Medium (50%)' },
  { cls:'img-lg', label:'L', title:'Large (100%)' },
]
const IMG_RE_WRAP = /^(img-wrap-left|img-wrap-right|img-block|img-behind)$/
const IMG_RE_SIZE = /^img-(sm|md|lg)$/

function WysiwygEditor({ value, onChange, placeholder, minHeight }) {
  const wrapRef = React.useRef(null)
  const ref = React.useRef(null)
  const imgElRef = React.useRef(null)                 // the DOM <img> we're editing (kept out of state to avoid mutation lint)
  const [active, setActive] = React.useState({})
  const [imgSel, setImgSel] = React.useState(null)    // { top, left, width, height, wrap, size }  — read-only position info

  /* Sync external value → DOM only when it differs AND we aren't typing,
     so the cursor never jumps mid-keystroke. */
  React.useEffect(() => {
    if (!ref.current) return
    const same = ref.current.innerHTML === (value || '')
    if (!same && document.activeElement !== ref.current) {
      ref.current.innerHTML = value || ''
      imgElRef.current = null
      setImgSel(null)
    }
  }, [value])

  /* Keep execCommand on HTML-tag mode (no styleWithCSS) — colours / sizes /
     highlights / alignment are routed through applySpanClass + applyBlockClass
     below, which use CLASS attributes that survive the backend sanitiser. */

  const sync = () => onChange(ref.current?.innerHTML || '')

  const run = (cmd, arg) => {
    ref.current?.focus()
    execCmd(cmd, arg)
    sync(); refreshActive()
  }

  /* Insert raw HTML at the caret using the Range API. We do NOT use
     execCommand('insertHTML') — it's unreliable in Firefox (it silently
     dropped class-wrapped spans, which is why text colour / highlight / custom
     size / image / table appeared to "do nothing"). This replaces any selected
     content and leaves the caret right after the inserted nodes. */
  const insertHtml = (html) => {
    ref.current?.focus()
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) {                       // no caret in the editor → append
      if (ref.current) ref.current.innerHTML += html
      sync(); refreshActive(); return
    }
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const tmp = document.createElement('div'); tmp.innerHTML = html
    const frag = document.createDocumentFragment(); let last = null
    while (tmp.firstChild) { last = tmp.firstChild; frag.appendChild(tmp.firstChild) }
    range.insertNode(frag)
    if (last) { range.setStartAfter(last); range.collapse(true); sel.removeAllRanges(); sel.addRange(range) }
    sync(); refreshActive()
  }

  /* Selection-aware heading / paragraph:
       · empty selection → format the current block (like Word's Style dropdown)
       · text selected   → wrap ONLY the selected text in the heading, splitting
                           the paragraph around it (Notion-style). */
  const applyBlock = (tag) => {
    ref.current?.focus()
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    if (range.collapsed || !sel.toString()) {
      execCmd('formatBlock', tag)
    } else {
      const wrapper = document.createElement(tag.toLowerCase())
      wrapper.appendChild(range.extractContents())
      range.insertNode(wrapper)
      const r = document.createRange(); r.selectNodeContents(wrapper)
      sel.removeAllRanges(); sel.addRange(r)
    }
    sync(); refreshActive()
  }

  /* Set text direction (LTR/RTL) on the block containing the cursor —
     essential for Arabic, Kurdish, Hebrew, Persian content. */
  const applyDir = (dir) => {
    ref.current?.focus()
    const sel = window.getSelection()
    let node = sel?.anchorNode
    if (node && node.nodeType === 3) node = node.parentNode
    while (node && node !== ref.current && !BLOCKS.has(node.tagName)) node = node.parentNode
    const target = node && node !== ref.current ? node : ref.current
    target.setAttribute('dir', dir)
    sync(); refreshActive()
  }

  /* Walk up from `node` to the closest BLOCK-level element inside the editor. */
  const closestBlock = (node) => {
    if (node && node.nodeType === 3) node = node.parentNode
    while (node && node !== ref.current && !BLOCKS.has(node.tagName)) node = node.parentNode
    return (node && node !== ref.current) ? node : null
  }

  /* Strip one regex's matching classes from every span inside a fragment.
     Empty spans (no classes, no attributes) are unwrapped to keep the
     output tidy and avoid runaway nesting after many edits. */
  const cleanFragmentSpans = (fragment, regex) => {
    fragment.querySelectorAll('span').forEach(s => {
      const keep = (s.className || '').split(/\s+/).filter(c => c && !regex.test(c))
      if (keep.length) s.className = keep.join(' ')
      else s.removeAttribute('class')
      if (!s.attributes.length && s.childNodes.length) {              // unwrap a now-classless span
        while (s.firstChild) s.parentNode.insertBefore(s.firstChild, s)
        s.remove()
      }
    })
  }

  /* Apply / clear an inline CLASS on the current selection (text colour,
     highlight, font-size preset, font family). Pass empty `cls` to remove all
     classes of that group from the selection.
     Uses the Range API (extractContents + insertNode) rather than
     execCommand('insertHTML') — the latter silently dropped these class-wrapped
     spans in Firefox, so colour/highlight appeared to do nothing. */
  const applySpanClass = (group, cls) => {
    const regex = GROUP_RE[group]; if (!regex) return
    ref.current?.focus()
    const sel = window.getSelection()
    if (!sel?.rangeCount) return
    const range = sel.getRangeAt(0)
    if (range.collapsed) return                                       // need a real selection
    const fragment = range.extractContents()
    cleanFragmentSpans(fragment, regex)                               // clear old colour/size/etc. on inner spans
    if (cls) {
      const wrapper = document.createElement('span')
      wrapper.className = cls
      wrapper.appendChild(fragment)
      range.insertNode(wrapper)
      const r = document.createRange(); r.selectNodeContents(wrapper)  // keep it selected → chain styles + see the highlight
      sel.removeAllRanges(); sel.addRange(r)
    } else {
      range.insertNode(fragment)                                      // remove: drop the cleaned content back, unwrapped
    }
    sync(); refreshActive()
  }

  /* Apply an inline CSS property (used for ARBITRARY values that don't have a
     preset class — chiefly user-typed font sizes like 17px, 22px, 100px).
     Cleans matching classes-of-group and existing same-property inline styles
     before wrapping. */
  /* Apply / clear a CLASS on the current block (paragraph / heading / li / quote).
     Used for alignment so it survives sanitiser stripping of inline styles. */
  const applyBlockClass = (group, cls) => {
    const regex = BLOCK_GROUP_RE[group]; if (!regex) return
    ref.current?.focus()
    const sel = window.getSelection()
    const block = closestBlock(sel?.anchorNode); if (!block) return
    const keep = (block.className || '').split(/\s+/).filter(c => c && !regex.test(c))
    if (cls) keep.push(cls)
    block.className = keep.join(' ')
    if (!block.className) block.removeAttribute('class')
    sync(); refreshActive()
  }

  /* Refresh which toolbar buttons appear "on" by querying the current selection. */
  const refreshActive = () => {
    try {
      /* class-based active states: walk up from the selection to find
         the closest span/block carrying a class in each group. Also detect
         arbitrary inline font-size (set by the manual size input). */
      let tc = '', hl = '', fs = '', ff = '', align = '', fsPx = 0
      const sel = window.getSelection()
      let n = sel?.anchorNode
      if (n && n.nodeType === 3) n = n.parentNode
      let cursor = n
      while (cursor && cursor !== ref.current) {
        if (cursor.classList?.length) {
          cursor.classList.forEach(c => {
            if (!tc && GROUP_RE.color.test(c)) tc = c
            if (!hl && GROUP_RE.hl.test(c))    hl = c
            if (!fs && GROUP_RE.size.test(c))  fs = c
            if (!ff && GROUP_RE.font.test(c))  ff = c
          })
        }
        if (!fsPx && cursor.style?.fontSize) {
          const m = cursor.style.fontSize.match(/(\d+(?:\.\d+)?)px/)
          if (m) fsPx = Math.round(parseFloat(m[1]))
        }
        cursor = cursor.parentNode
      }
      const block = closestBlock(n)
      if (block) align = (block.className || '').split(/\s+/).find(c => BLOCK_GROUP_RE.align.test(c)) || ''

      setActive({
        bold:                document.queryCommandState('bold'),
        italic:              document.queryCommandState('italic'),
        underline:           document.queryCommandState('underline'),
        strikeThrough:       document.queryCommandState('strikeThrough'),
        superscript:         document.queryCommandState('superscript'),
        subscript:           document.queryCommandState('subscript'),
        insertUnorderedList: document.queryCommandState('insertUnorderedList'),
        insertOrderedList:   document.queryCommandState('insertOrderedList'),
        tc, hl, fs, ff, align, fsPx,
      })
    } catch { /* old browsers — skip */ }
  }

  /* Compute the floating image-toolbar's position relative to the editor. */
  const positionImgToolbar = React.useCallback((el) => {
    if (!el || !wrapRef.current) return null
    const ir = el.getBoundingClientRect()
    const wr = wrapRef.current.getBoundingClientRect()
    const cls = (el.className || '').split(/\s+/).filter(Boolean)
    return {
      top:    Math.max(8, ir.top - wr.top - 46),
      left:   Math.max(8, ir.left - wr.left),
      width:  ir.width,
      height: ir.height,
      wrap:   cls.find(c => IMG_RE_WRAP.test(c)) || '',
      size:   cls.find(c => IMG_RE_SIZE.test(c)) || '',
    }
  }, [])

  /* Click on an <img> → show the floating toolbar; click anywhere else → hide it. */
  const onMouseUp = (e) => {
    refreshActive()
    if (e.target?.tagName === 'IMG') {
      imgElRef.current = e.target
      setImgSel(positionImgToolbar(e.target))
    } else {
      imgElRef.current = null
      setImgSel(null)
    }
  }

  /* Replace one of the image's wrap or size classes (mutually exclusive within group). */
  const updateImgClass = (group, next) => {
    const el = imgElRef.current; if (!el) return
    const re = group === 'wrap' ? IMG_RE_WRAP : IMG_RE_SIZE
    const keep = (el.className || '').split(/\s+/).filter(c => c && !re.test(c))
    if (next) keep.push(next)
    el.className = keep.join(' ')
    sync()
    requestAnimationFrame(() => setImgSel(positionImgToolbar(el)))
  }

  const editImgAlt = async () => {
    const el = imgElRef.current; if (!el) return
    const alt = await uiPrompt({
      title: 'Image alt text',
      label: 'Describe the image for screen readers',
      placeholder: 'e.g. Histogram of subject ages',
      initial: el.alt || '',
      icon: 'image',
    })
    if (alt === null) return
    el.alt = alt; sync()
  }

  const replaceImg = async () => {
    const el = imgElRef.current; if (!el) return
    const url = await uiPrompt({
      title: 'Replace image',
      label: 'New image URL (http / https)',
      placeholder: 'https://…',
      initial: el.getAttribute('src') || 'https://',
      icon: 'image',
    })
    if (!url) return
    el.setAttribute('src', url); sync()
    requestAnimationFrame(() => setImgSel(positionImgToolbar(el)))
  }

  const deleteImg = () => {
    const el = imgElRef.current; if (!el) return
    el.remove(); imgElRef.current = null; setImgSel(null); sync()
  }

  const onPaste = (e) => {
    e.preventDefault()
    const html = e.clipboardData.getData('text/html')
    const text = e.clipboardData.getData('text/plain')
    if (html) { insertHtml(renderSafeHtml(html)); return }   // Range-API insert (insertHtml syncs); FF-safe
    if (text) { execCmd('insertText', text); sync() }
  }

  const onKey = (e) => {
    if (e.key === 'Tab') {                                      // Tab indents (Shift+Tab outdents) inside lists
      e.preventDefault(); execCmd(e.shiftKey ? 'outdent' : 'indent'); sync(); return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      uiPrompt({ title:'Insert link', label:'Link URL', placeholder:'https://…', initial:'https://', icon:'link' })
        .then(url => { if (url) run('createLink', url) })
    }
  }

  /* Keep the image toolbar attached when the editor scrolls or the window resizes. */
  React.useEffect(() => {
    if (!imgSel) return
    const reflow = () => { const el = imgElRef.current; if (el) setImgSel(positionImgToolbar(el)) }
    window.addEventListener('resize', reflow)
    const scrollEl = ref.current
    scrollEl?.addEventListener('scroll', reflow)
    return () => { window.removeEventListener('resize', reflow); scrollEl?.removeEventListener('scroll', reflow) }
  }, [imgSel, positionImgToolbar])

  return (
    <div ref={wrapRef} className="rte-wysiwyg-wrap">
      <WysiwygToolbar
        run={run} insertHtml={insertHtml} active={active}
        applyBlock={applyBlock} applyDir={applyDir}
        applySpanClass={applySpanClass} applyBlockClass={applyBlockClass}
      />
      <div
        ref={ref}
        className={'rte-wysiwyg prose' + (imgSel ? ' has-img-sel' : '')}
        contentEditable
        dir="auto"
        suppressContentEditableWarning
        spellCheck="true"
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        style={{ minHeight }}
        onInput={sync}
        onKeyDown={onKey}
        onKeyUp={refreshActive}
        onMouseUp={onMouseUp}
        onFocus={refreshActive}
        onPaste={onPaste}
      />
      {imgSel && <ImageToolbar sel={imgSel} onWrap={(c) => updateImgClass('wrap', c)} onSize={(c) => updateImgClass('size', c)} onAlt={editImgAlt} onReplace={replaceImg} onDelete={deleteImg}/>}
    </div>
  )
}

/* MS Word-style image properties popup — appears above a selected image. */
function ImageToolbar({ sel, onWrap, onSize, onAlt, onReplace, onDelete }) {
  return (
    <div className="rte-img-bar" style={{ top: sel.top, left: sel.left }} onMouseDown={(e) => e.preventDefault()}>
      {IMG_WRAP.map(w => (
        <button key={w.cls || 'inline'} type="button"
          className={'rte-img-btn ' + (sel.wrap === w.cls ? 'on' : '')}
          title={w.title} onClick={() => onWrap(w.cls)}>
          <Icon name={w.icon}/>
        </button>
      ))}
      <span className="rte-tool-sep"/>
      {IMG_SIZES.map(s => (
        <button key={s.cls} type="button"
          className={'rte-img-btn ' + (sel.size === s.cls ? 'on' : '')}
          title={s.title} onClick={() => onSize(s.cls)}>
          <span className="rte-img-size">{s.label}</span>
        </button>
      ))}
      <span className="rte-tool-sep"/>
      <button type="button" className="rte-img-btn" title="Alt text"  onClick={onAlt}><span className="rte-img-alt">Alt</span></button>
      <button type="button" className="rte-img-btn" title="Replace"   onClick={onReplace}><Icon name="upload"/></button>
      <button type="button" className="rte-img-btn danger" title="Delete" onClick={onDelete}><Icon name="close"/></button>
    </div>
  )
}

function ToolBtn({ icon, title, on, onClick, label, children }) {
  return (
    <button
      type="button"
      className={'rte-tool ' + (on ? 'on' : '')}
      title={title}
      onMouseDown={(e) => e.preventDefault()}              /* don't steal selection */
      onClick={onClick}
    >
      {children ?? (label ? <span className="rte-tool-text">{label}</span> : <Icon name={icon}/>)}
    </button>
  )
}
const Sep = () => <span className="rte-tool-sep" aria-hidden="true"/>

/* Selection-aware heading buttons — wrap the selected text in a heading
   (splitting the paragraph) rather than re-styling the whole block. */
function HeadingButtons({ applyBlock }) {
  return (<>
    <ToolBtn label="H1" title="Heading 1 — wraps the selected text" onClick={() => applyBlock('H1')}/>
    <ToolBtn label="H2" title="Heading 2 — wraps the selected text" onClick={() => applyBlock('H2')}/>
    <ToolBtn label="H3" title="Heading 3 — wraps the selected text" onClick={() => applyBlock('H3')}/>
    <ToolBtn label="H4" title="Heading 4 — wraps the selected text" onClick={() => applyBlock('H4')}/>
    <ToolBtn label="¶"  title="Plain paragraph"                      onClick={() => applyBlock('P')}/>
  </>)
}

function usePopover() {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef(null)
  React.useEffect(() => {
    if (!open) return
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return [open, setOpen, ref]
}

/* Class-based colour / highlight picker. Each swatch carries the CSS class
   that the apply function will wrap the selection in. */
function ColorPicker({ title, swatch, colors, onPick, activeClass }) {
  const [open, setOpen, ref] = usePopover()
  return (
    <span className="rte-pop-wrap" ref={ref}>
      <ToolBtn title={title} on={!!activeClass} onClick={() => setOpen(o => !o)}>
        {swatch}
        <span className="rte-caret"/>
      </ToolBtn>
      {open && (
        <div className="rte-popover">
          <div className="rte-color-grid">
            {colors.map(c => (
              <button key={c.cls || 'none'} type="button"
                className={'rte-color-swatch ' + (c.none ? 'none' : '') + (activeClass === c.cls ? ' on' : '')}
                style={{ background: c.none ? '#fff' : c.val }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(c.cls); setOpen(false) }}
                title={c.none ? 'None' : c.val}/>
            ))}
          </div>
        </div>
      )}
    </span>
  )
}

/* Font-size dropdown — Word-style. The trigger shows the current size as
   a small mono badge. The dropdown opens with a NUMBER INPUT at the top so
   the author can type ANY size (e.g. 17, 22, 100). Common presets are
   listed beneath, each rendered at its own size as a true preview. */
function SizePicker({ sizes, onPick, activeClass, activePx }) {
  const [open, setOpen, ref] = usePopover()
  const [draft, setDraft] = React.useState('')
  const inputRef = React.useRef(null)
  const preset = sizes.find(s => s.cls === activeClass)
  const display = activePx ? String(activePx) : (preset?.label || '16')

  React.useEffect(() => {
    if (open) requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select?.() })
    if (open) setDraft(display)                                              // pre-fill with current size
  }, [open, display])

  const apply = (raw) => {
    const px = parseInt(raw, 10)
    if (!Number.isFinite(px) || px < 6 || px > 200) return
    const match = sizes.find(s => s.label === String(px))
    if (match) onPick(match.cls)                                              // exact preset → clean class
    else {
      // Snap any other value to the NEAREST preset class. An inline
      // style="font-size:Npx" would be stripped by the sanitiser on publish
      // (the size shows while editing then vanishes) — so we never emit one.
      const presets = sizes.map(s => ({ cls: s.cls, n: parseInt(s.label, 10) })).filter(p => Number.isFinite(p.n))
      const near = presets.reduce((a, b) => Math.abs(b.n - px) < Math.abs(a.n - px) ? b : a, presets[0])
      onPick(near.cls)
    }
    setOpen(false); setDraft('')
  }

  return (
    <span className="rte-pop-wrap" ref={ref}>
      <ToolBtn title="Font size — type any value or pick a preset" on={!!activeClass || !!activePx} onClick={() => setOpen(o => !o)}>
        <span className="rte-size-display">{display}</span>
        <span className="rte-caret"/>
      </ToolBtn>
      {open && (
        <div className="rte-popover rte-size-popover">
          <div className="rte-size-input-row" onMouseDown={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              type="number" min="6" max="200" step="1"
              className="rte-size-input"
              placeholder="Type size…"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(draft) } }}
            />
            <button type="button" className="rte-size-apply" disabled={!draft || !parseInt(draft, 10)} onClick={() => apply(draft)}>
              Apply
            </button>
          </div>
          <div className="rte-size-divider"/>
          {sizes.map(s => (
            <button key={s.cls || 'normal'} type="button"
              className={'rte-size-row ' + (activeClass === s.cls && !activePx ? 'on' : '') + (s.cls ? ' ' + s.cls : ' fs-default')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(s.cls); setOpen(false); setDraft('') }}>
              <span className="rte-size-num">{s.label}</span>
              <small className="rte-size-hint">{s.hint}</small>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/* Font family dropdown — "Aa" rendered in the current family, so the trigger
   button itself shows what's active. */
function FamilyPicker({ families, onPick, activeClass }) {
  const [open, setOpen, ref] = usePopover()
  const active = families.find(f => f.cls === activeClass) || families[0]
  return (
    <span className="rte-pop-wrap" ref={ref}>
      <ToolBtn title="Font family" on={!!activeClass} onClick={() => setOpen(o => !o)}>
        <span className="rte-family-display" style={{ fontFamily: active.family }}>Aa</span>
        <span className="rte-caret"/>
      </ToolBtn>
      {open && (
        <div className="rte-popover rte-size-popover">
          {families.map(f => (
            <button key={f.cls || 'serif'} type="button"
              className={'rte-size-row ' + (activeClass === f.cls ? 'on' : '')}
              style={{ fontFamily: f.family }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(f.cls); setOpen(false) }}>
              <span className="rte-size-num">Aa</span>
              <small className="rte-size-hint">{f.label}</small>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

function TablePicker({ insertHtml }) {
  const [open, setOpen, ref] = usePopover()
  const [hover, setHover] = React.useState({ r: -1, c: -1 })
  const ROWS = 6, COLS = 8

  const insert = (rows, cols) => {
    const headCells = Array(cols).fill('<th>Heading</th>').join('')
    const bodyRow   = '<tr>' + Array(cols).fill('<td>Cell</td>').join('') + '</tr>'
    const tbody     = '<tbody>' + Array(Math.max(1, rows - 1)).fill(bodyRow).join('') + '</tbody>'
    insertHtml(`<table><thead><tr>${headCells}</tr></thead>${tbody}</table><p><br/></p>`)
    setOpen(false); setHover({ r: -1, c: -1 })
  }

  return (
    <span className="rte-pop-wrap" ref={ref}>
      <ToolBtn title="Insert table" icon="table" onClick={() => setOpen(o => !o)}/>
      {open && (
        <div className="rte-popover rte-table-popover">
          <div className="rte-table-grid" onMouseLeave={() => setHover({ r: -1, c: -1 })}>
            {Array(ROWS).fill(0).map((_, r) => (
              <div key={r} className="rte-table-row">
                {Array(COLS).fill(0).map((_, c) => (
                  <button key={c} type="button"
                    className={'rte-table-cell ' + (r <= hover.r && c <= hover.c ? 'on' : '')}
                    onMouseEnter={() => setHover({ r, c })}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insert(r + 1, c + 1)}/>
                ))}
              </div>
            ))}
          </div>
          <div className="rte-table-label">
            {hover.r >= 0 ? `${hover.r + 1} × ${hover.c + 1}` : 'Choose size'}
          </div>
        </div>
      )}
    </span>
  )
}

const TextColorSwatch = () => (
  <span className="rte-color-icon"><span className="letter">A</span><span className="bar"/></span>
)
const HighlightSwatch = () => (
  <span className="rte-color-icon"><span className="letter hl">H</span><span className="bar yellow"/></span>
)

function WysiwygToolbar({ run, insertHtml, active, applyBlock, applyDir, applySpanClass, applyBlockClass }) {
  const onLink = async () => {
    const url = await uiPrompt({ title:'Insert link', label:'Link URL', placeholder:'https://…', initial:'https://', icon:'link' })
    if (url) run('createLink', url)
  }
  const onImage = async () => {
    const url = await uiPrompt({ title:'Insert image', label:'Image URL (http or https only)', placeholder:'https://…', initial:'https://', icon:'image' })
    if (url) insertHtml(`<img src="${url}" alt=""/>`)
  }
  return (
    <div className="rte-tools rte-wysiwyg-tools" role="toolbar" aria-label="Formatting">
      {/* Headings — selection-aware */}
      <HeadingButtons applyBlock={applyBlock}/>
      <Sep/>
      {/* Font size — every value resolves to a CSS class (sanitiser-safe): an exact
          preset, or the nearest preset when a custom value is typed. We never emit an
          inline style="font-size" (it would be stripped on publish). */}
      <SizePicker
        sizes={FONT_SIZES}
        onPick={(cls) => applySpanClass('size', cls)}
        activeClass={active.fs}
        activePx={active.fsPx}
      />
      {/* Font family */}
      <FamilyPicker families={FONT_FAMILIES} onPick={(cls) => applySpanClass('font', cls)} activeClass={active.ff}/>
      <Sep/>
      {/* Inline formatting (selection-aware via execCommand → <b>/<i>/<u>/<s>) */}
      <ToolBtn icon="bold"      title="Bold (⌘B)"        on={active.bold}           onClick={() => run('bold')}/>
      <ToolBtn icon="italic"    title="Italic (⌘I)"      on={active.italic}         onClick={() => run('italic')}/>
      <ToolBtn icon="underline" title="Underline (⌘U)"   on={active.underline}      onClick={() => run('underline')}/>
      <ToolBtn icon="strike"    title="Strikethrough"     on={active.strikeThrough} onClick={() => run('strikeThrough')}/>
      <ToolBtn label={<span>X<sup>2</sup></span>} title="Superscript" on={active.superscript} onClick={() => run('superscript')}/>
      <ToolBtn label={<span>X<sub>2</sub></span>} title="Subscript"   on={active.subscript}   onClick={() => run('subscript')}/>
      <Sep/>
      {/* Colour & highlight — class-based (survives the sanitiser) */}
      <ColorPicker title="Text colour" swatch={<TextColorSwatch/>} colors={TEXT_COLORS}      onPick={(cls) => applySpanClass('color', cls)} activeClass={active.tc}/>
      <ColorPicker title="Highlight"   swatch={<HighlightSwatch/>} colors={HIGHLIGHT_COLORS} onPick={(cls) => applySpanClass('hl',    cls)} activeClass={active.hl}/>
      <Sep/>
      {/* Lists & block formats */}
      <ToolBtn icon="ulist"     title="Bulleted list"    on={active.insertUnorderedList} onClick={() => run('insertUnorderedList')}/>
      <ToolBtn icon="olist"     title="Numbered list"    on={active.insertOrderedList}   onClick={() => run('insertOrderedList')}/>
      <ToolBtn icon="quote2"    title="Block quote"       onClick={() => run('formatBlock', 'blockquote')}/>
      <ToolBtn icon="codeblock" title="Code block"        onClick={() => run('formatBlock', 'pre')}/>
      <Sep/>
      {/* Alignment + justify — class-based, applied to the current block */}
      <ToolBtn icon="alignLeft"    title="Align left"   on={active.align === 'align-left'}    onClick={() => applyBlockClass('align', 'align-left')}/>
      <ToolBtn icon="alignCenter"  title="Centre"       on={active.align === 'align-center'}  onClick={() => applyBlockClass('align', 'align-center')}/>
      <ToolBtn icon="alignRight"   title="Align right"  on={active.align === 'align-right'}   onClick={() => applyBlockClass('align', 'align-right')}/>
      <ToolBtn icon="alignJustify" title="Justify"      on={active.align === 'align-justify'} onClick={() => applyBlockClass('align', 'align-justify')}/>
      <Sep/>
      {/* Indent / outdent — execCommand legacy (wraps in <blockquote>/unwraps) */}
      <ToolBtn icon="outdent" title="Decrease indent" onClick={() => run('outdent')}/>
      <ToolBtn icon="indent"  title="Increase indent" onClick={() => run('indent')}/>
      <Sep/>
      {/* Text direction — essential for Arabic / Kurdish / Hebrew / Persian */}
      <ToolBtn label="LTR" title="Left-to-right paragraph" onClick={() => applyDir('ltr')}/>
      <ToolBtn label="RTL" title="Right-to-left paragraph" onClick={() => applyDir('rtl')}/>
      <Sep/>
      {/* Insert */}
      <ToolBtn icon="link"   title="Insert link (⌘K)" onClick={onLink}/>
      <ToolBtn icon="image"  title="Insert image"     onClick={onImage}/>
      <TablePicker insertHtml={insertHtml}/>
      <ToolBtn icon="hr"     title="Horizontal rule"  onClick={() => run('insertHorizontalRule')}/>
      <Sep/>
      <ToolBtn icon="erase"  title="Clear formatting" onClick={() => run('removeFormat')}/>
    </div>
  )
}

/* ======================================================================== */
/*  Main component                                                          */
/* ======================================================================== */

export function RichTextEditor({
  value, format, onChange, onFormatChange,
  placeholder, minHeight = 160, autoDetect = true,
  showFormat = true, label,
}) {
  const taRef = React.useRef(null)
  const [tab, setTab] = React.useState('write')
  const [detected, setDetected] = React.useState(false)
  const fmt = String(format || 'PLAIN').toUpperCase()

  /* Auto-detect on first non-empty edit (only when still PLAIN). */
  React.useEffect(() => {
    if (!autoDetect || detected || !value || fmt !== 'PLAIN') return
    const guess = detectFormat(value)
    if (guess !== 'PLAIN') { onFormatChange?.(guess); setDetected(true) }
  }, [value, fmt, autoDetect, detected, onFormatChange])

  /* ---- MD textarea helpers ---- */
  const setSel = (start, end = start) => requestAnimationFrame(() => {
    const el = taRef.current; if (!el) return
    el.focus(); el.setSelectionRange(start, end)
  })
  const replace = (start, end, text, selStart, selEnd) => {
    const el = taRef.current; if (!el) return
    const next = el.value.slice(0, start) + text + el.value.slice(end)
    onChange(next)
    setSel(selStart ?? start + text.length, selEnd ?? selStart ?? start + text.length)
  }
  const wrap = (before, after = before) => {
    const el = taRef.current; if (!el) return
    const s = el.selectionStart, e = el.selectionEnd
    const sel = el.value.slice(s, e); const inner = sel || 'text'
    replace(s, e, before + inner + after, s + before.length, s + before.length + inner.length)
  }
  const prefixBlock = (prefix) => {
    const el = taRef.current; if (!el) return
    const s = el.selectionStart, e = el.selectionEnd
    const lineStart = el.value.lastIndexOf('\n', s - 1) + 1
    const block = el.value.slice(lineStart, Math.max(e, lineStart))
    const newBlock = (block || 'text').split('\n').map(l => prefix + l).join('\n')
    replace(lineStart, e, newBlock, lineStart, lineStart + newBlock.length)
  }
  const insert = (snippet) => {
    const el = taRef.current; if (!el) return
    const s = el.selectionStart
    replace(s, s, snippet, s + snippet.length, s + snippet.length)
  }
  const runMd = async (t) => {
    if (t.wrap) return wrap(t.wrap[0], t.wrap[1])
    if (t.prefix) return prefixBlock(t.prefix)
    if (t.action === 'link') {
      const url = await uiPrompt({ title:'Insert link', label:'Link URL', placeholder:'https://…', initial:'https://', icon:'link' })
      if (!url) return
      const el = taRef.current; const sel = el.value.slice(el.selectionStart, el.selectionEnd) || 'link text'
      const s = el.selectionStart, e = el.selectionEnd
      replace(s, e, `[${sel}](${url})`)
    }
    if (t.action === 'image') {
      const url = await uiPrompt({ title:'Insert image', label:'Image URL (http or https)', placeholder:'https://…', initial:'https://', icon:'image' })
      if (!url) return
      insert(`![](${url})`)
    }
    if (t.action === 'pre') return wrap('\n```\n', '\n```\n')
    if (t.action === 'table') return insert('\n\n| Column | Column |\n| --- | --- |\n| Cell | Cell |\n\n')
    if (t.action === 'hr')    return insert('\n\n---\n\n')
  }
  const onMdKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const el = taRef.current; const pos = el.selectionStart
      const lineStart = el.value.lastIndexOf('\n', pos - 1) + 1
      const line = el.value.slice(lineStart, pos)
      const m = line.match(/^(\s*)((?:[-*+]|\d+\.)\s|>\s)(.*)$/)
      if (m) {
        e.preventDefault()
        if (!m[3].trim()) { replace(lineStart, pos, '', lineStart); return }
        const next = '\n' + m[1] + (m[2].match(/^\d+/) ? (parseInt(m[2]) + 1) + '. ' : m[2])
        replace(pos, pos, next); return
      }
    }
    if (!(e.metaKey || e.ctrlKey)) return
    const k = e.key.toLowerCase()
    if (k === 'b') { e.preventDefault(); runMd(MD_TOOLS.find(t => t.key === 'bold')) }
    else if (k === 'i') { e.preventDefault(); runMd(MD_TOOLS.find(t => t.key === 'italic')) }
    else if (k === 'e') { e.preventDefault(); runMd(MD_TOOLS.find(t => t.key === 'code')) }
    else if (k === 'k') { e.preventDefault(); void runMd({ action:'link' }) }
  }

  const previewHtml = React.useMemo(() => renderByFormat(value || '', fmt), [value, fmt])

  return (
    <div className="rte">
      <div className="rte-bar">
        {label && <span className="rte-label">{label}</span>}
        {showFormat && (
          <div className="rte-fmt" role="group" aria-label="Body format">
            {FORMATS.map(f => (
              <button key={f.key} type="button"
                className={'rte-fmt-pill ' + (fmt === f.key ? 'on' : '')}
                title={f.desc}
                onClick={() => { onFormatChange?.(f.key); setTab('write') }}>
                {f.label}
              </button>
            ))}
          </div>
        )}
        {fmt === 'MARKDOWN' && (
          <div className="rte-tabs" role="tablist">
            <button type="button" className={'rte-tab ' + (tab === 'write'   ? 'on' : '')} onClick={() => setTab('write')}>Write</button>
            <button type="button" className={'rte-tab ' + (tab === 'preview' ? 'on' : '')} onClick={() => setTab('preview')}>Preview</button>
          </div>
        )}
      </div>

      {fmt === 'HTML' ? (
        <WysiwygEditor value={value} onChange={onChange} placeholder={placeholder} minHeight={minHeight}/>
      ) : fmt === 'MARKDOWN' ? (
        <>
          {tab === 'write' && (
            <div className="rte-tools" role="toolbar" aria-label="Markdown formatting">
              {MD_TOOLS.map((t, i) => t.sep
                ? <span key={'sep'+i} className="rte-tool-sep" aria-hidden="true"/>
                : <button key={t.key} type="button" className="rte-tool" title={t.title} onClick={() => runMd(t)}>
                    {t.icon ? <Icon name={t.icon}/> : <span className="rte-tool-text">{t.label}</span>}
                  </button>
              )}
            </div>
          )}
          {tab === 'write' ? (
            <textarea
              ref={taRef}
              className="rte-area"
              dir="auto"
              value={value || ''}
              onChange={e => onChange(e.target.value)}
              onKeyDown={onMdKey}
              placeholder={placeholder}
              spellCheck="true"
              style={{ minHeight }}
            />
          ) : (
            <div className="rte-preview prose" style={{ minHeight }}
              dangerouslySetInnerHTML={{ __html: previewHtml || '<p class="rte-empty">Nothing to preview yet.</p>' }}/>
          )}
          {tab === 'write' && (
            <div className="rte-hint">
              <Icon name="help" className="xs"/>
              <span><b>Markdown:</b> <code>**bold**</code> · <code>*italic*</code> · <code>~~strike~~</code> · <code>`code`</code> · <code>[link](url)</code> · <code>## H2</code> · <code>- list</code> · <code>&gt; quote</code> · <code>---</code> · GFM tables</span>
            </div>
          )}
        </>
      ) : (
        <textarea
          ref={taRef}
          className="rte-area"
          dir="auto"
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck="true"
          style={{ minHeight }}
        />
      )}
    </div>
  )
}
