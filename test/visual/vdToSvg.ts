/**
 * Test-harness name of the public VectorDrawable → SVG preview (src/preview.ts), kept so the visual
 * tests, test/visual/run-corpus.ts and scripts/compare-svg2vector/compare.mjs import it unchanged.
 * The implementation stays independent of the converter (see the src/preview.ts module doc).
 *
 * The `.ts` extension lets Node load this file natively (type stripping, used by compare.mjs), which
 * does not map `.js` specifiers to `.ts` sources.
 */
// @ts-expect-error TS5097: `.ts` specifier needed by Node's native type stripping; types still resolve.
import { vectorDrawableToSvg } from '../../src/preview.ts';

// @ts-expect-error TS5097: see above.
export { parseXml, parseAndroidColor } from '../../src/preview.ts';
export type { XmlNode } from '../../src/preview.ts';

/** Converts a VectorDrawable XML string into an equivalent standalone SVG string (tint ignored, 1 dp = 1 px). */
export function vdToSvg(xml: string): string {
    return vectorDrawableToSvg(xml);
}
