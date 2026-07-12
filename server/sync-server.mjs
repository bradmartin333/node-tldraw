// ESM throughout: mixing require() and import() of the tldraw packages loads
// @tldraw/store, /validate and /tlschema twice (once CJS, once ESM), which
// tldraw reports as duplicate library instances and which breaks validation.
//
// This is the app's only server: it serves the built web app (dist/), the
// board metadata API, and the sync websocket from one port, so the browser
// talks to a single same-origin host and no CORS setup is ever needed.
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { WebSocketServer } from 'ws'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { createTLSchema, defaultShapeSchemas } from '@tldraw/tlschema'
import { MARKDOWN_SHAPE_TYPE, markdownShapeProps } from '../shared/markdownShape.js'

const HOST = '0.0.0.0'
const PORT = Number(process.env.PORT || 8787)
const DB_DIR = process.env.SYNC_DB_DIR || '/data'
const DB_PATH = path.join(DB_DIR, 'tldraw-sync.db')
const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const BOARD_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const BOARD_ROUTE_PATTERN = /^\/api\/boards\/([^/]+?)(\/touch)?$/
const MAX_BODY_BYTES = 10 * 1024 * 1024
// How often to look for rooms with no connected clients. An evicted room's
// state lives in SQLite, so reopening the board just reloads it.
const ROOM_SWEEP_INTERVAL_MS = 30 * 1000

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
}

const db = new DatabaseSync(DB_PATH)
const rooms = new Map()

// TLSocketRoom validates every incoming record. Without a schema it falls back
// to the stock tldraw schema, which has no 'markdown' shape and rejects it with
// INVALID_RECORD. Built from the same props the client uses.
const tlSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    [MARKDOWN_SHAPE_TYPE]: { props: markdownShapeProps },
  },
})

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    room_id TEXT NOT NULL UNIQUE,
    updated_at INTEGER NOT NULL
  )
