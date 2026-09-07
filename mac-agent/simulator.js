import { exec, execSync, spawn } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import extractZip from 'extract-zip'
import { sendTouch, sendSwipe, sendButton } from './touch.js'
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
          return { udid: device.udid, name: device.name }
        }
      }
    }
    throw new Error('No available iPhone simulator found')
  }

  // Boot simulator
  async bootSimulator(udid) {
    console.log(`Booting simulator: ${udid}`)
    try {
      await execAsync(`xcrun simctl boot ${udid}`)
    } catch (err) {
      // Already booted is fine
      if (!err.message.includes('Unable to boot device in current state')) {
        throw err
      }
    }
    // Wait for boot
    await this.waitForBoot(udid)
    console.log(`✓ Simulator booted: ${udid}`)

      // Start idb-companion if installed
    await this.startIdb(udid)
  }

  // Start idb-companion for simulator if available
  async startIdb(udid) {
    try {
      console.log(`Starting idb-companion for ${udid}...`)
      const candidates = [
        '/opt/homebrew/bin/idb_companion',
        '/opt/homebrew/bin/idb-companion',
        '/usr/local/bin/idb_companion',
        '/usr/local/bin/idb-companion',
        'idb_companion',
        'idb-companion'
      ]
      let binPath = candidates.find(p => {
        try { return fs.existsSync(p) } catch { return false }
      })
      if (!binPath) {
        try {
          const { stdout } = await execAsync('which idb_companion || which idb-companion')
          binPath = stdout.trim().split('\n')[0]
        } catch {}
      }
      binPath = binPath || 'idb_companion'
      console.log(`Using idb-companion binary: ${binPath}`)

      const env = {
        ...process.env,
        PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${process.env.PATH || ''}`
      }

      const companion = spawn(binPath, ['--udid', udid, '--port', '10882'], {
        detached: true,
        stdio: 'ignore',
        env
      })
      companion.on('error', (err) => {
        console.warn(`idb-companion spawn warning: ${err.message}`)
      })
      companion.unref()
      this.activeCompanions.set(udid, companion)

      // Wait a moment for companion to spin up
      await new Promise(r => setTimeout(r, 1500))

      // Connect idb client
      try {
        await execAsync('idb connect localhost 10882', { env })
        console.log(`✓ idb connected to simulator ${udid}`)
      } catch (e) {
        console.log(`idb connect note: ${e.message}`)
      }
    } catch (err) {
      console.log(`idb-companion note: ${err.message}`)
    }
  }

  // Wait until simulator is fully booted
  async waitForBoot(udid, timeout = 120000) {
    try {
      await execAsync(`xcrun simctl bootstatus "${udid}" -b`, { timeout: 60000 })
      return true
    } catch (e) {
      console.log(`bootstatus note: ${e.message}, checking device status...`)
    }

    const start = Date.now()
    while (Date.now() - start < timeout) {
      try {
        const { stdout } = await execAsync(`xcrun simctl list devices -j`)
        const data = JSON.parse(stdout)
        for (const devices of Object.values(data.devices)) {
          for (const device of devices) {
            if (device.udid === udid && device.state === 'Booted') {
              return true
            }
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000))
    }
    throw new Error('Simulator boot timeout')
  }

  // Download and install app
  async installApp(udid, appZipUrl, sessionId) {
    console.log(`Downloading app for session: ${sessionId}`)
    const tmpDir = `/tmp/peekaboo_${sessionId}`
    const zipPath = `${tmpDir}/app.zip`
    const appDir = `${tmpDir}/app`

    fs.mkdirSync(tmpDir, { recursive: true })
    fs.mkdirSync(appDir, { recursive: true })

    // Inspect URL and token expiry
    try {
      const parsedUrl = new URL(appZipUrl)
      console.log(`Download source: ${parsedUrl.origin}${parsedUrl.pathname}`)
      const token = parsedUrl.searchParams.get('token')
      if (token) {
        try {
          const parts = token.split('.')
          if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
            if (payload.exp) {
              const expDate = new Date(payload.exp * 1000)
              const now = new Date()
              const diffSec = Math.round((expDate.getTime() - now.getTime()) / 1000)
              console.log(`Token expiry: ${expDate.toISOString()} (${diffSec > 0 ? `${diffSec}s remaining` : `EXPIRED ${Math.abs(diffSec)}s AGO`})`)
              if (diffSec <= 0) {
                console.error(`❌ Supabase signed URL has EXPIRED! Please generate a new signed URL with longer expiry (e.g. 3600 seconds).`)
              }
            }
          }
        } catch {}
      }
    } catch (e) {
      console.warn(`URL parse warning: ${e.message}`)
    }

    // Download app.zip
    const response = await fetch(appZipUrl)
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      let hint = ''
      if (response.status === 400) {
        hint = ' (Check if signed URL has expired or if token parameter is invalid)'
      }
      throw new Error(`Download failed: ${response.status} ${response.statusText}${hint} - Response: ${errorBody}`)
    }
    const buffer = await response.arrayBuffer()
    fs.writeFileSync(zipPath, Buffer.from(buffer))
    console.log(`✓ Downloaded: ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB`)

    // Extract zip (native unzip preserves symlinks and permissions better in .app bundles)
    try {
      await execAsync(`unzip -q -o "${zipPath}" -d "${appDir}"`)
      console.log('✓ Extracted app using native unzip')
    } catch (unzipErr) {
      console.warn(`Native unzip failed (${unzipErr.message}), falling back to extract-zip...`)
      await extractZip(zipPath, { dir: appDir })
    }

    // Find .app bundle (supports top-level or nested e.g. Payload/)
    const findAppBundle = (dir) => {
      const files = fs.readdirSync(dir, { withFileTypes: true })
      for (const file of files) {
        if (file.name.endsWith('.app')) {
          return path.join(dir, file.name)
        }
        if (file.isDirectory()) {
          const nested = findAppBundle(path.join(dir, file.name))
          if (nested) return nested
        }
      }
      return null
    }

    const appPath = findAppBundle(appDir)
    if (!appPath) throw new Error('No .app found in zip')

    const appBundle = path.basename(appPath)
    console.log(`Found app bundle: ${appBundle}`)

    // Install on simulator
    await execAsync(`xcrun simctl install ${udid} "${appPath}"`)
    console.log(`✓ App installed`)

    // Get bundle ID from Info.plist
    const { stdout: bundleId } = await execAsync(
      `/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${appPath}/Info.plist"`
    )

    return bundleId.trim()
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

  // Send touch event to simulator
  async sendTouch(udid, x, y) {
    return sendTouch(udid, x, y)
  }

  // Send swipe event to simulator
  async sendSwipe(udid, x1, y1, x2, y2) {
    return sendSwipe(udid, x1, y1, x2, y2)
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
