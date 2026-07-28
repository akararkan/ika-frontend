# Live streaming — backend fixes the frontend needs

Findings from wiring `live-streaming.md` / `live-row-frontend.md` into the app and
testing against the running stack (backend `:8080`, MediaMTX v1.19.3, 2026-07-27).
Everything below was reproduced end to end, not inferred from the docs.

Ordered by impact.

---

## P0 — Browser broadcasts record (and play) with no video

**Symptom.** A host goes live from the browser camera, ticks *Record*, ends, and
downloads a file that is black. Live viewers of the same broadcast get audio with
no picture.

**Cause.** `mediamtx.yml` leaves `webrtcTrackGatherTimeout` at its default **`2s`**.
MediaMTX waits that long after the WebRTC peer connection is established and takes
whatever has produced data as the session's track list — **permanently**.
`getUserMedia` resolves when the camera device opens, but Chrome's first *encoded*
H264 frame arrives later, and on the first broadcast of a browser session later
than 2s. Miss the window and the session is registered as audio-only, so nothing
downstream — playback or recorder — ever has a video track.

Straight from the MediaMTX log, same build, same machine, minutes apart:

```
[path …] [recorder] recording 1 track  (Opus)          ← lost the race
[path …] [recorder] recording 2 tracks (Opus, H264)    ← won it
```

**Fix.** One line in `mediamtx.yml`:

```yaml
webrtcTrackGatherTimeout: 10s
```

**Verified.** Patched at runtime via the control API
(`PATCH /v3/config/global/patch {"webrtcTrackGatherTimeout":"10s"}`) and re-ran the
exact cold-camera case that had been failing:

| camera | before (2s) | after (10s) |
|---|---|---|
| cold (first broadcast of the session) | `["Opus"]` — no video track | `["Opus","H264"]` → **h264 1280x720**, mean luma 71.5 |
| warm | `["Opus","H264"]` | `["Opus","H264"]` → h264 960x540, mean luma 72.6 |

> ~~The runtime patch is **not persisted**~~ — **DONE.** `mediamtx.yml:43` now
> carries `webrtcTrackGatherTimeout: 10s`, and the running server reports it
> (`GET /v3/config/global/get`). Re-confirmed 2026-07-28: a fresh browser
> broadcast registered `2 tracks (Opus, H264)` from the first moment.

**Frontend side, already shipped.** `publishCamera` now pulls a real decoded frame
through a detached `<video>` before sending the SDP offer, and attaches the host's
preview at capture time rather than after the handshake, to keep the pipeline
awake. That wins the race on a warm camera and narrows it on a cold one — it
cannot close it, because encoder start-up is not controllable from JS. The config
change is the deterministic fix.

---

## P1 — Recordings split into parts, and the first part is the useless one

**Symptom.** `GET /streams/{id}/recording/download` answers

```
400 — "This recording has 2 parts — pass ?part= (list them via GET /streams/{id}/recording)."
```

so "download my recording" fails outright. Fetching only the first part yields a
black file.

**Cause.** MediaMTX restarts its recorder whenever the published **track set
changes**. A browser broadcast changes it routinely: audio registers first, video
joins a beat later, recorder restarts. Result — part 1 is the audio-only prelude,
part 2 holds the picture. Logged twice for one session:

```
[recorder] recording 2 tracks (Opus, H264)
[recorder] recording 2 tracks (Opus, H264)   ← restarted ~2s later
```

**Worth considering backend-side** (the frontend now walks the manifest and saves
every part, so this is no longer breaking, just unpleasant):

- ~~Fixing **P0** should make this rarer~~ — **confirmed 2026-07-28.** With
  `webrtcTrackGatherTimeout: 10s` in the file, a browser broadcast logged
  `[recorder] recording 2 tracks (Opus, H264)` **once**, no restart, and the
  manifest came back `partCount: 1`. The audio-only prelude is gone.
- ~~`…/recording/download` with no `part` could concatenate/remux the parts~~ —
  **built**, see the record-in-takes section below. Note it must **re-encode**,
  not remux: a stream-copy concat propagates the per-part head/tail defects
  measured in P1b into every seam.
- Discarding a part that has no video track would avoid handing anyone a black
  file at all.

---

## P1b — Recordings that freeze but keep their sound. What is actually in the file

**Symptom.** Not P0 — the file *has* a video track and plays normally, then the
picture stops and audio runs on to the end of the duration.

**Measured**, 2026-07-28, on a real 39s WHIP broadcast published by headless
Chrome with `--use-fake-device-for-media-stream` and `record: true`. Numbers are
from the delivered file, not from stats.

| | measured |
|---|---|
| keyframe interval | **2.00s median** (20 keyframes / 34.1s) |
| first video packet | 0.80s |
| first **decodable** frame | **2.00s** — the first keyframe |
| last video packet | 36.69s |
| last audio packet | **39.46s** |
| decoded video gaps > 0.4s | **none** |

