import type { TextLayout } from './context.js';

// Stands in for src/text.ts in the browser builds (tsup.config.ts): drawing text needs font files
// and opentype.js, loaded synchronously the Node way, so the browser bundles carry neither.

/** The `fonts` option is not available in the browser builds: a TypeError, not a silent skip. */
export function textLayout(_fonts: Record<string, string | Uint8Array>): TextLayout {
    throw new TypeError(
        'The fonts option (<text> as glyph outlines) is only available in the Node build of svg-vectordrawable.',
    );
}
