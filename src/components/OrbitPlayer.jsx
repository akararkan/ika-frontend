// OrbitPlayer — the "1e Orbit" ring player as a standalone React component.
// Usage:  <OrbitPlayer src="/audio/voice-note.mp3" title="Night Drive" artist="KOA" />
// No dependencies. React 17+. Pass dark={true} for the dark card look;
// default is light, for a white app background.
//
// USER-SUPPLIED CODE, VERBATIM — this is the design reference itself, kept
// byte-for-byte on purpose ("use the same code"). Do not refactor it onto the
// app's <audio>/mediaPrefs engine or re-palette it; the imperative-ref style
// is intentional, hence the file-level lint disables.
/* eslint-disable react-hooks/refs, react-hooks/immutability, no-unused-vars, no-empty */

import React, { useEffect, useRef, useState } from 'react';

export default function OrbitPlayer({
  src,                    // audio file URL (mp3/wav/ogg…)
  title = 'Untitled',
  artist = '',
  size = 300,             // ring area square size (px)
  accent = '#2f6fed',     // progress / played color
  dark = false,           // dark or white card
  flush = false,          // no card chrome: fill the parent, no border (feed post embed)
}) {
  const cvRef = useRef(null);
  const S = useRef({ ac: null, buf: null, src: null, off: 0, t0: 0, playing: false, peaks: null, drag: null, raf: 0 }).current;
  const [ready, setReady] = useState(false);
  const [, force] = useState(0);
  const rerender = () => force(n => n + 1);

  useEffect(() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    S.ac = new AC();
    let dead = false;
    if (src) {
      fetch(src)
        .then(r => r.arrayBuffer())
        .then(a => S.ac.decodeAudioData(a))
        .then(buf => {
          if (dead) return;
          S.buf = buf;
          // 700-point peak envelope for the ring
          const ch = buf.getChannelData(0), N = 700, pk = new Float32Array(N), step = ch.length / N;
          for (let i = 0; i < N; i++) {
            let m = 0;
            for (let j = Math.floor(i * step); j < (i + 1) * step; j += 8) m = Math.max(m, Math.abs(ch[j]));
            pk[i] = m;
          }
          let m = 0;
          for (let i = 0; i < N; i++) m = Math.max(m, pk[i]);
          for (let i = 0; i < N; i++) pk[i] = Math.pow(pk[i] / (m || 1), 0.75);
          S.peaks = pk;
          setReady(true);
        });
    }
    const loop = () => { draw(); S.raf = requestAnimationFrame(loop); };
    S.raf = requestAnimationFrame(loop);
    return () => { dead = true; cancelAnimationFrame(S.raf); try { S.ac.close(); } catch (e) {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const dur = () => (S.buf ? S.buf.duration : 0);
  const pos = () => (S.playing ? Math.min(dur(), S.off + (S.ac.currentTime - S.t0)) : S.off);
  const stopSrc = () => { if (S.src) { S.src.onended = null; try { S.src.stop(); } catch (e) {} S.src = null; } };
  const start = () => {
    const s = S.ac.createBufferSource();
    s.buffer = S.buf;
    s.connect(S.ac.destination);
    s.onended = () => { if (S.src === s && S.playing) { S.playing = false; S.off = 0; rerender(); } };
    s.start(0, S.off);
    S.src = s;
    S.t0 = S.ac.currentTime;
  };
  const play = () => { if (!S.buf) return; S.ac.resume(); if (S.off >= dur() - 0.05) S.off = 0; start(); S.playing = true; rerender(); };
  const pause = () => { if (!S.playing) return; S.off = pos(); S.playing = false; stopSrc(); rerender(); };

  // --- ring scrub (drag anywhere on the ring; angle -> time) ---
  const angleTime = e => {
    const r = cvRef.current.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    let a = Math.atan2(dy, dx) + Math.PI / 2;
    if (a < 0) a += 2 * Math.PI;
    return (a / (2 * Math.PI)) * dur();
  };
  const down = e => { if (!S.buf) return; S.ac.resume(); e.currentTarget.setPointerCapture(e.pointerId); S.drag = { was: S.playing }; if (S.playing) pause(); S.off = angleTime(e); rerender(); };
  const move = e => { if (S.drag) S.off = angleTime(e); };
  const up = () => { if (S.drag) { const was = S.drag.was; S.drag = null; if (was) play(); rerender(); } };

  function draw() {
    const cv = cvRef.current;
    if (!cv) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.floor(w * dpr)) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr); }
    const x = cv.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 44;
    const rest = dark ? 'rgba(125,143,174,.35)' : 'rgba(19,35,61,.16)';
    const faint = dark ? 'rgba(242,246,253,.14)' : 'rgba(19,35,61,.1)';
    const glow = dark ? '110,168,255' : '47,111,237';
    if (!S.peaks) { x.strokeStyle = faint; x.lineWidth = 2; x.beginPath(); x.arc(cx, cy, R, 0, 7); x.stroke(); return; }
    const t = pos(), fr = t / dur(), now = performance.now();
    const pk = S.peaks, N = 96;
    const amp = pk[Math.floor(fr * pk.length)] || 0;
    if (S.playing) {
      const gl = x.createRadialGradient(cx, cy, R * 0.3, cx, cy, R + 40);
      gl.addColorStop(0, 'rgba(' + glow + ',0)');
      gl.addColorStop(0.8, 'rgba(' + glow + ',' + (0.05 + amp * 0.13) + ')');
      gl.addColorStop(1, 'rgba(' + glow + ',0)');
      x.fillStyle = gl;
      x.fillRect(0, 0, w, h);
    }
    for (let i = 0; i < N; i++) {
      const frac = i / N, a = -Math.PI / 2 + frac * 2 * Math.PI;
      const v = pk[Math.floor(frac * pk.length)];
      let len = 6 + v * 30;
      if (S.playing) {
        const di = Math.min(Math.abs(frac - fr), 1 - Math.abs(frac - fr));
        len *= 1 + 0.6 * Math.exp(-di * di * 900) * (0.6 + 0.4 * Math.sin(now / 80 + i));
      }
      x.strokeStyle = frac <= fr ? accent : rest;
      x.lineWidth = 3;
      x.lineCap = 'round';
      const wob = S.playing ? Math.sin(now / 300 + i * 0.7) * 1.5 : 0;
      x.beginPath();
      x.moveTo(cx + Math.cos(a) * (R - len / 2 + wob), cy + Math.sin(a) * (R - len / 2 + wob));
      x.lineTo(cx + Math.cos(a) * (R + len / 2 + wob), cy + Math.sin(a) * (R + len / 2 + wob));
      x.stroke();
    }
    x.strokeStyle = faint; x.lineWidth = 1;
    x.beginPath(); x.arc(cx, cy, R - 24, 0, 7); x.stroke();
    x.strokeStyle = accent; x.lineWidth = 3; x.lineCap = 'round';
    x.beginPath(); x.arc(cx, cy, R - 24, -Math.PI / 2, -Math.PI / 2 + fr * 2 * Math.PI); x.stroke();
    const pa = -Math.PI / 2 + fr * 2 * Math.PI;
    x.fillStyle = dark ? '#fff' : '#13233d';
    x.beginPath(); x.arc(cx + Math.cos(pa) * (R - 24), cy + Math.sin(pa) * (R - 24), 5, 0, 7); x.fill();
  }

  const fmt = t => { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
  const fg = dark ? '#f2f6fd' : '#13233d';
  const sub = dark ? '#66799c' : '#8794a8';

  return (
    <div style={{ width: flush ? '100%' : size + 100, background: flush ? 'transparent' : (dark ? '#0a0f1c' : '#fff'), border: flush ? 'none' : '1px solid ' + (dark ? '#1b2740' : '#e0e6ee'), borderRadius: 18, overflow: 'hidden', fontFamily: "'Public Sans',system-ui,sans-serif" }}>
      {(title || artist) ? (
        <div style={{ padding: '16px 20px 0' }}>
          <div style={{ font: "700 16px 'Source Serif 4',serif", color: fg }}>{title}</div>
          {artist ? <div style={{ font: '500 11.5px ui-monospace,monospace', color: sub, marginTop: 2 }}>{artist}</div> : null}
        </div>
      ) : null}
      <div style={{ position: 'relative', height: size }}>
        <div onPointerDown={down} onPointerMove={move} onPointerUp={up} style={{ position: 'absolute', inset: 0, cursor: 'pointer', touchAction: 'none' }}>
          <canvas ref={cvRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        <button
          onClick={() => (S.playing ? pause() : play())}
          style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 64, height: 64, borderRadius: '50%', background: dark ? '#f2f6fd' : '#13233d', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 20px rgba(19,35,61,.3)' }}
        >
          {S.playing ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill={dark ? '#0a0f1c' : '#fff'}><path d="M7 5h3.6v14H7z M13.4 5H17v14h-3.4z" /></svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill={dark ? '#0a0f1c' : '#fff'}><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 22px 16px' }}>
        <span style={{ font: '600 13px ui-monospace,monospace', color: fg }}>{fmt(pos())}</span>
        <span style={{ flex: 1, textAlign: 'center', font: "500 10.5px 'Public Sans',sans-serif", letterSpacing: 1.2, color: sub }}>
          {ready ? 'DRAG THE RING TO SCRUB' : src ? 'LOADING…' : 'PASS A src PROP'}
        </span>
        <span style={{ font: '600 13px ui-monospace,monospace', color: sub }}>{fmt(dur())}</span>
      </div>
    </div>
  );
}
