/**
 * Hunts for *any* signal Ring gives when the button is pressed mid-call.
 *
 * Push notifications and the events API both come up empty (verified), so this
 * opens a live call and watches every other channel at once while you press:
 *
 *   - push notifications of any category
 *   - the legacy `dings/active` endpoint, which predates push
 *   - the events API with no `kind` filter, in case a press lands as some
 *     other event type
 *   - unknown live-session signalling messages, which the library prints as
 *     "UNKNOWN MESSAGE" on its own
 *
 * Run it, wait for "call is up", then press the doorbell button a couple of
 * times and watch for anything that appears.
 */
import { clientApi } from 'ring-client-api/rest-client'
import { connectRing } from '../ring.ts'
import { log } from '../log.ts'

const { api, camera } = await connectRing()

camera.onNewNotification.subscribe((notification) => {
  log.info(`>>> PUSH: category "${notification.android_config.category}"`)
})

log.info('opening live call...')
const session = await camera.startLiveCall()
session.activateCameraSpeaker()
session.onCallEnded.subscribe(() => log.info('call ended'))
await session.isUsingOpus
log.info('call is up — PRESS THE DOORBELL BUTTON NOW (a few times)')

const seenDings = new Set<string>()
const seenEvents = new Set<string>()
let activeDingPolls = 0

const dingsTimer = setInterval(() => {
  void (async () => {
    try {
      const dings = await api.restClient.request<unknown[]>({
        url: clientApi('dings/active'),
        method: 'GET',
      })
      activeDingPolls++
      for (const ding of dings ?? []) {
        const id = JSON.stringify((ding as { id_str?: string; id?: number }).id_str ?? (ding as { id?: number }).id)
        if (!seenDings.has(id)) {
          seenDings.add(id)
          log.info(`>>> DINGS/ACTIVE: ${JSON.stringify(ding).slice(0, 300)}`)
        }
      }
    } catch (e) {
      log.debug('dings/active failed', e)
    }
  })()
}, 2000)

const eventsTimer = setInterval(() => {
  void (async () => {
    try {
      const { events } = await camera.getEvents({ limit: 5 })
      for (const event of events) {
        if (!seenEvents.has(event.ding_id_str)) {
          if (seenEvents.size > 0) {
            log.info(`>>> EVENT: kind=${event.kind} state=${event.state} at ${event.created_at}`)
          }
          seenEvents.add(event.ding_id_str)
        }
      }
    } catch (e) {
      log.debug('events poll failed', e)
    }
  })()
}, 3000)

await new Promise((resolve) => setTimeout(resolve, 60000))

clearInterval(dingsTimer)
clearInterval(eventsTimer)
log.info(`done — ${activeDingPolls} dings/active polls, ${seenDings.size} active ding(s) seen`)
log.info('if nothing appeared above, Ring exposes no button signal during a call')

session.stop()
api.disconnect()
process.exit(0)
