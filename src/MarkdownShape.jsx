import { useMemo } from 'react'
import {
  BaseBoxShapeTool,
  BaseBoxShapeUtil,
  DefaultToolbar,
  DefaultToolbarContent,
  HTMLContainer,
  TldrawUiMenuItem,
  stopEventPropagation,
  useIsToolSelected,
  useTools,
  useValue,
} from 'tldraw'
import { MARKDOWN_SHAPE_TYPE, markdownShapeProps } from '../shared/markdownShape.js'
import { getLanguageLabel, highlightCode } from './highlight.js'
import { parseBlocks, tokenizeInline } from './markdown.js'

export { MARKDOWN_SHAPE_TYPE }
export const MARKDOWN_TOOL_ID = 'markdown'

const DEFAULT_MARKDOWN = [
  '# Note',
  '',
  'Type **markdown** here.',
  '',
  '- Double-click to edit',
  '- Drag the edges to resize',
].join('\n')

// -- Rendering ---------------------------------------------------------------
// Token trees from ./markdown.js and ./highlight.js are mapped to React
// elements. Nothing is ever passed to dangerouslySetInnerHTML: note text is
// synced to every other client, so it must not be able to inject markup.

function renderInline(nodes, keyPrefix) {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`

    switch (node.type) {
      case 'text':
        return node.value
      case 'code':
        return (
          <code key={key} className="md-inline-code">
            {node.value}
          </code>
        )
      case 'strong':
        return <strong key={key}>{renderInline(node.children, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline(node.children, key)}</em>
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            onPointerDown={stopEventPropagation}
          >
            {renderInline(node.children, key)}
          </a>
        )
      default:
        return null
    }
  })
}

function renderInlineWithBreaks(text, keyPrefix) {
  const lines = text.split('\n')
  return lines.flatMap((line, index) => {
    const rendered = renderInline(tokenizeInline(line), `${keyPrefix}-l${index}`)
    return index < lines.length - 1
      ? [...rendered, <br key={`${keyPrefix}-br${index}`} />]
      : rendered
  })
}

// lowlight emits nested <span class="hljs-*"> elements; anything else is text.
function renderHighlighted(nodes, keyPrefix) {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`

    if (node.type === 'text') return node.value

    if (node.type === 'element') {
      const className = node.properties?.className
      return (
        <span key={key} className={Array.isArray(className) ? className.join(' ') : className}>
          {renderHighlighted(node.children ?? [], key)}
        </span>
      )
    }

    return null
  })
}

function CodeBlock({ code, language }) {
  const { nodes, isHighlighted } = useMemo(() => highlightCode(code, language), [code, language])

  return (
    <div className="md-code-block">
      {language ? (
        // A header row rather than an overlay: absolutely positioning the label
        // over the block hides the tail of a long first line.
        <div className="md-code-head">
          <span className={`md-code-lang${isHighlighted ? '' : ' is-unknown'}`}>
            {getLanguageLabel(language)}
          </span>
        </div>
      ) : null}
      <pre>
        <code className="hljs">{nodes ? renderHighlighted(nodes, 'hl') : code}</code>
      </pre>
    </div>
  )
}

function MarkdownContent({ source }) {
  const blocks = useMemo(() => parseBlocks(source), [source])

  return (
    <div className="md-render">
      {blocks.map((block, index) => {
        const key = `b-${index}`

        switch (block.type) {
          case 'heading': {
            const Heading = `h${block.level}`
            return <Heading key={key}>{renderInline(tokenizeInline(block.text), key)}</Heading>
          }
          case 'hr':
            return <hr key={key} />
          case 'code':
            return <CodeBlock key={key} code={block.text} language={block.language} />
          case 'quote':
            return <blockquote key={key}>{renderInlineWithBreaks(block.text, key)}</blockquote>
          case 'ul':
            return (
              <ul key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>
                    {renderInline(tokenizeInline(item), `${key}-${itemIndex}`)}
                  </li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={key} start={block.start}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>
                    {renderInline(tokenizeInline(item), `${key}-${itemIndex}`)}
                  </li>
                ))}
              </ol>
            )
          case 'p':
          default:
            return <p key={key}>{renderInlineWithBreaks(block.text, key)}</p>
        }
      })}
    </div>
  )
}

// -- Shape util --------------------------------------------------------------

