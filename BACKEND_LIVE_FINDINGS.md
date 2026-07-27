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

> The runtime patch is **not persisted** — it reverts to `2s` on the next
> `docker compose restart`. It needs to go in the file.

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

- Fixing **P0** should make this rarer — with video present from the first moment
  the track set never changes. **Not verified**, worth confirming.
- `…/recording/download` with no `part` could concatenate/remux the parts and
  return one file, which is what a user means by "download the recording". Today
  the caller has to know the manifest exists.
- Discarding a part that has no video track would avoid handing anyone a black
  file at all.

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
