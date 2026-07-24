import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createSocket, type Socket } from 'node:dgram'
import { RtpPacket } from 'werift'
import type { StreamingSession } from 'ring-client-api/streaming/streaming-session'
import { config } from './config.ts'
import { log } from './log.ts'

/**
 * Assistant audio -> Ring's speaker.
 *
 * ring-client-api ships `transcodeReturnAudio`, but it appends our arguments
 * *after* `-i`, so raw PCM (which needs `-f s16le -ar ... -ac ...` before the
 * input) can't be described. So we run the same pipeline ourselves: ffmpeg
 * encodes to the codec Ring negotiated and muxes to RTP on a local UDP port; we
 * read those packets back and hand them to the WebRTC sender.
 */
export class ReturnAudio {
  private readonly ffmpeg: ChildProcessWithoutNullStreams
  private readonly socket: Socket
  private readonly rtcpSocket: Socket | undefined
  private readonly frameBytes: number
  private readonly silence: Buffer
  private queue: Buffer[] = []
  private queuedBytes = 0
  private timer: NodeJS.Timeout | undefined
  private stopped = false

  private constructor(
    ffmpeg: ChildProcessWithoutNullStreams,
    socket: Socket,
    rtcpSocket: Socket | undefined,
    frameBytes: number,
  ) {
    this.ffmpeg = ffmpeg
    this.socket = socket
    this.rtcpSocket = rtcpSocket
    this.frameBytes = frameBytes
    this.silence = Buffer.alloc(frameBytes)
  }

  static async start(session: StreamingSession, usingOpus: boolean): Promise<ReturnAudio> {
    const socket = createSocket('udp4')
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
    const port = socket.address().port

    // ffmpeg's RTP muxer also emits RTCP on port+1. Nothing needs it, but
    // binding keeps the OS from answering with ICMP port-unreachable noise.
    let rtcpSocket: Socket | undefined = createSocket('udp4')
    try {
      await new Promise<void>((resolve, reject) => {
        rtcpSocket!.once('error', reject)
        rtcpSocket!.bind(port + 1, '127.0.0.1', resolve)
      })
    } catch {
      rtcpSocket = undefined
    }

    socket.on('message', (message) => {
      try {
        session.sendAudioPacket(RtpPacket.deSerialize(message))
      } catch (e) {
        log.debug('return-audio: bad RTP packet', e)
      }
    })

    const sampleRate = config.audio.sampleRate
    const args = [
      '-hide_banner',
      '-loglevel',
      config.debug ? 'warning' : 'error',
      '-fflags',
      '+nobuffer',
      '-flags',
      'low_delay',
      '-f',
      's16le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-i',
      'pipe:',
      // Match whatever Ring answered with — opus normally, pcmu on some devices.
      ...(usingOpus
        ? ['-acodec', 'libopus', '-ac', '2', '-ar', '48000', '-application', 'voip']
        : ['-acodec', 'pcm_mulaw', '-ac', '1', '-ar', '8000']),
      '-flags',
      '+global_header',
      '-f',
      'rtp',
      `rtp://127.0.0.1:${port}`,
    ]

    log.debug('return-audio: ffmpeg', args.join(' '))
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    ffmpeg.stderr.on('data', (chunk: Buffer) => log.debug('return-audio/ffmpeg:', chunk.toString().trim()))
    ffmpeg.stdin.on('error', () => {
      // ffmpeg exiting mid-write; the stop path handles teardown.
    })

    const frameBytes = Math.round((sampleRate * 2 * config.audio.frameMs) / 1000)
    const returnAudio = new ReturnAudio(ffmpeg, socket, rtcpSocket, frameBytes)
    returnAudio.startPacing()
    return returnAudio
  }

  /**
   * Buffer assistant audio for the next tick. Anything beyond the latency cap
   * is dropped from the front — better to clip a word than to have the
   * assistant talking half a second behind the visitor.
   */
  write(pcm: Buffer): void {
    if (this.stopped) return
    this.queue.push(pcm)
    this.queuedBytes += pcm.length

    const maxBytes = Math.round((config.audio.sampleRate * 2 * config.audio.maxBufferedMs) / 1000)
    while (this.queuedBytes > maxBytes && this.queue.length > 1) {
      const dropped = this.queue.shift()!
      this.queuedBytes -= dropped.length
      log.debug(`return-audio: dropped ${dropped.length}B to stay under latency cap`)
    }
  }

  /**
   * Feed ffmpeg one frame per tick, padding with silence when the assistant
   * isn't speaking. A continuous stream keeps the opus encoder's timeline
   * aligned with the wall clock, so speech comes out paced instead of bursty.
   */
  private startPacing(): void {
    this.timer = setInterval(() => {
      if (this.stopped || !this.ffmpeg.stdin.writable) return
      this.ffmpeg.stdin.write(this.nextFrame())
    }, config.audio.frameMs)
  }

  private nextFrame(): Buffer {
    if (this.queuedBytes === 0) return this.silence

    const parts: Buffer[] = []
    let needed = this.frameBytes

    while (needed > 0 && this.queue.length > 0) {
      const head = this.queue[0]!
      if (head.length <= needed) {
        parts.push(head)
        needed -= head.length
        this.queuedBytes -= head.length
        this.queue.shift()
      } else {
        parts.push(head.subarray(0, needed))
        this.queue[0] = head.subarray(needed)
        this.queuedBytes -= needed
        needed = 0
      }
    }

    if (needed > 0) parts.push(Buffer.alloc(needed))
    return Buffer.concat(parts, this.frameBytes)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.queue = []
    this.queuedBytes = 0
    this.ffmpeg.stdin.end()
    this.ffmpeg.kill('SIGTERM')
    this.socket.close()
    this.rtcpSocket?.close()
  }
}
