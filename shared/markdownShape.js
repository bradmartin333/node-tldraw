// Single source of truth for the markdown shape's schema.
//
// Imported by BOTH the browser client (src/MarkdownShape.jsx) and the Node sync
// server (server/sync-server.cjs). The sync server validates every incoming
// record against its schema, so if the two sides disagree on these props the
// server rejects markdown shapes with INVALID_RECORD. Keep this file free of
// React and DOM imports so Node can load it.

import { T } from '@tldraw/validate'

export const MARKDOWN_SHAPE_TYPE = 'markdown'

export const markdownShapeProps = {
  w: T.number,
  h: T.number,
  text: T.string,
}
