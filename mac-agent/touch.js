import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * Send touch event to simulator using idb
 * @param {string} udid
 * @param {number} x
 * @param {number} y
 */
export async function sendTouch(udid, x, y) {
  const rx = Math.round(x)
  const ry = Math.round(y)
  try {
    await execAsync(`idb ui tap ${rx} ${ry} --udid ${udid}`)
    console.log(`[Touch] idb tap at (${rx}, ${ry})`)
  } catch (err) {
    console.error(`[Touch] Tap error: ${err.message}`)
  }
}

/**
 * Send swipe event to simulator using idb
 * @param {string} udid
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 */
export async function sendSwipe(udid, x1, y1, x2, y2) {
  const rx1 = Math.round(x1)
  const ry1 = Math.round(y1)
  const rx2 = Math.round(x2)
  const ry2 = Math.round(y2)
  try {
    await execAsync(`idb ui swipe ${rx1} ${ry1} ${rx2} ${ry2} --udid ${udid}`)
    console.log(`[Touch] idb swipe from (${rx1}, ${ry1}) to (${rx2}, ${ry2})`)
  } catch (err) {
    console.error(`[Touch] Swipe error: ${err.message}`)
  }
}

/**
 * Send button event (e.g. HOME, LOCK)
 * @param {string} udid
 * @param {string} button HOME, LOCK, etc.
 */
export async function sendButton(udid, button = 'HOME') {
  try {
    await execAsync(`idb ui button ${button} --udid ${udid}`)
    console.log(`[Touch] idb button ${button} pressed`)
  } catch (err) {
    console.error(`[Touch] Button error: ${err.message}`)
  }
}
