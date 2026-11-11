import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { failsConditions, foreignElements } from '../src/elements.js';
import type { XastElement } from '../src/ast.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';
import { vdToSvg } from './visual/vdToSvg.js';

const MODES = [true, false] as const;
const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const svg = (inner: string, attrs = ''): string =>
    `<svg xmlns="${SVG_NS}"${attrs} width="24" height="24" viewBox="0 0 24 24">${inner}</svg>`;
const RECT = '<rect width="24" height="24" fill="#008000"/>';

const repro = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`wpt-repro/${name}`, import.meta.url)), 'utf8');
const codes = (doc: string, optimize: boolean): string[] => convert(doc, { optimize }).warnings.map((w) => w.code);
const pathCount = (xml: string): number => xml.match(/<path\b/g)?.length ?? 0;

describe('elements outside the SVG namespace are not rendered', () => {
    it.each(MODES)(
        'wpt <h:link> is skipped silently: strict converts it like its source (optimize: %s)',
        (optimize) => {
            const doc = repro('wpt-foreign-element.svg');
            const { xml, warnings } = convert(doc, { optimize, strict: true });
            expect(warnings).toEqual([]);
            expect(xml).not.toContain('link');
            const result = compareSvgs(doc, vdToSvg(xml));
            expect(result.sizeMismatch).toBeNull();
            expect(result.inked).toBeGreaterThan(0);
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        },
    );

    it.each(MODES)('skips a foreign subtree, its SVG-looking children included (optimize: %s)', (optimize) => {
        const doc = svg(
            `<h:div><rect width="4" height="4"/></h:div>` +
                `<foo xmlns="http://example.org/ns"><rect width="4" height="4"/></foo>` +
                `<sodipodi:namedview xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"/>` +
                RECT,
            ` xmlns:h="${XHTML_NS}"`,
        );
        const { xml, warnings } = convert(doc, { optimize, strict: true });
        expect(warnings).toEqual([]);
        expect(pathCount(xml)).toBe(1);
    });

    it.each(MODES)(
        'still reports a prefixed element of the SVG namespace (never dropped silently) (optimize: %s)',
        (optimize) => {
            const doc = svg('<s:rect width="4" height="4"/>', ` xmlns:s="${SVG_NS}"`);
            expect(codes(doc, optimize)).toEqual(['empty-path']);
        },
    );
});

describe('non-rendering SVG elements are skipped without a warning', () => {
    it.each(MODES)('<view>, <cursor>, SVG fonts, <color-profile>, <hatch> (optimize: %s)', (optimize) => {
        const doc = svg(
            '<view id="v" viewBox="0 0 12 12"/><cursor x="0" y="0" href="c.png"/>' +
                '<font horiz-adv-x="1"><font-face font-family="F"/><glyph unicode="a" d="M0 0h1v1z"/></font>' +
                '<font-face font-family="G"/><color-profile name="p" href="p.icc"/>' +
                '<hatch id="h"><hatchpath d="M0 0h1"/></hatch>' +
                RECT,
        );
        const { xml, warnings } = convert(doc, { optimize, strict: true });
        expect(warnings).toEqual([]);
        expect(pathCount(xml)).toBe(1);
    });

    it.each(MODES)('an unsupported element under display:none is not reported (optimize: %s)', (optimize) => {
        expect(codes(svg(`<image display="none" href="a.png" width="4" height="4"/>${RECT}`), optimize)).toEqual([]);
    });
});

describe('SMIL animation elements are reported', () => {
    it.each(MODES)('<animate> inside a <path> → unsupported-element, strict rejects (optimize: %s)', (optimize) => {
        const doc = svg(
            '<path d="M0 0h24v24H0z" fill="#f00"><animate attributeName="fill" to="#0f0" dur="1s"/></path>',
        );
        expect(codes(doc, optimize)).toEqual(['unsupported-element']);
        expect(() => convert(doc, { optimize, strict: true })).toThrow(/<animate> cannot be represented/);
    });

    it.each(MODES)('<set> inside a shape, <animateTransform> in a group (optimize: %s)', (optimize) => {
        const doc = svg(
            '<rect width="4" height="4"><set attributeName="fill" to="green" begin="0"/></rect>' +
                '<g><animateTransform attributeName="transform" type="rotate" to="90"/><rect width="2" height="2"/></g>',
        );
        const { warnings } = convert(doc, { optimize });
        expect(warnings.map((w) => [w.code, w.node])).toEqual([
            ['unsupported-element', 'set'],
            ['unsupported-element', 'animateTransform'],
        ]);
    });
});

