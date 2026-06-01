/* =========================================================
   StoryEditor — Instagram / Facebook-style story composer.
   ---------------------------------------------------------
   Lets the author stack multiple TEXT layers on top of a
   photo, gradient, or video, drag them around, rotate, scale,
   and re-style them. On Save we either:
     · IMAGE/TEXT story → flatten everything into a single PNG
       blob via <canvas> and hand back as the media file, so the
       backend doesn't need an overlay metadata API (POST_API
       §20 only takes one textContent + media file).
     · VIDEO story → keep the video as-is and bake the layers
       into a derived poster image (used as the thumbnail).
   ========================================================= */
import React from 'react'
import { Icon } from './ui.jsx'

/* ---------- Editor preset palette ---------- */

const BACKGROUNDS = [
  { id:'g1', label:'Emerald',  bg:'linear-gradient(160deg,#0a4a3c,#159a76)' },
  { id:'g2', label:'Brass',    bg:'linear-gradient(160deg,#bd9344,#7a5a1a)' },
  { id:'g3', label:'Midnight', bg:'linear-gradient(160deg,#1f3a4a,#070d0b)' },
  { id:'g4', label:'Rose',     bg:'linear-gradient(160deg,#c2453f,#5a2a1a)' },
  { id:'g5', label:'Forest',   bg:'linear-gradient(160deg,#16302a,#0a2a1f)' },
  { id:'g6', label:'Paper',    bg:'linear-gradient(160deg,#f4f1e8,#cdc4ad)' },
]

const FONTS = [
  { id:'serif',   label:'Serif',  family:'"IBM Plex Serif", Georgia, serif' },
  { id:'sans',    label:'Sans',   family:'"IBM Plex Sans", system-ui, sans-serif' },
  { id:'mono',    label:'Mono',   family:'"IBM Plex Mono", ui-monospace, monospace' },
  { id:'display', label:'Display',family:'"IBM Plex Serif", Georgia, serif', italic:true, weight:500 },
]

const COLORS = ['#ffffff', '#0b1a16', '#bd9344', '#159a76', '#c2453f', '#3f6a8a', '#f4ead0', '#0a4a3c']

/* Story canvas is 1080×1920 (Instagram-equivalent 9:16). The on-screen
   preview is scaled to fit the modal viewport; all positions are stored
   as % so they translate cleanly to the export resolution. */
const EXPORT_W = 1080
const EXPORT_H = 1920

/* ---------- A single draggable / rotatable text layer ---------- */

