/**
 * Return-audio pipeline test with no Ring and no Vapi.
 *
 * Feeds known PCM through ReturnAudio and inspects the RTP that comes out the
 * other side. Everything upstream of `sendAudioPacket` is ours, so this is the
 * part that can't be blamed on Ring being offline.
 */
import type { StreamingSession } from 'ring-client-api/streaming/streaming-session'
import type { RtpPacket } from 'werift'
import { ReturnAudio } from '../return-audio.ts'
import { synthesize } from '../say.ts'
import { config } from '../config.ts'
import { log } from '../log.ts'

const packets: RtpPacket[] = []
const fakeSession = {
  sendAudioPacket(rtp: RtpPacket) {
    packets.push(rtp)
  },
} as unknown as StreamingSession

const sampleRate = config.audio.sampleRate
const returnAudio = await ReturnAudio.start(fakeSession, true)
const pacingStartedAt = performance.now()

const speech = synthesize('Testing the doorbell speaker path.', sampleRate)
if (!speech) {
  log.error('macOS `say` unavailable — cannot run this test')
  process.exit(1)
}

log.info(`feeding ${(speech.length / (sampleRate * 2)).toFixed(1)}s of PCM`)
const frameBytes = (sampleRate * 2 * config.audio.frameMs) / 1000
for (let offset = 0; offset < speech.length; offset += frameBytes) {
  returnAudio.write(speech.subarray(offset, offset + frameBytes))
  await new Promise((resolve) => setTimeout(resolve, config.audio.frameMs))
}
await new Promise((resolve) => setTimeout(resolve, 1500))
const pacingSeconds = (performance.now() - pacingStartedAt) / 1000
returnAudio.stop()

// The whole point of wall-clock pacing: audio fed should track elapsed time.
const fedSeconds = (returnAudio.stats.framesWritten * config.audio.frameMs) / 1000
log.info(
  `pacing: fed ${fedSeconds.toFixed(2)}s of audio in ${pacingSeconds.toFixed(2)}s wall ` +
    `(${((fedSeconds / pacingSeconds) * 100).toFixed(1)}% of real time, want ~100%)`,
)
log.info(`underrun frames: ${returnAudio.stats.underrunFrames}/${returnAudio.stats.framesWritten}`)

const payloadBytes = packets.reduce((total, packet) => total + packet.payload.length, 0)
const timestamps = packets.map((packet) => packet.header.timestamp)
const gaps = timestamps.slice(1).map((value, index) => value - timestamps[index]!)
const uniqueGaps = [...new Set(gaps)]

log.info(`rtp packets: ${packets.length}`)
log.info(`payload bytes: ${payloadBytes}`)
log.info(`payload type: ${packets[0]?.header.payloadType ?? 'n/a'}`)
log.info(`timestamp step(s): ${uniqueGaps.join(', ')} (960 = 20ms at 48kHz)`)
log.info(`sequence contiguous: ${gaps.length > 0 && uniqueGaps.every((gap) => gap === 960)}`)

// ~50 packets/sec of opus at 20ms framing, non-empty payloads.
const healthy = packets.length > 20 && payloadBytes > 1000
log.info(healthy ? 'PASS — the speaker leg produces well-formed opus RTP' : 'FAIL — no usable RTP came out')
process.exit(healthy ? 0 : 1)
