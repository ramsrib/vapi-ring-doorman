import { config } from './config.ts'
import { log } from './log.ts'
import { connectRing, waitForHumanAnswer, watchForDings, type Ding } from './ring.ts'
import { restoreChimeFromDisk } from './chime.ts'
import { bridgeCall, type BridgedCall } from './bridge.ts'

const answerNow = process.argv.includes('--now')

const { api, camera } = await connectRing()
await restoreChimeFromDisk(camera)

let current: BridgedCall | undefined

/*
 * Ring suppresses the doorbell while a call is active — a press mid-call
 * produces no push and no events-API entry at all (verified 2026-07-24), so
 * this guard only ever trips on a duplicate push. Calls end via the assistant's
 * endCall tool, an end-call phrase, Vapi's silence timeout, Enter here, or
 * CALL_MAX_SECONDS.
 */
async function answer(ding: Ding): Promise<void> {
  if (current) {
    log.info(`ding (${ding.source}) ignored — a call is already in progress`)
    return
  }

  // `--now` has no ding to follow, and asking for a call on demand means now.
  if (config.call.answerMode === 'fallback' && ding.id) {
    const wait = config.call.fallbackAfterSeconds
    log.info(`ding (${ding.source}) — holding ${wait}s for someone to answer in the Ring app`)
    if (await waitForHumanAnswer(camera, ding, wait)) {
      log.info('standing down — a person took the call')
      return
    }
    if (current) return
    log.info('nobody answered — the assistant is taking it')
  } else {
    log.info(`ding (${ding.source}) — answering`)
  }

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

const dings = watchForDings(camera, (ding) => void answer(ding))

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
  await answer({ source: 'manual' })
  await shutdown('manual call finished')
} else {
  log.info(
    config.call.answerMode === 'fallback'
      ? `listening — the assistant answers if nobody picks up within ${config.call.fallbackAfterSeconds}s`
      : 'listening for doorbell presses — press the button',
  )
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
