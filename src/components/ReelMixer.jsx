/* =========================================================
   Reel audio mixer — the panel over the reel.

   A reel posted with a Sound plays TWO tracks at once: the
   clip's own recorded audio and the added library track (see
   hooks/useReelAudio.js, which owns the playback side). This is
   only the surface for balancing them — one row per track, each
   with a level and a mute, plus the way back out of the reel's
   master mute, which outranks both.
   ========================================================= */
import { Icon } from './ui.jsx'

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0))

const pct = (n) => Math.round(clamp01(n) * 100)
const levelIcon = (off, v) => off ? 'mute' : v < .5 ? 'volumelow' : 'volume'

/** The mixer panel — one row per track, plus a way back out of master mute.
 *  `hasOriginal` is false for a PHOTO reel: there is no recorded audio to
 *  level, so the panel shows the added sound alone rather than a dead slider. */
export function ReelMixer({ audio, muted, onUnmute, trackName, onClose, hasOriginal = true }) {
  const rows = []
  if (hasOriginal) rows.push({ key: 'orig', label: 'Original sound', value: audio.mix.orig, off: audio.mix.origOff })
  if (audio.hasMusic) rows.push({ key: 'music', label: trackName || 'Added sound', value: audio.mix.music, off: audio.mix.musicOff })
  const title = rows.length > 1 ? 'Audio mixer' : hasOriginal ? 'Volume' : 'Sound'

  return (
    <div className="rv-mix" role="group" aria-label={title}>
      <div className="rv-mix-head">
        <b>{title}</b>
        <button className="rv-mix-x" onClick={onClose} aria-label="Close audio mixer"><Icon name="close" className="xs"/></button>
      </div>

      {/* Master mute wins over both levels, so say so rather than letting the
          sliders look broken while nothing comes out. */}
      {muted && (
        <button className="rv-mix-master" onClick={onUnmute}>
          <Icon name="mute" className="xs"/>Sound is off — turn it on
        </button>
      )}

      {/* Whose balance this is. It matters: these numbers are the author's
          until the first slider move, and then they are the listener's. */}
      {audio.seeded && !muted && (
        <p className="rv-mix-note" style={{ marginTop: 0, marginBottom: 2 }}>Set by the person who posted it.</p>
      )}

      {rows.map(row => (
        <div key={row.key} className="rv-mix-row">
          <button className={'rv-mix-off' + (row.off ? ' on' : '')} onClick={() => audio.toggleOff(row.key)}
            aria-pressed={row.off} aria-label={`${row.off ? 'Unmute' : 'Mute'} ${row.label}`}
            title={row.off ? 'Unmute' : 'Mute'}>
            <Icon name={levelIcon(row.off, row.value)} className="xs"/>
          </button>
          {/* name and readout share the first row, the slider spans both
              columns underneath — so DOM order is name, readout, slider. */}
          <span className="rv-mix-name rvm-marquee">{row.label}</span>
          <span className="rv-mix-pct">{row.off ? 'off' : `${pct(row.value)}%`}</span>
          <input className="rv-mix-range" type="range" min="0" max="100" step="1"
            value={pct(row.value)} aria-label={`${row.label} volume`}
            onChange={e => audio.setLevel(row.key, Number(e.target.value) / 100)}/>
        </div>
      ))}

      {audio.failed && <p className="rv-mix-note">The added sound could not be loaded — the reel’s own audio is unaffected.</p>}
    </div>
  )
}