`)

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body === undefined ? undefined : JSON.stringify(body))
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
    let settled = false

    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY_BYTES) {
        fail(new Error('Request body too large'))
        // Stop buffering the rest of an oversized upload.
        req.destroy()
      }
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', fail)
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

function boardExistsForRoom(roomId) {
  return Boolean(db.prepare('SELECT 1 AS one FROM boards WHERE room_id = ?').get(roomId))
}

// Only [a-zA-Z0-9_] survives, so interpolating the prefix into DDL below is safe.
function roomPrefix(roomId) {
  return `r_${roomId.replace(/[^a-zA-Z0-9_]/g, '_')}_`
}

function loadOrMakeRoom(roomId) {
  const existing = rooms.get(roomId)
  if (existing && !existing.isClosed()) return existing

  const sql = new NodeSqliteWrapper(db, { tablePrefix: roomPrefix(roomId) })
  const storage = new SQLiteSyncStorage({ sql })

  const room = new TLSocketRoom({ storage, schema: tlSchema })
  rooms.set(roomId, room)
  return room
}

// Fully remove a room: disconnect clients, forget it, and drop its SQLite
// tables (SQLiteSyncStorage creates documents/tombstones/metadata per prefix).
// Without this, deleted boards leave orphaned tables that grow the DB forever.
function destroyRoom(roomId) {
  const room = rooms.get(roomId)
  if (room && !room.isClosed()) room.close()
  rooms.delete(roomId)

  const prefix = roomPrefix(roomId)
  for (const table of ['documents', 'tombstones', 'metadata']) {
    db.exec(`DROP TABLE IF EXISTS ${prefix}${table}`)
  }
}

// Rooms whose last client disconnected stay in memory otherwise; on a
// long-running server that is an unbounded leak.
const roomSweepInterval = setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.isClosed()) {
      rooms.delete(roomId)
    } else if (room.getNumActiveSessions() === 0) {
      room.close()
      rooms.delete(roomId)
    }
  }
}, ROOM_SWEEP_INTERVAL_MS)

// -- Static files --------------------------------------------------------------

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

// Vite emits content-hashed filenames like index-BW8kpDzZ.js — those can be
// cached forever. Everything else (index.html, the mounted logo files) must
// revalidate so a redeploy or logo swap shows up without a hard refresh.
const HASHED_ASSET_PATTERN = /-[a-zA-Z0-9_-]{8,}\.[a-z0-9]+$/

function serveStatic(res, pathname) {
  let filePath = path.normalize(path.join(DIST_DIR, pathname.replace(/^\/+/, '')))
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) {
    jsonResponse(res, 404, { error: 'Not found' })
    return
  }

  let stats = fs.statSync(filePath, { throwIfNoEntry: false })
  if (stats?.isDirectory()) {
    filePath = path.join(filePath, 'index.html')
    stats = fs.statSync(filePath, { throwIfNoEntry: false })
  }

  if (!stats?.isFile()) {
    // SPA fallback: client-side routes like /boards/<id> resolve to the app.
    filePath = path.join(DIST_DIR, 'index.html')
    stats = fs.statSync(filePath, { throwIfNoEntry: false })
    if (!stats?.isFile()) {
      jsonResponse(res, 404, { error: 'Not found (is dist/ built?)' })
      return
    }
  }

  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(200, {
    'content-type': STATIC_MIME[ext] ?? 'application/octet-stream',
    'content-length': stats.size,
    'cache-control': HASHED_ASSET_PATTERN.test(filePath)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  })
  fs.createReadStream(filePath).pipe(res)
}

// -- HTTP API --------------------------------------------------------------------

function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')

  if (url.pathname === '/health') {
    try {
      db.prepare('SELECT 1 AS one').get()
      jsonResponse(res, 200, { ok: true })
    } catch {
      jsonResponse(res, 500, { ok: false })
    }
    return
  }

  if (url.pathname === '/api/boards' && req.method === 'GET') {
    const rows = db
      .prepare('SELECT id, name, room_id, updated_at FROM boards ORDER BY updated_at DESC')
      .all()
    jsonResponse(res, 200, rows.map(serializeBoard))
    return
  }

  if (url.pathname === '/api/boards' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
        const name = String(body.name || '').trim()
        if (!name) {
          jsonResponse(res, 400, { error: 'Name is required' })
          return
        }

        const snapshot = body.snapshot
        if (snapshot != null && (typeof snapshot !== 'object' || Array.isArray(snapshot))) {
          jsonResponse(res, 400, { error: 'Invalid snapshot payload' })
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
            // Roll back the half-created board, including any room tables the
            // failed import left behind.
            destroyRoom(roomId)
            db.prepare('DELETE FROM boards WHERE id = ?').run(id)
            jsonResponse(res, 400, { error: 'Failed to import board snapshot' })
            return
          }
        }

        jsonResponse(res, 201, { id, name, roomId, updatedAt })
      })
      .catch((error) => {
        jsonResponse(res, 400, { error: error.message })
      })
    return
  }

  const boardRoute = url.pathname.match(BOARD_ROUTE_PATTERN)
  if (boardRoute) {
    const boardId = decodeURIComponent(boardRoute[1])
    const isTouch = Boolean(boardRoute[2])

    if (!isValidBoardId(boardId)) {
      jsonResponse(res, 400, { error: 'Invalid board id' })
      return
    }

    if (isTouch && req.method === 'POST') {
      const updatedAt = Date.now()
      const result = db
        .prepare('UPDATE boards SET updated_at = ? WHERE id = ?')
        .run(updatedAt, boardId)

      if (result.changes === 0) {
        jsonResponse(res, 404, { error: 'Board not found' })
        return
      }

      const updated = db
        .prepare('SELECT id, name, room_id, updated_at FROM boards WHERE id = ?')
        .get(boardId)
      jsonResponse(res, 200, serializeBoard(updated))
      return
    }

    if (!isTouch && req.method === 'PATCH') {
      readJsonBody(req)
        .then((body) => {
          const name = String(body.name || '').trim()
          if (!name) {
            jsonResponse(res, 400, { error: 'Name is required' })
            return
          }

          const updatedAt = Date.now()
          const result = db
            .prepare('UPDATE boards SET name = ?, updated_at = ? WHERE id = ?')
            .run(name, updatedAt, boardId)

          if (result.changes === 0) {
            jsonResponse(res, 404, { error: 'Board not found' })
            return
          }

          const updated = db
            .prepare('SELECT id, name, room_id, updated_at FROM boards WHERE id = ?')
            .get(boardId)
          jsonResponse(res, 200, serializeBoard(updated))
        })
        .catch((error) => {
          jsonResponse(res, 400, { error: error.message })
        })
      return
    }

    if (!isTouch && req.method === 'DELETE') {
      const row = db.prepare('SELECT room_id FROM boards WHERE id = ?').get(boardId)
      if (!row) {
        jsonResponse(res, 404, { error: 'Board not found' })
        return
      }

      db.prepare('DELETE FROM boards WHERE id = ?').run(boardId)
      destroyRoom(row.room_id)

      jsonResponse(res, 204)
      return
    }
  }

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sync/')) {
    jsonResponse(res, 404, { error: 'Not found' })
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    jsonResponse(res, 405, { error: 'Method not allowed' })
    return
  }

  serveStatic(res, decodeURIComponent(url.pathname))
}

const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res)
  } catch (error) {
    // A handler throw (bad percent-encoding, SQLite error, ...) must not take
    // the whole process down with it.
    console.error('Request failed:', error)
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: 'Internal server error' })
    } else {
      res.end()
    }
  }
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    const match = url.pathname.match(/^\/sync\/([^/]+)$/)

    if (!match) {
      socket.destroy()
      return
    }

    const roomId = decodeURIComponent(match[1])

    // Only rooms that belong to a known board may be opened. Otherwise every
    // typo'd or stale URL would mint a fresh set of orphaned SQLite tables.
    if (!boardExistsForRoom(roomId)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Load the room in the same tick as the session attach: created here, it
      // has a session before the idle-room sweep can ever observe it empty.
      const room = loadOrMakeRoom(roomId)
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
  } catch (error) {
    console.error('Upgrade failed:', error)
    socket.destroy()
  }
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true

  clearInterval(roomSweepInterval)
  server.close()
  for (const room of rooms.values()) {
    if (!room.isClosed()) room.close()
  }
  rooms.clear()
  try {
    db.close()
  } catch {
    // Already closed or mid-statement; nothing else to release.
  }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

server.listen(PORT, HOST, () => {
  console.log(`tldraw server listening on http://${HOST}:${PORT}`)
  console.log(`Serving static files from ${DIST_DIR}`)
  console.log(`SQLite DB: ${DB_PATH}`)
})
