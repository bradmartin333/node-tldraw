import { useEffect, useMemo, useRef, useState } from 'react'
import { Tldraw, parseTldrawJsonFile, serializeTldrawJson } from 'tldraw'
import { useSync } from '@tldraw/sync'
import 'tldraw/tldraw.css'

const DEFAULT_BOARD = {
  id: 'b-default',
  name: 'Board',
  roomId: 'room-default',
  updatedAt: Date.now(),
}

const slugify = (value) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const toSafeFileName = (value) => slugify(value) || 'board'

const getBoardInitials = (value) => {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

const formatRelativeTime = (updatedAt) => {
  const deltaMs = Date.now() - updatedAt
  const minutes = Math.round(deltaMs / 60000)
  if (minutes < 1) return 'Updated just now'
  if (minutes < 60) return `Updated ${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Updated ${hours}h ago`
  const days = Math.round(hours / 24)
  return `Updated ${days}d ago`
}

const BOARD_PATH_PREFIX = '/boards/'
const BOARD_QUERY_PARAM = 'board'

const getBoardIdFromUrl = () => {
  const { pathname, search } = window.location

  if (pathname.startsWith(BOARD_PATH_PREFIX)) {
    const rawBoardId = pathname.slice(BOARD_PATH_PREFIX.length).split('/')[0]
    return rawBoardId ? decodeURIComponent(rawBoardId) : null
  }

  // Keep compatibility for existing shared links using ?board=<id>.
  const params = new URLSearchParams(search)
  return params.get(BOARD_QUERY_PARAM)
}

const setBoardIdInUrl = (boardId, { replace = false } = {}) => {
  const url = new URL(window.location.href)
  const currentPath = url.pathname

  if (boardId) {
    url.pathname = `${BOARD_PATH_PREFIX}${encodeURIComponent(boardId)}`
  } else {
    url.pathname = '/'
  }

  // Remove legacy query param once board path routing is in use.
  url.searchParams.delete(BOARD_QUERY_PARAM)

  if (currentPath === url.pathname) return

  const nextUrl = `${url.pathname}${url.search}${url.hash}`
  if (replace) {
    window.history.replaceState(null, '', nextUrl)
    return
  }

  window.history.pushState(null, '', nextUrl)
}

const trimTrailingSlash = (value) => value.replace(/\/+$/, '')

const toSyncApiBase = () => {
  const configured = import.meta.env.VITE_SYNC_HTTP_URL?.trim()
  if (configured) return trimTrailingSlash(configured)

  const protocol = window.location.protocol
  const host = window.location.hostname
  return `${protocol}//${host}:8787`
}

const toSyncSocketBase = () => {
  const configured = import.meta.env.VITE_SYNC_WS_URL?.trim()
  if (configured) return trimTrailingSlash(configured)

  const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const host = window.location.hostname
  return `${wsProtocol}://${host}:8787`
}

const withAuthHeaders = (headers = {}) => {
  const token = import.meta.env.VITE_SYNC_WRITE_TOKEN?.trim()
  if (!token) return headers
  return { ...headers, authorization: `Bearer ${token}` }
}

function formatImportError(error) {
  switch (error.type) {
    case 'notATldrawFile':
      return 'That file is not a valid .tldr document.'
    case 'fileFormatVersionTooNew':
      return 'This .tldr file was created with a newer tldraw version.'
    case 'migrationFailed':
      return 'The .tldr file could not be migrated to this version.'
    case 'invalidRecords':
      return 'The .tldr file is corrupted or has invalid records.'
    case 'v1File':
      return 'Legacy v1 .tldr files are not supported in this uploader.'
    default:
      return 'Unable to open this .tldr file.'
  }
}

export default function App() {
  const [boards, setBoards] = useState([])
  const [activeBoardId, setActiveBoardId] = useState(null)
  const [isPaneCollapsed, setIsPaneCollapsed] = useState(false)
  const [isTldrDragActive, setIsTldrDragActive] = useState(false)
  const [editor, setEditor] = useState(null)
  const [boardsError, setBoardsError] = useState('')
  const fileInputRef = useRef(null)
  const skipNextUrlSyncRef = useRef(false)

  const activeBoard = useMemo(
    () => boards.find((board) => board.id === activeBoardId) ?? boards[0] ?? DEFAULT_BOARD,
    [activeBoardId, boards],
  )

  useEffect(() => {
    let isMounted = true

    fetch(`${toSyncApiBase()}/api/boards`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load boards')
        return response.json()
      })
      .then((result) => {
        if (!isMounted) return
        setBoards(result)
        setActiveBoardId((prev) => {
          if (prev && result.some((board) => board.id === prev)) return prev

          const boardIdFromUrl = getBoardIdFromUrl()
          if (boardIdFromUrl && result.some((board) => board.id === boardIdFromUrl)) {
            return boardIdFromUrl
          }

          return result[0]?.id ?? null
        })
      })
      .catch((error) => {
        if (!isMounted) return
        setBoardsError(error.message)
      })

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (boards.length === 0) return

    const nextBoardId = boards.some((board) => board.id === activeBoardId)
      ? activeBoardId
      : boards[0]?.id ?? null

    if (nextBoardId !== activeBoardId) {
      setActiveBoardId(nextBoardId)
      return
    }

    if (skipNextUrlSyncRef.current) {
      skipNextUrlSyncRef.current = false
      return
    }

    const boardIdFromUrl = getBoardIdFromUrl()
    const shouldReplace = !boardIdFromUrl || !boards.some((board) => board.id === boardIdFromUrl)
    setBoardIdInUrl(nextBoardId, { replace: shouldReplace })
  }, [activeBoardId, boards])

  useEffect(() => {
    const handlePopState = () => {
      const boardIdFromUrl = getBoardIdFromUrl()
      skipNextUrlSyncRef.current = true

      if (!boardIdFromUrl) {
        setActiveBoardId(boards[0]?.id ?? null)
        return
      }

      if (!boards.some((board) => board.id === boardIdFromUrl)) return
      setActiveBoardId(boardIdFromUrl)
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [boards])

  const syncUri = useMemo(() => {
    return `${toSyncSocketBase()}/sync/${activeBoard.roomId}`
  }, [activeBoard.roomId])

  const syncedStore = useSync({ uri: syncUri })

  const handleCreateBoard = () => {
    const name = window.prompt('Board name')
    if (!name || !name.trim()) return

    fetch(`${toSyncApiBase()}/api/boards`, {
      method: 'POST',
      headers: withAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: name.trim() }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to create board')
        return response.json()
      })
      .then((board) => {
        setBoards((prev) => [board, ...prev])
        setActiveBoardId(board.id)
      })
      .catch((error) => {
        window.alert(error.message)
      })
  }

  const handleDeleteBoard = (boardId) => {
    const board = boards.find((item) => item.id === boardId)
    if (!board) return

    if (!window.confirm(`Delete "${board.name}"?`)) return

    fetch(`${toSyncApiBase()}/api/boards/${boardId}`, {
      method: 'DELETE',
      headers: withAuthHeaders(),
    })
      .then((response) => {
        if (!response.ok && response.status !== 204) {
          throw new Error('Failed to delete board')
        }

        setBoards((prev) => {
          const remaining = prev.filter((item) => item.id !== boardId)
          setActiveBoardId((currentId) => {
            if (currentId !== boardId) return currentId
            return remaining[0]?.id ?? null
          })
          return remaining
        })
      })
      .catch((error) => {
        window.alert(error.message)
      })
  }

  const handleDownloadTldr = async () => {
    if (!editor) return

    try {
      const json = await serializeTldrawJson(editor)
      const blob = new Blob([json], { type: 'application/vnd.tldraw+json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${toSafeFileName(activeBoard.name)}.tldr`
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      window.alert('Could not export this board as .tldr')
    }
  }

  const importTldrFile = async (file) => {
    if (!editor) return

    const json = await file.text()
    const parsed = parseTldrawJsonFile({ json, schema: editor.store.schema })
    if (!parsed.ok) {
      window.alert(formatImportError(parsed.error))
      return
    }

    // Extract board name from filename (remove .tldr extension)
    const boardName = file.name.replace(/\.tldr$/i, '') || 'Imported Board'
    const snapshot = parsed.value.getStoreSnapshot()

    // Create a new board with the imported content
    fetch(`${toSyncApiBase()}/api/boards`, {
      method: 'POST',
      headers: withAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: boardName, snapshot }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to create board')
        return response.json()
      })
      .then((newBoard) => {
        setBoards((prev) => [newBoard, ...prev])
        setActiveBoardId(newBoard.id)
      })
      .catch((error) => {
        window.alert(error.message)
      })
  }

  const handleUploadChange = async (event) => {
    const [file] = event.target.files ?? []
    event.target.value = ''
    if (!file) return
    await importTldrFile(file)
  }

  const handleDragOver = (event) => {
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (!files.some((file) => file.name.toLowerCase().endsWith('.tldr'))) return

    event.preventDefault()
    setIsTldrDragActive(true)
  }

  const handleDragLeave = () => {
    setIsTldrDragActive(false)
  }

  const handleDrop = async (event) => {
    const files = Array.from(event.dataTransfer?.files ?? [])
    const file = files.find((item) => item.name.toLowerCase().endsWith('.tldr'))
    if (!file) return

    event.preventDefault()
    setIsTldrDragActive(false)
    await importTldrFile(file)
  }

  return (
    <div className={`app-shell ${isPaneCollapsed ? 'is-collapsed' : ''}`}>
      <aside className="board-pane">
        <div className="brand-block">
          {!isPaneCollapsed ? (
            <div className="brand-head">
              <span className="brand-logo" aria-hidden="true">
                t
              </span>
              <span className="brand-wordmark">tldraw</span>
            </div>
          ) : null}
          <div className="brand-controls">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setIsPaneCollapsed((prev) => !prev)}
              aria-label={isPaneCollapsed ? 'Expand boards panel' : 'Collapse boards panel'}
            >
              <svg
                className={`icon-chevron ${isPaneCollapsed ? 'is-collapsed' : ''}`}
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M6 3.5L10.5 8L6 12.5"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.75"
                />
              </svg>
            </button>
          </div>
        </div>

        {!isPaneCollapsed ? (
          <>
            <div className="pane-actions">
              <div className="pane-heading">
                <p className="brand-kicker">Today</p>
                <h1 className="brand-title">Boards</h1>
              </div>
              <div className="pane-action-row">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".tldr,application/vnd.tldraw+json"
                  className="hidden-file-input"
                  onChange={handleUploadChange}
                />
                <button type="button" className="secondary-btn" onClick={handleCreateBoard}>
                  New Board
                </button>
                <button
                  type="button"
                  className="secondary-btn secondary-btn-muted"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Upload
                </button>
              </div>
            </div>

            {boardsError ? <p className="pane-error">{boardsError}</p> : null}

            <nav className="board-list" aria-label="Boards">
              {boards.map((board) => (
                <div key={board.id} className={`board-row ${board.id === activeBoard.id ? 'is-active' : ''}`}>
                  <button
                    type="button"
                    className="board-open"
                    onClick={() => setActiveBoardId(board.id)}
                    title={board.name}
                  >
                    <span className="board-badge" aria-hidden="true">
                      {getBoardInitials(board.name)}
                    </span>
                    <span>
                      <span className="board-name">{board.name}</span>
                      <span className="board-meta">{formatRelativeTime(board.updatedAt)}</span>
                    </span>
                  </button>
                  <div className="board-actions">
                    {board.id === activeBoard.id ? (
                      <button
                        type="button"
                        className="board-download"
                        onClick={handleDownloadTldr}
                        aria-label={`Download ${board.name}`}
                        title="Download .tldr"
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path
                            d="M8 2.5v6m0 0l2.5-2.5M8 8.5L5.5 6M3 10.5v1A1.5 1.5 0 004.5 13h7A1.5 1.5 0 0013 11.5v-1"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.5"
                          />
                        </svg>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="board-delete"
                      onClick={() => handleDeleteBoard(board.id)}
                      aria-label={`Delete ${board.name}`}
                    >
                      x
                    </button>
                  </div>
                </div>
              ))}
            </nav>
          </>
        ) : null}
      </aside>

      <main className="canvas-pane">
        <header className="canvas-header">
          <div>
            <h2>{activeBoard.name}</h2>
            <p>{formatRelativeTime(activeBoard.updatedAt)}</p>
          </div>
        </header>

        <section
          className={`canvas-stage ${isTldrDragActive ? 'is-drop-active' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {syncedStore.status === 'loading' ? (
            <div className="status-card">Connecting to sync server...</div>
          ) : null}
          {syncedStore.status === 'error' ? (
            <div className="status-card error">Sync error: {syncedStore.error.message}</div>
          ) : null}
          {syncedStore.status === 'synced-remote' ? (
            <Tldraw key={activeBoard.roomId} store={syncedStore.store} onMount={setEditor} />
          ) : null}
          {isTldrDragActive ? <div className="drop-overlay">Drop .tldr file to import</div> : null}
        </section>
      </main>
    </div>
  )
}
