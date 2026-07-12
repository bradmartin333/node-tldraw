// Parses large request bodies (board imports can carry multi-MB base64 image
// data) off the main thread, so a big .tldr import can't stall live sync
// sessions on other boards while JSON.parse runs.
import { parentPort } from 'node:worker_threads'

parentPort.on('message', ({ id, raw }) => {
  try {
    const value = raw ? JSON.parse(raw) : {}
    parentPort.postMessage({ id, value })
  } catch {
    parentPort.postMessage({ id, error: 'Invalid JSON' })
  }
})
