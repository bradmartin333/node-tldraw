import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Tldraw,
  defaultBindingUtils,
  defaultShapeUtils,
  parseTldrawJsonFile,
  serializeTldrawJson,
} from 'tldraw'
import { useSync } from '@tldraw/sync'
import 'tldraw/tldraw.css'
import {
  MarkdownShapeTool,
  MarkdownShapeUtil,
  markdownAssetUrls,
  markdownComponents,
  markdownUiOverrides,
} from './MarkdownShape.jsx'

// <Tldraw> merges these with its defaults, so it takes the custom utils only.
const customShapeUtils = [MarkdownShapeUtil]
const customTools = [MarkdownShapeTool]

// useSync does NOT merge: it builds the store schema from exactly what it is
// given. It must receive the defaults alongside the custom utils, or the
// built-in shapes drop out of the schema and their migrations break.
const syncShapeUtils = [...defaultShapeUtils, MarkdownShapeUtil]

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
const BOARDS_REFRESH_INTERVAL_MS = 15000
const RELATIVE_TIME_REFRESH_INTERVAL_MS = 30000
const BOARD_TOUCH_THROTTLE_MS = 5000
const LOGO_LIGHT_URL = '/assets/light.webp'
const LOGO_DARK_URL = '/assets/dark.webp'
const BRAND_LOGO_WIDTH_PX = 200

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
  const [editingBoardId, setEditingBoardId] = useState(null)
  const [editingBoardName, setEditingBoardName] = useState('')
  const [isRenamingBoard, setIsRenamingBoard] = useState(false)
  const [isPaneCollapsed, setIsPaneCollapsed] = useState(false)
  const [isTldrDragActive, setIsTldrDragActive] = useState(false)
  const [isBoardPreparing, setIsBoardPreparing] = useState(true)
  const [editor, setEditor] = useState(null)
  const [boardsError, setBoardsError] = useState('')
  const [boardSearchQuery, setBoardSearchQuery] = useState('')
  const [isNewBoardMenuOpen, setIsNewBoardMenuOpen] = useState(false)
  const [newBoardMenuPosition, setNewBoardMenuPosition] = useState({ x: 0, y: 0 })
  const [, setRelativeTimeNow] = useState(Date.now())
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const stored = localStorage.getItem('tldraw-color-scheme')
    if (stored === 'dark') return true
    return false
  })
  const fileInputRef = useRef(null)
  const newBoardButtonRef = useRef(null)
  const newBoardMenuRef = useRef(null)
  const skipNextUrlSyncRef = useRef(false)
  const boardTouchThrottleRef = useRef({ boardId: null, lastTouchedAt: 0 })

  const sortedBoards = useMemo(() => {
    return [...boards].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [boards])

  const filteredBoards = useMemo(() => {
    const query = boardSearchQuery.trim().toLowerCase()
    if (!query) return sortedBoards
    return sortedBoards.filter((board) => board.name.toLowerCase().includes(query))
  }, [boardSearchQuery, sortedBoards])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDarkMode ? 'dark' : 'light')
    localStorage.setItem('tldraw-color-scheme', isDarkMode ? 'dark' : 'light')
  }, [isDarkMode])

  useEffect(() => {
    if (!editor) return
    editor.user.updateUserPreferences({ colorScheme: isDarkMode ? 'dark' : 'light' })
  }, [editor, isDarkMode])

  const activeBoard = useMemo(
    () => boards.find((board) => board.id === activeBoardId) ?? sortedBoards[0] ?? DEFAULT_BOARD,
    [activeBoardId, boards, sortedBoards],
  )

  const loadBoards = useCallback(({ preserveActiveSelection = true, clearErrors = false } = {}) => {
    return fetch(`${toSyncApiBase()}/api/boards`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load boards')
        return response.json()
      })
      .then((result) => {
        setBoards(result)
        if (clearErrors) {
          setBoardsError('')
        }

        setActiveBoardId((prev) => {
          if (preserveActiveSelection && prev && result.some((board) => board.id === prev)) {
            return prev
          }

          const boardIdFromUrl = getBoardIdFromUrl()
          if (boardIdFromUrl && result.some((board) => board.id === boardIdFromUrl)) {
            return boardIdFromUrl
          }

          const sorted = [...result].sort((a, b) => b.updatedAt - a.updatedAt)
          return sorted[0]?.id ?? null
        })
      })
  }, [])

  useEffect(() => {
    let isMounted = true

    loadBoards({ preserveActiveSelection: false, clearErrors: true })
      .then(() => {
        if (!isMounted) return
      })
      .catch((error) => {
        if (!isMounted) return
        setBoardsError(error.message)
      })

    return () => {
      isMounted = false
    }
  }, [loadBoards])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setRelativeTimeNow(Date.now())
    }, RELATIVE_TIME_REFRESH_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      loadBoards({ preserveActiveSelection: true, clearErrors: false }).catch(() => {
        // Keep the last successful snapshot if background refresh fails.
      })
    }, BOARDS_REFRESH_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadBoards])

  useEffect(() => {
    if (boards.length === 0) return

    const nextBoardId = boards.some((board) => board.id === activeBoardId)
      ? activeBoardId
      : sortedBoards[0]?.id ?? null

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
  }, [activeBoardId, boards, sortedBoards])

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

  useEffect(() => {
    if (!isNewBoardMenuOpen) return undefined

    const handlePointerDown = (event) => {
      const target = event.target
      if (newBoardMenuRef.current?.contains(target)) return
      if (newBoardButtonRef.current?.contains(target)) return
      setIsNewBoardMenuOpen(false)
    }

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setIsNewBoardMenuOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [isNewBoardMenuOpen])

  const openNewBoardContextMenu = useCallback((event) => {
    event.preventDefault()
    event.stopPropagation()

    const menuWidth = 160
    const menuHeight = 44
    const maxX = Math.max(8, window.innerWidth - menuWidth - 8)
    const maxY = Math.max(8, window.innerHeight - menuHeight - 8)

    setNewBoardMenuPosition({
      x: Math.min(event.clientX, maxX),
      y: Math.min(event.clientY, maxY),
    })
    setIsNewBoardMenuOpen(true)
  }, [])

  const syncUri = useMemo(() => {
    return `${toSyncSocketBase()}/sync/${activeBoard.roomId}`
  }, [activeBoard.roomId])

  const syncedStore = useSync({
    uri: syncUri,
    shapeUtils: syncShapeUtils,
    bindingUtils: defaultBindingUtils,
  })

  const fitBoardToUsedArea = useCallback(
    ({ preferSelection = false, animate = true, editorInstance } = {}) => {
      const targetEditor = editorInstance ?? editor
      if (!targetEditor) return

      const cameraOptions = animate
        ? {
          animation: {
            duration: 220,
          },
        }
        : {
          animation: {
            duration: 0,
          },
        }

      const selectedShapeIds = Array.from(targetEditor.getSelectedShapeIds?.() ?? [])

      if (preferSelection && selectedShapeIds.length > 0) {
        targetEditor.zoomToSelection?.(cameraOptions)
        return
      }

      const usedShapeIds = Array.from(targetEditor.getCurrentPageShapeIds?.() ?? [])
      if (usedShapeIds.length === 0) return

      targetEditor.zoomToFit?.(cameraOptions)
    },
    [editor],
  )

  useEffect(() => {
    setIsBoardPreparing(true)
  }, [activeBoard.roomId])

  const handleEditorMount = useCallback(
    (nextEditor) => {
      setEditor(nextEditor)
      fitBoardToUsedArea({ preferSelection: false, animate: false, editorInstance: nextEditor })

      window.requestAnimationFrame(() => {
        setIsBoardPreparing(false)
      })
    },
    [fitBoardToUsedArea],
  )

  useEffect(() => {
    if (syncedStore.status !== 'synced-remote') {
      setIsBoardPreparing(true)
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      setIsBoardPreparing(false)
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [syncedStore.status])

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
        setBoardsError('')
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

  const startRenamingBoard = (board) => {
    setActiveBoardId(board.id)
    setEditingBoardId(board.id)
    setEditingBoardName(board.name)
  }

  const cancelRenamingBoard = () => {
    setEditingBoardId(null)
    setEditingBoardName('')
  }

  const submitRenamingBoard = (board) => {
    if (isRenamingBoard) return

    const nextName = editingBoardName.trim()

    if (!nextName) {
      window.alert('Board name cannot be empty')
      return
    }

    if (nextName === board.name) {
      cancelRenamingBoard()
      return
    }

    setIsRenamingBoard(true)

    fetch(`${toSyncApiBase()}/api/boards/${board.id}`, {
      method: 'PATCH',
      headers: withAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: nextName }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to rename board')
        return response.json()
      })
      .then((updatedBoard) => {
        setBoards((prev) =>
          prev.map((item) => {
            if (item.id !== updatedBoard.id) return item
            return updatedBoard
          }),
        )
        cancelRenamingBoard()
      })
      .catch((error) => {
        window.alert(error.message)
      })
      .finally(() => {
        setIsRenamingBoard(false)
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

  const touchBoard = useCallback((boardId) => {
    return fetch(`${toSyncApiBase()}/api/boards/${boardId}/touch`, {
      method: 'POST',
      headers: withAuthHeaders(),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to update board activity')
        return response.json()
      })
      .then((updatedBoard) => {
        setBoards((prev) => prev.map((item) => (item.id === updatedBoard.id ? updatedBoard : item)))
      })
      .catch(() => {
        // Ignore touch errors to keep drawing interactions uninterrupted.
      })
  }, [])

  useEffect(() => {
    if (!editor || !activeBoard.id || syncedStore.status !== 'synced-remote') return undefined

    const unsubscribe = editor.store.listen(() => {
      const now = Date.now()
      const { boardId, lastTouchedAt } = boardTouchThrottleRef.current

      if (boardId === activeBoard.id && now - lastTouchedAt < BOARD_TOUCH_THROTTLE_MS) return

      boardTouchThrottleRef.current = { boardId: activeBoard.id, lastTouchedAt: now }
      touchBoard(activeBoard.id)
    }, { source: 'user', scope: 'document' })

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe()
      }
    }
  }, [activeBoard.id, editor, syncedStore.status, touchBoard])

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
              <img
                src={isDarkMode ? LOGO_DARK_URL : LOGO_LIGHT_URL}
                alt="Brand"
                className="app-brand-logo"
                style={{ '--app-brand-logo-width': `${BRAND_LOGO_WIDTH_PX}px` }}
              />
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
              <div className="pane-action-row">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".tldr,application/vnd.tldraw+json"
                  className="hidden-file-input"
                  onChange={handleUploadChange}
                />
                <button
                  ref={newBoardButtonRef}
                  type="button"
                  className="secondary-btn"
                  onMouseDown={(event) => {
                    if (event.button === 2) {
                      openNewBoardContextMenu(event)
                    }
                  }}
                  onContextMenu={openNewBoardContextMenu}
                  onClick={handleCreateBoard}
                >
                  New Board
                </button>
              </div>
              <input
                type="search"
                className="board-search"
                placeholder="Search boards"
                aria-label="Search boards"
                value={boardSearchQuery}
                onChange={(event) => setBoardSearchQuery(event.target.value)}
              />
            </div>

            {isNewBoardMenuOpen ? (
              <div
                ref={newBoardMenuRef}
                className="context-menu"
                style={{ left: `${newBoardMenuPosition.x}px`, top: `${newBoardMenuPosition.y}px` }}
                role="menu"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="context-menu-item"
                  onClick={() => {
                    setIsNewBoardMenuOpen(false)
                    fileInputRef.current?.click()
                  }}
                  role="menuitem"
                >
                  Upload
                </button>
              </div>
            ) : null}

            {boardsError ? <p className="pane-error">{boardsError}</p> : null}

            <nav className="board-list" aria-label="Boards">
              {filteredBoards.map((board) => (
                <div key={board.id} className={`board-row ${board.id === activeBoard.id ? 'is-active' : ''}`}>
                  <div
                    className="board-open"
                    onClick={() => setActiveBoardId(board.id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return

                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setActiveBoardId(board.id)
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    title={board.name}
                  >
                    <span className="board-details">
                      {editingBoardId === board.id ? (
                        <input
                          type="text"
                          className="board-name-input"
                          value={editingBoardName}
                          onChange={(event) => setEditingBoardName(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            event.stopPropagation()

                            if (event.key === 'Enter') {
                              event.preventDefault()
                              submitRenamingBoard(board)
                            }

                            if (event.key === 'Escape') {
                              event.preventDefault()
                              cancelRenamingBoard()
                            }
                          }}
                          onBlur={() => {
                            if (!isRenamingBoard) {
                              submitRenamingBoard(board)
                            }
                          }}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="board-name"
                          onClick={(event) => {
                            if (board.id !== activeBoard.id) return

                            event.stopPropagation()
                            startRenamingBoard(board)
                          }}
                        >
                          {board.name}
                        </span>
                      )}
                      <span className="board-meta">{formatRelativeTime(board.updatedAt)}</span>
                    </span>
                  </div>
                  <div className="board-actions">
                    <button
                      type="button"
                      className={`board-download ${board.id === activeBoard.id ? '' : 'is-hidden'}`}
                      onClick={handleDownloadTldr}
                      aria-label={`Download ${board.name}`}
                      title="Download .tldr"
                      disabled={board.id !== activeBoard.id}
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
          <div className="canvas-controls">
            <button
              type="button"
              className="secondary-btn"
              onClick={() => fitBoardToUsedArea({ preferSelection: true })}
              disabled={!editor}
              title="Fit selection or used area"
            >
              Zoom To Fit
            </button>
            <button
              type="button"
              className="icon-btn theme-toggle-btn"
              onClick={() => setIsDarkMode((prev) => !prev)}
              aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDarkMode ? (
                <svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16">
                  <circle cx="8" cy="8" r="3" fill="currentColor" />
                  <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16">
                  <path d="M13.5 9.5A5.5 5.5 0 016.5 2.5a5.5 5.5 0 100 11 5.5 5.5 0 007-4z" fill="currentColor" />
                </svg>
              )}
            </button>
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
            <div className={`canvas-editor-shell ${isBoardPreparing ? 'is-preparing' : ''}`}>
              <Tldraw
                key={activeBoard.roomId}
                store={syncedStore.store}
                onMount={handleEditorMount}
                shapeUtils={customShapeUtils}
                tools={customTools}
                overrides={markdownUiOverrides}
                components={markdownComponents}
                assetUrls={markdownAssetUrls}
              />
            </div>
          ) : null}
          {isTldrDragActive ? <div className="drop-overlay">Drop .tldr file to import</div> : null}
        </section>
      </main>
    </div>
  )
}
