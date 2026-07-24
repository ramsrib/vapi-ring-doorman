# Ring + Vapi: what we learned building this

Everything here was established empirically against a real device on
2026-07-24, mostly because the documented behaviour either didn't exist or
didn't match. Claims are marked **verified** (we measured it) or
**inferred** (consistent with observation, not directly proven).

Ring has no official third-party API. Everything on the Ring side goes through
`ring-client-api` (unofficial, v14.3.0), so treat all of it as subject to
change without notice.

---

## Test environment

Everything below was observed on this exact setup, on **2026-07-24**.

### The device

```
name         Office
id           704424693
kind         df_doorbell_clownfish
model        "Unknown Model"        # see below
ownership    doorbots               # owned, not authorizedDoorbots (shared)
power        battery at 59%, external_connection: true  (battery model, wired in)
firmware     "Up to Date"           # see below
wifi         -35 dBm, category "good"
```

Two quirks in that block:

- **`df_doorbell_clownfish` is not in `ring-client-api`'s `RingCameraKind`
  table.** That list tops out at the `scallop` / `cocoa` / `graham_cracker`
  generation, so this device falls through to the literal string
  `"Unknown Model"`. Everything we need still works — the unknown kind affects
  only the model name, not streaming. Ring's public docs don't map this
  codename to a retail model either; we couldn't identify which product it is.
- **`firmware_version` is the string `"Up to Date"`, not a version number.**
  Both `data.firmware_version` and `getHealth().firmware` return that status
  text, so there is no way to record an actual firmware build from this API —
  which means "worked on firmware X" is not a claim we can make.

Settings as returned by `fetchRingDevices()`:

```jsonc
{
  "doorbell_volume": 4,             // the ding tone from the doorbell's own speaker
  "voice_volume": 8,                // live-call speaker volume — a separate control
  "chime_settings": { "enable": true, "type": 2, "duration": 10 },
  "video_settings": { "hevc_enabled": false, "encryption_enabled": false },
  "enable_vod": 1
}
```

There are **no Chime devices** on the account and `hasInHomeDoorbell` is
`false`, so the doorbell's own speaker is the only thing that makes noise.
`setInHomeDoorbell()` is useless here; the only volume lever is
`doorbell_volume`.

**Beware `hasBattery`.** While the device was offline, `battery_life` came back
`null`, so `camera.hasBattery` was `false` and our own tooling printed the
device as "wired". Once online it reports 59%. The property is derived from
`battery_life`, not from the device kind, so it is only as good as the last
successful poll — don't treat it as a hardware fact.

### Toolchain

