import WebSocket from 'ws'
import { config } from './config.ts'
import { log } from './log.ts'

interface CreateCallResponse {
  id: string
  transport?: { websocketCallUrl?: string }
  message?: string
}

/**
 * A Vapi call using the websocket transport: we create the call over REST, then
 * exchange raw PCM frames on the returned socket. No phone number, no WebRTC —
 * the audio plumbing is ours, which is what makes bridging to Ring tractable.
 */
export class VapiCall {
  readonly id: string
  private readonly socket: WebSocket
  private audioHandler: ((pcm: Buffer) => void) | undefined
  private endedHandler: (() => void) | undefined
  private ended = false

  private constructor(id: string, socket: WebSocket) {
    this.id = id
    this.socket = socket

    socket.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        // Assistant audio: PCM s16le mono at config.audio.sampleRate.
        this.audioHandler?.(data as Buffer)
      } else {
        this.handleControlMessage(data.toString())
      }
    })

    socket.on('close', (code: number, reason: Buffer) => {
      log.info(`vapi: socket closed (${code}${reason.length ? ` ${reason.toString()}` : ''})`)
      this.markEnded()
    })

    socket.on('error', (e: Error) => {
      log.error('vapi: socket error', e.message)
      this.markEnded()
    })
  }

  static async create(): Promise<VapiCall> {
    const response = await fetch(`${config.vapi.baseUrl}/call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.vapi.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        assistantId: config.vapi.assistantId,
        transport: {
          provider: 'vapi.websocket',
          audioFormat: {
            format: 'pcm_s16le',
            container: 'raw',
            sampleRate: config.audio.sampleRate,
          },
        },
      }),
    })

    const body = (await response.json()) as CreateCallResponse
    if (!response.ok) {
      throw new Error(`Vapi call creation failed (${response.status}): ${JSON.stringify(body)}`)
    }

    const url = body.transport?.websocketCallUrl
    if (!url) {
      throw new Error(`Vapi did not return a websocketCallUrl: ${JSON.stringify(body)}`)
    }

    log.info(`vapi: call ${body.id} created`)
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    log.info('vapi: websocket open')

    return new VapiCall(body.id, socket)
  }

  onAudio(handler: (pcm: Buffer) => void): void {
    this.audioHandler = handler
  }

  onEnded(handler: () => void): void {
    this.endedHandler = handler
  }

  sendAudio(pcm: Buffer): void {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(pcm)
  }

  hangup(): void {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ type: 'hangup' }))
  }

  close(): void {
    this.hangup()
    this.socket.close()
    this.markEnded()
  }

  private handleControlMessage(raw: string): void {
    let parsed: { type?: string; [key: string]: unknown }
    try {
      parsed = JSON.parse(raw) as typeof parsed
    } catch {
      log.debug('vapi: non-JSON control message', raw.slice(0, 200))
      return
    }

    switch (parsed['type']) {
      case 'transcript': {
        const role = parsed['role'] as string | undefined
        const type = parsed['transcriptType'] as string | undefined
        if (type === 'final') log.info(`vapi: ${role} — ${String(parsed['transcript'])}`)
        break
      }
      case 'status-update': {
        const status = parsed['status'] as string | undefined
        log.info(`vapi: status ${status}`)
        if (status === 'ended') this.markEnded()
        break
      }
      case 'hangup':
      case 'end-call':
        this.markEnded()
        break
      default:
        log.debug('vapi:', raw.slice(0, 300))
    }
  }

  private markEnded(): void {
    if (this.ended) return
    this.ended = true
    this.endedHandler?.()
  }
}
