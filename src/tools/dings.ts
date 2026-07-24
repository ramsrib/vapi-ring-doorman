/**
 * Ding listener with no Vapi involvement.
 *
 * Run this first when something is broken: if presses show up here, the push
 * path is healthy and the problem is downstream in the audio bridge.
 */
import { connectRing, watchForDings } from '../ring.ts'
import { log } from '../log.ts'

const { camera } = await connectRing()

camera.onNewNotification.subscribe((notification) => {
  log.info(`notification: ${notification.android_config.category} (ding id ${notification.data.event.ding.id})`)
})

watchForDings(camera, (source) => log.info(`>>> DOORBELL PRESSED (via ${source})`))

log.info('listening — press the doorbell button (Ctrl-C to stop)')
log.info('nothing appearing? set RING_DING_POLL_SECONDS=5 in .env to use the polling fallback')

const recent = await camera.getEvents({ limit: 5, kind: 'ding' })
log.info('recent dings from the events API:')
for (const event of recent.events) {
  log.info(`  ${event.created_at}  id=${event.ding_id_str}  state=${event.state}`)
}
