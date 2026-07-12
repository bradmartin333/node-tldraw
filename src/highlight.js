// Syntax highlighting for fenced code blocks. Pure: returns a token tree, never
// markup, so the renderer can map it to React elements and user-authored code
// blocks can't inject HTML into other people's boards. (highlight.js proper
// returns an HTML string, which would force dangerouslySetInnerHTML — lowlight
// exposes the same grammars as a tree instead.)
//
// The grammars themselves live in ./highlightLanguages.js behind a dynamic
// import: they are the heaviest part of the app bundle by far, and most boards
// never render a code block. Callers kick off loadHighlighter() and re-render
// when it resolves; until then highlightCode degrades to un-highlighted code.
//
// No JSX here, so this module is directly unit-testable under node --test.

let lowlight = null
let loadPromise = null

/** Load lowlight + all grammars. Idempotent; resolves once they're ready. */
export function loadHighlighter() {
  loadPromise ??= import('./highlightLanguages.js').then((mod) => {
    lowlight = mod.lowlight
    return lowlight
  })
  return loadPromise
}

export function isHighlighterLoaded() {
  return lowlight !== null
}

// Null-prototype: a plain object literal would resolve fence tags that collide
// with Object.prototype members — ```__proto__ would return Object.prototype and
// ```constructor a function, both of which blow up when rendered as a React child.
const LANGUAGE_LABELS = Object.assign(Object.create(null), {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  dockerfile: 'Dockerfile',
  go: 'Go',
  html: 'HTML',
  ini: 'INI',
  java: 'Java',
  javascript: 'JavaScript',
  js: 'JavaScript',
  json: 'JSON',
  jsx: 'JSX',
  markdown: 'Markdown',
  md: 'Markdown',
  php: 'PHP',
  python: 'Python',
  py: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  sh: 'Shell',
  shell: 'Shell',
  sql: 'SQL',
  toml: 'TOML',
  ts: 'TypeScript',
  tsx: 'TSX',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
  yml: 'YAML',
})

export function getLanguageLabel(language) {
  if (!language) return ''
  return LANGUAGE_LABELS[language] ?? language.toUpperCase()
}

/**
 * Highlight `code` as `language`.
 *
 * Returns `{ nodes, isHighlighted }`. `nodes` is a lowlight/hast token tree when
 * the grammar is known AND the highlighter has finished loading, or `null`
 * otherwise — callers render the raw code in that case. Returning the flag
 * alongside the tree means callers don't have to ask whether the language is
 * supported as a second, separate lookup.
 */
export function highlightCode(code, language) {
  if (!lowlight || !language || !lowlight.registered(language)) {
    return { nodes: null, isHighlighted: false }
  }

  try {
    const tree = lowlight.highlight(language, code)
    return { nodes: tree.children ?? [], isHighlighted: true }
  } catch {
    // A grammar that throws on pathological input shouldn't take the note down.
    return { nodes: null, isHighlighted: false }
  }
}
