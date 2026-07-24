import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = join(projectRoot, '.env')

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing ${name} in .env — see .env.example`)
  }
  return value
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}"`)
  return parsed
}

export const config = {
  ring: {
    refreshToken: required('RING_REFRESH_TOKEN'),
    /** Camera to answer with. Name substring or numeric id. Empty = first doorbell found. */
    cameraName: process.env.RING_CAMERA ?? '',
    /**
     * Fallback ding detection. Ring pushes are the primary path; if pushes stop
     * arriving (Ring changes FCM registration from time to time), set this to
     * poll the events API instead. Seconds; 0 disables.
     */
    dingPollSeconds: num('RING_DING_POLL_SECONDS', 0),
  },
  vapi: {
    apiKey: required('VAPI_API_KEY'),
    assistantId: required('VAPI_ASSISTANT_ID'),
    baseUrl: process.env.VAPI_BASE_URL ?? 'https://api.vapi.ai',
    /**
     * Said by the *assistant*, these hang up the call. Applied as a per-call
     * override, so the saved assistant config is left untouched.
     */
    endCallPhrases: (process.env.VAPI_END_CALL_PHRASES ?? 'goodbye,have a great day,bye for now')
      .split(',')
      .map((phrase) => phrase.trim())
      .filter(Boolean),
  },
  audio: {
    /** PCM sample rate used on the Vapi websocket and between the two ffmpeg legs. */
    sampleRate: num('AUDIO_SAMPLE_RATE', 16000),
    /**
     * Frame size for the paced writer feeding Ring's speaker. Not an env knob:
     * it is passed to opus as `-frame_duration`, which accepts only
     * 2.5/5/10/20/40/60, and the pacing tick derives from it.
     */
    frameMs: 20,
    /**
     * Jitter buffer. After the queue runs dry we hold this much audio before
     * resuming, so one late websocket frame costs a single pause instead of a
     * run of half-empty frames. Raise it if the assistant sounds choppy; every
     * millisecond here is a millisecond of added latency.
     *
     * Sized from measurement, not taste: Vapi delivers audio in bursts with
     * gaps of ~51 ms at p95 and ~54 ms at p99 (`npm run vapi-test` reports
     * this). 150 ms rides through those comfortably.
     */
    prebufferMs: num('AUDIO_PREBUFFER_MS', 150),
    /**
     * Cap on assistant audio buffered toward Ring. Beyond this we drop the
     * oldest frames — buffered audio can't be un-said after an interruption.
     * Generous enough that ordinary bursts are smoothed rather than clipped.
     */
    maxBufferedMs: num('AUDIO_MAX_BUFFERED_MS', 1500),
    /** Opus bitrate toward the doorbell speaker. */
    opusBitrate: process.env.AUDIO_OPUS_BITRATE ?? '48k',
    /**
     * Fill gaps with faint noise instead of digital silence, so the doorbell's
     * speaker path never idles and clips the start of the next word.
     */
    comfortNoise: process.env.AUDIO_COMFORT_NOISE !== 'false',
  },
  call: {
    /** Hard stop for a single bridged call. Ring live calls die on their own too. */
    maxSeconds: num('CALL_MAX_SECONDS', 300),
    /**
     * Wait this long after the press before the assistant starts talking, so
     * the greeting lands after the doorbell's own chime rather than under it.
     * Ring's chime duration is in the device settings (currently 10s), but the
     * audible tone is shorter; tune by ear.
     */
    answerDelayMs: num('CALL_ANSWER_DELAY_MS', 4000),
    /**
     * Silence the doorbell's chime for the duration of a call, so pressing the
     * button again mid-conversation doesn't blast the tone over the assistant.
     * Restored on exit — see `npm run restore-chime` if a crash leaves it muted.
     */
    muteChimeDuringCall: process.env.MUTE_CHIME_DURING_CALL !== 'false',
  },
  debug: process.env.DEBUG === 'true',
  /**
   * Write each leg of a call to a wav on hangup: `ring-in.wav` is what the
   * doorbell heard, `vapi-in.wav` what the assistant said. The fastest way to
   * tell a dead microphone from a dead speaker.
   */
  recordCalls: process.env.RECORD === 'true',
}

/** Bytes of 16-bit mono PCM per second, at the configured sample rate. */
export const bytesPerSecond = config.audio.sampleRate * 2

/** Bytes of 16-bit mono PCM holding `ms` of audio. */
export function bytesForMs(ms: number): number {
  return Math.round((bytesPerSecond * ms) / 1000)
}

/** Seconds of audio in `bytes` of 16-bit mono PCM. */
export function secondsOfBytes(bytes: number): number {
  return bytes / bytesPerSecond
}

/**
 * Ring rotates the refresh token on every login; the old one stops working.
 * Persisting it is the difference between "push notifications work" and the
 * silent auth failures that killed the previous attempt at this.
 */
export function persistRefreshToken(token: string): void {
  if (!existsSync(envPath)) return
  const contents = readFileSync(envPath, 'utf8')
  const line = `RING_REFRESH_TOKEN=${token}`
  const updated = /^RING_REFRESH_TOKEN=.*$/m.test(contents)
    ? contents.replace(/^RING_REFRESH_TOKEN=.*$/m, line)
    : `${contents.trimEnd()}\n${line}\n`
  writeFileSync(envPath, updated)
}
