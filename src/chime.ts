import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { RingCamera } from 'ring-client-api'
import { config } from './config.ts'
import { log } from './log.ts'

const statePath = join(dirname(fileURLToPath(import.meta.url)), '..', '.chime-state.json')

interface ChimeState {
  cameraId: number
  doorbellVolume: number
}

/**
 * Reads the chime volume from the cached device data. Ring's cache lags a
 * `setSettings` by several seconds — re-fetch via `fetchRingDevices()` when you
 * need the authoritative value.
 */
export function currentVolume(camera: RingCamera): number | undefined {
  const settings = (camera.data as { settings?: { doorbell_volume?: number } }).settings
  return settings?.doorbell_volume
}

/**
 * Drops the doorbell's chime volume to zero and returns a restore function.
 *
 * The original volume is also written to disk: muting the doorbell is a change
 * to the user's actual house, and a crash between mute and restore would
 * otherwise leave it permanently silent with no clue why.
 */
export async function muteChime(camera: RingCamera): Promise<() => Promise<void>> {
  if (!config.call.muteChimeDuringCall) return async () => {}

  const original = currentVolume(camera)
  if (original === undefined) {
    log.debug('chime: device exposes no doorbell_volume, leaving it alone')
    return async () => {}
  }
  if (original === 0) {
    log.debug('chime: already silent, leaving it alone')
    return async () => {}
  }

  writeFileSync(statePath, JSON.stringify({ cameraId: camera.id, doorbellVolume: original }))
  await camera.setSettings({ doorbell_volume: 0 })
  log.info(`chime: muted (was ${original})`)

  let restored = false
  return async () => {
    if (restored) return
    restored = true
    try {
      await camera.setSettings({ doorbell_volume: original })
      log.info(`chime: restored to ${original}`)
      rmSync(statePath, { force: true })
    } catch (e) {
      log.error(`chime: could not restore volume to ${original} — run: npm run restore-chime`, e)
    }
  }
}

/** Undoes a mute left behind by a crashed run. Safe to call at startup. */
export async function restoreChimeFromDisk(camera: RingCamera): Promise<void> {
  if (!existsSync(statePath)) return
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as ChimeState
    if (state.cameraId !== camera.id) return
    await camera.setSettings({ doorbell_volume: state.doorbellVolume })
    log.warn(`chime: a previous run left the chime muted — restored to ${state.doorbellVolume}`)
    rmSync(statePath, { force: true })
  } catch (e) {
    log.error('chime: failed to restore from saved state', e)
  }
}
