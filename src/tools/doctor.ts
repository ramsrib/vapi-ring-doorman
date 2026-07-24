/** Checks every prerequisite before you go stand at the door. */
import { spawnSync } from 'node:child_process'
import { RingApi } from 'ring-client-api'
import { config } from '../config.ts'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok ' : '  XX '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const [major] = process.versions.node.split('.').map(Number)
check('node >= 22.18 (runs TypeScript directly)', (major ?? 0) >= 22, `v${process.versions.node}`)

const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })
check('ffmpeg on PATH', ffmpeg.status === 0)
check('ffmpeg has libopus', (ffmpeg.stdout ?? '').includes('libopus'))

check('RING_REFRESH_TOKEN set', Boolean(config.ring.refreshToken))
check('VAPI_API_KEY set', Boolean(config.vapi.apiKey))
check('VAPI_ASSISTANT_ID set', Boolean(config.vapi.assistantId))

try {
  const api = new RingApi({ refreshToken: config.ring.refreshToken })
  const cameras = await api.getCameras()
  const doorbells = cameras.filter((c) => c.isDoorbot)
  check('ring auth', true, `${cameras.length} device(s), ${doorbells.length} doorbell(s)`)
  check(
    'target camera reachable',
    cameras.some((c) => !c.isOffline),
    cameras.map((c) => `${c.name}${c.isOffline ? ' (offline)' : ''}`).join(', '),
  )
  api.disconnect()
} catch (e) {
  check('ring auth', false, e instanceof Error ? e.message : String(e))
  console.log('       token expired? run: npm run auth')
}

try {
  const response = await fetch(`${config.vapi.baseUrl}/assistant/${config.vapi.assistantId}`, {
    headers: { authorization: `Bearer ${config.vapi.apiKey}` },
  })
  const body = (await response.json()) as { name?: string; firstMessage?: string }
  check('vapi assistant reachable', response.ok, response.ok ? `"${body.name ?? 'unnamed'}"` : `HTTP ${response.status}`)
  if (response.ok && body.firstMessage) console.log(`       first message: "${body.firstMessage}"`)
} catch (e) {
  check('vapi assistant reachable', false, e instanceof Error ? e.message : String(e))
}

console.log(failures === 0 ? '\nall good — npm run dings, then npm start' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