function TextLayer({ layer, selected, onSelect, onChange, onDelete }) {
  const ref = React.useRef(null)
  const start = React.useRef(null)

  const fontDef = FONTS.find(f => f.id === layer.font) || FONTS[0]

  const onPointerDown = (e) => {
    e.stopPropagation()
    onSelect(layer.id)
    const parent = ref.current?.parentElement?.getBoundingClientRect()
    if (!parent) return
    start.current = {
      pointerId: e.pointerId,
      px: e.clientX, py: e.clientY,
      x: layer.x, y: layer.y,
      pw: parent.width, ph: parent.height,
    }
    ref.current?.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e) => {
    if (!start.current || e.pointerId !== start.current.pointerId) return
    const dx = (e.clientX - start.current.px) / start.current.pw * 100
    const dy = (e.clientY - start.current.py) / start.current.ph * 100
    onChange({
      ...layer,
      x: Math.max(0, Math.min(100, start.current.x + dx)),
      y: Math.max(0, Math.min(100, start.current.y + dy)),
    })
  }
  const onPointerUp = (e) => {
    if (start.current?.pointerId === e.pointerId) {
      ref.current?.releasePointerCapture?.(e.pointerId)
      start.current = null
    }
  }

  const style = {
    position:'absolute',
    left: `${layer.x}%`, top: `${layer.y}%`,
    transform: `translate(-50%,-50%) rotate(${layer.rotation}deg) scale(${layer.scale})`,
    transformOrigin:'center center',
    fontFamily: fontDef.family,
    fontStyle:  fontDef.italic ? 'italic' : (layer.italic ? 'italic' : 'normal'),
    fontWeight: layer.bold ? 700 : (fontDef.weight || 500),
    fontSize:   `${layer.size}px`,
    lineHeight: 1.18,
    color:      layer.color,
    background: layer.bgOn ? layer.bgColor : 'transparent',
    padding:    layer.bgOn ? '8px 14px' : '0',
    borderRadius: layer.bgOn ? '12px' : '0',
    textAlign:  layer.align,
    whiteSpace: 'pre-wrap',
    wordBreak:  'break-word',
    maxWidth:   '88%',
    cursor:     selected ? 'grabbing' : 'grab',
    touchAction:'none',
    userSelect: 'none',
    textShadow: layer.bgOn ? 'none' : '0 2px 8px rgba(0,0,0,.45)',
    outline:    selected ? '2px dashed rgba(189,147,68,.85)' : 'none',
    outlineOffset: 4,
  }
  return (
    <div
      ref={ref}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onChange({ ...layer, _edit: true })}
    >
      {layer.text || 'tap to edit'}
      {selected && (
        <button
          type="button"
          onPointerDown={e => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onDelete(layer.id) }}
          style={{
            position:'absolute', top:-12, right:-12, width:26, height:26,
            borderRadius:'50%', background:'#0b1a16', color:'#fff', border:'2px solid #fff',
            display:'grid', placeItems:'center', boxShadow:'0 2px 6px rgba(0,0,0,.3)',
            zIndex:5,
          }}
        >
          <Icon name="close" className="xs"/>
        </button>
      )}
    </div>
  )
}

/* ---------- Draggable poll sticker ---------- */

function PollSticker({ poll, selected, onSelect, onMove, onEdit, onDelete }) {
  const ref = React.useRef(null)
  const start = React.useRef(null)

  const onPointerDown = (e) => {
    e.stopPropagation()
    onSelect()
    const parent = ref.current?.parentElement?.getBoundingClientRect()
    if (!parent) return
    start.current = { pointerId: e.pointerId, px: e.clientX, py: e.clientY, x: poll.x, y: poll.y, pw: parent.width, ph: parent.height }
    ref.current?.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e) => {
    if (!start.current || e.pointerId !== start.current.pointerId) return
    const dx = (e.clientX - start.current.px) / start.current.pw * 100
    const dy = (e.clientY - start.current.py) / start.current.ph * 100
    onMove({
      x: Math.max(8, Math.min(92, start.current.x + dx)),
      y: Math.max(8, Math.min(92, start.current.y + dy)),
    })
  }
  const onPointerUp = (e) => {
    if (start.current?.pointerId === e.pointerId) {
      ref.current?.releasePointerCapture?.(e.pointerId)
      start.current = null
    }
  }

  return (
    <div
      ref={ref}
      className={'se-poll-sticker ' + (selected ? 'on' : '')}
      style={{ left: `${poll.x}%`, top: `${poll.y}%` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => { e.stopPropagation(); onEdit() }}
    >
      <div className="se-poll-sticker-head"><Icon name="qna" className="xs"/><span>Poll</span></div>
      <div className="se-poll-sticker-q">{poll.question}</div>
      <div className="se-poll-sticker-opts">
        <span>{poll.optionA}</span>
        <em className="se-poll-or">or</em>
        <span>{poll.optionB}</span>
      </div>
      {selected && (
        <>
          <button type="button" className="se-poll-fab edit" onPointerDown={e => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onEdit() }} aria-label="Edit poll"><Icon name="compose" className="xs"/></button>
          <button type="button" className="se-poll-fab del" onPointerDown={e => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDelete() }} aria-label="Remove poll"><Icon name="close" className="xs"/></button>
        </>
      )}
    </div>
  )
}

/* ---------- Main editor ---------- */

