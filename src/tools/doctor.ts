/** Checks every prerequisite before you go stand at the door. */
import { spawnSync } from 'node:child_process'
import { createRingApi } from '../ring.ts'

let failures = 0

/*
 * config.ts throws at import when a required variable is missing, so it is
 * loaded dynamically here — otherwise this tool would die with a stack trace
 * instead of reporting the missing variable as a failed check.
 */
let config: typeof import('../config.ts').config | undefined
let configError: string | undefined
try {
  ;({ config } = await import('../config.ts'))
} catch (e) {
  configError = e instanceof Error ? e.message : String(e)
}

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok ' : '  XX '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const [major] = process.versions.node.split('.').map(Number)
check('node >= 22.18 (runs TypeScript directly)', (major ?? 0) >= 22, `v${process.versions.node}`)

const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })
check('ffmpeg on PATH', ffmpeg.status === 0)
check('ffmpeg has libopus', (ffmpeg.stdout ?? '').includes('libopus'))

check('.env has the required variables', config !== undefined, configError ?? '')

if (!config) {
  console.log('\nfix .env before the remaining checks can run — see .env.example')
  process.exit(1)
}

try {
  const api = createRingApi()
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
