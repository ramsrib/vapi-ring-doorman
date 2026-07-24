import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * macOS `say` -> raw PCM s16le mono at `sampleRate`.
 *
 * Stands in for the visitor's voice when testing without the doorbell.
 * Returns undefined off macOS or if either process fails.
 *
 * `say` writes to a temp file rather than stdout: `-o /dev/stdout` fails with
 * error -54, it wants a real path with a format it recognises.
 */
export function synthesize(text: string, sampleRate: number): Buffer | undefined {
  if (process.platform !== 'darwin') return undefined

  const dir = mkdtempSync(join(tmpdir(), 'doorman-say-'))
  const wavPath = join(dir, 'speech.wav')

  try {
    const spoken = spawnSync('say', ['-o', wavPath, '--data-format=LEI16@22050', '--file-format=WAVE', text])
    if (spoken.status !== 0) return undefined

    const converted = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        wavPath,
        '-f',
        's16le',
        '-ar',
        String(sampleRate),
        '-ac',
        '1',
        'pipe:1',
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    )
    return converted.status === 0 && converted.stdout.length > 0 ? converted.stdout : undefined
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Minimal RIFF header so raw PCM can be played back by anything. */
export function toWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
