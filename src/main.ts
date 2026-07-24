import { config } from './config.ts'
import { log } from './log.ts'
import { connectRing, watchForDings } from './ring.ts'
import { restoreChimeFromDisk } from './chime.ts'
import { bridgeCall, type BridgedCall } from './bridge.ts'

const answerNow = process.argv.includes('--now')

const { api, camera } = await connectRing()
await restoreChimeFromDisk(camera)

let current: BridgedCall | undefined
let answeredAt = 0

async function answer(source: string): Promise<void> {
  if (current) {
    /*
     * Kept, but it will almost never fire: Ring suppresses the doorbell while
     * a call is active. Pressing the button mid-call produces no push and no
     * events-API entry at all (verified 2026-07-24), so there is nothing to
     * react to. Calls end via the assistant's endCall tool, an end-call phrase,
     * Vapi's silence timeout, Enter in this terminal, or CALL_MAX_SECONDS.
     */
    const sinceAnswer = Date.now() - answeredAt
    if (sinceAnswer < config.call.cooldownSeconds * 1000) {
      log.info(`ding (${source}) ignored — call just started`)
    } else {
      log.info(`ding (${source}) — hanging up`)
      current.hangup('button pressed again')
    }
    return
  }

  log.info(`ding (${source}) — answering`)
  answeredAt = Date.now()
  const call = bridgeCall(camera)
  current = call
  try {
    await call.done
  } catch (e) {
    log.error('call failed', e)
  } finally {
    current = undefined
    log.info('waiting for the next press')
  }
}

const dings = watchForDings(camera, (source) => void answer(source))

// Registered before any awaiting work below. Top-level await blocks the rest of
// module evaluation, so handlers installed at the bottom of this file would not
// exist during a `--now` call — and a Ctrl-C then killed the process outright,
// leaving the doorbell chime muted with no restore.
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// Hitting Enter in the terminal ends the current call. Not useful to a visitor
// at the door, but useful to whoever is watching the logs.
if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', () => {
    if (current) {
      log.info('keyboard — hanging up')
      current.hangup('keyboard')
    }
  })
  process.stdin.resume()
}

if (answerNow) {
  log.info('--now: opening a call without waiting for a button press')
  await answer('manual')
  await shutdown('manual call finished')
} else {
  log.info('listening for doorbell presses — press the button')
  log.info('to end a call: say goodbye, stay silent, or press Enter here')
}

async function shutdown(reason: string): Promise<void> {
  log.info(`shutting down (${reason})`)
  dings.stop()
  // Ends the call, which also restores the chime volume.
  current?.hangup('shutting down')
  await current?.done
  api.disconnect()
  // Deliberately not process.exit() here: when stdout is a file, exiting
  // discards buffered writes, which once hid a chime restore that had in fact
  // run. Let the loop drain, and only force the issue if something lingers.
  setTimeout(() => process.exit(0), 2000).unref()
}
