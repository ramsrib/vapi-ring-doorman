/**
 * Exercises the Vapi leg of the bridge with no Ring hardware involved.
 *
 * Speaks a phrase into the call the same way the doorbell would, records what
 * the assistant says back, and writes it to a wav you can play. Proves call
 * creation, the websocket protocol, and the PCM format contract in one go.
 *
 *   npm run vapi-test
 *   SAY="I have a package for you" npm run vapi-test
 */
import { writeFileSync } from 'node:fs'
import { config } from '../config.ts'
import { log } from '../log.ts'
import { VapiCall } from '../vapi.ts'
import { synthesize, toWav } from '../say.ts'

const sampleRate = config.audio.sampleRate
const phrase = process.env['SAY'] ?? 'Hi, I am delivering a package. Where should I leave it?'
const outputPath = 'vapi-test.wav'

const call = await VapiCall.create()

const received: Buffer[] = []
const arrivalGaps: number[] = []
let lastArrival = 0
call.onAudio((pcm) => {
  const now = performance.now()
  if (lastArrival > 0) arrivalGaps.push(now - lastArrival)
  lastArrival = now
  received.push(pcm)
})

let ended = false
call.onEnded(() => {
  ended = true
})

const frameBytes = (sampleRate * 2 * config.audio.frameMs) / 1000
const silence = Buffer.alloc(frameBytes)

/** Feed the call in real time, like the Ring leg would. */
async function stream(pcm: Buffer): Promise<void> {
  for (let offset = 0; offset < pcm.length && !ended; offset += frameBytes) {
    call.sendAudio(pcm.subarray(offset, offset + frameBytes))
    await new Promise((resolve) => setTimeout(resolve, config.audio.frameMs))
  }
}

async function streamSilence(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms && !ended; elapsed += config.audio.frameMs) {
    call.sendAudio(silence)
    await new Promise((resolve) => setTimeout(resolve, config.audio.frameMs))
  }
}

// Let the assistant deliver its greeting first, as it would to a visitor.
log.info('listening for the greeting')
await streamSilence(6000)

const speech = synthesize(phrase, sampleRate)
if (speech) {
  log.info(`speaking: "${phrase}"`)
  await stream(speech)
} else {
  log.warn('no macOS `say` available — sending silence only')
}

log.info('waiting for the reply')
await streamSilence(9000)

const audio = Buffer.concat(received)
log.info(`received ${(audio.length / (sampleRate * 2)).toFixed(1)}s of assistant audio in ${received.length} chunks`)

// How bursty is Vapi's delivery? This sets the jitter buffer we need on the
// Ring side — anything above AUDIO_PREBUFFER_MS shows up as a gap in playback.
if (arrivalGaps.length > 0) {
  const sorted = [...arrivalGaps].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.floor(sorted.length * q)]!.toFixed(0)
  log.info(
    `chunk arrival gaps: p50 ${at(0.5)}ms  p95 ${at(0.95)}ms  p99 ${at(0.99)}ms  ` +
      `max ${Math.max(...arrivalGaps).toFixed(0)}ms`,
  )
}

if (audio.length > 0) {
  writeFileSync(outputPath, toWav(audio, sampleRate))
  log.info(`wrote ${outputPath} — play it with: afplay ${outputPath}`)
}

call.close()
process.exit(audio.length > 0 ? 0 : 1)