Three things follow, and the first one overturns the theory this section used to
carry.

**1. Packet loss cannot cause a permanent freeze here.** Keyframes arrive every
two seconds, so a loss-broken H264 chain repairs itself within 2s. The premise
that "Chrome only emits keyframes on request and nothing ever asks" is false in
this stack — something (almost certainly MediaMTX's own segmenting) is
requesting them steadily. Any fix built on the loss theory is guarding a failure
mode that does not occur, and a repair that re-opens the camera on loss makes a
weak uplink worse. Confirm with the keyframe cadence before believing otherwise:

```bash
ffprobe -v quiet -select_streams v -show_entries packet=pts_time,flags -of csv=p=0 rec.mp4 | grep K
```

**2. The head is undecodable — ~1.2s.** Video packets start at 0.80s but nothing
decodes until the first keyframe at 2.00s: `sps_id N out of range`,
`non-existing PPS 0 referenced`, `no frame!`. MediaMTX writes video samples
before the H264 parameter sets reach the container — its own log says so
(`[recorder] SPS not received yet`). Every part has this lead-in.

**3. The tail loses ~2.8s of video while keeping the audio.** Video stops at
36.69s, audio runs to 39.46s. The final fMP4 fragment is not flushed on
publisher teardown. This is a reproducible instance of the reported symptom, at
the end of every file.

**Also measured, and good news:**

- `remote-inbound-rtp` **is** present with a numeric `fractionLost` from t+4s, so
  receiver-reported loss is available to the publisher if it is ever wanted.
- `replaceTrack` on the same transceiver does **not** restart the recorder —
  `[recorder] recording 2 tracks` logged once, `partCount: 1`, and no gap in the
  decoded video across the swap. Repairing a dead camera mid-broadcast is safe
  and does not split the file.

**Fixed frontend-side, shipped.** `liveWebrtc.watchVideo` polls `framesEncoded`
and, on a stall or on `ended`/`mute`, re-acquires the camera and `replaceTrack`s
it — verified above. A screen wake lock is held while broadcasting, since
display sleep suspending the camera is the most common way a live picture dies
with the tab still open.

**Worth doing backend-side.** Both #2 and #3 are cured for free by the join step
in the section below, because re-encoding drops the undecodable lead-in and
rebuilds the timeline. Fixing them at the source would be better still: hold
video samples until SPS/PPS are known, and flush the final fragment on
disconnect.

---

## NEW — Recording in takes, and one file at the end

Built 2026-07-28 (backend `~/Desktop/irc` + frontend). **Exercised end to end**
against the running stack with a headless fake camera:

```
recording/start -> 200 RECORDING     take 1
recording/stop  -> 200 PAUSED        pause — the broadcast survived; take 2 published fine
recording/start -> 200 RECORDING     take 2
end             -> status AVAILABLE, partCount 1
```

The endpoints, the pause-that-does-not-drop-the-broadcast, and the join into a
single file all work. The seam quality took two iterations to get right — see
trap 3.

> The **seek-based join is compiled but not yet exercised through the running
> backend** (it needs a restart). The ffmpeg pipeline itself is verified on real
> parts; what is unproven is only the Java calling it.

**Shape.** The host records in takes while live — on, off, on again — and every
take is joined into a single file when the stream ends. Nothing about the seams
is visible in the finished video, and `download` with no `part` finally means
what a caller expects, which retires the multi-part 400 in **P1**.

| route | effect |
|---|---|
| `POST /streams/{id}/recording/start` | host-only, live-only, idempotent → `RECORDING` |
| `POST /streams/{id}/recording/stop`  | pauses, broadcast continues → `PAUSED` |

New `RecordingStatus` values: `PAUSED` (live, not saving) and `PROCESSING` (ended,
takes being joined — the individual parts stay downloadable throughout).

### Three traps, all of which drop the broadcast or corrupt the file

**1. Pause must not delete the path config.** `removeRecordingPath` issues
`DELETE /v3/config/paths/delete/{id}`, which tears down the path the browser is
actively publishing to. Using it to pause ends the stream. Pause is
`PATCH {"record": false}`.

**2. The path config must exist before anyone publishes.** Adding one under a
live publisher re-creates the path and drops the broadcast — the same bug as #1
wearing a different coat. `ensurePath(streamId, record)` therefore runs at
go-live for **every** stream, opted in or not, so every later change is a patch
of an existing entry. The privacy property is unchanged (`record: false` writes
nothing to disk; what exists is a config entry, not a recording), but path
cleanup at end had to become unconditional or an opted-out stream leaks one
MediaMTX path per broadcast, forever.

**3. The join must trim each part before joining. Re-encoding alone is not
enough.** This was measured, twice, and the first answer was wrong.

Each part carries both P1b defects: audio starts at 0 but video does not decode
until 0.45–1.5s in, and audio outlives video by ~2.7s at the end. Concatenating
leaves a video-shaped hole at every seam.

| join strategy | seam freeze |
|---|---|
| one-pass `concat` + re-encode | **2.7s** — a re-encode of a hole is a hole |
| per-part `-shortest`, then concat | 0.6s — tail cured, lead-in remains |
| per-part `-ss <first decodable frame>` **+** `-shortest`, then concat | **none** |

So the join is two passes. First normalize each part on its own — seek past the
undecodable lead-in and cut the audio-only tail:

```bash
SS=$(ffprobe -v quiet -select_streams v -show_frames -show_entries frame=pts_time \
     -of csv=p=0 -read_intervals '%+10' part.mp4 | head -1)
ffmpeg -ss "$SS" -i part.mp4 -map 0:v:0 -map '0:a:0?' \
       -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac \
       -shortest -avoid_negative_ts make_zero norm-N.mp4
```

`-ss` goes **before** `-i` and trims both streams together — shifting video
alone would desync it by exactly the amount you trimmed. `-show_frames` rather
than `-show_packets` because only the former decodes, and the undecodable
lead-in is precisely what must be skipped.

Then join. Every part now shares codec parameters, so this is a stream copy —
no second generation of loss, and it takes seconds:

```bash
ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart out.mp4
```

**Verified** on a two-take broadcast: 214 decodable frames, 0.02 → 10.69s, **no
gap greater than 0.4s anywhere**, video and audio ending 0.07s apart.

It runs once per broadcast, off the request path (after commit, single-threaded
— a re-encode is CPU-hungry and shares the box with the media server), and is
non-destructive: if ffmpeg is missing, errors or times out, the original parts
are left exactly as they are and the recording still lands `AVAILABLE`.

### Two operational notes

- **`ffmpeg` must be on the backend host's PATH.** Configurable via
  `app.streaming.ffmpeg-bin`. Without it the join silently no-ops and recordings
  stay multi-part — degraded, not broken.
- **The database CHECK constraint needed widening by hand.** `live_streams_
  recording_status_check` enumerated the original five statuses; with
  `ddl-auto: update` and no Flyway/Liquibase, Hibernate will never alter it, so
  the first pause would have thrown a constraint violation. Applied to the local
  `irc` database as:

  ```sql
  ALTER TABLE live_streams DROP CONSTRAINT live_streams_recording_status_check;
  ALTER TABLE live_streams ADD CONSTRAINT live_streams_recording_status_check
    CHECK (recording_status::text = ANY (ARRAY['DISABLED','RECORDING','PAUSED',
      'PROCESSING','AVAILABLE','EMPTY','DELETED']::text[]));
  ```

  **This lives only in that database.** With no migration tool in the project it
  is not reproducible anywhere else — any other environment needs the same
  statement run by hand, and that is a standing hazard for every future enum
  change, not just this one. Adopting Flyway is the real fix.

---

## P2 — `stream.ended` and `stream.viewer` never reach followers

**Symptom.** The "following is live" rail only ever *grows*. A followed host ends
their stream and the card stays until a page reload; tapping it opens a dead room.

**Cause.** Measured by reading the raw SSE frames as a follower who never joined:

| event | reaches a follower who never joined? |
|---|---|
| `stream.started` | **yes** — fanned to the host's followers, works perfectly |
| `stream.ended` | **no** |
| `stream.viewer` | **no** |

Both are fanned to a *stream's participants*, which matches the delivery table in
`live-streaming.md` — but it means a follower's row can never learn the stream is
over. `live-row-frontend.md` §4 tells the frontend to subscribe to
`stream.ended` "to avoid polling", and that is not achievable as built.

**Fix.** Fan `stream.ended` out to the host's followers, exactly like
`stream.started`. That is the one that matters; `stream.viewer` is a nice-to-have
(counts on the rail would go stale between refreshes without it).

**Frontend workaround in place until then:** a 60s reconcile on the rail and the
discovery grid, paused while the tab is hidden. It is marked for deletion in the
code the day `stream.ended` is fanned to followers.

---

## P3 — `hostAvatarUrl` is never populated

`live-streaming.md` documents `hostUsername` / `hostDisplayName` / `hostAvatarUrl`
as present on the read/discovery endpoints so a live row can render the avatar ring
without a per-card user fetch. The first two arrive; **`hostAvatarUrl` is absent
from every response** — `/streams/live`, `/streams/live/following`, `/streams/{id}`,
go-live and join.

Consequence: the live rail always renders the initials plate. It degrades cleanly
(the field is documented nullable and the frontend treats it as such), so this is
cosmetic — but the ring is the whole point of that row.

Also note: when it *is* populated, if the value is a relative path the frontend
prefixes `API_BASE` (as it does for every other avatar). An absolute URL is passed
through untouched.

---

## P4 — Small stuff

- **`shareUrl` still mints `https://irc.example.com/live/{id}`.** `irc.base-url`
  needs the real frontend origin (dev: `http://localhost:5173`), or every shared
  live link is dead. Flagged previously for channels; still true for streams.
- **`recordingDownloadUrl` is omitted, not `null`.** The doc says "`null`
  otherwise"; the field is simply absent from the JSON. Harmless — noting it only
  because the doc and the wire disagree.

---

## What was verified working, for the record

Not everything needs fixing — these were exercised end to end and behaved exactly
as documented:

- Per-path recording opt-in. An opted-in stream gets a MediaMTX path with
  `record: true`; an **opted-out stream has no path at all** (`404` from
  `/v3/config/paths/get/{id}`) so it never touches disk; the path config is removed
  again on end. The privacy argument for per-path was sound and it works.
- `POST /streams {record:true}` → `recordingStatus: RECORDING` → `AVAILABLE`/`EMPTY`
  on end → `DELETED` after removal.
- `GET /streams/mine`, `PATCH /streams/{id}`, `DELETE /streams/{id}`,
  `GET`/`DELETE /streams/{id}/recording` — all correct, and all `403` for non-owners.
- `stream.updated` fires on a live `PATCH` and reaches current viewers.
- The download route is Bearer-authed (**403 with no token**, `404` + JSON when
  there is no recording), which is why the frontend fetches it as a Blob rather
  than linking to it.
- RTMP ingest: ffmpeg → `ingestUrl` → recorded h264+aac cleanly. The WebRTC path is
  the only one with the P0 race.

---

## Test recipe

Reproducing P0/P1 needs a real publisher; headless browsers publish no camera, so
every stream ends `EMPTY` unless you either drive Chrome with
`--use-fake-device-for-media-stream` (fake camera, exercises the WHIP path and the
race) or publish synthetically over RTMP:

```bash
ffmpeg -re -f lavfi -i testsrc=size=640x360:rate=25 \
       -f lavfi -i sine=frequency=440 \
       -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
       -c:a aac -t 10 -f flv "<ingestUrl>"
```

Then check what actually landed:

```bash
curl -s localhost:9997/v3/paths/get/<streamId> | jq .tracks   # must include H264
docker logs irc-mediamtx-1 | grep '\[recorder\] recording'    # 1 track = the bug
ffprobe -show_entries stream=codec_name,codec_type recording.mp4
```

A file with one `opus` stream and no video stream is the P0 failure. To check for a
black picture rather than a missing track:

```bash
ffmpeg -i recording.mp4 -vf signalstats,metadata=print:key=lavfi.signalstats.YAVG \
       -frames:v 15 -an -f null -    # mean YAVG < 20 ≈ black
```

### Driving a real WHIP publish (the recipe that produced the P1b numbers)

RTMP ingest does not exercise the WebRTC path, which is where every one of these
bugs lives. What works:

1. Serve a page that imports the app's **real** `src/lib/liveWebrtc.js` (copy it
   next to the page; it has no imports) and calls `publishCamera(whipUrl)`.
   Serve over `http://127.0.0.1` — `file://` is not a secure context, so
   `getUserMedia` is unavailable.