describe('conditional processing (SVG 2 §5.8)', () => {
    it.each(MODES)('wpt requiredExtensions="" → the element is not rendered (optimize: %s)', (optimize) => {
        const { xml, warnings } = convert(repro('wpt-required-extensions-empty.svg'), { optimize, strict: true });
        expect(warnings).toEqual([]);
        expect(pathCount(xml)).toBe(0);
    });

    it.each(MODES)(
        'an unknown extension excludes a group and its subtree, unsupported content included (optimize: %s)',
        (optimize) => {
            const doc = svg(
                `<g requiredExtensions="http://example.org/bogus"><rect width="4" height="4"/><text>a</text></g>` +
                    `<text requiredExtensions="">b</text>${RECT}`,
            );
            const { xml, warnings } = convert(doc, { optimize, strict: true });
            expect(warnings).toEqual([]);
            expect(pathCount(xml)).toBe(1);
        },
    );

    it.each(MODES)(
        'the XHTML / MathML extensions are supported (rendered, like browsers) (optimize: %s)',
        (optimize) => {
            const doc = svg(
                `<rect width="24" height="24" requiredExtensions="${XHTML_NS} http://www.w3.org/1998/Math/MathML"/>`,
            );
            expect(pathCount(convert(doc, { optimize, strict: true }).xml)).toBe(1);
        },
    );

    it.each(MODES)(
        'systemLanguage="" is never rendered; another value is rendered and reported (optimize: %s)',
        (optimize) => {
            const doc = svg(
                '<rect width="4" height="4" systemLanguage=""/><rect x="8" width="4" height="4" systemLanguage="fr"/>',
            );
            const { xml, warnings } = convert(doc, { optimize });
            expect(pathCount(xml)).toBe(1);
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
            expect(warnings[0]!.message).toMatch(/systemLanguage .* device language/);
        },
    );

    it.each(MODES)('requiredFeatures (removed in SVG 2) is ignored, like browsers (optimize: %s)', (optimize) => {
        const doc = svg('<rect width="24" height="24" requiredFeatures=""/>');
        const { xml, warnings } = convert(doc, { optimize, strict: true });
        expect(warnings).toEqual([]);
        expect(pathCount(xml)).toBe(1);
    });

    it('failsConditions', () => {
        const el = (attributes: Record<string, string>): XastElement => ({ type: 'element', name: 'g', attributes });
        expect(failsConditions(el({}))).toBe(false);
        expect(failsConditions(el({ requiredExtensions: '' }))).toBe(true);
        expect(failsConditions(el({ requiredExtensions: '  ' }))).toBe(true);
        expect(failsConditions(el({ requiredExtensions: `${XHTML_NS} http://example.org/x` }))).toBe(true);
        expect(failsConditions(el({ requiredExtensions: XHTML_NS }))).toBe(false);
        expect(failsConditions(el({ systemLanguage: ' ' }))).toBe(true);
        expect(failsConditions(el({ systemLanguage: 'en' }))).toBe(false);
        expect(failsConditions(el({ requiredFeatures: '' }))).toBe(false);
    });
});

describe('foreignElements', () => {
    const el = (name: string, attributes: Record<string, string> = {}, children: XastElement[] = []): XastElement => ({
        type: 'element',
        name,
        attributes,
        children,
    });

    it('resolves prefixes and the default namespace with XML scoping', () => {
        const link = el('h:link');
        const unbound = el('x:rect');
        const svgPrefixed = el('s:rect');
        const inner = el('rect');
        const rebound = el('h:rect', { 'xmlns:h': SVG_NS });
        const undeclared = el('rect', { xmlns: '' });
        const foreignDefault = el('div', { xmlns: XHTML_NS }, [inner]);
        const plain = el('rect');
        const root = el('svg', { xmlns: SVG_NS, 'xmlns:h': XHTML_NS, 'xmlns:s': SVG_NS }, [
            link,
            unbound,
            svgPrefixed,
            rebound,
            undeclared,
            foreignDefault,
            el('g', {}, [plain]),
        ]);
        const foreign = foreignElements(root);
        expect([link, unbound, undeclared, foreignDefault].every((e) => foreign.has(e))).toBe(true);
        expect([svgPrefixed, rebound, plain].some((e) => foreign.has(e))).toBe(false);
        expect(foreign.has(inner)).toBe(false); // never visited: its foreign parent is skipped whole
    });

    it('reads a document without any xmlns as SVG', () => {
        const rect = el('rect');
        expect(foreignElements(el('svg', {}, [rect])).has(rect)).toBe(false);
    });
});
