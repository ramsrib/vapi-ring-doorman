/**
 * Return-audio path test with no Vapi involvement.
 *
 * Opens a live call and pushes locally generated speech (or a tone) out of the
 * doorbell's speaker. If you hear it at the door, the hard half of the bridge
 * works and anything still broken is on the Vapi leg.
 *
 *   npm run speaker-test              # says a default phrase
 *   SAY="package is at the back" npm run speaker-test
 */
import { spawnSync } from 'node:child_process'
import { connectRing } from '../ring.ts'
import { ReturnAudio } from '../return-audio.ts'
import { config } from '../config.ts'
import { log } from '../log.ts'

const sampleRate = config.audio.sampleRate
const phrase = process.env['SAY'] ?? 'Hello, this is a test from the doorbell speaker.'

function tone(seconds: number): Buffer {
  const samples = sampleRate * seconds
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), i * 2)
  }
  return pcm
}

/** macOS `say` -> ffmpeg -> raw PCM at our sample rate. */
function speech(text: string): Buffer | undefined {
  if (process.platform !== 'darwin') return undefined
  const aiff = spawnSync('say', ['-o', '/dev/stdout', '--data-format=LEI16@22050', text], {
    maxBuffer: 64 * 1024 * 1024,
  })
  if (aiff.status !== 0 || aiff.stdout.length === 0) return undefined
  const converted = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', 'pipe:1'],
    { input: aiff.stdout, maxBuffer: 64 * 1024 * 1024 },
  )
  return converted.status === 0 && converted.stdout.length > 0 ? converted.stdout : undefined
}

const { api, camera } = await connectRing()

log.info('opening live call')
const session = await camera.startLiveCall()
session.activateCameraSpeaker()

const usingOpus = await session.isUsingOpus
log.info(`ring answered using ${usingOpus ? 'opus' : 'pcmu'}`)

const returnAudio = await ReturnAudio.start(session, usingOpus)

const audio = speech(phrase) ?? tone(3)
log.info(`pushing ${(audio.length / (sampleRate * 2)).toFixed(1)}s of audio to the speaker`)

// Hand it over in real-time-sized pieces; ReturnAudio paces the rest.
const chunk = (sampleRate * 2 * config.audio.frameMs) / 1000
for (let offset = 0; offset < audio.length; offset += chunk) {
  returnAudio.write(audio.subarray(offset, offset + chunk))
  await new Promise((resolve) => setTimeout(resolve, config.audio.frameMs))
}

await new Promise((resolve) => setTimeout(resolve, 2000))
log.info('done')
returnAudio.stop()
session.stop()
api.disconnect()
process.exit(0)
