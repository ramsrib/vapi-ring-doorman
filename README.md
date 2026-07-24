# vapi-ring-doorman

Your Ring doorbell, answered by a [Vapi](https://vapi.ai) voice assistant.

Press the button and the assistant picks up — the visitor talks to it through the
doorbell's own speaker and microphone, in real time, and it hangs up when the
conversation is done.

> **Unofficial.** Ring publishes no third-party API. This is built on
> [`ring-client-api`](https://github.com/dgreif/ring), which reverse-engineers
> the app's, and Ring can break it without notice. Vapi calls cost money per
> minute. Use on a doorbell you own.

## How it works

```
button press (Ring push notification)
        |
  live call + speaker enabled
        |
visitor ->  Ring mic  -> WebRTC opus -> ffmpeg -> PCM 16k -> ws -> Vapi
visitor <- Ring speaker <- WebRTC opus <- ffmpeg <- PCM 16k <- ws <- Vapi
```

Both legs are ffmpeg transcodes because the two sides speak different audio:
Ring negotiates opus (48 kHz stereo) or pcmu over WebRTC, while Vapi's websocket
transport wants raw `pcm_s16le` mono. Vapi's websocket transport is what makes
this tractable at all — no phone number, no SIP, no WebRTC on that side, just
PCM frames over a socket.

| File | Role |
| --- | --- |
| `src/main.ts` | Waits for a press, answers one call at a time |
| `src/ring.ts` | Auth, camera selection, live calls, ding detection |
| `src/vapi.ts` | Websocket-transport call: PCM in/out, transcripts |
| `src/jitter-buffer.ts` | Smooths Vapi's bursty audio into steady frames |
| `src/return-audio.ts` | Assistant audio -> ffmpeg -> RTP -> Ring's speaker |
| `src/bridge.ts` | Wires one call together and tears it down |
| `src/chime.ts` | Mutes and restores the doorbell chime |

## Requirements

- Node 22.18+ (runs the TypeScript directly, no build step)
- ffmpeg with libopus (`brew install ffmpeg`)
- A Ring doorbell you own, and a Vapi account with an assistant

## Setup

```bash
npm install
cp .env.example .env
npm run auth      # interactive: Ring email, password, 2FA -> refresh token
npm run doctor    # checks node, ffmpeg, Ring auth, and the Vapi assistant
```

Paste the token from `npm run auth` into `.env` as `RING_REFRESH_TOKEN`. Ring
rotates that token as it's used and this app writes the new one back to `.env`
automatically — don't strip that out, because a stale token fails in ways that
look like "push notifications stopped working" rather than an auth error.

## Running

```bash
npm start     # listen for button presses — the real thing
npm run call  # answer immediately without a press, for iterating
```

While a call runs, each line tells you whether audio is actually crossing:

```
bridge: ring->vapi 10.6s  vapi->ring 10.6s  underruns 176f  dropped 0.00s
```

Both counters climbing together is healthy. `underruns` climbing *while the
assistant speaks* means the jitter buffer is too small.

## Ending a call

The doorbell button starts calls; it cannot end them. Ring suppresses the button
while a call is active — no push, no events-API entry, nothing to react to
(see [docs/FINDINGS.md](docs/FINDINGS.md)). Calls end four other ways:

| How | Where it comes from |
| --- | --- |
| The assistant decides the conversation is over | `endCall` tool, appended per call |
| It says "goodbye" / "have a great day" | `VAPI_END_CALL_PHRASES` |
| Nobody says anything | Vapi's silence timeout |
| Enter in the terminal, or `CALL_MAX_SECONDS` | this app |

The first two are applied through `assistantOverrides` at call creation, so your
saved Vapi assistant is never modified.

## The chime

The doorbell's own chime is muted for the duration of a call, so a second press
doesn't blast the tone over the conversation, and restored afterwards. The
original volume is saved to `.chime-state.json` first — muting someone's
doorbell is a change to their house, and a crash between mute and restore would
otherwise leave it silent with no clue why. Startup restores it automatically,
and `npm run restore-chime` is the manual escape. Set
`MUTE_CHIME_DURING_CALL=false` to leave it alone.

## Diagnosing

Each leg can be tested on its own, which is how every problem here was found:

```bash
npm run doctor        # prerequisites, Ring auth, Vapi assistant
npm run dings         # is the push path alive?          (no Vapi)
npm run rtp-probe     # is the device actually streaming? (no Vapi, no ffmpeg)
npm run encoder-test  # is the speaker leg well-formed?   (no Ring, no Vapi)
npm run vapi-test     # is the Vapi leg alive?            (no Ring)
npm run speaker-test  # your voice out of the doorbell    (no Vapi)
npm run cameras       # list devices, to pin RING_CAMERA
npm run press-probe   # does your device signal a mid-call press?
```

`rtp-probe` is the one that matters most: an offline doorbell still lets a call
connect, negotiate a codec, and report "audio flowing", while sending zero RTP.
It counts raw packets upstream of everything else, so zeros mean the device
isn't streaming and the code is fine.

`RECORD=true` writes each leg of a call to a wav on hangup — `ring-in.wav` is
what the doorbell heard, `vapi-in.wav` what the assistant said. Fastest way to
tell a dead microphone from a dead speaker.

## Tuning audio

| Symptom | Knob | Notes |
| --- | --- | --- |
| Choppy assistant audio | `AUDIO_PREBUFFER_MS` | Vapi delivers in bursts — p95 gap ~51 ms. Default 150 ms rides through; every ms is added latency. `npm run vapi-test` prints the live distribution. |
| Greeting overlaps the chime | `CALL_ANSWER_DELAY_MS` | How long to wait after the press before the assistant speaks. |
| First syllable clipped | `AUDIO_COMFORT_NOISE` | Keeps the speaker path from idling between words. |

Raising `AUDIO_SAMPLE_RATE` past 16000 is usually pointless: Vapi's built-in
voices are band-limited to ~8 kHz, so higher rates only upsample. A
higher-fidelity voice provider may change that — measure before assuming.

## What we learned

[docs/FINDINGS.md](docs/FINDINGS.md) documents Ring's undocumented behaviour —
the offline device that fakes a working call, the button going dead mid-call,
cached data that lies after a settings write — plus the audio pitfalls
(Node timer drift starving the encoder, Vapi's bursty delivery) and the exact
device and versions everything was verified against. Read it before debugging.

## License

MIT
