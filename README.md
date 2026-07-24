# ring-vapi-doorman

Press the Ring doorbell button, and a Vapi assistant answers through the doorbell —
the visitor talks to it out of the Ring speaker and mic, in real time.

Written from scratch against `ring-client-api@14.3.0`. The earlier attempt lives in
`~/Projects/archive/misc/ring-experiments/` and is not referenced by any of this code.

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

Two decisions worth knowing about:

- **We run the return-audio ffmpeg ourselves** instead of using the library's
  `transcodeReturnAudio`. That helper appends caller arguments *after* `-i`, so
  there is no way to declare a raw-PCM input (`-f s16le -ar … -ac …` must come
  before it). We spawn the same pipeline with the input flags in the right place.
- **Assistant audio is paced into 20 ms frames**, padded with silence when the
  assistant isn't talking, and dropped from the front past
  `AUDIO_MAX_BUFFERED_MS`. A continuous stream keeps the opus encoder aligned
  with the wall clock, so speech arrives paced rather than in bursts, and the
  latency cap keeps the assistant from replying to something the visitor said a
  second ago.

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

## Status

**Vapi leg: verified live** (2026-07-24). `npm run vapi-test` held a real
conversation with the "Ring - Doorbell" assistant — synthesized visitor speech
in, correct transcripts back (`user — Hi. I have a package for Sriram.`), 23.6 s
of assistant audio captured to a wav at sane levels. That covers call creation,
the websocket protocol, the PCM format contract in both directions, and the 20 ms
frame pacing.

**Ring leg: not yet run.** The refresh token in `.env` expired and
re-authenticating needs an interactive 2FA login:

```bash
npm run auth      # then paste the token into .env
npm run doctor    # ring auth should flip to ok
npm run speaker-test   # first real signal: your voice out of the doorbell
npm run call           # full bridge, without waiting for a button press
npm start              # the real thing
```

Unknowns that only the hardware can settle: whether ding pushes arrive (the old
project's dead end — fall back to `RING_DING_POLL_SECONDS=5`), and the true
round-trip latency once opus transcoding sits on both ends.
