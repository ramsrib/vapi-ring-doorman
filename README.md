# ring-vapi-doorman

Press the Ring doorbell button, and a Vapi assistant answers through the doorbell —
the visitor talks to it out of the Ring speaker and mic, in real time.

Written from scratch against `ring-client-api@14.3.0`. The earlier attempt lives in
`~/Projects/archive/misc/ring-experiments/` and is not referenced by any of this code.

**[docs/FINDINGS.md](docs/FINDINGS.md)** collects what we learned about the device
and both APIs — Ring's undocumented behaviour, the audio pitfalls, and the traps
that cost the most time. Read it before debugging anything here.

## How it works

```
button press (Ring push notification)
        |
  camera.startLiveCall()  +  activateCameraSpeaker()
        |
visitor ->  Ring mic  -> WebRTC opus -> ffmpeg -> PCM 16k -> ws -> Vapi
visitor <- Ring speaker <- WebRTC opus <- ffmpeg <- PCM 16k <- ws <- Vapi
```

Both legs are ffmpeg transcodes because the two sides speak different audio:
Ring negotiates opus (48 kHz stereo) or pcmu over WebRTC, Vapi's websocket
transport wants raw `pcm_s16le` mono.

| File | Role |
| --- | --- |
| `src/main.ts` | Waits for a press, answers one call at a time |
| `src/ring.ts` | Auth, camera selection, ding detection (push + optional poll) |
| `src/vapi.ts` | Creates the websocket-transport call, PCM in/out, transcripts |
| `src/return-audio.ts` | Assistant audio -> ffmpeg -> RTP -> Ring's speaker |
| `src/bridge.ts` | Wires one call together and tears it down |

Call behaviour:

- The greeting is held for `CALL_ANSWER_DELAY_MS` (4 s) so it lands *after* the
  doorbell's own chime instead of underneath it.
- **The button cannot end a call.** Ring suppresses the doorbell while a call
  is active: pressing it mid-call produces no push *and* no events-API entry
  (verified 2026-07-24 — one press logged for a two-minute call, two presses
  made). There is no signal to react to, so calls end another way (below).
- The chime is muted for the duration of a call, so a second press doesn't blast
  the tone over the conversation, and restored on the way out. A crash-safe copy
  of the original volume lives in `.chime-state.json`; `npm run restore-chime`
  puts it back, and startup does so automatically.

Three decisions worth knowing about:

- **We run the return-audio ffmpeg ourselves** instead of using the library's
  `transcodeReturnAudio`. That helper appends caller arguments *after* `-i`, so
  there is no way to declare a raw-PCM input (`-f s16le -ar … -ac …` must come
  before it). We spawn the same pipeline with the input flags in the right place.
- **Assistant audio is paced to the wall clock**, not one frame per timer tick.
  A nominal 20 ms `setInterval` actually fires at ~92% of real time on an idle
  machine, and feeding a live encoder 8% slow starves it — which is audible as
  choppiness. The pacer ticks finer and writes however many frames are *due*,
  measured at 99.7% of real time (`npm run encoder-test` reports this).
- **Gaps are filled with faint noise, not digital silence.** Zeros encode to
  near-nothing in VBR opus and a receiver that sees near-nothing can let its
  speaker path idle, clipping the first syllable when speech resumes.

## Setup

```bash
npm install
cp .env.example .env     # already seeded with the old project's Vapi credentials
npm run auth             # interactive: Ring email, password, 2FA -> refresh token
npm run doctor           # verifies node, ffmpeg+libopus, Ring auth, Vapi assistant
```

`npm run auth` prints a refresh token; paste it into `.env` as `RING_REFRESH_TOKEN`.
Ring rotates that token in use — `src/config.ts` writes the new one back to `.env`
automatically, which is the failure mode that silently kills push notifications if
you skip it.

## Running

