/* =========================================================
   Reel studio — put text, emoji and moving stickers on a reel.

   The story editor bakes its design into a flat image. A reel
   cannot: a photo would freeze every sticker and a video would
   need a full re-encode. So this surface authors DATA — the
   same overlay document the viewer draws live — and what is on
   the stage here is what is drawn there, because both sides
   anchor to the media's own rectangle and share one geometry
   helper (lib/reelOverlay.js).

   LAYOUT: one centred composition, never a smear. The stage is
   sized off the surface's HEIGHT (its width follows from 9:16),
   and every control lives in the DOCK — a bounded card that
   sits beside the stage where there is room and under it on
   phones. The dock shows exactly one thing at a time: a glyph
   tray, the selected item's controls, or a hint. Full-window
   sliders and stranded swatch rows are what this replaced.

   The stage fits the media exactly as the viewer does: `cover`
   for a clip, `contain` for a photo — and carries the viewer's
   scrim, so an author can see what the bottom gradient will do
   to their text before anyone else does.
   ========================================================= */
import React from 'react'
import { Icon } from './ui.jsx'
import {
  ALIGNS, COLORS, EMOJI, FONTS, MAX_ITEMS, MAX_TEXT, MOTIONS, STICKERS,
  mediaRect, serialiseOverlay,
} from '../lib/reelOverlay.js'

const uid = () => Math.random().toString(36).slice(2, 9)
/* Keeps an item inside the frame: the reels viewer clips at the card edge
   (overflow:hidden + contain:paint), so anything past this is simply lost. */
const CLAMP = { min: .06, max: .94 }
const clampPos = (v) => Math.min(CLAMP.max, Math.max(CLAMP.min, v))

function newItem(kind, text, motion = 0) {
  return {
    id: uid(), k: kind, text,
    x: .5, y: kind === 't' ? .42 : .5,
    r: 0,
    s: kind === 't' ? .085 : .18,
    f: 0, c: 0, a: 1, m: motion, bg: 0,
  }
}

/** One draggable item on the stage. Pointer capture, so a fast drag that
 *  leaves the glyph keeps tracking — the same model the story editor uses. */
