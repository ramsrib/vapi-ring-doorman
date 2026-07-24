import { config } from './config.ts'
import { log } from './log.ts'
import { connectRing, watchForDings } from './ring.ts'
import { bridgeCall } from './bridge.ts'

const answerNow = process.argv.includes('--now')

const { api, camera } = await connectRing()

let busyUntil = 0
let active = false

async function answer(source: string): Promise<void> {
  const now = Date.now()
  if (active || now < busyUntil) {
    log.info(`ding (${source}) ignored — call in progress`)
    return
  }
  active = true
  busyUntil = now + config.call.cooldownSeconds * 1000
  log.info(`ding (${source}) — answering`)
  try {
    await bridgeCall(camera)
  } catch (e) {
    log.error('call failed', e)
  } finally {
    active = false
    log.info('waiting for the next press')
  }
}

const dings = watchForDings(camera, (source) => void answer(source))

if (answerNow) {
  log.info('--now: opening a call without waiting for a button press')
  await answer('manual')
  shutdown('manual call finished')
} else {
  log.info('listening for doorbell presses — press the button')
}

function shutdown(reason: string): void {
  log.info(`shutting down (${reason})`)
  dings.stop()
  api.disconnect()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