export function StoryEditor({ initialMedia, onCancel, onSave }) {
  /* Background: gradient OR uploaded file (image or video). */
  const initialUrl = React.useMemo(() => initialMedia ? URL.createObjectURL(initialMedia) : null, [initialMedia])
  const initialKind = initialMedia ? (initialMedia.type.startsWith('video') ? 'video' : 'image') : null
  const [bgFile, setBgFile] = React.useState(initialMedia || null)
  const [bgUrl, setBgUrl] = React.useState(initialUrl)
  const [bgKind, setBgKind] = React.useState(initialKind)        // 'image' | 'video' | null
  const [bgPreset, setBgPreset] = React.useState(initialMedia ? null : BACKGROUNDS[0])

  React.useEffect(() => () => { if (bgUrl) URL.revokeObjectURL(bgUrl) }, [bgUrl])

  const setMediaFile = (file) => {
    if (!file) return
    if (bgUrl) URL.revokeObjectURL(bgUrl)
    const url = URL.createObjectURL(file)
    setBgFile(file); setBgUrl(url)
    setBgKind(file.type.startsWith('video') ? 'video' : 'image')
    setBgPreset(null)
  }
  const clearMedia = () => {
    if (bgUrl) URL.revokeObjectURL(bgUrl)
    setBgFile(null); setBgUrl(null); setBgKind(null)
    setBgPreset(BACKGROUNDS[0])
  }

  /* Text layers — array of {id, text, x%, y%, rotation, scale, font, size, color, align, bold, italic, bgOn, bgColor}. */
  const [layers, setLayers] = React.useState([])
  const [selectedId, setSelectedId] = React.useState(null)
  const selected = layers.find(l => l.id === selectedId) || null

  /* Optional two-option poll sticker — { question, optionA, optionB, x%, y% }.
     Draggable like a text layer; attached to the story after create (StoryPoll
     API). null = no poll. */
  const [poll, setPoll] = React.useState(null)
  const [pollEdit, setPollEdit] = React.useState(false)
  const [pollSelected, setPollSelected] = React.useState(false)
  const deselectAll = () => { setSelectedId(null); setPollSelected(false) }

  const stageRef = React.useRef(null)
  const fileRef = React.useRef(null)

  const addText = () => {
    const id = Math.random().toString(36).slice(2, 9)
    const layer = {
      id, text:'Your text',
      x: 50, y: 50,
      rotation: 0, scale: 1,
      font: 'serif', size: 56, color: '#ffffff',
      align: 'center', bold: false, italic: false,
      bgOn: false, bgColor: 'rgba(11,26,22,.5)',
      _edit: true,
    }
    setLayers(prev => [...prev, layer])
    setSelectedId(id)
  }

  const patchSelected = (patch) => {
    if (!selected) return
    setLayers(prev => prev.map(l => l.id === selected.id ? { ...l, ...patch } : l))
  }
  const updateLayer = (next) => setLayers(prev => prev.map(l => l.id === next.id ? next : l))
  const deleteLayer = (id) => {
    setLayers(prev => prev.filter(l => l.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  /* Inline edit popover for the selected layer's text. */
  const editingId = selected?._edit ? selected.id : null
  const stopEditing = (text) => {
    setLayers(prev => prev.map(l => l.id === editingId ? { ...l, text, _edit: false } : l))
  }

  /* Flatten the stage → PNG blob. Used for IMAGE / TEXT-only stories and as
     a poster for VIDEO stories. */
  const flattenToBlob = React.useCallback(async () => {
    const cnv = document.createElement('canvas')
    cnv.width = EXPORT_W; cnv.height = EXPORT_H
    const ctx = cnv.getContext('2d')

    // Background — gradient preset, image, or video frame
    if (bgPreset) {
      // Parse the preset gradient and reapply on canvas (canvas can't render
      // CSS gradients directly). We use two-stop linear gradient extracted
      // from the preset background string.
      const colors = (bgPreset.bg.match(/#[0-9a-f]{6}/gi) || ['#0a4a3c','#159a76'])
      const grad = ctx.createLinearGradient(0, 0, EXPORT_W * 0.4, EXPORT_H)
      grad.addColorStop(0, colors[0]); grad.addColorStop(1, colors[1])
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, EXPORT_W, EXPORT_H)
    } else if (bgKind === 'image' && bgUrl) {
      const img = await new Promise((resolve, reject) => {
        const i = new Image(); i.crossOrigin = 'anonymous'
        i.onload = () => resolve(i); i.onerror = reject; i.src = bgUrl
      })
      // cover-fit
      const ir = img.width / img.height, cr = EXPORT_W / EXPORT_H
      let sw, sh, sx, sy
      if (ir > cr) { sh = img.height; sw = sh * cr; sx = (img.width - sw) / 2; sy = 0 }
      else         { sw = img.width;  sh = sw / cr; sx = 0; sy = (img.height - sh) / 2 }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, EXPORT_W, EXPORT_H)
    } else if (bgKind === 'video' && bgUrl) {
      // Grab a frame at the current time (or t=0)
      const v = document.querySelector('video[data-story-bg]')
      if (v) {
        const ir = v.videoWidth / v.videoHeight, cr = EXPORT_W / EXPORT_H
        let sw, sh, sx, sy
        if (ir > cr) { sh = v.videoHeight; sw = sh * cr; sx = (v.videoWidth - sw) / 2; sy = 0 }
        else         { sw = v.videoWidth;  sh = sw / cr; sx = 0; sy = (v.videoHeight - sh) / 2 }
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, EXPORT_W, EXPORT_H)
      } else {
        ctx.fillStyle = '#0a1a16'; ctx.fillRect(0, 0, EXPORT_W, EXPORT_H)
      }
    } else {
      ctx.fillStyle = '#0a1a16'; ctx.fillRect(0, 0, EXPORT_W, EXPORT_H)
    }

    // Text layers — render in order on top
    for (const layer of layers) {
      const fontDef = FONTS.find(f => f.id === layer.font) || FONTS[0]
      const px = EXPORT_W * layer.x / 100
      const py = EXPORT_H * layer.y / 100

      ctx.save()
      ctx.translate(px, py)
      ctx.rotate(layer.rotation * Math.PI / 180)
      ctx.scale(layer.scale, layer.scale)

      const weight = layer.bold ? 700 : (fontDef.weight || 500)
      const italic = (fontDef.italic || layer.italic) ? 'italic ' : ''
      // Scale font size from preview (px in stage CSS) to export resolution.
      // Stage rendered at ~360px wide, so multiplier = EXPORT_W / 360 ≈ 3.
      const stageW = stageRef.current?.getBoundingClientRect().width || 360
      const sizeScale = EXPORT_W / stageW
      const fontSizePx = Math.round(layer.size * sizeScale)
      ctx.font = `${italic}${weight} ${fontSizePx}px ${fontDef.family}`
      ctx.textAlign = layer.align
      ctx.textBaseline = 'middle'

      // Wrap to the same 88% width the preview text box uses (in this scaled
      // coordinate space that's 0.88 * EXPORT_W), so the baked text breaks onto
      // the same lines the author saw — no more over-wide overflow / clipping.
      const lines = wrapCanvasText(ctx, layer.text || '', EXPORT_W * 0.88)
      const lineH = fontSizePx * 1.18
      const totalH = lineH * lines.length

      // Background pill
      if (layer.bgOn) {
        const maxWidth = Math.max(...lines.map(t => ctx.measureText(t).width))
        const padX = 24 * sizeScale, padY = 18 * sizeScale
        const bgW = maxWidth + padX * 2, bgH = totalH + padY * 2
        ctx.fillStyle = layer.bgColor
        const xOffset = layer.align === 'center' ? -bgW/2 : layer.align === 'right' ? -bgW : 0
        roundRect(ctx, xOffset, -bgH/2, bgW, bgH, 22 * sizeScale)
        ctx.fill()
      } else {
        // soft drop-shadow for legibility on busy photos
        ctx.shadowColor = 'rgba(0,0,0,.45)'
        ctx.shadowBlur = 14 * sizeScale
        ctx.shadowOffsetY = 4 * sizeScale
      }

      ctx.fillStyle = layer.color
      lines.forEach((line, i) => {
        const y = -totalH/2 + lineH * (i + 0.5)
        ctx.fillText(line, 0, y)
      })

      ctx.restore()
    }

    return new Promise(resolve => cnv.toBlob(b => resolve(b), 'image/png', 0.95))
  }, [bgPreset, bgKind, bgUrl, layers])

  const handleSave = async () => {
    const flat = await flattenToBlob()
    const plainText = layers.map(l => l.text).filter(Boolean).join('\n').trim()
    if (bgKind === 'video' && bgFile) {
      // Keep the original video as media; flattened image is a derived poster.
      const poster = flat ? new File([flat], 'story-poster.png', { type:'image/png' }) : null
      onSave({ kind:'VIDEO', media: bgFile, thumbnail: poster, textContent: plainText, poll })
    } else {
      const png = flat ? new File([flat], 'story.png', { type:'image/png' }) : null
      onSave({ kind: bgPreset ? 'TEXT' : 'IMAGE', media: png, thumbnail: null, textContent: plainText, poll })
    }
  }

  return (
    <div className="story-editor">
      {/* Top bar */}
      <div className="se-bar">
        <button className="se-bar-btn" onClick={onCancel} aria-label="Cancel">
          <Icon name="chevleft"/>
        </button>
        <div className="se-bar-spacer"/>
        <button className="se-bar-btn ghost" onClick={addText} title="Add text">
          <Icon name="compose" className="sm"/><span>Text</span>
        </button>
        <button className="se-bar-btn ghost" onClick={() => fileRef.current?.click()} title="Replace media">
          <Icon name="image" className="sm"/><span>Photo</span>
        </button>
        <button className={'se-bar-btn ghost ' + (poll ? 'on' : '')} onClick={() => setPollEdit(true)} title={poll ? 'Edit poll' : 'Add poll'}>
          <Icon name="qna" className="sm"/><span>Poll</span>
        </button>
        <input ref={fileRef} type="file" hidden accept="image/*,video/*" onChange={e => { const f = e.target.files?.[0]; if (f) setMediaFile(f); e.target.value = '' }}/>
        {bgFile && (
          <button className="se-bar-btn ghost" onClick={clearMedia} title="Remove media">
            <Icon name="close" className="sm"/>
          </button>
        )}
        <button className="se-bar-btn primary" onClick={handleSave}>
          <span>Next</span><Icon name="chevright" className="sm"/>
        </button>
      </div>

      {/* Stage — 9:16 preview */}
      <div
        className="se-stage-wrap"
        onPointerDown={(e) => {
          // Tap the empty stage (not a layer) to deselect
          if (e.target === e.currentTarget || e.target.classList.contains('se-stage')) deselectAll()
        }}
      >
        <div className="se-stage" ref={stageRef}
          style={{ background: bgPreset?.bg || '#0a1a16' }}
          onPointerDown={() => deselectAll()}
        >
          {bgKind === 'image' && bgUrl && (
            <img src={bgUrl} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }}/>
          )}
          {bgKind === 'video' && bgUrl && (
            <video data-story-bg src={bgUrl} muted playsInline autoPlay loop
              style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }}/>
          )}
          {layers.map(l => (
            <TextLayer
              key={l.id}
              layer={l}
              selected={selectedId === l.id}
              onSelect={(id) => { setSelectedId(id); setPollSelected(false) }}
              onChange={updateLayer}
              onDelete={deleteLayer}
            />
          ))}
          {poll && (
            <PollSticker
              poll={poll}
              selected={pollSelected}
              onSelect={() => { setSelectedId(null); setPollSelected(true) }}
              onMove={(pos) => setPoll(p => ({ ...p, ...pos }))}
              onEdit={() => setPollEdit(true)}
              onDelete={() => { setPoll(null); setPollSelected(false) }}
            />
          )}
        </div>
      </div>

      {/* Background preset strip — only when no media uploaded */}
      {!bgFile && (
        <div className="se-bg-row">
          {BACKGROUNDS.map(b => (
            <button key={b.id} className={'se-bg-tile ' + (bgPreset?.id === b.id ? 'on' : '')}
              style={{ background: b.bg }}
              onClick={() => setBgPreset(b)}
              title={b.label}/>
          ))}
        </div>
      )}

      {/* Toolbar — appears when a text layer is selected */}
      {selected && (
        <div className="se-tools">
          {/* Row 1: fonts + colors */}
          <div className="se-tools-row">
            <div className="se-fonts">
              {FONTS.map(f => (
                <button key={f.id} className={'se-font ' + (selected.font === f.id ? 'on' : '')}
                  style={{ fontFamily: f.family, fontStyle: f.italic ? 'italic' : 'normal' }}
                  onClick={() => patchSelected({ font: f.id })}>Aa</button>
              ))}
            </div>
            <div className="se-colors">
              {COLORS.map(c => (
                <button key={c} className={'se-color ' + (selected.color === c ? 'on' : '')}
                  style={{ background: c, borderColor: c === '#ffffff' ? '#cbc4ab' : 'transparent' }}
                  onClick={() => patchSelected({ color: c })}/>
              ))}
            </div>
          </div>
          {/* Row 2: format chips */}
          <div className="se-tools-row">
            <button className={'se-chip ' + (selected.bold ? 'on' : '')} onClick={() => patchSelected({ bold: !selected.bold })}><b>B</b></button>
            <button className={'se-chip ' + (selected.italic ? 'on' : '')} onClick={() => patchSelected({ italic: !selected.italic })}><i>I</i></button>
            <button className={'se-chip ' + (selected.align === 'left' ? 'on' : '')} onClick={() => patchSelected({ align: 'left' })} title="Left"><Icon name="align-left" className="sm"/>L</button>
            <button className={'se-chip ' + (selected.align === 'center' ? 'on' : '')} onClick={() => patchSelected({ align: 'center' })} title="Center"><Icon name="align-center" className="sm"/>C</button>
            <button className={'se-chip ' + (selected.align === 'right' ? 'on' : '')} onClick={() => patchSelected({ align: 'right' })} title="Right"><Icon name="align-right" className="sm"/>R</button>
            <button className={'se-chip ' + (selected.bgOn ? 'on' : '')} onClick={() => patchSelected({ bgOn: !selected.bgOn })} title="Pill background">Pill</button>
          </div>
          {/* Row 3: sliders */}
          <div className="se-tools-row se-sliders">
            <label className="se-slider">
              <span>Size</span>
              <input type="range" min={20} max={120} step={2}
                value={selected.size}
                onChange={e => patchSelected({ size: +e.target.value })}/>
              <i className="muted text-xs" style={{ fontStyle:'normal' }}>{selected.size}</i>
            </label>
            <label className="se-slider">
              <span>Rotate</span>
              <input type="range" min={-180} max={180} step={1}
                value={selected.rotation}
                onChange={e => patchSelected({ rotation: +e.target.value })}/>
              <i className="muted text-xs" style={{ fontStyle:'normal' }}>{selected.rotation}°</i>
            </label>
            <label className="se-slider">
              <span>Scale</span>
              <input type="range" min={0.5} max={2.5} step={0.05}
                value={selected.scale}
                onChange={e => patchSelected({ scale: +e.target.value })}/>
              <i className="muted text-xs" style={{ fontStyle:'normal' }}>{selected.scale.toFixed(2)}×</i>
            </label>
          </div>
        </div>
      )}

      {/* Inline editor — keeps the keyboard up while the user types and
          places the new text immediately on commit. */}
      {editingId && (
        <InlineTextEditor
          initial={selected.text}
          onCommit={stopEditing}
        />
      )}

      {pollEdit && (
        <PollEditor
          initial={poll}
          onCancel={() => setPollEdit(false)}
          // Preserve the sticker's position across edits; seed a centred spot for a new poll.
          onCommit={(p) => { setPoll(p ? { ...(poll || { x: 50, y: 64 }), ...p } : null); setPollSelected(!!p); setPollEdit(false) }}
        />
      )}
    </div>
  )
}

