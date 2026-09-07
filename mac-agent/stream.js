import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'

const execAsync = promisify(exec)

/**
 * Take screenshot of simulator and return as base64
 * @param {string} udid
 * @returns {Promise<string>} base64 encoded PNG
 */
export async function takeScreenshot(udid) {
  const tmpPath = `/tmp/screenshot_${Date.now()}_${Math.random().toString(36).slice(2)}.png`
  await execAsync(`xcrun simctl io ${udid} screenshot "${tmpPath}"`)
  const buffer = fs.readFileSync(tmpPath)
  try {
    fs.unlinkSync(tmpPath)
  } catch {}
  return buffer.toString('base64')
}

/**
 * Start continuous screenshot stream
 * @param {string} udid
 * @param {(frameBase64: string) => void} onFrame
 * @param {number} [fps=15]
 * @returns {() => void} stop function
 */
export function startScreenStream(udid, onFrame, fps = 15) {
  let running = true
  const interval = Math.round(1000 / fps)

  const capture = async () => {
    while (running) {
      try {
        const frame = await takeScreenshot(udid)
        if (running) {
          onFrame(frame)
        }
      } catch (err) {
        console.error('Screenshot error:', err.message)
      }
      // Delay for target FPS
      await new Promise(r => setTimeout(r, interval))
    }
  }

  capture()
  return () => { running = false }
}
