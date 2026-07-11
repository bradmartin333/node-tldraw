import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseBlocks, sanitizeUrl, tokenizeInline } from '../src/markdown.js'
import { getLanguageLabel, highlightCode } from '../src/highlight.js'

// -- sanitizeUrl -------------------------------------------------------------

test('sanitizeUrl allows http, https and mailto', () => {
  assert.equal(sanitizeUrl('https://example.com'), 'https://example.com')
  assert.equal(sanitizeUrl('http://example.com'), 'http://example.com')
  assert.equal(sanitizeUrl('HTTPS://Example.com'), 'HTTPS://Example.com')
  assert.equal(sanitizeUrl('mailto:a@b.com'), 'mailto:a@b.com')
})

test('sanitizeUrl allows same-origin relative targets', () => {
  assert.equal(sanitizeUrl('/boards/x'), '/boards/x')
  assert.equal(sanitizeUrl('#anchor'), '#anchor')
})

test('sanitizeUrl rejects script-bearing schemes', () => {
  assert.equal(sanitizeUrl('javascript:alert(1)'), null)
  assert.equal(sanitizeUrl('  javascript:alert(1)'), null)
  assert.equal(sanitizeUrl('JaVaScRiPt:alert(1)'), null)
  assert.equal(sanitizeUrl('data:text/html,<script>'), null)
  assert.equal(sanitizeUrl('vbscript:x'), null)
})

test('sanitizeUrl rejects protocol-relative URLs that resolve off-origin', () => {
  assert.equal(sanitizeUrl('//evil.com'), null)
})

test('a link with a rejected target degrades to literal text, not an href', () => {
  const nodes = tokenizeInline('[click](javascript:alert(1))')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].type, 'text')
  assert.ok(!nodes.some((node) => node.type === 'link'))
})

// -- emphasis ----------------------------------------------------------------

test('underscores inside identifiers are not emphasis', () => {
  const nodes = tokenizeInline('board_id and user_name')
  assert.deepEqual(nodes, [{ type: 'text', value: 'board_id and user_name' }])
})

test('underscores at word boundaries are still emphasis', () => {
  assert.deepEqual(tokenizeInline('_hi_'), [
    { type: 'em', children: [{ type: 'text', value: 'hi' }] },
  ])
  assert.deepEqual(tokenizeInline('__hi__'), [
    { type: 'strong', children: [{ type: 'text', value: 'hi' }] },
  ])
})

test('asterisk emphasis prefers strong over em at the same offset', () => {
  assert.deepEqual(tokenizeInline('**bold**'), [
    { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
  ])
  assert.deepEqual(tokenizeInline('*it*'), [
    { type: 'em', children: [{ type: 'text', value: 'it' }] },
  ])
})

test('inline code shields its contents from emphasis parsing', () => {
  const nodes = tokenizeInline('`a_b_c`')
  assert.deepEqual(nodes, [{ type: 'code', value: 'a_b_c' }])
})

test('tokenizeInline terminates on unbalanced delimiters', () => {
  // Guards the scanner against a zero-length match looping forever.
  for (const input of ['**', '`', '_', '*a', '[x](', '___']) {
    assert.ok(Array.isArray(tokenizeInline(input)))
  }
})

// -- blocks ------------------------------------------------------------------

test('parseBlocks captures the fence language', () => {
  const [block] = parseBlocks('```css\n.a { color: red; }\n```')
  assert.equal(block.type, 'code')
  assert.equal(block.language, 'css')
  assert.equal(block.text, '.a { color: red; }')
})

test('parseBlocks handles a bare fence and an unterminated fence', () => {
  assert.equal(parseBlocks('```\nx\n```')[0].language, '')
  assert.deepEqual(parseBlocks('```js\nx').at(0), { type: 'code', language: 'js', text: 'x' })
})

test('parseBlocks preserves an ordered list that does not start at 1', () => {
  const [block] = parseBlocks('3. c\n4. d')
  assert.equal(block.type, 'ol')
  assert.equal(block.start, 3)
  assert.deepEqual(block.items, ['c', 'd'])
})

test('parseBlocks distinguishes a rule from a list item', () => {
  assert.equal(parseBlocks('---')[0].type, 'hr')
  assert.equal(parseBlocks('- a')[0].type, 'ul')
})

test('parseBlocks tolerates empty and nullish input', () => {
  assert.deepEqual(parseBlocks(''), [])
  assert.deepEqual(parseBlocks(undefined), [])
})

// -- highlighting ------------------------------------------------------------

test('getLanguageLabel does not resolve Object.prototype members', () => {
  // A plain object literal would return Object.prototype / a function here, and
  // rendering either as a React child throws.
  for (const tag of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(typeof getLanguageLabel(tag), 'string', `${tag} must yield a string`)
  }
  assert.equal(getLanguageLabel('constructor'), 'CONSTRUCTOR')
})

test('getLanguageLabel maps known tags and uppercases unknown ones', () => {
  assert.equal(getLanguageLabel('js'), 'JavaScript')
  assert.equal(getLanguageLabel('css'), 'CSS')
  assert.equal(getLanguageLabel('wat'), 'WAT')
  assert.equal(getLanguageLabel(''), '')
})

test('highlightCode reports unknown languages instead of throwing', () => {
  assert.deepEqual(highlightCode('x', 'nope'), { nodes: null, isHighlighted: false })
  assert.deepEqual(highlightCode('x', ''), { nodes: null, isHighlighted: false })
  assert.deepEqual(highlightCode('x', '__proto__'), { nodes: null, isHighlighted: false })
})

test('highlightCode tokenizes a known language', () => {
  const { nodes, isHighlighted } = highlightCode('.a { color: red; }', 'css')
  assert.equal(isHighlighted, true)

  const classes = new Set()
  const walk = (node) => {
    if (node.type === 'element') {
      for (const name of node.properties?.className ?? []) classes.add(name)
    }
    for (const child of node.children ?? []) walk(child)
  }
  nodes.forEach(walk)

  assert.ok(classes.has('hljs-selector-class'))
  assert.ok(classes.has('hljs-attribute'))
})

test('grammar aliases resolve', () => {
  for (const alias of ['js', 'ts', 'py', 'sh', 'yml', 'html']) {
    assert.equal(highlightCode('x', alias).isHighlighted, true, `${alias} should highlight`)
  }
})
