import { bytesForMs, config } from './config.ts'
import { log } from './log.ts'

/**
 * Turns Vapi's bursty websocket audio into a steady stream of fixed-size frames.
 *
 * Pure Buffer in, Buffer out — no ffmpeg, no sockets — so the behaviour that
 * took the longest to get right can be exercised without hardware. Every choice
 * in here came from measurement; see docs/FINDINGS.md before changing one.
 */
export class JitterBuffer {
  readonly frameBytes: number
  private readonly prebufferBytes: number
  private readonly maxBytes: number
  private readonly fillerFrames: Buffer[]
  private fillerIndex = 0
  private queue: Buffer[] = []
  private queuedBytes = 0
  /** True while refilling after the queue ran dry. */
  private buffering = true
  readonly stats = { underrunFrames: 0, droppedBytes: 0, framesRead: 0 }

  constructor() {
    this.frameBytes = bytesForMs(config.audio.frameMs)
    this.prebufferBytes = bytesForMs(config.audio.prebufferMs)
    this.maxBytes = bytesForMs(config.audio.maxBufferedMs)

    /*
     * Gaps are filled with very quiet noise rather than digital silence.
     *
     * Pure zeros encode to near-nothing in VBR opus, and a receiver that sees
     * near-nothing can let its speaker path idle — which clips the first
     * syllable when speech resumes. Noise around -60 dBFS is inaudible on a
     * doorbell speaker but keeps the path continuously open. A handful of
     * pre-generated frames cycles to avoid per-frame work.
     */
    const amplitude = config.audio.comfortNoise ? 24 : 0
    this.fillerFrames = Array.from({ length: 8 }, () => {
      const frame = Buffer.alloc(this.frameBytes)
      for (let i = 0; amplitude > 0 && i < this.frameBytes; i += 2) {
        frame.writeInt16LE(Math.round((Math.random() * 2 - 1) * amplitude), i)
      }
      return frame
    })
  }

  /**
   * Queue assistant audio. Anything beyond the latency cap is dropped from the
   * front — better to clip a word than to have the assistant replying to
   * something the visitor said a second ago.
   */
  write(pcm: Buffer): void {
    this.queue.push(pcm)
    this.queuedBytes += pcm.length

    while (this.queuedBytes > this.maxBytes && this.queue.length > 1) {
      const dropped = this.queue.shift()!
      this.queuedBytes -= dropped.length
      this.stats.droppedBytes += dropped.length
      if (config.debug) log.debug(`jitter: dropped ${dropped.length}B to stay under the latency cap`)
    }
  }

  /** One frame's worth of audio, padded with comfort noise when starved. */
  nextFrame(): Buffer {
    this.stats.framesRead++

    if (this.buffering) {
      // Hold until there's enough queued to ride out the next hiccup.
      if (this.queuedBytes < this.prebufferBytes) {
        this.stats.underrunFrames++
        return this.filler()
      }
      this.buffering = false
    }

    if (this.queuedBytes === 0) {
      this.buffering = true
      this.stats.underrunFrames++
      return this.filler()
    }

    // Fast path: the head alone covers the frame, so hand out a view rather
    // than allocating and copying 50 times a second.
    const head = this.queue[0]!
    if (head.length >= this.frameBytes) {
      const frame = head.length === this.frameBytes ? head : head.subarray(0, this.frameBytes)
      if (head.length === this.frameBytes) this.queue.shift()
      else this.queue[0] = head.subarray(this.frameBytes)
      this.queuedBytes -= this.frameBytes
      return frame
    }

    // Slow path: this frame spans more than one queued chunk.
    const parts: Buffer[] = []
    let needed = this.frameBytes
    while (needed > 0 && this.queue.length > 0) {
      const chunk = this.queue[0]!
      if (chunk.length <= needed) {
        parts.push(chunk)
        needed -= chunk.length
        this.queuedBytes -= chunk.length
        this.queue.shift()
      } else {
        parts.push(chunk.subarray(0, needed))
        this.queue[0] = chunk.subarray(needed)
        this.queuedBytes -= needed
        needed = 0
      }
    }
    if (needed > 0) parts.push(Buffer.alloc(needed))
    return Buffer.concat(parts, this.frameBytes)
  }

  clear(): void {
    this.queue = []
    this.queuedBytes = 0
    this.buffering = true
  }

  private filler(): Buffer {
    this.fillerIndex = (this.fillerIndex + 1) % this.fillerFrames.length
    return this.fillerFrames[this.fillerIndex]!
  }
}
