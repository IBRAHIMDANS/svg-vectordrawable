import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConversionError, convert } from '../src/index.js';
import { failsConditions, foreignElements, switchChild } from '../src/elements.js';
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

    it.each(MODES)('draws a prefixed element of the SVG namespace, as a browser does (optimize: %s)', (optimize) => {
        const doc = svg('<s:rect width="4" height="4"/>', ` xmlns:s="${SVG_NS}"`);
        const { xml, warnings } = convert(doc, { optimize, strict: true });
        expect(warnings).toEqual([]);
        expect(pathCount(xml)).toBe(1);
    });
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

describe('HTML media elements in the SVG namespace and an empty <foreignObject> draw nothing (T-174)', () => {
    // Checked in Chrome and Firefox (2026-11-11): none of these draws, nor its subtree.
    const MEDIA = ['video', 'audio', 'iframe', 'canvas'] as const;
    const EMPTY_FO = {
        empty: '<foreignObject width="24" height="24"/>',
        blank: '<foreignObject width="24" height="24">  \n </foreignObject>',
        comment: '<foreignObject width="24" height="24"><!-- nothing --></foreignObject>',
    };
    const silentInBothModes = (doc: string, paths: number): void => {
        for (const optimize of MODES) {
            const { xml, warnings } = convert(doc, { optimize, strict: true });
            expect(warnings).toEqual([]);
            expect(pathCount(xml)).toBe(paths);
        }
    };

    it.each(MEDIA)('<%s> alone, with a child, beside a <rect>: silent in both modes, strict accepts', (name) => {
        silentInBothModes(svg(`<${name} width="24" height="24" src="a.mp4"/>`), 0);
        silentInBothModes(svg(`<${name} width="24" height="24"><rect width="4" height="4"/></${name}>`), 0);
        silentInBothModes(svg(`<${name} width="24" height="24"/>${RECT}`), 1);
    });

    it.each(Object.entries(EMPTY_FO))(
        '%s <foreignObject>, alone and beside a <rect>: silent in both modes',
        (_, fo) => {
            silentInBothModes(svg(fo), 0);
            silentInBothModes(svg(`${fo}${RECT}`), 1);
        },
    );

    it.each(MODES)('a <foreignObject> with content is still reported (optimize: %s)', (optimize) => {
        expect(codes(svg(`<foreignObject width="24" height="24">hi</foreignObject>${RECT}`), optimize)).toEqual([
            'unsupported-element',
        ]);
    });

    it.each(MODES)('their CSS and the resources they reference are not reported (optimize: %s)', (optimize) => {
        const doc = svg(
            '<defs><pattern id="p" width="4" height="4"><rect width="4" height="4" style="mix-blend-mode: screen"/></pattern></defs>' +
                '<video fill="url(#p)" style="mix-blend-mode: multiply"><rect style="mix-blend-mode: screen"/></video>' +
                '<foreignObject width="1" height="1" style="mix-blend-mode: multiply"/>' +
                RECT,
        );
        expect(codes(doc, optimize)).toEqual([]);
    });

    it('a root without a viewBox holding only them draws nothing: no crop warning', () => {
        for (const inner of ['<video/>', '<canvas width="4" height="4"/>', EMPTY_FO.empty])
            silentInBothModes(`<svg xmlns="${SVG_NS}">${inner}</svg>`, 0);
    });

    it('a <switch> passes over a media element (like Firefox), picks an empty <foreignObject> (both browsers)', () => {
        silentInBothModes(svg(`<switch><video width="24" height="24"/>${RECT}</switch>`), 1);
        silentInBothModes(svg(`<switch>${EMPTY_FO.empty}${RECT}</switch>`), 0);
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

describe('an unsupported element is reported once per name (T-172)', () => {
    const FO =
        '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>';
    const IMAGE = '<image href="a.png" width="4" height="4"/>';
    const message = (name: string): string => `<${name}> cannot be represented in a VectorDrawable; skipped.`;
    const reported = (doc: string, optimize: boolean): [string, string][] =>
        convert(doc, { optimize }).warnings.map((w) => [w.code, w.message]);
    const three = svg(`${FO}<g>${FO}</g>${FO}${RECT}`);
    const mixed = svg(`${FO}${IMAGE}${FO}${IMAGE}${RECT}`);
    const animated = svg(
        '<rect width="4" height="4"><set attributeName="fill" to="red"/></rect>' +
            '<g><set attributeName="fill" to="red"/><rect width="2" height="2"/></g>',
    );

    it.each(MODES)('three <foreignObject> → one warning, same output as one (optimize: %s)', (optimize) => {
        expect(reported(three, optimize)).toEqual([['unsupported-element', message('foreignObject')]]);
        expect(convert(three, { optimize }).xml).toBe(convert(svg(`${FO}${RECT}`), { optimize }).xml);
    });

    it.each(MODES)('<foreignObject> and <image> stay two warnings (optimize: %s)', (optimize) => {
        expect(reported(mixed, optimize)).toEqual([
            ['unsupported-element', message('foreignObject')],
            ['unsupported-element', message('image')],
        ]);
    });

    it.each(MODES)('a <set> in a shape and in a group → one warning (optimize: %s)', (optimize) => {
        expect(reported(animated, optimize)).toEqual([['unsupported-element', message('set')]]);
    });

    it.each(MODES)('strict rejects the same files with the same error (optimize: %s)', (optimize) => {
        for (const doc of [three, mixed, animated]) {
            const [first] = convert(doc, { optimize }).warnings;
            let thrown: unknown;
            try {
                convert(doc, { optimize, strict: true });
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(ConversionError);
            expect((thrown as ConversionError).warning).toEqual(first);
            expect(() => convert(doc, { optimize, strict: 'lossy' })).toThrow(ConversionError);
        }
    });

    it('each conversion reports it again', () => {
        expect(reported(three, false)).toHaveLength(1);
        expect(reported(three, false)).toHaveLength(1);
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

describe('<switch> renders its first child passing conditional processing (SVG 2 §5.6.3)', () => {
    const visual = (doc: string, optimize: boolean): string => {
        const { xml, warnings } = convert(doc, { optimize, strict: true });
        expect(warnings).toEqual([]);
        const result = compareSvgs(doc, vdToSvg(xml));
        expect(result.sizeMismatch).toBeNull();
        expect(result.inked).toBeGreaterThan(0);
        expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        return xml;
    };

    it.each(MODES)(
        'wpt struct-cond-01: the failing child and the later ones are bypassed (optimize: %s)',
        (optimize) => {
            const xml = visual(
                svg(
                    '<switch><rect fill="#f00" width="12" height="12" requiredExtensions="http://example.org/bogus"/>' +
                        '<rect fill="#008000" y="12" width="12" height="12"/><rect fill="#00f" x="12" width="12" height="12"/>' +
                        '</switch>',
                ),
                optimize,
            );
            expect(pathCount(xml)).toBe(1);
            expect(xml).toContain('#FF008000');
        },
    );

    it.each(MODES)('wpt use-switch: a <use> can instance a <switch> (optimize: %s)', (optimize) => {
        const xml = visual(
            svg(
                '<defs><switch id="s"><rect width="24" height="24" fill="#008000"/><rect width="4" height="4" fill="#f00"/>' +
                    '</switch></defs><rect x="2" y="2" width="20" height="20" fill="#f00"/><use href="#s"/>',
            ),
            optimize,
        );
        expect(pathCount(xml)).toBe(2);
    });

    it.each(MODES)(
        'Illustrator export: the private-extension <foreignObject> is bypassed silently (optimize: %s)',
        (optimize) => {
            const xml = visual(
                svg(
                    '<switch><foreignObject requiredExtensions="http://ns.adobe.com/AdobeIllustrator/10.0/" ' +
                        'width="1" height="1"/><g i:extraneous="self"><rect width="12" height="24" fill="#f00"/>' +
                        '<rect x="12" width="12" height="24" fill="#008000"/></g></switch>',
                    ' xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/"',
                ),
                optimize,
            );
            expect(pathCount(xml)).toBe(2);
        },
    );

    it.each(MODES)(
        'the <switch> attributes apply to the chosen child (transform, clip-path, opacity) (optimize: %s)',
        (optimize) => {
            visual(
                svg(
                    '<clipPath id="c"><rect width="12" height="24"/></clipPath>' +
                        '<switch transform="translate(2 0)" clip-path="url(#c)" opacity="0.5" fill="#008000">' +
                        '<rect width="20" height="24"/><rect width="24" height="24" fill="#f00"/></switch>',
                ),
                optimize,
            );
        },
    );

    it.each(MODES)(
        'no candidate → nothing; text, <desc>, foreign elements are not candidates (optimize: %s)',
        (optimize) => {
            const doc = svg(
                '<switch><rect width="4" height="4" requiredExtensions=""/><rect width="4" height="4" systemLanguage=""/>' +
                    '</switch><switch> text <desc>d</desc><title>t</title><h:p>p</h:p><!-- c -->' +
                    '<rect x="8" width="4" height="4"/></switch><switch/>',
                ` xmlns:h="${XHTML_NS}"`,
            );
            const { xml, warnings } = convert(doc, { optimize, strict: true });
            expect(warnings).toEqual([]);
            expect(pathCount(xml)).toBe(1);
            expect(xml).toMatch(/M8[ ,]0h4v4/);
        },
    );

    it.each(MODES)('the chosen child is reported like any child (<text>) (optimize: %s)', (optimize) => {
        expect(codes(svg(`<switch><text>a</text>${RECT}</switch>`), optimize)).toEqual(['unsupported-element']);
    });

    it.each(MODES)('a nested <switch> picks again (optimize: %s)', (optimize) => {
        const xml = visual(
            svg(
                `<switch><switch><rect requiredExtensions="" width="4" height="4"/>${RECT}</switch>` +
                    '<rect width="24" height="24" fill="#f00"/></switch>',
            ),
            optimize,
        );
        expect(pathCount(xml)).toBe(1);
    });

    // optimize: true is left out: svgo's removeHiddenElems drops the display="none" child first.
    it('display does not take part in the choice: a chosen display="none" child renders nothing', () => {
        const doc = svg(`<switch><rect width="4" height="4" display="none"/>${RECT}</switch>`);
        const { xml, warnings } = convert(doc, { optimize: false, strict: true });
        expect(warnings).toEqual([]);
        expect(pathCount(xml)).toBe(0);
    });

    it.each(MODES)(
        'systemLanguage: the catch-all child is rendered, the choice reported once (optimize: %s)',
        (optimize) => {
            const doc = svg(
                '<switch><g systemLanguage="fr"><rect width="4" height="4" fill="#f00"/></g>' +
                    `<rect width="24" height="24" fill="#008000"/><rect systemLanguage="en" width="2" height="2"/></switch>`,
            );
            const { xml, warnings } = convert(doc, { optimize });
            expect(warnings.map((w) => [w.code, w.node])).toEqual([['unsupported-attribute', 'switch']]);
            expect(warnings[0]!.message).toMatch(/device language.*the child without it is rendered/);
            expect(pathCount(xml)).toBe(1);
            expect(xml).toContain('#FF008000');
            expect(() => convert(doc, { optimize, strict: true })).toThrow(
                /systemLanguage on the children of <switch>/,
            );
        },
    );

    it.each(MODES)(
        'systemLanguage without a catch-all: the first candidate, reported once (optimize: %s)',
        (optimize) => {
            const doc = svg(
                '<switch><rect systemLanguage="de" requiredExtensions="" width="2" height="2"/>' +
                    '<rect systemLanguage="fr" width="24" height="24" fill="#008000"/>' +
                    '<rect systemLanguage="en" width="4" height="4" fill="#f00"/></switch>',
            );
            const { xml, warnings } = convert(doc, { optimize });
            expect(warnings.map((w) => [w.code, w.node])).toEqual([['unsupported-attribute', 'switch']]);
            expect(warnings[0]!.message).toMatch(/the first child is rendered/);
            expect(pathCount(xml)).toBe(1);
            expect(xml).toContain('#FF008000');
        },
    );

    it.each(MODES)('a catch-all before every language child still reports the choice (optimize: %s)', (optimize) => {
        // Firefox ranks a language match above the catch-all whatever the order.
        const doc = svg(`<switch>${RECT}<rect systemLanguage="en" width="4" height="4" fill="#f00"/></switch>`);
        expect(codes(doc, optimize)).toEqual(['unsupported-attribute']);
    });

    it('switchChild', () => {
        const el = (name: string, attributes: Record<string, string> = {}): XastElement => ({
            type: 'element',
            name,
            attributes,
        });
        const sw = (...children: XastElement[]): XastElement => ({ type: 'element', name: 'switch', children });
        const none = new WeakSet<XastElement>();
        const [a, b] = [el('rect'), el('g')];
        expect(switchChild(sw(), none)).toEqual({ child: undefined, languageDependent: false });
        expect(switchChild(sw({ type: 'text' }, el('desc'), a, b), none)).toEqual({
            child: a,
            languageDependent: false,
        });
        expect(switchChild(sw(el('rect', { requiredExtensions: '' }), b), none).child).toBe(b);
        expect(switchChild(sw(el('rect', { display: 'none' }), b), none).child).not.toBe(b);
        const fr = el('g', { systemLanguage: 'fr' });
        expect(switchChild(sw(fr, a), none)).toEqual({ child: a, languageDependent: true });
        expect(switchChild(sw(fr, el('g', { systemLanguage: 'en' })), none)).toEqual({
            child: fr,
            languageDependent: true,
        });
        expect(switchChild(sw(a, b), new WeakSet([a])).child).toBe(b);
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

describe('<switch> survives svgo and group opacity checks', () => {
    const doc = (body: string): string => `<svg xmlns="${SVG_NS}" viewBox="0 0 24 24">${body}</svg>`;

    it.each(MODES)('does not merge or drop the alternatives of a switch (optimize: %s)', (optimize) => {
        const xml = convert(
            doc('<switch><path d="M0 0h12v12H0z" fill="#0f0"/><path d="M12 12h12v12H12z" fill="#0f0"/></switch>'),
            { optimize },
        ).xml;
        // Only the first alternative: one sub-path (a merged path would carry both).
        const paths = [...xml.matchAll(/android:pathData="([^"]*)"/g)].map((m) => m[1]!);
        expect(paths).toHaveLength(1);
        expect(paths[0]!.match(/[Mm]/g)).toHaveLength(1);
    });

    it.each(MODES)('counts the chosen child of a switch for group opacity overlaps (optimize: %s)', (optimize) => {
        const { warnings } = convert(
            doc(
                '<g opacity=".5"><switch><rect width="12" height="12"/></switch><rect x="6" width="12" height="12"/></g>',
            ),
            { optimize },
        );
        expect(warnings.map((w) => w.code)).toContain('opacity-approximated');
    });
});
