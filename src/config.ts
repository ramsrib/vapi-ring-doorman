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
  },
  audio: {
    /** PCM sample rate used on the Vapi websocket and between the two ffmpeg legs. */
    sampleRate: num('AUDIO_SAMPLE_RATE', 16000),
    /** Frame size for the paced writer feeding Ring's speaker. */
    frameMs: num('AUDIO_FRAME_MS', 20),
    /**
     * Cap on assistant audio buffered toward Ring. Beyond this we drop the
     * oldest frames — a doorbell conversation wants low latency, not
     * completeness, and buffered audio can't be un-said after an interruption.
     */
    maxBufferedMs: num('AUDIO_MAX_BUFFERED_MS', 400),
  },
  call: {
    /** Hard stop for a single bridged call. Ring live calls die on their own too. */
    maxSeconds: num('CALL_MAX_SECONDS', 300),
    /** Ignore further dings for this long after a call starts. */
    cooldownSeconds: num('CALL_COOLDOWN_SECONDS', 15),
  },
  debug: process.env.DEBUG === 'true',
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
