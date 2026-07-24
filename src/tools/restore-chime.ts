/**
 * Puts the doorbell chime volume back if a crashed run left it muted.
 *
 *   npm run restore-chime         # restore the volume saved before muting
 *   VOLUME=4 npm run restore-chime  # or set it explicitly
 */
import { connectRing } from '../ring.ts'
import { currentVolume, restoreChimeFromDisk } from '../chime.ts'
import { log } from '../log.ts'

const { api, camera } = await connectRing()
const explicit = process.env['VOLUME']

if (explicit) {
  await camera.setSettings({ doorbell_volume: Number(explicit) })
  log.info(`chime: set doorbell_volume to ${explicit}`)
} else {
  await restoreChimeFromDisk(camera)
  log.info(`chime: doorbell_volume is ${currentVolume(camera) ?? 'unknown'} (cached value, may lag a few seconds)`)
  log.info('still silent? re-run with VOLUME=4')
}

api.disconnect()
process.exit(0)
