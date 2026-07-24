import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createSocket, type Socket } from 'node:dgram'
import { RtpPacket } from 'werift'
import type { StreamingSession } from 'ring-client-api/streaming/streaming-session'
import { config } from './config.ts'
import { JitterBuffer } from './jitter-buffer.ts'
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
  private readonly buffer = new JitterBuffer()
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private framesWritten = 0

  private constructor(ffmpeg: ChildProcessWithoutNullStreams, socket: Socket, rtcpSocket: Socket | undefined) {
    this.ffmpeg = ffmpeg
    this.socket = socket
    this.rtcpSocket = rtcpSocket
  }

  static async start(session: StreamingSession, usingOpus: boolean): Promise<ReturnAudio> {
    const socket = createSocket('udp4')
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
    const port = socket.address().port

    // ffmpeg's RTP muxer also emits RTCP on port+1. Nothing needs it, but
    // binding keeps the OS from answering with ICMP port-unreachable noise.
    const rtcp = createSocket('udp4')
    const rtcpSocket = await new Promise<Socket | undefined>((resolve) => {
      rtcp.once('error', () => {
        rtcp.close()
        resolve(undefined)
      })
      rtcp.bind(port + 1, '127.0.0.1', () => resolve(rtcp))
    })

    socket.on('message', (message) => {
      try {
        session.sendAudioPacket(RtpPacket.deSerialize(message))
      } catch (e) {
        log.debug('return-audio: bad RTP packet', e)
      }
    })

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
      String(config.audio.sampleRate),
      '-ac',
      '1',
      '-i',
      'pipe:',
      // Match whatever Ring answered with — opus normally, pcmu on some devices.
      ...(usingOpus
        ? [
            '-acodec',
            'libopus',
            '-ac',
            '2',
            '-ar',
            '48000',
            '-application',
            'voip',
            '-b:a',
            config.audio.opusBitrate,
            '-vbr',
            'on',
            '-compression_level',
            '10',
            '-frame_duration',
            String(config.audio.frameMs),
          ]
        : ['-acodec', 'pcm_mulaw', '-ac', '1', '-ar', '8000']),
      '-flags',
      '+global_header',
      '-f',
      'rtp',
      `rtp://127.0.0.1:${port}`,
    ]

    log.debug('return-audio: ffmpeg', args.join(' '))
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      if (config.debug) log.debug('return-audio/ffmpeg:', chunk.toString().trim())
    })
    ffmpeg.stdin.on('error', () => {
      // ffmpeg exiting mid-write; the stop path handles teardown.
    })

    const returnAudio = new ReturnAudio(ffmpeg, socket, rtcpSocket)
    returnAudio.startPacing()
    return returnAudio
  }

  get stats(): { underrunFrames: number; droppedBytes: number; framesWritten: number } {
    return { ...this.buffer.stats, framesWritten: this.framesWritten }
  }

  write(pcm: Buffer): void {
    if (this.stopped) return
    this.buffer.write(pcm)
  }

  /**
   * Feed ffmpeg on a wall-clock schedule rather than one frame per timer tick.
   *
   * Node timers drift — a nominal 20 ms interval fires every 21-22 ms under
   * load, which is a few percent slow. Feeding a live encoder a few percent
   * slow starves it, and starvation is audible as choppiness. So we tick at
   * finer granularity and write however many frames are actually due.
   */
  private startPacing(): void {
    const frameMs = config.audio.frameMs
    const startedAt = performance.now()

    this.timer = setInterval(() => {
      if (this.stopped || !this.ffmpeg.stdin.writable) return
      const due = Math.floor((performance.now() - startedAt) / frameMs)
      // Cap catch-up so a long stall (GC, laptop sleep) doesn't dump a burst.
      const behind = Math.min(due - this.framesWritten, 5)
      for (let i = 0; i < behind; i++) {
        this.ffmpeg.stdin.write(this.buffer.nextFrame())
        this.framesWritten++
      }
    }, Math.max(5, Math.floor(frameMs / 2)))
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.buffer.clear()
    this.ffmpeg.stdin.end()
    this.ffmpeg.kill('SIGTERM')
    this.socket.close()
    this.rtcpSocket?.close()
  }
}
