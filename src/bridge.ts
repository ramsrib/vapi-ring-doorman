import { closeSync, openSync, writeSync } from 'node:fs'
import type { RingCamera } from 'ring-client-api'
import { config, secondsOfBytes } from './config.ts'
import { log } from './log.ts'
import { startSpeakerCall } from './ring.ts'
import { VapiCall } from './vapi.ts'
import { ReturnAudio } from './return-audio.ts'
import { muteChime } from './chime.ts'
import { wavHeader } from './say.ts'

export interface BridgedCall {
  /** Resolves once both ends are torn down. */
  done: Promise<void>
  /** Ends the call early. */
  hangup(reason: string): void
}

/** Streams a call leg straight to disk, so a long call never buffers in memory. */
class LegRecorder {
  private readonly fd: number
  private readonly path: string
  private bytes = 0

  constructor(path: string) {
    this.path = path
    this.fd = openSync(path, 'w')
    writeSync(this.fd, wavHeader(0, config.audio.sampleRate))
  }

  write(pcm: Buffer): void {
    writeSync(this.fd, pcm)
    this.bytes += pcm.length
  }

  /** Rewrites the header now that the length is known, and closes the file. */
  finish(): string {
    writeSync(this.fd, wavHeader(this.bytes, config.audio.sampleRate), 0, 44, 0)
    closeSync(this.fd)
    return this.path
  }
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
  let restoreChime: () => Promise<void> = async () => {}
  let session: Awaited<ReturnType<typeof startSpeakerCall>>['session'] | undefined
  let finished = false

  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  // Byte counters, because "the call connected" and "audio is crossing" are
  // very different things and only one of them is audible from indoors.
  let fromRingBytes = 0
  let toRingBytes = 0
  const recorders = config.recordCalls
    ? { ring: new LegRecorder('ring-in.wav'), vapi: new LegRecorder('vapi-in.wav') }
    : undefined

  function statsLine(): string {
    const quality = returnAudio
      ? `  underruns ${returnAudio.stats.underrunFrames}f  dropped ${secondsOfBytes(returnAudio.stats.droppedBytes).toFixed(2)}s`
      : ''
    return (
      `ring->vapi ${secondsOfBytes(fromRingBytes).toFixed(1)}s  ` +
      `vapi->ring ${secondsOfBytes(toRingBytes).toFixed(1)}s${quality}`
    )
  }

  const stats = setInterval(() => log.info(`bridge: ${statsLine()}`), 5000)
  const maxTimer = setTimeout(() => finish('max call duration'), config.call.maxSeconds * 1000)

  function finish(reason: string): void {
    if (finished) return
    finished = true
    log.info(`bridge: ending (${reason})`)
    log.info(`bridge: totals — ${statsLine()}`)
    if (fromRingBytes === 0) {
      log.warn('bridge: no audio ever arrived from the doorbell mic — the assistant was talking to itself')
    }
    if (recorders) {
      log.info(`bridge: wrote ${recorders.ring.finish()} (what the doorbell heard) and ${recorders.vapi.finish()}`)
    }
    clearInterval(stats)
    clearTimeout(maxTimer)
    returnAudio?.stop()
    vapi?.close()
    session?.stop()
    void restoreChime().finally(resolveDone)
  }

  void (async () => {
    try {
      log.info('bridge: starting Ring live call')
      const call = await startSpeakerCall(camera)
      session = call.session
      if (finished) {
        session.stop()
        return
      }
      session.onCallEnded.subscribe(() => finish('ring hung up'))
      log.info(`bridge: ring answered using ${call.usingOpus ? 'opus' : 'pcmu'}`)

      restoreChime = await muteChime(camera)
      returnAudio = await ReturnAudio.start(session, call.usingOpus)

      // Hold the greeting until the doorbell's own chime has had its moment.
      const wait = Math.max(0, config.call.answerDelayMs - (performance.now() - startedAt))
      if (wait > 0) {
        log.info(`bridge: waiting ${(wait / 1000).toFixed(1)}s for the chime before greeting`)
        await new Promise((resolve) => setTimeout(resolve, wait))
      }

      /*
       * Deliberately created *after* the delay, not during it.
       *
       * Vapi starts the greeting the moment the call connects, so connecting
       * early just means the assistant talks over the chime and its opening
       * words pile up in the jitter buffer until the latency cap drops them.
       * The ~half-second of setup is the price of the greeting landing cleanly.
       */
      vapi = await VapiCall.create({
        // Per-call overrides, so the saved assistant is never modified. Ring
        // gives us no signal for a button press during an active call, so the
        // button cannot end one — these give the assistant its own way out.
        'tools:append': [{ type: 'endCall' }],
        endCallPhrases: config.vapi.endCallPhrases,
        maxDurationSeconds: config.call.maxSeconds,
      })
      if (finished) return
      vapi.onEnded(() => finish('vapi hung up'))
      vapi.onAudio((pcm) => {
        toRingBytes += pcm.length
        recorders?.vapi.write(pcm)
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
          recorders?.ring.write(chunk)
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