function StageItem({ item, rect, selected, onSelect, onMove }) {
  const start = React.useRef(null)

  const down = (e) => {
    e.stopPropagation()
    onSelect(item.id)
    start.current = { id: e.pointerId, px: e.clientX, py: e.clientY, x: item.x, y: item.y }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const move = (e) => {
    const s = start.current
    if (!s || s.id !== e.pointerId || !rect.width) return
    onMove(item.id, {
      x: clampPos(s.x + (e.clientX - s.px) / rect.width),
      y: clampPos(s.y + (e.clientY - s.py) / rect.height),
    })
  }
  const up = (e) => {
    if (start.current?.id === e.pointerId) { e.currentTarget.releasePointerCapture?.(e.pointerId); start.current = null }
  }

  const font = FONTS[item.f] || FONTS[0]
  return (
    <span
      className={'rs-item' + (item.k === 't' ? ' is-text' : ' is-glyph') + (item.bg ? ' has-bg' : '') + (selected ? ' on' : '')}
      style={{
        left: `${item.x * 100}%`,
        top: `${item.y * 100}%`,
        transform: `translate(-50%,-50%) rotate(${item.r}deg)`,
        fontSize: `${rect.width * item.s}px`,
        color: COLORS[item.c] || COLORS[0],
        fontFamily: item.k === 't' ? font.css : undefined,
        fontWeight: item.k === 't' ? font.weight : undefined,
        textAlign: ALIGNS[item.a] || 'center',
      }}
      data-m={item.m || undefined}
      dir="auto"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
    >{item.text}</span>
  )
}

/**
 * @param file      the attached reel media (image or video)
 * @param initial   an overlay document to keep editing, or null
 * @param onCancel  leave, discard nothing
 * @param onSave    (doc|null) — null means "no overlay"
 */
export function ReelStudio({ file, initial, onCancel, onSave }) {
  const isVideo = !!file && file.type?.startsWith('video')
  const fit = isVideo ? 'cover' : 'contain'          // exactly what the viewer does
  const [items, setItems] = React.useState(() => (initial?.items || []).map(i => ({ ...i, id: uid() })))
  const [sel, setSel] = React.useState(null)
  const [tray, setTray] = React.useState(null)        // 'emoji' | 'sticker' | null
  const [draft, setDraft] = React.useState(null)      // text being typed
  const [media, setMedia] = React.useState({ w: 0, h: 0 })
  const [box, setBox] = React.useState({ width: 0, height: 0 })

  const stageRef = React.useRef(null)
  const [url, setUrl] = React.useState(null)
  React.useEffect(() => {
    if (!file) return
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])

  React.useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      setBox({ width: r.width, height: r.height })
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* Intrinsic size via a REF CALLBACK as well as the load event: a cached
     image is already `complete` when React attaches handlers, the event never
     fires, and the fit rect silently falls back to the whole stage — which
     puts the author's text on the letterbox instead of on the photo. */
  const readIntrinsics = React.useCallback((el) => {
    if (!el) return
    const w = el.naturalWidth || el.videoWidth || 0
    const h = el.naturalHeight || el.videoHeight || 0
    if (w && h) setMedia(m => (m.w === w && m.h === h ? m : { w, h }))
  }, [])

  const rect = mediaRect(box, media.w, media.h, fit)
  const selected = items.find(i => i.id === sel) || null
  const patch = (id, next) => setItems(list => list.map(i => (i.id === id ? { ...i, ...next } : i)))
  const select = (id) => { setSel(id); setTray(null) }   // the dock shows one thing at a time
  const add = (item) => {
    if (items.length >= MAX_ITEMS) return
    setItems(list => [...list, item])
    setSel(item.id)
    setTray(null)
  }

  const commitText = () => {
    const text = (draft?.text || '').trim()
    if (!text) { setDraft(null); return }
    if (draft.id) patch(draft.id, { text })
    else add(newItem('t', text))
    setDraft(null)
  }

  const save = () => onSave(serialiseOverlay(items, fit))

  /* ---- the dock's single occupant ---- */
  const dock = tray === 'emoji' ? (
    <div className="rs-tray" role="listbox" aria-label="Emoji">
      {EMOJI.map(e => <button key={e} className="rs-glyph" onClick={() => add(newItem('e', e))}>{e}</button>)}
    </div>
  ) : tray === 'sticker' ? (
    <div className="rs-tray" role="listbox" aria-label="Moving stickers">
      {STICKERS.map(s => (
        <button key={s.g + s.m} className="rs-glyph" data-m={s.m || undefined}
          title={`${s.label} · ${MOTIONS[s.m].label}`}
          onClick={() => add(newItem('s', s.g, s.m))}>{s.g}</button>
      ))}
    </div>
  ) : selected ? (
    <>
      <div className="rs-sec">
        <h5>Place</h5>
        <div className="rs-row">
          <span className="rs-lab">Size</span>
          <input type="range" min="3" max="45" value={Math.round(selected.s * 100)}
            aria-label="Size" onChange={e => patch(selected.id, { s: Number(e.target.value) / 100 })}/>
          <span className="rs-val">{Math.round(selected.s * 100)}</span>
        </div>
        <div className="rs-row">
          <span className="rs-lab">Turn</span>
          <input type="range" min="-45" max="45" value={selected.r}
            aria-label="Rotation" onChange={e => patch(selected.id, { r: Number(e.target.value) })}/>
          <span className="rs-val">{selected.r}°</span>
        </div>
      </div>

      {selected.k === 't' && (
        <div className="rs-sec">
          <h5>Colour</h5>
          <div className="rs-swatches">
            {COLORS.map((c, i) => (
              <button key={c} className={'rs-sw' + (selected.c === i ? ' on' : '')} style={{ background: c }}
                aria-label={`Colour ${i + 1}`} onClick={() => patch(selected.id, { c: i })}/>
            ))}
          </div>
        </div>
      )}
      {selected.k === 't' && (
        <div className="rs-sec">
          <h5>Style</h5>
          <div className="rs-chips">
            {FONTS.map(f => (
              <button key={f.id} className={'rs-chip' + (selected.f === f.id ? ' on' : '')}
                onClick={() => patch(selected.id, { f: f.id })}>{f.label}</button>
            ))}
            <button className={'rs-chip' + (selected.bg ? ' on' : '')}
              onClick={() => patch(selected.id, { bg: selected.bg ? 0 : 1 })}>Plate</button>
            <button className="rs-chip" onClick={() => setDraft({ id: selected.id, text: selected.text })}>Edit text</button>
          </div>
        </div>
      )}

      <div className="rs-sec">
        <h5>Motion</h5>
        <div className="rs-chips">
          {MOTIONS.map(m => (
            <button key={m.id} className={'rs-chip' + (selected.m === m.id ? ' on' : '')}
              onClick={() => patch(selected.id, { m: m.id })}>{m.label}</button>
          ))}
        </div>
      </div>

      <button className="rs-del" onClick={() => { setItems(l => l.filter(i => i.id !== selected.id)); setSel(null) }}>
        <Icon name="trash" className="xs"/>Remove from reel
      </button>
    </>
  ) : (
    <div className="rs-tips">
      <b>Everything here plays on top of the reel.</b>
      <span>Add text, emoji or a moving sticker with the tools below, drag it into place, then tap it to set its size, colour and motion.</span>
    </div>
  )

  return (
    <div className="rs-wrap" role="dialog" aria-modal="true" aria-label="Add text and stickers">
      <header className="rs-bar">
        <button className="rs-ghost" onClick={onCancel}>Cancel</button>
        <span className="rs-count">{items.length ? `${items.length}/${MAX_ITEMS}` : 'Tap a tool below'}</span>
        <button className="btn btn-primary btn-sm" onClick={save}>Done</button>
      </header>

      <div className="rs-main">
        <div className="rs-stagecol">
          <div ref={stageRef} className="rs-stage" onPointerDown={() => setSel(null)}>
            {url && (isVideo
              ? <video ref={readIntrinsics} className="rs-media" src={url} style={{ objectFit: fit }} muted loop autoPlay playsInline
                  onLoadedMetadata={e => readIntrinsics(e.currentTarget)}/>
              : <img ref={readIntrinsics} className="rs-media" src={url} alt="" style={{ objectFit: fit }}
                  onLoad={e => readIntrinsics(e.currentTarget)}/>)}
            <div className="rs-scrim" aria-hidden="true"/>
            <div className="rs-fit" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
              {items.map(it => (
                <StageItem key={it.id} item={it} rect={rect} selected={sel === it.id}
                  onSelect={select} onMove={patch}/>
              ))}
            </div>
            {!items.length && !draft && <p className="rs-hint">Text and stickers you add here play on top of the reel.</p>}
          </div>
        </div>

        <aside className="rs-dock">{dock}</aside>
      </div>

      <nav className="rs-tools">
        <button onClick={() => { setSel(null); setDraft({ id: null, text: '' }) }}><Icon name="compose"/><small>Text</small></button>
        <button className={tray === 'emoji' ? 'on' : ''} onClick={() => { setSel(null); setTray(t => (t === 'emoji' ? null : 'emoji')) }}><Icon name="smile"/><small>Emoji</small></button>
        <button className={tray === 'sticker' ? 'on' : ''} onClick={() => { setSel(null); setTray(t => (t === 'sticker' ? null : 'sticker')) }}><Icon name="sparkle"/><small>Stickers</small></button>
        {!!items.length && <button onClick={() => { setItems([]); setSel(null) }}><Icon name="close"/><small>Clear</small></button>}
      </nav>

      {draft && (
        <div className="rs-type" onClick={e => { if (e.target === e.currentTarget) commitText() }}>
          <textarea autoFocus value={draft.text} maxLength={MAX_TEXT} dir="auto"
            placeholder="Type something…"
            onChange={e => setDraft(d => ({ ...d, text: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText() } }}/>
          <button className="btn btn-primary btn-sm" onClick={commitText}>Add</button>
        </div>
      )}
    </div>
  )
}
