# vapi-ring-doorman

**Let an AI assistant answer your Ring doorbell.**

Someone presses your doorbell. Instead of ringing into an empty house, a voice
assistant picks up and talks to them through the doorbell's own speaker — and
listens through its microphone. It can greet visitors, take a message, tell a
courier where to leave a package, and hang up when the conversation is over.

It sounds like this:

```
🔔  *ding-dong*
    Assistant:  Hello there! This is the doorbell. How can I help you?
    Visitor:    Hi, I have a package for Alex.
    Assistant:  Thanks! Could you leave it behind the planter by the door?
    Visitor:    Sure, will do. Bye!
    Assistant:  Have a great day.   *call ends*
```

You decide what it says and how it behaves — that part lives in your
[Vapi](https://vapi.ai) assistant, not in this code.

---

## Before you start — two honest warnings

**1. Ring doesn't officially support this.** Ring publishes no public API for
other apps. This uses [`ring-client-api`](https://github.com/dgreif/ring), a
community project that works out how the Ring app talks to Ring's servers. It
works well today, and Ring could break it tomorrow without warning. Only use it
on a doorbell you own.

**2. It only works while it's running.** This is a program on your computer, not
a service in the cloud. Close the terminal window and your doorbell goes back to
being an ordinary doorbell.

---

## What you'll need

- **A Ring doorbell** you own, on wifi and working in the Ring app
- **A computer** to run it on — a Mac, a Linux box, or a Raspberry Pi. It has to
  stay on and awake for the doorbell to be answered.
- **A Vapi account** with an assistant ([vapi.ai](https://vapi.ai))
- **Your Ring login**, including the two-factor code Ring sends you
- About 20 minutes for first-time setup

---

## Setup

### 1. Install the two things this needs

**Node.js** 22.18 or newer, from [nodejs.org](https://nodejs.org), and
**ffmpeg**, which handles the audio conversion.

On a Mac, with [Homebrew](https://brew.sh):

```bash
brew install node ffmpeg
```

On Debian or Ubuntu:

```bash
sudo apt install nodejs ffmpeg
```

### 2. Download this project and install it

```bash
git clone https://github.com/ramsrib/vapi-ring-doorman.git
cd vapi-ring-doorman
npm install
```

### 3. Create your settings file

```bash
cp .env.example .env
```

`.env` is where your keys and tokens live. It's deliberately excluded from
version control — never share it or commit it.

### 4. Create your Vapi assistant

In the [Vapi dashboard](https://dashboard.vapi.ai), create an assistant and give
it instructions. Something like:

> You are a friendly doorbell assistant. Greet the visitor and ask how you can
> help. Keep replies short — under about 15 seconds. If it's a delivery, ask them
> to leave the package by the door. If they're looking for someone, offer to take
> a message. Be polite, and say goodbye when the conversation is finished.

Then copy two values into `.env`:

- `VAPI_API_KEY` — from your Vapi account settings
- `VAPI_ASSISTANT_ID` — shown on the assistant you just created

### 5. Connect your Ring account

```bash
npm run auth
```

This asks for your Ring email, password, and two-factor code, then prints a long
**refresh token**. Copy it into `.env` as `RING_REFRESH_TOKEN`.

> That token grants access to your Ring account — treat it like a password, keep
> it in `.env`, and put it nowhere else. Ring replaces it periodically as it's
> used, and this app saves each new one for you automatically.

### 6. Check everything works

```bash
npm run doctor
```

Every line should say `ok`. If one says `XX` it tells you what's wrong — usually
a mistyped key, or a doorbell that's offline in the Ring app.

---

## Using it

**Start it:**

```bash
npm start
```

You'll see:

```
ring: using "Front Door" ...
listening for doorbell presses — press the button
```

Now go press your doorbell. The assistant waits a few seconds for the chime to
finish, then greets whoever is there.

**Leave that window open.** Press `Ctrl-C` when you want to stop.

**To test without walking outside:** `npm run call` starts a conversation
straight away, no button press needed.

### Choosing when the assistant answers

Two modes, set with `ANSWER_MODE` in `.env`:

| Mode | Behaviour |
| --- | --- |
| `immediate` *(default)* | The assistant answers every press. |
| `fallback` | A person gets first refusal. The assistant waits `FALLBACK_AFTER_SECONDS` (default 25) and only steps in if nobody picks up in the Ring app. |

Ring tracks whether a press was answered, so `fallback` mode reads that rather
than guessing: a ding that nobody takes ends up `timed_out`, one that someone
answers ends up `completed`. If the state is still undecided when the timer runs
out, the assistant answers — a missed visitor is worse than an assistant that
speaks up unnecessarily.

Keep `FALLBACK_AFTER_SECONDS` under about 60, since that's how long a Ring ding
lives. And remember the visitor is standing there in silence the whole time —
20-30s reads as a slow answer, a minute reads as a broken doorbell.

`npm run call` always connects immediately; it has no press to wait on.

### What happens during a call

- **The chime is muted** while the assistant is talking, so a second press
  doesn't blast the ding over the conversation. It's restored afterwards.
- **The button can't hang up.** Ring ignores the doorbell button while a call is
  in progress, so there's nothing for this app to listen for. Calls end when the
  assistant decides the conversation is over, when it says goodbye, when nobody
  speaks for a while, or when you press Enter in the terminal.
- **Progress is printed** every few seconds:

  ```
  bridge: ring->vapi 10.6s  vapi->ring 10.6s  underruns 176f  dropped 0.00s
  ```

  The first two numbers are seconds of audio travelling each way. Both climbing
  together means the conversation is flowing properly.

---

## If something goes wrong

Each part can be tested on its own, which is far faster than guessing.

| What you're seeing | Try this | What it tells you |
| --- | --- | --- |
| Won't start at all | `npm run doctor` | Checks your keys, Ring login, and ffmpeg |
| Nothing happens when you press the button | `npm run dings` | Whether Ring is telling us about presses |
| Assistant talks, but hears nothing | `npm run rtp-probe` | Whether the doorbell is really sending audio |
| Visitor hears nothing | `npm run speaker-test` | Plays your voice out of the doorbell |
| Doorbell fine, assistant silent | `npm run vapi-test` | Tests the assistant with no doorbell involved |
| Assistant sounds choppy | Raise `AUDIO_PREBUFFER_MS` in `.env` | Smooths uneven audio, at the cost of a little delay |
| Chime stayed silent after a crash | `npm run restore-chime` | Puts the doorbell's ding back |

**The most confusing failure, worth knowing in advance:** if your doorbell is
offline, a call still appears to connect and the assistant still talks — but no
audio ever arrives from the door. `npm run rtp-probe` is how you tell. If it
counts zero packets, the doorbell isn't streaming and nothing in this app can fix
that; check it in the Ring app.

To capture a call for closer inspection, set `RECORD=true` in `.env`. You'll get
`ring-in.wav` (what the doorbell heard) and `vapi-in.wav` (what the assistant
said).

---

## Settings worth knowing

All of these live in `.env`, and all have sensible defaults.

| Setting | Does what |
| --- | --- |
| `ANSWER_MODE` | `immediate` answers every press; `fallback` lets a person answer first |
| `FALLBACK_AFTER_SECONDS` | How long `fallback` mode waits before stepping in |
| `CALL_ANSWER_DELAY_MS` | How long to wait after the press before the assistant speaks, so it doesn't talk over the chime |
| `AUDIO_PREBUFFER_MS` | Raise if the assistant sounds choppy; lower for slightly faster replies |
| `MUTE_CHIME_DURING_CALL` | Set to `false` to leave your chime alone during calls |
| `CALL_MAX_SECONDS` | Hard limit on how long a single call can last |
| `RING_CAMERA` | Which doorbell to use, if you have more than one (`npm run cameras` lists them) |

---

## For developers

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
transport wants raw `pcm_s16le` mono. That websocket transport is what makes this
tractable — no phone number, no SIP, no WebRTC on the Vapi side, just PCM frames
over a socket.

| File | Role |
| --- | --- |
| `src/main.ts` | Waits for a press, answers one call at a time |
| `src/ring.ts` | Auth, camera selection, live calls, ding detection |
| `src/vapi.ts` | Websocket-transport call: PCM in/out, transcripts |
| `src/jitter-buffer.ts` | Smooths Vapi's bursty audio into steady frames |
| `src/return-audio.ts` | Assistant audio -> ffmpeg -> RTP -> Ring's speaker |
| `src/bridge.ts` | Wires one call together and tears it down |
| `src/chime.ts` | Mutes and restores the doorbell chime |

TypeScript runs directly on Node 22.18+ with no build step. `npm run typecheck`
type-checks the project; `npm run encoder-test` verifies the audio pipeline with
no hardware attached.

**[docs/FINDINGS.md](docs/FINDINGS.md) is worth reading before changing
anything.** It documents Ring's undocumented behaviour — the offline device that
fakes a working call, the button going dead mid-call, cached data that lies after
a settings write — plus the audio pitfalls (Node timer drift starving the
encoder, Vapi's bursty delivery) and the exact device and versions everything was
verified against.

Contributions welcome. Behaviour in `src/jitter-buffer.ts` and the pacing loop in
`src/return-audio.ts` was tuned by measurement, so please check `FINDINGS.md`
before changing those numbers.

## License

[MIT](LICENSE) — do whatever you like with it.
