// Syntax highlighting for fenced code blocks. Pure: returns a token tree, never
// markup, so the renderer can map it to React elements and user-authored code
// blocks can't inject HTML into other people's boards. (highlight.js proper
// returns an HTML string, which would force dangerouslySetInnerHTML — lowlight
// exposes the same grammars as a tree instead.)
//
// No JSX here, so this module is directly unit-testable under node --test.

import { createLowlight } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

// Grammars are registered individually rather than via lowlight/common to keep
// them out of the bundle unless listed. Each grammar brings its own aliases
// (js, ts, py, sh, yml, html...), so those resolve without being named here.
const lowlight = createLowlight({
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  php,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  typescript,
  xml,
  yaml,
})

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
 * the grammar is known, or `null` when it isn't — callers render the raw code in
 * that case. Returning the flag alongside the tree means callers don't have to
 * ask whether the language is supported as a second, separate lookup.
 */
export function highlightCode(code, language) {
  if (!language || !lowlight.registered(language)) {
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