| | |
| --- | --- |
| macOS | 26.5.2 (build 25F84), Apple Silicon |
| Node | v26.2.0 — note `ring-client-api` declares `^20 \|\| ^22 \|\| ^24`, so npm prints an EBADENGINE warning. Works regardless. |
| npm | 11.13.0 |
| ffmpeg | 8.1.2, with libopus |
| ring-client-api | 14.3.0 |
| werift | 0.22.4 (pinned — must match the library's copy) |
| ws | 8.21.1 |
| @eneris/push-receiver | 4.3.0 (transitive; carries Ring's push) |
| Vapi | assistant "Ring - Doorbell", websocket transport, `pcm_s16le` @ 16 kHz |

Identifiers deliberately left out of this doc: the device's MAC-style
`device_id`, the `location_id` UUID, and the wifi SSID.

Anything below that depends on the model — chime behaviour, the codec Ring
negotiates, whether the button is swallowed mid-call — should be re-checked on
a different doorbell. The audio and API lessons are general.

---

## Authentication

- **Refresh tokens rotate on nearly every connect.** Every run of this app logs
  `refresh token rotated`. If you don't persist the new one, the next run fails
  with `Refresh token is not valid` — *verified*, and it is the most likely
  cause of a setup that "worked yesterday".
- Getting a fresh token needs interactive 2FA (`ring-auth-cli`), so it can't be
  automated from a script.
- **Inferred:** this is the likeliest explanation for the previous project's
  push-notification troubles. A stale token produces auth failures that look
  like "push stopped working" rather than an obvious error.

---

## Device offline: the failure that looks like a bug

The single most misleading behaviour we hit. With the doorbell physically
offline:

- `camera.startLiveCall()` **succeeds**. Ring's cloud negotiates the WebRTC
  session and answers with opus.
- `activateCameraSpeaker()` succeeds. The bridge reports "audio flowing both
  ways". The assistant greets and talks.
- **Zero RTP packets arrive** — audio *and* video, across the whole session.
- Ring tears the session down after ~22 s.

So a completely dead device produces a call that looks alive from every angle
except the one that matters. *Verified.*

Device fields that give it away:

```jsonc
{
  "alerts": { "connection": "offline" },
  "ring_id": null,
  "health": { "latest_signal_strength": null, "wifi_name": null }
}
```

**How to tell in ten seconds:** `npm run rtp-probe`. It counts raw RTP upstream
of ffmpeg and everything else we do. Zeros mean the device isn't streaming; a
climbing count (~50 audio packets/sec) means it is. Healthy output looks like:

```
audio rtp: 117 packets / 18946B   video rtp: 438 packets
audio rtp: 267 packets / 43147B   video rtp: 974 packets
```

---

## Cached data lies

`camera.data` is a cached snapshot. After `camera.setSettings({...})` the change
does **not** appear in `camera.data`, even after `requestUpdate()` and several
seconds of waiting. Re-read through `api.fetchRingDevices()` to see the truth.
*Verified* — we chased a "setSettings doesn't work" ghost for one round trip
before checking a fresh fetch showed `4 → 0 → 4` exactly as commanded.

---

## Push notifications (the button press)

Push works, and works well:

- Category `com.ring.pn.live-event.ding`, delivered via FCM
  (`@eneris/push-receiver`).
- **~1.2 s from button press to our code answering.** *Verified.*
- `ring-client-api` does not dedupe: `onNewNotification` emits every push it
  receives, and `onDoorbellPressed` filters by category.

This contradicts the previous attempt's experience, where unreliable push was
the dead end. See the auth note above for the likely reason.

### Ring goes deaf during an active call

**A button press while a call is in progress produces no signal at all.**
*Verified twice, with the button pressed 2-3 times per test:*

| Channel | Result |
| --- | --- |
| Push notifications (any category) | nothing |
| Events API, filtered `kind: 'ding'` | nothing |
| Events API, no filter | nothing new |
| `dings/active` (legacy pre-push endpoint) | only our own session, as `kind: "on_demand"` |
| Live-session signalling | no unknown messages |

For reference, `dings/active` during our own live call returns:

```jsonc
{ "id_str": "7666222543358700277", "state": "ringing", "protocol": "sip",
  "kind": "on_demand", "device_kind": "df_doorbell_clownfish" }
```

**Consequence:** the doorbell button cannot be used to end a call. Ring appears
to treat the ding as already answered and swallows further presses. The device
itself still registers them — it plays the chime tone — so the press is real;
Ring just never tells the API.

**Untested escape hatch:** if that chime tone reaches the doorbell's own
microphone, it would arrive in the audio we already receive and could be
detected. Unknown whether the device's echo canceller strips it, since the tone
comes from the same speaker the canceller is tuned to remove. To test: run with
`MUTE_CHIME_DURING_CALL=false` and `RECORD=true`, press mid-call, and look for
a tone burst in `ring-in.wav`.

---

## Live calls

- `startLiveCall()` negotiates **opus** (48 kHz stereo) on this device.
  `session.isUsingOpus` reports it; pcmu is the documented alternative.
- **`activateCameraSpeaker()` is mandatory** or the visitor hears nothing.
- Ring ends an idle session after ~22 s. With audio flowing both ways a call
  ran ~2 minutes without Ring intervening (Vapi ended it first). *Verified.*
- Session signalling methods: `sdp`, `ice`, `session_created`,
  `session_started`, `pong`, `notification`, `close`, `camera_started`,
  `stream_info`. The library logs anything else as `UNKNOWN MESSAGE`, which
  makes it a usable canary for undocumented events.

---

## Audio: what actually caused problems

### `transcodeReturnAudio` can't take raw PCM

The library's helper builds its ffmpeg command as `-re -i <your args>`, placing
caller arguments **after** `-i`. Raw PCM needs `-f s16le -ar … -ac …` *before*
the input, so it cannot be expressed. We run the same pipeline ourselves
(ffmpeg → RTP on a local UDP port → `sendAudioPacket`) with the flags in the
right order. See `src/return-audio.ts`.

Related: `werift` must be pinned to the exact version `ring-client-api` depends
on (`0.22.4`) so npm dedupes to one copy and `RtpPacket` stays a single type.

### Node timers starve a live encoder

**A nominal 20 ms `setInterval` fires at ~92% of real time on an idle machine.**
*Verified* with a standalone benchmark: 230 ticks in 5 s, not 250.

Feeding an audio encoder one frame per tick therefore runs ~8% slow, and a
starved encoder is audible as choppiness. The fix is to pace against the wall
clock — compute how many frames are *due* since start and write that many.
Measured at 99.7% of real time afterwards, and it was the single biggest audio
quality win.

Anything doing real-time media in Node has this problem. It is not specific to
Ring or Vapi.

### Vapi delivers audio in bursts

Measured chunk inter-arrival gaps on the Vapi websocket (`npm run vapi-test`
prints these):

```
p50 0ms   p95 51ms   p99 54-56ms   max ~2000ms (first chunk)
```

p50 of 0 ms means chunks arrive clumped together, then a gap. A jitter buffer
smaller than ~55 ms will empty mid-word. We use 150 ms
(`AUDIO_PREBUFFER_MS`), which costs 150 ms of latency and removed the audible
choppiness. *Verified:* underrun counters stayed flat at 174 across a full
conversation afterwards, all of them from the pre-greeting warm-up.

### Vapi's audio is band-limited — don't chase sample rates

Vapi accepts `sampleRate` of 16000, 24000 and 48000 on the websocket transport
and honours all three. But measuring the returned audio at 48 kHz:

```
full band        mean -23.3 dB
above 8 kHz      mean -59.7 dB     # 36 dB down
```

There is no real content above 8 kHz. Higher rates only upsample, tripling
bytes for nothing. **16 kHz is the correct setting.** *Verified.* Some of the
perceived "not high quality" is inherent to the TTS and the doorbell speaker,
not something the bridge can fix.

### Digital silence vs comfort noise

We fill gaps with faint noise (~-60 dBFS) rather than zeros, on the theory that
a receiver seeing near-silent VBR opus frames may let its speaker path idle and
clip the first syllable when speech resumes. **Inferred, not isolated:** it
shipped together with the pacing fix and the larger jitter buffer, and the
combination fixed the reported clipping. We never tested it alone.

### Opus RTP shape

For sanity-checking a return-audio pipeline without hardware
(`npm run encoder-test`): payload type 97, timestamp step exactly 960 per 20 ms
frame at 48 kHz, contiguous sequence numbers, ~50 packets/sec.

---

## Vapi API notes

- **The full OpenAPI spec is fetchable at `https://api.vapi.ai/api-json`.** Far
  more reliable than the docs site for exact field names — it is how we found
  the override fields below.
- Websocket transport: `POST /call` with
  `transport: { provider: 'vapi.websocket', audioFormat: {...} }`, which returns
  `transport.websocketCallUrl`. Binary frames are audio, text frames are JSON
  control/status messages.
- `assistantOverrides` **does** support: `tools:append`, `endCallPhrases`,
  `endCallMessage`, `maxDurationSeconds`, `firstMessage`, `stopSpeakingPlan`.
- `assistantOverrides` **does not** support: `endCallFunctionEnabled`,
  `silenceTimeoutSeconds` (both exist elsewhere in the API, not as overrides).
- Appending `{ type: 'endCall' }` via `tools:append` gives the assistant the
  ability to hang up **without modifying the saved assistant** — the override
  applies only to calls this app creates. With it, a call ends ~0.5 s after the
  goodbye instead of idling until Vapi's silence timeout. *Verified.*
- `endCallPhrases` match phrases spoken **by the assistant**, not the visitor.

---

## Muting the chime

`camera.setSettings({ doorbell_volume: 0 })` works and takes effect immediately
(*verified* via fresh fetch). We mute for the duration of a call so a second
press doesn't blast the tone over the conversation, and restore afterwards.

This changes the user's actual house, so the original volume is also written to
`.chime-state.json` before muting. A crash between mute and restore would
otherwise leave the doorbell permanently silent with no clue why — which
happened twice during development, both times caught by the restore-on-startup
path. `npm run restore-chime` is the manual escape.

---

## Node/tooling gotchas that cost us time

- **Signal handlers registered after a top-level `await` never register.**
  Module evaluation blocks at the await, so a `process.on('SIGINT', …)` at the
  bottom of the file doesn't exist yet during the awaited work — Ctrl-C then
  kills the process outright and skips all cleanup. Register handlers first.
- **`process.exit()` truncates buffered stdout.** When stdout is a file, exiting
  immediately after logging discards the last lines. This hid a chime restore
  that had actually run and sent us chasing a non-bug. Let the loop drain
  instead, with an `unref()`'d timer as a backstop.
- **`timeout 60 npm run x` sends SIGTERM to npm, not to node.** The child is
  killed without running its handlers. Signal the node process directly.
- **`head -n` on a pipe kills the producer** via EPIPE, skipping graceful
  shutdown. Redirect to a file and grep it instead.
- **macOS `say -o /dev/stdout` fails** with `Opening output file failed: -54`.
  Write to a real `.wav` path and read it back.

---

## Open questions

- Does the chime tone survive the device's echo canceller into the mic feed?
  (The only remaining route to a working button-press hangup.)
- Does push delivery stay reliable over days and weeks? Ours was reliable
  across a single day. `RING_DING_POLL_SECONDS=5` is the fallback if it drifts.
- Does the device sleep or behave differently on battery models? This one is
  wired.
