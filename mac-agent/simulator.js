import { exec, execSync, spawn } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import extractZip from 'extract-zip'
import { sendButton } from './touch.js'
import { startScreenStream, takeScreenshot } from './stream.js'

const execAsync = promisify(exec)

export class SimulatorManager {
  constructor() {
    this.activeSimulators = new Map() // sessionId → udid
    this.activeCompanions = new Map() // udid → ChildProcess
  }

  // Find best available simulator UDID
  async findAvailableSimulator() {
    const { stdout } = await execAsync('xcrun simctl list devices available -j')
    const data = JSON.parse(stdout)

    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!runtime.includes('iOS')) continue
      for (const device of devices) {
        if (device.isAvailable && device.name.includes('iPhone')) {
          console.log(`Found simulator: ${device.name} (${device.udid})`)
          return device.udid
        }
      }
    }
    throw new Error('No available iPhone simulator found')
  }

  // Boot simulator
  async bootSimulator(udid) {
    console.log(`Booting simulator ${udid}...`)
    
    // Boot it
    try {
      await execAsync(`xcrun simctl boot "${udid}"`)
    } catch (err) {
      // Already booted is fine
      if (!err.message.includes('Unable to boot device in current state')) {
        throw err
      }
    }

    // Wait for booted state with a timeout
    const timeout = 60000 // 60s max
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const { stdout } = await execAsync(`xcrun simctl list devices`)
      if (stdout.includes(`${udid}) (Booted)`)) {
        console.log(`Simulator ${udid} is booted`)
        return
      }
      await new Promise(r => setTimeout(r, 2000))
    }
    throw new Error(`Simulator ${udid} did not boot within 60s`)
  }

  // Download and install app
  async installApp(udid, appZipUrl, sessionId) {
    const tmpDir = `/tmp/peekaboo-${sessionId}`
    const zipPath = `${tmpDir}/app.zip`
    
    await execAsync(`mkdir -p "${tmpDir}"`)
    
    console.log(`Downloading app zip...`)
    // 60s download timeout
    await execAsync(`curl -L --max-time 60 -o "${zipPath}" "${appZipUrl}"`)
    
    const { stdout: sizeOut } = await execAsync(`du -sh "${zipPath}"`)
    console.log(`Downloaded: ${sizeOut.trim()}`)
    
    await execAsync(`unzip -o "${zipPath}" -d "${tmpDir}"`)
    
    const { stdout: appPath } = await execAsync(`find "${tmpDir}" -name "*.app" -not -name "*.appex" | head -1`)
    const app = appPath.trim()
    if (!app) throw new Error('No .app found in zip')
    
    console.log(`Installing app: ${app}`)
    await execAsync(`xcrun simctl install "${udid}" "${app}"`)
    
    // Extract bundle ID
    const { stdout: plistOut } = await execAsync(
      `/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${app}/Info.plist" 2>/dev/null || defaults read "${app}/Info.plist" CFBundleIdentifier`
    )
    const extractedBundleId = plistOut.trim()
    console.log(`Bundle ID: ${extractedBundleId}`)
    return extractedBundleId
  }

  // Launch app on simulator
  async launchApp(udid, bundleId) {
    if (!bundleId) {
      console.warn('No bundleId provided to launch')
      return
    }
    console.log(`Launching: ${bundleId}`)
    try {
      await execAsync(`xcrun simctl launch ${udid} "${bundleId}"`)
      console.log(`✓ App launched`)
    } catch (err) {
      console.error(`Launch error: ${err.message}`)
    }
  }

  // Send single tap
  async sendTouch(udid, x, y) {
    try {
      // xcrun simctl io requires integer coordinates
      const ix = Math.round(x)
      const iy = Math.round(y)

      // Use xdotool-style touch via simctl
      await execAsync(
        `xcrun simctl io ${udid} sendEvent touch ${ix} ${iy}`
      )
    } catch (err) {
      // Fallback — use AppleScript to click in simulator window
      try {
        await execAsync(`osascript -e '
          tell application "Simulator" to activate
          tell application "System Events"
            tell process "Simulator"
              click at {${Math.round(x)}, ${Math.round(y)}}
            end tell
          end tell
        '`)
      } catch (e) {
        console.error('Touch fallback also failed:', e.message)
      }
    }
  }

  // Send swipe gesture
  async sendSwipe(udid, x1, y1, x2, y2) {
    try {
      // Simulate swipe as series of touch events
      const steps = 10
      for (let i = 0; i <= steps; i++) {
        const x = Math.round(x1 + (x2 - x1) * (i / steps))
        const y = Math.round(y1 + (y2 - y1) * (i / steps))
        await execAsync(`xcrun simctl io ${udid} sendEvent touch ${x} ${y}`)
        await new Promise(r => setTimeout(r, 20))
      }
    } catch (err) {
      console.error('Swipe error:', err.message)
    }
  }

  // Send button event to simulator
  async sendButton(udid, button) {
    return sendButton(udid, button)
  }

  // Take screenshot and return as base64
  async takeScreenshot(udid) {
    return takeScreenshot(udid)
  }

  // Start continuous screenshot stream
  startScreenStream(udid, onFrame) {
    return startScreenStream(udid, onFrame)
  }

  // Shutdown and cleanup simulator session
  async cleanupSession(sessionId) {
    const udid = this.activeSimulators.get(sessionId)
    if (!udid) return

    // Stop idb-companion
    try {
      const companion = this.activeCompanions.get(udid)
      if (companion) {
        companion.kill()
        this.activeCompanions.delete(udid)
      }
    } catch {}

    try {
      await execAsync(`xcrun simctl shutdown ${udid}`)
      console.log(`✓ Simulator shut down: ${udid}`)
    } catch {}

    // Clean up temp files
    try {
      fs.rmSync(`/tmp/peekaboo_${sessionId}`, { recursive: true })
    } catch {}

    this.activeSimulators.delete(sessionId)
  }
}
