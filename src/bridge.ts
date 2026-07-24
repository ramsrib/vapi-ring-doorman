import type { RingCamera } from 'ring-client-api'
import { config } from './config.ts'
import { log } from './log.ts'
import { VapiCall } from './vapi.ts'
import { ReturnAudio } from './return-audio.ts'

/**
 * One answered doorbell press:
 *
 *   visitor -> Ring mic -> WebRTC/opus -> ffmpeg -> PCM -> websocket -> Vapi
 *   visitor <- Ring speaker <- WebRTC/opus <- ffmpeg <- PCM <- websocket <- Vapi
 *
 * Resolves once both ends are torn down.
 */
export async function bridgeCall(camera: RingCamera): Promise<void> {
  log.info('bridge: starting Ring live call')
  const session = await camera.startLiveCall()

  // Without this the visitor hears nothing — Ring keeps the speaker off until
  // the "answering" side explicitly turns it on.
  session.activateCameraSpeaker()

  let vapi: VapiCall | undefined
  let returnAudio: ReturnAudio | undefined
  let finished = false
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const finish = (reason: string) => {
    if (finished) return
    finished = true
    log.info(`bridge: ending (${reason})`)
    clearTimeout(maxTimer)
    returnAudio?.stop()
    vapi?.close()
    session.stop()
    resolveDone()
  }

  const maxTimer = setTimeout(() => finish('max call duration'), config.call.maxSeconds * 1000)
  session.onCallEnded.subscribe(() => finish('ring hung up'))

  try {
    const usingOpus = await session.isUsingOpus
    log.info(`bridge: ring answered using ${usingOpus ? 'opus' : 'pcmu'}`)

    vapi = await VapiCall.create()
    vapi.onEnded(() => finish('vapi hung up'))

    returnAudio = await ReturnAudio.start(session, usingOpus)
    vapi.onAudio((pcm) => returnAudio!.write(pcm))

    // Ring -> Vapi. ring-client-api runs this ffmpeg for us: it feeds the
    // negotiated RTP in and we take raw PCM off stdout.
    await session.startTranscoding({
      input: ['-fflags', '+nobuffer', '-flags', 'low_delay'],
      video: false,
      audio: ['-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(config.audio.sampleRate)],
      output: ['-f', 's16le', '-flush_packets', '1', 'pipe:1'],
      stdoutCallback: (chunk: Buffer) => vapi?.sendAudio(chunk),
    })

    log.info('bridge: audio flowing both ways — talk to the doorbell')
  } catch (e) {
    log.error('bridge: setup failed', e)
    finish('setup failed')
  }

  await done
}
