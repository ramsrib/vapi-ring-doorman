import { RingApi } from 'ring-client-api'
import type { RingCamera } from 'ring-client-api'
import { config, persistRefreshToken } from './config.ts'
import { log } from './log.ts'

export interface RingConnection {
  api: RingApi
  camera: RingCamera
}

export async function connectRing(): Promise<RingConnection> {
  const api = new RingApi({
    refreshToken: config.ring.refreshToken,
    debug: config.debug,
    // We only care about live calls and dings; polling device status less often
    // keeps us well clear of Ring's rate limits.
    cameraStatusPollingSeconds: 60,
  })

  api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    persistRefreshToken(newRefreshToken)
    log.info('ring: refresh token rotated, .env updated')
  })

  const cameras = await api.getCameras()
  if (cameras.length === 0) {
    throw new Error('No Ring cameras on this account')
  }

  const camera = pickCamera(cameras, config.ring.cameraName)
  log.info(`ring: using "${camera.name}" (id ${camera.id}, ${camera.model}${camera.isDoorbot ? ', doorbell' : ''})`)

  if (!camera.isDoorbot) {
    log.warn('ring: that device is not a doorbell — it will never report a button press')
  }

  // Ask Ring to send us ding events for this device. The push receiver
  // registration itself happens inside RingApi on construction.
  await camera.subscribeToDingEvents().catch((e: unknown) => {
    log.warn('ring: subscribeToDingEvents failed (pushes may still work):', e)
  })

  return { api, camera }
}

function pickCamera(cameras: RingCamera[], wanted: string): RingCamera {
  if (wanted) {
    const match = cameras.find(
      (c) => String(c.id) === wanted || c.name.toLowerCase().includes(wanted.toLowerCase()),
    )
    if (!match) {
      const names = cameras.map((c) => `${c.name} (${c.id})`).join(', ')
      throw new Error(`No Ring camera matching "${wanted}". Available: ${names}`)
    }
    return match
  }
  const doorbell = cameras.find((c) => c.isDoorbot)
  return doorbell ?? cameras[0]!
}

export interface DingSource {
  stop(): void
}

/**
 * Calls `onDing` when the doorbell button is pressed.
 *
 * Primary path is the Ring push notification (`onDoorbellPressed`), which is
 * near-instant. The optional poller is a backstop for when push registration
 * breaks — it costs one API call per interval and lands a few seconds late.
 */
export function watchForDings(camera: RingCamera, onDing: (source: string) => void): DingSource {
  const subscription = camera.onDoorbellPressed.subscribe(() => onDing('push'))

  let timer: NodeJS.Timeout | undefined
  if (config.ring.dingPollSeconds > 0) {
    let lastSeenDingId: string | undefined
    let primed = false

    const poll = async () => {
      try {
        const { events } = await camera.getEvents({ limit: 5, kind: 'ding' })
        const newest = events[0]
        if (!newest) return
        if (!primed) {
          // First poll only establishes a baseline, otherwise we'd "answer"
          // whatever ding happened before startup.
          lastSeenDingId = newest.ding_id_str
          primed = true
          return
        }
        if (newest.ding_id_str !== lastSeenDingId) {
          lastSeenDingId = newest.ding_id_str
          onDing('poll')
        }
      } catch (e) {
        log.debug('ring: ding poll failed', e)
      }
    }

    void poll()
    timer = setInterval(() => void poll(), config.ring.dingPollSeconds * 1000)
    log.info(`ring: ding polling fallback every ${config.ring.dingPollSeconds}s`)
  }

  return {
    stop() {
      subscription.unsubscribe()
      if (timer) clearInterval(timer)
    },
  }
}
