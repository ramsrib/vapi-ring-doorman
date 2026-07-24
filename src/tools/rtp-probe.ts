/** Counts raw RTP packets from Ring, upstream of any ffmpeg work. */
import { connectRing, startSpeakerCall } from '../ring.ts'
import { log } from '../log.ts'

const { api, camera } = await connectRing()
const { session, usingOpus } = await startSpeakerCall(camera)

let audioPackets = 0
let audioBytes = 0
let videoPackets = 0

session.onAudioRtp.subscribe((rtp) => {
  audioPackets++
  audioBytes += rtp.payload.length
})
session.onVideoRtp.subscribe(() => videoPackets++)
session.onCallEnded.subscribe(() => log.info('ring ended the call'))

log.info(`opus: ${usingOpus}`)

const timer = setInterval(
  () => log.info(`audio rtp: ${audioPackets} packets / ${audioBytes}B   video rtp: ${videoPackets} packets`),
  3000,
)

await new Promise((resolve) => setTimeout(resolve, 25000))
clearInterval(timer)
log.info(`FINAL audio rtp packets=${audioPackets} bytes=${audioBytes} | video rtp packets=${videoPackets}`)
session.stop()
api.disconnect()
process.exit(0)