```bash
npm start           # listen for button presses (the real thing)
npm run call        # open a call right now, no button press — fastest way to iterate
npm run dings       # log presses only, no Vapi — is the push path alive?
npm run speaker-test  # push local speech out of the doorbell, no Vapi — is return audio alive?
npm run vapi-test   # hold a conversation with the assistant, no Ring — is the Vapi leg alive?
npm run cameras     # list devices, pick one for RING_CAMERA
```

Those three test tools exist because the bridge has a small number of things that
can quietly fail. Isolate them before debugging the whole loop. `vapi-test` speaks
into the call with macOS `say` and writes the assistant's audio to `vapi-test.wav`.

## Known risk: push notifications

Ring has no official API. Ding delivery rides on FCM push via
`@eneris/push-receiver`, and it is the part that historically stops working —
it was where the previous attempt stalled. If `npm run dings` shows nothing when
you press the button:

1. Check the refresh token is current (`npm run doctor`).
2. Set `RING_DING_POLL_SECONDS=5` in `.env`. That polls the events API instead;
   it adds a few seconds of delay but does not depend on push at all.

## Ending a call

Four ways, in the order they usually fire:

| How | Where it comes from |
| --- | --- |
| The assistant decides the conversation is over | `endCall` tool, appended per call |
| The assistant says "goodbye" / "have a great day" | `VAPI_END_CALL_PHRASES` |
| Nobody says anything | Vapi's own silence timeout |
| Enter in the terminal, or `CALL_MAX_SECONDS` | this app |

The first two are applied through `assistantOverrides` at call creation —
`tools:append` and `endCallPhrases` — so the saved Vapi assistant is never
modified and the behaviour only applies to calls this app makes.

Not on the list: the doorbell button. See above.

## Tuning audio

Two numbers matter, both measurable rather than guessable:

| Symptom | Knob | Notes |
| --- | --- | --- |
| Choppy assistant audio | `AUDIO_PREBUFFER_MS` | Vapi delivers in bursts — p95 gap ~51 ms, p99 ~54 ms. Default 150 ms rides through; every ms is added latency. `npm run vapi-test` prints the live distribution. |
| First syllable clipped | `CALL_ANSWER_DELAY_MS`, `AUDIO_COMFORT_NOISE` | Give the chime room, and keep the speaker path warm. |

During a call the bridge logs `underruns Nf` every 5 s. If N climbs while the
assistant is speaking, the jitter buffer is too small. If N is flat, the audio
path is clean and any remaining roughness is upstream — Vapi's TTS is natively
band-limited (measured 36 dB down above 8 kHz), so raising `AUDIO_SAMPLE_RATE`
past 16000 only upsamples and costs bytes.

## Status — working

Confirmed end to end on 2026-07-24 with the real doorbell: pressing the button
fires a Ring push, the bridge answers, and you hold a conversation with the
assistant through the doorbell's speaker and mic. Push notifications — the thing
that killed the previous attempt — fire reliably, ~1.2 s from press to answer.

Audio quality after tuning: zero underruns during speech, nothing dropped, both
legs recorded at matching durations (114.38 s from the doorbell vs 114.60 s to
it, over a two-minute call — no drift).

Remaining rough edges:

- Ring's `alerts.connection` can read `offline` while the device is fine, and
  `camera.data` lags settings changes by a few seconds — read fresh via
  `fetchRingDevices()` when it matters.

## Diagnosing

Each leg can be tested alone, which is how every problem so far was localised:

```bash
npm run doctor        # prerequisites, Ring auth, Vapi assistant
npm run dings         # is the push path alive?          (no Vapi)
npm run rtp-probe     # is the device actually streaming? (no Vapi, no ffmpeg)
npm run encoder-test  # is the speaker leg well-formed?   (no Ring, no Vapi)
npm run vapi-test     # is the Vapi leg alive?            (no Ring)
npm run speaker-test  # your voice out of the doorbell    (no Vapi)
```

`rtp-probe` is the one that proved a dead call was an offline doorbell rather
than a bug: it counts raw RTP upstream of everything we do.
