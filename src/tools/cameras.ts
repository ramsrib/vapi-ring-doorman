/** Lists the Ring devices on the account so you can pin RING_CAMERA. */
import { RingApi } from 'ring-client-api'
import { config } from '../config.ts'

const api = new RingApi({ refreshToken: config.ring.refreshToken, debug: config.debug })
const cameras = await api.getCameras()

for (const camera of cameras) {
  console.log(
    [
      `id=${camera.id}`,
      `name="${camera.name}"`,
      `model=${camera.model}`,
      camera.isDoorbot ? 'doorbell' : 'camera',
      camera.hasBattery ? `battery=${camera.batteryLevel ?? '?'}%` : 'wired',
      camera.isOffline ? 'OFFLINE' : 'online',
      camera.isRingEdgeEnabled ? 'ring-edge' : '',
    ]
      .filter(Boolean)
      .join('  '),
  )
}

api.disconnect()
