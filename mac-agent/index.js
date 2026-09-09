process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message)
  console.error(err.stack)
  // Don't exit — keep the server alive so curl gets a response
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION:', reason)
})

import express from 'express'
import { WebSocketServer } from 'ws'
import cors from 'cors'
import { createServer } from 'http'
import { v4 as uuidv4 } from 'uuid'
import { SimulatorManager } from './simulator.js'

const PORT = process.env.PORT || 3001
const app = express()
const server = createServer(app)

// Configure server timeouts (120s) to allow time for simulator boot & download
server.timeout = 120000
server.keepAliveTimeout = 120000
server.headersTimeout = 125000

const wss = new WebSocketServer({ server })

app.use(cors())
app.use(express.json())

const simulator = new SimulatorManager()
const sessions = new Map() // sessionId → { udid, bundleId, stopStream, ws }
const activeSessions = sessions

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.size,
    timestamp: new Date().toISOString()
  })
})

// List active sessions
app.get('/sessions', (req, res) => {
  const list = []
  for (const [id, session] of sessions.entries()) {
    list.push({
      sessionId: id,
      udid: session.udid,
      bundleId: session.bundleId
    })
  }
  res.json({ sessions: list })
})

// Get single session status
app.get('/session/:id', (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session) {
    return res.status(404).json({ error: 'Session not found' })
  }

  const host = req.get('host') || `localhost:${PORT}`
  const protocol = (req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https') ? 'wss' : 'ws'

  res.json({
    sessionId: req.params.id,
    udid: session.udid,
    bundleId: session.bundleId,
    wsUrl: `${protocol}://${host}/stream/${req.params.id}`
  })
})

// Start a new session
app.post('/session/start', async (req, res) => {
  req.setTimeout(110000)
  res.setTimeout(110000)

  const { appZipUrl, bundleId } = req.body || {}
  if (!appZipUrl) {
    return res.status(400).json({ error: 'appZipUrl required' })
  }

  const sessionId = uuidv4()
  console.log(`[${sessionId}] Starting session...`)

  try {
    console.log(`[${sessionId}] Finding simulator...`)
    const udid = await simulator.findAvailableSimulator()
    console.log(`[${sessionId}] Found simulator: ${udid}`)

    console.log(`[${sessionId}] Booting simulator...`)
    await simulator.bootSimulator(udid)
    console.log(`[${sessionId}] Simulator booted`)

    console.log(`[${sessionId}] Installing app from: ${appZipUrl.substring(0, 60)}...`)
    const resolvedBundleId = await simulator.installApp(udid, appZipUrl, sessionId)
    console.log(`[${sessionId}] App installed, bundleId: ${resolvedBundleId}`)

    console.log(`[${sessionId}] Launching app...`)
    await simulator.launchApp(udid, resolvedBundleId || bundleId)
    console.log(`[${sessionId}] App launched`)

    // Start streaming
    const stopStream = simulator.startScreenStream(udid, (frame) => {
      // store frame for websocket clients
      const sess = activeSessions.get(sessionId)
      if (sess?.ws && sess.ws.readyState === 1) {
        sess.ws.send(JSON.stringify({
          type: 'frame',
          data: frame,
          timestamp: Date.now()
        }))
      }
    })

    activeSessions.set(sessionId, { udid, bundleId: resolvedBundleId || bundleId, stopStream, ws: null })

    console.log(`[${sessionId}] ✅ Session ready`)
    return res.json({ sessionId, udid, bundleId: resolvedBundleId || bundleId, status: 'ready' })

  } catch (err) {
    console.error(`[${sessionId}] ❌ Session start failed:`, err.message)
    console.error(err.stack)
    // Always respond — never leave curl hanging
    if (!res.headersSent) {
      return res.status(500).json({ 
        error: err.message, 
        sessionId,
        stack: err.stack 
      })
    }
  }
})

// End a session
app.post('/session/end', async (req, res) => {
  const { sessionId } = req.body
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' })

  const session = sessions.get(sessionId)
  if (session) {
    if (session.stopStream) session.stopStream()
    if (session.ws) session.ws.close()
    await simulator.cleanupSession(sessionId)
    sessions.delete(sessionId)
  }

  console.log(`✓ Session ended: ${sessionId}`)
  res.json({ success: true })
})

// WebSocket — stream frames and receive touch events
wss.on('connection', (ws, req) => {
  // Extract sessionId from URL: /stream/{sessionId}
  const sessionId = req.url?.split('/stream/')?.[1]?.split('?')[0]
  if (!sessionId) {
    ws.close()
    return
  }

  const session = sessions.get(sessionId)
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
    ws.close()
    return
  }

  console.log(`WebSocket connected for session: ${sessionId}`)

  // Stop any prior active stream for this session
  if (session.stopStream) {
    session.stopStream()
    session.stopStream = null
  }
  session.ws = ws

  // Start streaming screenshots to this client
  const stopStream = simulator.startScreenStream(session.udid, (frameBase64) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'frame',
        data: frameBase64,
        timestamp: Date.now()
      }))
    }
  })
  session.stopStream = stopStream

  // Handle messages from browser
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message.toString())

    if (msg.type === 'touch') {
      await simulator.sendTouch(session.udid, msg.x, msg.y)
    }

    if (msg.type === 'swipe') {
      await simulator.sendSwipe(
        session.udid,
        msg.x1, msg.y1,
        msg.x2, msg.y2
      )
    }

    if (msg.type === 'button') {
      await simulator.sendButton(session.udid, msg.button || 'HOME')
    }

    if (msg.type === 'launchApp') {
      await simulator.launchApp(session.udid, session.bundleId)
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
    }
    } catch (err) {
      console.error('Message error:', err)
    }
  })

  // Cleanup on disconnect
  ws.on('close', () => {
    console.log(`WebSocket disconnected: ${sessionId}`)
    stopStream()
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Peekaboo Mac Agent running on port ${PORT}`)
  console.log(`Health: http://localhost:${PORT}/health`)
})