/* ---------- Poll sticker editor overlay ---------- */
function PollEditor({ initial, onCommit, onCancel }) {
  const [q, setQ] = React.useState(initial?.question || '')
  const [a, setA] = React.useState(initial?.optionA || '')
  const [b, setB] = React.useState(initial?.optionB || '')
  const ok = q.trim() && a.trim() && b.trim()
  return (
    <div className="se-edit" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="se-poll-card" onClick={e => e.stopPropagation()}>
        <h3 className="title"><Icon name="qna" className="sm"/>Poll</h3>
        <label className="field-label">Question</label>
        <input className="field" value={q} maxLength={120} onChange={e => setQ(e.target.value)} placeholder="Ask something…" autoFocus/>
        <div className="se-poll-grid">
          <div><label className="field-label">Option 1</label><input className="field" value={a} maxLength={40} onChange={e => setA(e.target.value)} placeholder="Yes"/></div>
          <div><label className="field-label">Option 2</label><input className="field" value={b} maxLength={40} onChange={e => setB(e.target.value)} placeholder="No"/></div>
        </div>
        <div className="se-poll-actions">
          {initial && <button className="btn btn-secondary btn-sm" onClick={() => onCommit(null)}>Remove</button>}
          <span style={{ flex:1 }}/>
          <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary btn-sm" disabled={!ok} onClick={() => ok && onCommit({ question: q.trim(), optionA: a.trim(), optionB: b.trim() })}>Done</button>
        </div>
      </div>
    </div>
  )
}

