const http = require('http')
const path = require('path')
const fs = require('fs')
const { randomUUID } = require('crypto')
const { DatabaseSync } = require('node:sqlite')
const { WebSocketServer } = require('ws')
const { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } = require('@tldraw/sync-core')

const HOST = '0.0.0.0'
const PORT = Number(process.env.SYNC_PORT || 8787)
const DB_DIR = process.env.SYNC_DB_DIR || '/data'
const DB_PATH = path.join(DB_DIR, 'tldraw-sync.db')
const WRITE_TOKEN = String(process.env.SYNC_WRITE_TOKEN || '').trim()
const BOARD_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost',
  'http://127.0.0.1',
]
const ALLOWED_ORIGINS = new Set(
  String(process.env.SYNC_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
)

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
}

const db = new DatabaseSync(DB_PATH)
const rooms = new Map()

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    room_id TEXT NOT NULL UNIQUE,
    updated_at INTEGER NOT NULL
  )
`)

function maybeSeedBoards() {
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM boards').get()
  if (Number(countRow.count) > 0) return

  const now = Date.now()
  const seed = [
    {
      id: 'b-foundation',
      name: 'Product Foundation',
      roomId: 'room-product-foundation',
      updatedAt: now - 2 * 60 * 1000,
    },
    {
      id: 'b-onboarding',
      name: 'Onboarding Flows',
      roomId: 'room-onboarding-flows',
      updatedAt: now - 19 * 60 * 1000,
    },
  ]

  const insert = db.prepare(
    'INSERT INTO boards (id, name, room_id, updated_at) VALUES (?, ?, ?, ?)',
  )

  for (const item of seed) {
    insert.run(item.id, item.name, item.roomId, item.updatedAt)
  }
}

function jsonHeaders(origin) {
  const headers = {
    'content-type': 'application/json',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    vary: 'Origin',
  }

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['access-control-allow-origin'] = origin
  }

  return headers
}

function isAllowedOrigin(origin) {
  if (!origin) return false
  return ALLOWED_ORIGINS.has(origin)
}

function hasWriteAccess(req) {
  if (!WRITE_TOKEN) return true
  return req.headers.authorization === `Bearer ${WRITE_TOKEN}`
}

function isValidBoardId(value) {
  return BOARD_ID_PATTERN.test(value)
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 10 * 1024 * 1024) {
        reject(new Error('Request body too large'))
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function serializeBoard(row) {
  return {
    id: row.id,
    name: row.name,
    roomId: row.room_id,
    updatedAt: row.updated_at,
  }
}

maybeSeedBoards()

function roomPrefix(roomId) {
  return `r_${roomId.replace(/[^a-zA-Z0-9_]/g, '_')}_`
}

function loadOrMakeRoom(roomId) {
  const existing = rooms.get(roomId)
  if (existing) return existing

  const sql = new NodeSqliteWrapper(db, { tablePrefix: roomPrefix(roomId) })
  const storage = new SQLiteSyncStorage({ sql })

  const room = new TLSocketRoom({ storage })
  rooms.set(roomId, room)
  return room
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const origin = req.headers.origin

  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403, jsonHeaders(origin))
      res.end()
      return
    }

    res.writeHead(204, jsonHeaders(origin))
    res.end()
    return
  }

  if (url.pathname === '/health') {
    res.writeHead(200, jsonHeaders(origin))
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (url.pathname === '/api/boards' && req.method === 'GET') {
    const rows = db
      .prepare('SELECT id, name, room_id, updated_at FROM boards ORDER BY updated_at DESC')
      .all()
    res.writeHead(200, jsonHeaders(origin))
    res.end(JSON.stringify(rows.map(serializeBoard)))
    return
  }

  if (url.pathname === '/api/boards' && req.method === 'POST') {
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Origin is not allowed' }))
      return
    }

    if (!hasWriteAccess(req)) {
      res.writeHead(401, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    readJsonBody(req)
      .then((body) => {
        const name = String(body.name || '').trim()
        if (!name) {
          res.writeHead(400, jsonHeaders(origin))
          res.end(JSON.stringify({ error: 'Name is required' }))
          return
        }

        const snapshot = body.snapshot
        if (snapshot != null && (typeof snapshot !== 'object' || Array.isArray(snapshot))) {
          res.writeHead(400, jsonHeaders(origin))
          res.end(JSON.stringify({ error: 'Invalid snapshot payload' }))
          return
        }

        const base = slugify(name) || 'board'
        const stamp = Date.now()
        const id = `b-${base}-${stamp}`
        const roomId = `room-${base}-${stamp}`
        const updatedAt = stamp

        db.prepare('INSERT INTO boards (id, name, room_id, updated_at) VALUES (?, ?, ?, ?)').run(
          id,
          name,
          roomId,
          updatedAt,
        )

        if (snapshot) {
          try {
            const room = loadOrMakeRoom(roomId)
            room.loadSnapshot(snapshot)
          } catch {
            db.prepare('DELETE FROM boards WHERE id = ?').run(id)
            res.writeHead(400, jsonHeaders(origin))
            res.end(JSON.stringify({ error: 'Failed to import board snapshot' }))
            return
          }
        }

        res.writeHead(201, jsonHeaders(origin))
        res.end(
          JSON.stringify({
            id,
            name,
            roomId,
            updatedAt,
          }),
        )
      })
      .catch((error) => {
        res.writeHead(400, jsonHeaders(origin))
        res.end(JSON.stringify({ error: error.message }))
      })
    return
  }

  if (req.method === 'PATCH' && url.pathname.startsWith('/api/boards/')) {
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Origin is not allowed' }))
      return
    }

    if (!hasWriteAccess(req)) {
      res.writeHead(401, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    const boardId = decodeURIComponent(url.pathname.replace('/api/boards/', ''))
    if (!isValidBoardId(boardId)) {
      res.writeHead(400, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Invalid board id' }))
      return
    }

    readJsonBody(req)
      .then((body) => {
        const name = String(body.name || '').trim()
        if (!name) {
          res.writeHead(400, jsonHeaders(origin))
          res.end(JSON.stringify({ error: 'Name is required' }))
          return
        }

        const updatedAt = Date.now()
        const result = db
          .prepare('UPDATE boards SET name = ?, updated_at = ? WHERE id = ?')
          .run(name, updatedAt, boardId)

        if (result.changes === 0) {
          res.writeHead(404, jsonHeaders(origin))
          res.end(JSON.stringify({ error: 'Board not found' }))
          return
        }

        const updated = db
          .prepare('SELECT id, name, room_id, updated_at FROM boards WHERE id = ?')
          .get(boardId)

        res.writeHead(200, jsonHeaders(origin))
        res.end(JSON.stringify(serializeBoard(updated)))
      })
      .catch((error) => {
        res.writeHead(400, jsonHeaders(origin))
        res.end(JSON.stringify({ error: error.message }))
      })
    return
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/boards/') && url.pathname.endsWith('/touch')) {
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Origin is not allowed' }))
      return
    }

    if (!hasWriteAccess(req)) {
      res.writeHead(401, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    const boardId = decodeURIComponent(url.pathname.replace('/api/boards/', '').replace('/touch', ''))
    if (!isValidBoardId(boardId)) {
      res.writeHead(400, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Invalid board id' }))
      return
    }

    const updatedAt = Date.now()
    const result = db
      .prepare('UPDATE boards SET updated_at = ? WHERE id = ?')
      .run(updatedAt, boardId)

    if (result.changes === 0) {
      res.writeHead(404, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Board not found' }))
      return
    }

    const updated = db
      .prepare('SELECT id, name, room_id, updated_at FROM boards WHERE id = ?')
      .get(boardId)

    res.writeHead(200, jsonHeaders(origin))
    res.end(JSON.stringify(serializeBoard(updated)))
    return
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/boards/')) {
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Origin is not allowed' }))
      return
    }

    if (!hasWriteAccess(req)) {
      res.writeHead(401, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    const boardId = decodeURIComponent(url.pathname.replace('/api/boards/', ''))
    if (!isValidBoardId(boardId)) {
      res.writeHead(400, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Invalid board id' }))
      return
    }

    const result = db.prepare('DELETE FROM boards WHERE id = ?').run(boardId)
    if (result.changes === 0) {
      res.writeHead(404, jsonHeaders(origin))
      res.end(JSON.stringify({ error: 'Board not found' }))
      return
    }

    res.writeHead(204, jsonHeaders(origin))
    res.end()
    return
  }

  res.writeHead(404, jsonHeaders(origin))
  res.end(JSON.stringify({ error: 'Not found' }))
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const match = url.pathname.match(/^\/sync\/([^/]+)$/)

  if (!match) {
    socket.destroy()
    return
  }

  const roomId = decodeURIComponent(match[1])
  const room = loadOrMakeRoom(roomId)

  wss.handleUpgrade(req, socket, head, (ws) => {
    const sessionId = randomUUID()

    room.handleSocketConnect({
      sessionId,
      socket: ws,
    })

    // TLSocketRoom attaches listeners via addEventListener when available.
    // For socket implementations without addEventListener, wire events manually.
    if (typeof ws.addEventListener !== 'function') {
      ws.on('message', (message) => {
        room.handleSocketMessage(sessionId, message)
      })

      ws.on('close', () => {
        room.handleSocketClose(sessionId)
      })

      ws.on('error', () => {
        room.handleSocketError(sessionId)
      })
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`tldraw sync server listening on ws://${HOST}:${PORT}`)
  console.log(`SQLite DB: ${DB_PATH}`)
})
