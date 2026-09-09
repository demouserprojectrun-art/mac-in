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
  // Set a server-side timeout so Express doesn't hang the connection
  req.setTimeout(110000)
  res.setTimeout(110000)

  try {
    const { appZipUrl, sessionId: requestedId, bundleId: providedBundleId } = req.body

    // If session already exists, return existing connection info
    if (requestedId && sessions.has(requestedId)) {
      const existing = sessions.get(requestedId)
      const host = req.get('host') || `localhost:${PORT}`
      const protocol = (req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https') ? 'wss' : 'ws'
      return res.json({
        success: true,
        sessionId: requestedId,
        simulatorName: 'Existing Simulator',
        udid: existing.udid,
        bundleId: existing.bundleId,
        wsUrl: `${protocol}://${host}/stream/${requestedId}`
      })
    }

    if (!appZipUrl) {
      return res.status(400).json({ error: 'appZipUrl required' })
    }

    const sessionId = requestedId || uuidv4()
    console.log(`\n=== Starting session: ${sessionId} ===`)

    // Find and boot simulator
    const { udid, name } = await simulator.findAvailableSimulator()
    await simulator.bootSimulator(udid)

    // Install app
    const bundleId = providedBundleId || await simulator.installApp(udid, appZipUrl, sessionId)

    // Launch app
    await simulator.launchApp(udid, bundleId)

    // Store session
    simulator.activeSimulators.set(sessionId, udid)
    sessions.set(sessionId, { udid, bundleId, stopStream: null, ws: null })

    console.log(`✓ Session ready: ${sessionId}`)

    const host = req.get('host') || `localhost:${PORT}`
    const protocol = (req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https') ? 'wss' : 'ws'

    if (!res.headersSent) {
      res.json({
        success: true,
        sessionId,
        simulatorName: name,
        udid,
        bundleId,
        wsUrl: `${protocol}://${host}/stream/${sessionId}`
      })
    }
  } catch (err) {
    console.error('Session start error:', err)
    // Make sure we always respond — never leave curl hanging
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
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