export class MarkdownShapeUtil extends BaseBoxShapeUtil {
  static type = MARKDOWN_SHAPE_TYPE

  // Shared with the sync server's schema — see shared/markdownShape.js.
  static props = markdownShapeProps

  getDefaultProps() {
    return {
      w: 320,
      h: 220,
      text: DEFAULT_MARKDOWN,
    }
  }

  canEdit() {
    return true
  }

  component(shape) {
    const editor = this.editor

    const isEditing = useValue(
      'markdown-is-editing',
      () => editor.getEditingShapeId() === shape.id,
      [editor, shape.id],
    )

    // The shape's content is inert until the shape is the only thing selected.
    // While inert, pointer events pass through to the canvas so the shape can be
    // selected and dragged like any other; once it is solely selected, its own
    // scrollbar, text selection and links become usable.
    const isOnlySelected = useValue(
      'markdown-is-only-selected',
      () => editor.getOnlySelectedShapeId() === shape.id,
      [editor, shape.id],
    )

    const isInteractive = isEditing || isOnlySelected

    return (
      <HTMLContainer
        className="md-shape"
        style={{
          width: shape.props.w,
          height: shape.props.h,
          pointerEvents: isInteractive ? 'all' : 'none',
        }}
      >
        {isEditing ? (
          <textarea
            className="md-editor"
            value={shape.props.text}
            autoFocus
            spellCheck={false}
            onChange={(event) =>
              editor.updateShape({
                id: shape.id,
                type: MARKDOWN_SHAPE_TYPE,
                props: { text: event.target.value },
              })
            }
            onPointerDown={stopEventPropagation}
            onWheelCapture={stopEventPropagation}
            onKeyDown={(event) => {
              // Escape leaves edit mode; every other key is kept away from the
              // canvas so typing doesn't fire tool shortcuts.
              if (event.key === 'Escape') {
                event.currentTarget.blur()
                editor.setEditingShape(null)
                return
              }
              event.stopPropagation()
            }}
            onFocus={(event) => {
              // One stopping point for the whole editing session, so a single
              // undo reverts the edit instead of one undo per keystroke.
              editor.markHistoryStoppingPoint('edit markdown')

              const { value } = event.currentTarget
              event.currentTarget.setSelectionRange(value.length, value.length)
            }}
          />
        ) : (
          <div
            className="md-scroll"
            // Keep the canvas from zooming when the wheel is used to scroll the
            // note's own overflow.
            onWheelCapture={isInteractive ? stopEventPropagation : undefined}
          >
            <MarkdownContent source={shape.props.text} />
          </div>
        )}
      </HTMLContainer>
    )
  }

  getIndicatorPath(shape) {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, 8)
    return path
  }
}

// -- Tool --------------------------------------------------------------------

export class MarkdownShapeTool extends BaseBoxShapeTool {
  static id = MARKDOWN_TOOL_ID
  static initial = 'idle'
  shapeType = MARKDOWN_SHAPE_TYPE
}

// -- UI wiring ---------------------------------------------------------------

const MARKDOWN_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
  '<path fill="black" d="M4 7h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm1.5 2.2v5.6h1.8v-3l1.7 2 1.7-2v3h1.8V9.2h-1.8l-1.7 2-1.7-2H5.5zm11.2 0v2.8h-1.6l2.5 3.2 2.5-3.2h-1.6V9.2h-2.3z"/>' +
  '</svg>'

export const markdownAssetUrls = {
  icons: {
    'markdown-icon': `data:image/svg+xml,${encodeURIComponent(MARKDOWN_ICON_SVG)}`,
  },
}

export const markdownUiOverrides = {
  tools(editor, tools) {
    tools[MARKDOWN_TOOL_ID] = {
      id: MARKDOWN_TOOL_ID,
      icon: 'markdown-icon',
      label: 'Markdown',
      kbd: 'm',
      onSelect: () => {
        editor.setCurrentTool(MARKDOWN_TOOL_ID)
      },
    }
    return tools
  },
}

export const markdownComponents = {
  Toolbar: (props) => {
    const tools = useTools()
    const isSelected = useIsToolSelected(tools[MARKDOWN_TOOL_ID])
    return (
      <DefaultToolbar {...props}>
        <DefaultToolbarContent />
        <TldrawUiMenuItem {...tools[MARKDOWN_TOOL_ID]} isSelected={isSelected} />
      </DefaultToolbar>
    )
  },
}