2. Drive it with `playwright-core` + `channel: 'chrome'` and
   `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
   --autoplay-policy=no-user-gesture-required`. The fake camera is a rolling
   test pattern, so a frozen picture is obvious.
3. Get the `whipUrl` from `POST /api/v1/streams` as a real user — MediaMTX auth
   is an HTTP hook to the backend, so a stream key issued by the backend is the
   only way past it.

Then, on the delivered file — the two checks that actually distinguish the
failure modes:

```bash
# where does each track stop? video ≪ audio = the picture died
ffprobe -v quiet -select_streams v -show_entries packet=pts_time -of csv=p=0 rec.mp4 | tail -1
ffprobe -v quiet -select_streams a -show_entries packet=pts_time -of csv=p=0 rec.mp4 | tail -1

# gaps in DECODED video — the only definition of "frozen" that matters
ffprobe -v quiet -select_streams v -show_frames -show_entries frame=pts_time \
        -of csv=p=0 rec.mp4 | awk -F, 'NR>1 && $1-p>0.4 {print p" -> "$1} {p=$1}'
```

Beware `nb_frames` and `duration` — both report the container's claims, not what
decodes. A file whose video is entirely undecodable still reports a healthy
video stream. Only `-show_frames` (which decodes) and the decoder's own stderr
tell the truth.
