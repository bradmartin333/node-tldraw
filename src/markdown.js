// Pure markdown parser: text in, plain token objects out. No React, no DOM.
//
// Kept free of JSX so it can be unit-tested directly (see test/markdown.test.js)
// and so the rendering layer stays a dumb token -> element mapping. Tokens are
// never HTML strings, so the renderer can escape everything via React and user
// content can't inject markup into other people's boards.

// Emphasis rules. Ordered: earliest match in the text wins, and ties are broken
// by position in this list, so `code` shields its contents from the others and
// `**strong**` is preferred over `*em*` at the same offset.
//
// The underscore variants use lookarounds to require non-word boundaries.
// Without them `_` matches inside identifiers and `board_id and user_name`
// renders as "board<em>id and user</em>name". CommonMark forbids intraword `_`
// emphasis for exactly this reason; `*` has no such restriction.
// The `g` flag is load-bearing: the tokenizer seeks via `lastIndex` instead of
// slicing the input for every match, which kept re-scanning the whole tail and
// made long paragraphs quadratic to tokenize.
const INLINE_RULES = [
  { type: 'code', re: /`([^`]+?)`/g },
  { type: 'strong', re: /\*\*([^*]+?)\*\*/g },
  { type: 'strong', re: /(?<![\w_])__([^_]+?)__(?![\w_])/g },
  { type: 'link', re: /\[([^\]]+?)\]\(([^)]+?)\)/g },
  { type: 'em', re: /\*([^*]+?)\*/g },
  { type: 'em', re: /(?<![\w_])_([^_]+?)_(?![\w_])/g },
]

/**
 * Allowlist link targets. Anything not matched renders as literal text rather
 * than a link, so `javascript:` and friends can never reach an href.
 */
export function sanitizeUrl(url) {
  const trimmed = String(url ?? '').trim()

  // Browsers ignore ASCII control chars / whitespace in hrefs, which can be used
  // to smuggle `javascript:` past a naive prefix check (e.g. `java\nscript:`).
  if (!trimmed || /[\u0000-\u001F\u007F\s]/.test(trimmed)) return null

  // Protocol-relative `//host` looks relative but resolves off-origin, so it
  // has to be rejected before the relative-path check below.
  if (/^\/\//.test(trimmed)) return null

  if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return trimmed
  if (/^[/#]/.test(trimmed)) return trimmed

  return null
}

/**
 * Tokenize inline markdown into a tree of
 * {type:'text'|'code'|'strong'|'em'|'link'} nodes.
 */
export function tokenizeInline(text) {
  const nodes = []
  let cursor = 0

  const pushText = (value) => {
    if (!value) return
    const last = nodes[nodes.length - 1]
    if (last?.type === 'text') last.value += value
    else nodes.push({ type: 'text', value })
  }

  // Per-rule cache of the next match at or beyond the cursor. A cached match is
  // still valid after the cursor moves past other rules' matches (the text is
  // immutable), so each rule scans the input at most once end-to-end instead of
  // re-scanning the tail after every emitted token. `undefined` = not looked
  // yet, `null` = no further matches.
  const nextMatch = new Array(INLINE_RULES.length).fill(undefined)

  while (cursor < text.length) {
    let best = null

    for (let i = 0; i < INLINE_RULES.length; i++) {
      let match = nextMatch[i]

      if (match === undefined || (match !== null && match.index < cursor)) {
        const re = INLINE_RULES[i].re
        re.lastIndex = cursor
        match = re.exec(text)
        nextMatch[i] = match
      }

      // Ties break by rule order (strict <), so `code` still shields its
      // contents and `**strong**` still beats `*em*` at the same offset.
      if (match && (best === null || match.index < best.match.index)) {
        best = { rule: INLINE_RULES[i], match }
      }
    }

    if (!best) {
      pushText(text.slice(cursor))
      break
    }

    const { rule, match } = best
    pushText(text.slice(cursor, match.index))

    if (rule.type === 'code') {
      nodes.push({ type: 'code', value: match[1] })
    } else if (rule.type === 'link') {
      const href = sanitizeUrl(match[2])
      // A rejected target degrades to the literal source text, not a dead link.
      if (href) nodes.push({ type: 'link', href, children: tokenizeInline(match[1]) })
      else pushText(match[0])
    } else {
      nodes.push({ type: rule.type, children: tokenizeInline(match[1]) })
    }

    cursor = match.index + match[0].length
  }

  return nodes
}

const isUnorderedItem = (line) => /^\s*[-*+]\s+/.test(line)
const isOrderedItem = (line) => /^\s*\d+\.\s+/.test(line)
const isFence = (line) => /^```/.test(line.trim())
const isHeading = (line) => /^#{1,6}\s+/.test(line)
const isQuote = (line) => /^>\s?/.test(line)

/**
 * Parse markdown into block tokens. Inline content is left as raw strings for
 * the caller to run through tokenizeInline.
 */
export function parseBlocks(markdown) {
  const lines = String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (isFence(line)) {
      // ```css -> language tag, drives highlighting and the block's label.
      const language = line.trim().slice(3).trim().toLowerCase()
      const buffer = []
      i++
      while (i < lines.length && !isFence(lines[i])) {
        buffer.push(lines[i])
        i++
      }
      i++ // consume the closing fence (a no-op if the fence was never closed)
      blocks.push({ type: 'code', language, text: buffer.join('\n') })
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      i++
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    if (isQuote(line)) {
      const buffer = []
      while (i < lines.length && isQuote(lines[i])) {
        buffer.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', text: buffer.join('\n') })
      continue
    }

    if (isUnorderedItem(line)) {
      const items = []
      while (i < lines.length && isUnorderedItem(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    if (isOrderedItem(line)) {
      const items = []
      // Preserve the first number so a list starting at 3. renders as 3, 4, 5.
      const start = Number(/^\s*(\d+)\./.exec(line)[1])
      while (i < lines.length && isOrderedItem(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push({ type: 'ol', start, items })
      continue
    }

    const buffer = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !isHeading(lines[i]) &&
      !isFence(lines[i]) &&
      !isQuote(lines[i]) &&
      !isUnorderedItem(lines[i]) &&
      !isOrderedItem(lines[i])
    ) {
      buffer.push(lines[i])
      i++
    }
    blocks.push({ type: 'p', text: buffer.join('\n') })
  }

  return blocks
}
