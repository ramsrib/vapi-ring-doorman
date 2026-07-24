import { writeFileSync } from 'node:fs'
import type { RingCamera } from 'ring-client-api'
import { config } from './config.ts'
import { log } from './log.ts'
import { VapiCall } from './vapi.ts'
import { ReturnAudio } from './return-audio.ts'
import { muteChime } from './chime.ts'
import { toWav } from './say.ts'

export interface BridgedCall {
  /** Resolves once both ends are torn down. */
  done: Promise<void>
  /** Ends the call early — second button press, signal, whatever. */
  hangup(reason: string): void
}

/**
 * One answered doorbell press:
 *
 *   visitor -> Ring mic -> WebRTC/opus -> ffmpeg -> PCM -> websocket -> Vapi
 *   visitor <- Ring speaker <- WebRTC/opus <- ffmpeg <- PCM <- websocket <- Vapi
 *
 * Returns immediately with a handle; the call sets itself up in the background.
 */
export function bridgeCall(camera: RingCamera): BridgedCall {
  const startedAt = performance.now()

  let vapi: VapiCall | undefined
  let returnAudio: ReturnAudio | undefined
  let restoreChime: (() => Promise<void>) | undefined
  let session: Awaited<ReturnType<RingCamera['startLiveCall']>> | undefined
  let finished = false

  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  // Byte counters, because "the call connected" and "audio is crossing" are
  // very different things and only one of them is audible from indoors.
  let fromRingBytes = 0
  let toRingBytes = 0
  const recordings: { ring: Buffer[]; vapi: Buffer[] } = { ring: [], vapi: [] }
  const recording = process.env['RECORD'] === 'true'
  const bytesPerSecond = config.audio.sampleRate * 2

  const stats = setInterval(() => {
    const quality = returnAudio
      ? `  underruns ${returnAudio.stats.underrunFrames}f  dropped ${(returnAudio.stats.droppedBytes / bytesPerSecond).toFixed(2)}s`
      : ''
    log.info(
      `bridge: ring->vapi ${(fromRingBytes / bytesPerSecond).toFixed(1)}s  ` +
        `vapi->ring ${(toRingBytes / bytesPerSecond).toFixed(1)}s${quality}`,
    )
  }, 5000)

  const maxTimer = setTimeout(() => finish('max call duration'), config.call.maxSeconds * 1000)

  function finish(reason: string): void {
    if (finished) return
    finished = true
    log.info(`bridge: ending (${reason})`)
    log.info(
      `bridge: totals — ring->vapi ${(fromRingBytes / bytesPerSecond).toFixed(1)}s, ` +
        `vapi->ring ${(toRingBytes / bytesPerSecond).toFixed(1)}s` +
        (returnAudio
          ? `, underrun frames ${returnAudio.stats.underrunFrames}/${returnAudio.stats.framesWritten}` +
            `, dropped ${(returnAudio.stats.droppedBytes / bytesPerSecond).toFixed(2)}s`
          : ''),
    )
    if (fromRingBytes === 0) {
      log.warn('bridge: no audio ever arrived from the doorbell mic — the assistant was talking to itself')
    }
    if (recording) {
      writeFileSync('ring-in.wav', toWav(Buffer.concat(recordings.ring), config.audio.sampleRate))
      writeFileSync('vapi-in.wav', toWav(Buffer.concat(recordings.vapi), config.audio.sampleRate))
      log.info('bridge: wrote ring-in.wav (what the doorbell heard) and vapi-in.wav (what the assistant said)')
    }
    clearInterval(stats)
    clearTimeout(maxTimer)
    returnAudio?.stop()
    vapi?.close()
    session?.stop()
    void restoreChime?.().finally(resolveDone)
    if (!restoreChime) resolveDone()
  }

  void (async () => {
    try {
      log.info('bridge: starting Ring live call')
      session = await camera.startLiveCall()
      if (finished) {
        session.stop()
        return
      }

      // Without this the visitor hears nothing — Ring keeps the speaker off
      // until the answering side explicitly turns it on.
      session.activateCameraSpeaker()
      session.onCallEnded.subscribe(() => finish('ring hung up'))

      if (config.call.muteChimeDuringCall) {
        restoreChime = await muteChime(camera)
      }

      const usingOpus = await session.isUsingOpus
      log.info(`bridge: ring answered using ${usingOpus ? 'opus' : 'pcmu'}`)

      returnAudio = await ReturnAudio.start(session, usingOpus)

      // Hold the greeting until the doorbell's own chime has had its moment.
      const elapsed = performance.now() - startedAt
      const wait = Math.max(0, config.call.answerDelayMs - elapsed)
      if (wait > 0) {
        log.info(`bridge: waiting ${(wait / 1000).toFixed(1)}s for the chime before greeting`)
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
      if (finished) return

      vapi = await VapiCall.create()
      vapi.onEnded(() => finish('vapi hung up'))
      vapi.onAudio((pcm) => {
        toRingBytes += pcm.length
        if (recording) recordings.vapi.push(pcm)
        returnAudio!.write(pcm)
      })

      // Ring -> Vapi. ring-client-api runs this ffmpeg for us: it feeds the
      // negotiated RTP in and we take raw PCM off stdout.
      await session.startTranscoding({
        input: ['-fflags', '+nobuffer', '-flags', 'low_delay'],
        video: false,
        audio: ['-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(config.audio.sampleRate)],
        output: ['-f', 's16le', '-flush_packets', '1', 'pipe:1'],
        stdoutCallback: (chunk: Buffer) => {
          fromRingBytes += chunk.length
          if (recording) recordings.ring.push(chunk)
          vapi?.sendAudio(chunk)
        },
      })

      log.info('bridge: audio flowing both ways — talk to the doorbell')
    } catch (e) {
      log.error('bridge: setup failed', e)
      finish('setup failed')
    }
  })()

  return { done, hangup: finish }
}
