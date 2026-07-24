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
import { connectRing } from '../ring.ts'
import { ReturnAudio } from '../return-audio.ts'
import { config } from '../config.ts'
import { log } from '../log.ts'
import { synthesize } from '../say.ts'

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

const { api, camera } = await connectRing()

log.info('opening live call')
const session = await camera.startLiveCall()
session.activateCameraSpeaker()

const usingOpus = await session.isUsingOpus
log.info(`ring answered using ${usingOpus ? 'opus' : 'pcmu'}`)

const returnAudio = await ReturnAudio.start(session, usingOpus)

const audio = synthesize(phrase, sampleRate) ?? tone(3)
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
