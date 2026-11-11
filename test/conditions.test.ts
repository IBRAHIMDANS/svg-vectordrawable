import { describe, expect, it } from 'vitest';
import { convert, ConversionError } from '../src/index.js';
import { systemLanguageIgnored } from '../src/elements.js';

const MODES = [true, false] as const;
const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const svg = (inner: string, attrs = ''): string =>
    `<svg xmlns="${SVG_NS}"${attrs} width="24" height="24" viewBox="0 0 24 24">${inner}</svg>`;
const RECT = '<rect width="24" height="24" fill="#008000"/>';
const pathCount = (xml: string): number => xml.match(/<path\b/g)?.length ?? 0;

/** The ConversionError thrown by `run`, or a failure when it does not throw one. */
function conversionError(run: () => unknown): ConversionError {
    try {
        run();
    } catch (e) {
        if (e instanceof ConversionError) return e;
        throw e;
    }
    throw new Error('expected a ConversionError');
}

describe('conditional processing on the root <svg> (SVG 2 §5.8)', () => {
    it.each(
        MODES.flatMap((optimize) =>
            [' requiredExtensions=""', ' requiredExtensions="http://example.org/bogus"', ' systemLanguage=""'].map(
                (attrs) => ({ attrs, optimize }),
            ),
        ),
    )('a failing root ($attrs) renders nothing and is reported (optimize: $optimize)', ({ attrs, optimize }) => {
        // <text> would be reported if the content were walked: only the root warning is expected.
        const doc = svg(`${RECT}<text>a</text>`, attrs);
        const { xml, warnings } = convert(doc, { optimize });
        expect(xml).toBe(convert(svg(''), { optimize }).xml); // the empty-document output
        expect(pathCount(xml)).toBe(0);
        expect(warnings.map((w) => [w.code, w.node])).toEqual([['unsupported-attribute', 'svg']]);
        expect(warnings[0]!.message).toMatch(/root <svg> fails .* nothing is rendered/);

        const error = conversionError(() => convert(doc, { optimize, strict: 'lossy' }));
        expect(error.warning.code).toBe('unsupported-attribute');
    });

    it.each(MODES)('a root requiring a supported extension is rendered silently (optimize: %s)', (optimize) => {
        const doc = svg(RECT, ` requiredExtensions="${XHTML_NS}"`);
        const { xml, warnings } = convert(doc, { optimize, strict: true });
        expect(warnings).toEqual([]);
        expect(pathCount(xml)).toBe(1);
    });

    it.each(MODES)(
        'a non-empty systemLanguage on the root is rendered and reported, like on descendants (optimize: %s)',
        (optimize) => {
            const doc = svg(RECT, ' systemLanguage="fr"');
            const { xml, warnings } = convert(doc, { optimize });
            expect(pathCount(xml)).toBe(1);
            expect(warnings.map((w) => [w.code, w.node])).toEqual([['unsupported-attribute', 'svg']]);
            expect(warnings[0]!.message).toMatch(/systemLanguage on <svg> depends on the device language/);
            expect(conversionError(() => convert(doc, { optimize, strict: 'lossy' })).warning.code).toBe(
                'unsupported-attribute',
            );
        },
    );

    it.each(MODES)(
        'the systemLanguage message is the same on the root and on descendants (optimize: %s)',
        (optimize) => {
            const onRoot = convert(svg(RECT, ' systemLanguage="fr"'), { optimize }).warnings;
            const onChild = convert(svg('<g systemLanguage="fr"><rect width="24" height="24"/></g>'), {
                optimize,
            }).warnings;
            expect(onRoot.map((w) => w.message)).toEqual([systemLanguageIgnored('svg')]);
            expect(onChild.map((w) => w.message)).toEqual(onChild.map((w) => systemLanguageIgnored(w.node!))); // svgo may collapse the <g>
            expect(onChild).toHaveLength(1);
        },
    );
});

describe('display / visibility on the root <svg>', () => {
    it.each(
        MODES.flatMap((optimize) =>
            [
                { case: 'attribute', doc: svg(`${RECT}<text>a</text>`, ' display="none"') },
                { case: 'style', doc: svg(`${RECT}<text>a</text>`, ' style="display:none"') },
                { case: 'with a failing condition', doc: svg(RECT, ' display="none" systemLanguage=""') },
                { case: 'with a systemLanguage', doc: svg(RECT, ' display="none" systemLanguage="fr"') },
            ].map((c) => ({ ...c, optimize })),
        ),
    )('display: none ($case) renders an empty <vector>, silently (optimize: $optimize)', ({ doc, optimize }) => {
        // <text> would be reported if the content were walked: no warning at all is expected.
        const { xml, warnings } = convert(doc, { optimize, strict: true });
        expect(xml).toBe(convert(svg(''), { optimize }).xml); // the empty-document output, same size
        expect(pathCount(xml)).toBe(0);
        expect(warnings).toEqual([]);
    });

    it('a root svgo drops for a reason the source does not state falls back to optimize: false', () => {
        // display: none from a <style> rule: svgo inlines it and drops the root; the unoptimized
        // conversion does not apply the CSS, and says so (as with optimize: false), instead of
        // emptying the <vector> silently.
        const ruled = svg(`<style>svg{display:none}</style>${RECT}`);
        expect(convert(ruled).warnings).toEqual(convert(ruled, { optimize: false }).warnings);
        expect(convert(ruled).warnings.map((w) => w.code)).toContain('unsupported-style');
        // svgo only looks for visible descendants by attribute: a style="visibility:visible" child of
        // a hidden root made it drop the root. The child is drawn.
        const visible = svg(`${RECT}<rect style="visibility:visible" width="4" height="4"/>`, ' visibility="hidden"');
        const { xml, warnings } = convert(visible, { strict: true });
        expect(pathCount(xml)).toBe(1);
        expect(warnings).toEqual([]);
    });

    it.each(MODES)('a root without display: none keeps its content (optimize: %s)', (optimize) => {
        expect(pathCount(convert(svg(RECT, ' display="inline"'), { optimize, strict: true }).xml)).toBe(1);
    });

    it.each(MODES)(
        'visibility: hidden on the root is inherited; a visible child is drawn (optimize: %s)',
        (optimize) => {
            const doc = svg(`${RECT}<rect visibility="visible" width="4" height="4"/>`, ' visibility="hidden"');
            const { xml, warnings } = convert(doc, { optimize, strict: true });
            expect(warnings).toEqual([]);
            expect(pathCount(xml)).toBe(1);
            expect(xml).not.toContain('#FF008000');
        },
    );
});