/* ---------- Inline text editor overlay ---------- */
function InlineTextEditor({ initial, onCommit }) {
  const [v, setV] = React.useState(initial === 'Your text' ? '' : initial)
  const ref = React.useRef(null)
  React.useEffect(() => { ref.current?.focus(); ref.current?.select?.() }, [])
  return (
    <div className="se-edit" onClick={(e) => e.target === e.currentTarget && onCommit(v.trim() || initial)}>
      <textarea
        ref={ref}
        className="se-edit-area"
        value={v}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') onCommit(v.trim() || initial) }}
        placeholder="Type your text…"
      />
      <button className="btn btn-primary se-edit-done" onClick={() => onCommit(v.trim() || initial)}>Done</button>
    </div>
  )
}

/* ---------- canvas helper ---------- */
function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/* Word-wrap text for the canvas export so the baked PNG matches the editor
   preview, which wraps via CSS (maxWidth:88% + wordBreak:break-word). Without
   this, a long line (e.g. an Arabic dua) baked as ONE over-wide line and ran
   off the edge. Honours explicit "\n", greedily fills to maxW, and hard-breaks
   any single token wider than maxW. `ctx.font` must already be set. */
function wrapCanvasText(ctx, text, maxW) {
  const out = []
  const breakWord = (word) => {              // break a token longer than maxW, char by char
    let chunk = ''
    for (const ch of word) {
      if (chunk && ctx.measureText(chunk + ch).width > maxW) { out.push(chunk); chunk = ch }
      else chunk += ch
    }
    return chunk
  }
  for (const para of String(text || '').split('\n')) {
    if (!para) { out.push(''); continue }
    let line = ''
    for (const w of para.split(' ')) {
      const test = line ? line + ' ' + w : w
      if (ctx.measureText(test).width <= maxW) { line = test; continue }
      if (line) out.push(line)
      line = ctx.measureText(w).width > maxW ? breakWord(w) : w
    }
    out.push(line)
  }
  return out
}
