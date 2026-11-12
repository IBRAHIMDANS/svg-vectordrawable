import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { MAX_EXPANDED_NODES, resolveUses } from '../src/useResolver.js';
import type { XastElement } from '../src/ast.js';
import { USE_INSTANCE_ATTR } from '../src/inherited.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vdToSvg } from './visual/vdToSvg.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';

const el = (name: string, attributes: Record<string, string> = {}, children: XastElement[] = []): XastElement => ({
    type: 'element',
    name,
    attributes,
    children,
});

const root = (children: XastElement[]): XastElement => ({ type: 'root', children });

/** Returns the single child of a parent, asserting it is the only one (keeps tests readable). */
const onlyChild = (node: XastElement): XastElement => {
    expect(node.children).toHaveLength(1);
    const child = node.children?.[0];
    expect(child).toBeDefined();
    return child as XastElement;
};

describe('resolveUses', () => {
    it('replaces a <use href="#id"> with a <g> wrapping a deep clone of the target', () => {
        const path = el('path', { id: 'p', d: 'M0 0h8v8z' });
        const tree = root([
            el('svg', {}, [el('defs', {}, [path]), el('use', { href: '#p', fill: '#0a0', x: '2', y: '3' })]),
        ]);

        resolveUses(tree);

        const svg = onlyChild(tree);
        const defs = svg.children?.[0];
        const replaced = svg.children?.[1];

        // The <use> became a <g>…
        expect(replaced?.name).toBe('g');
        expect(replaced?.attributes?.fill).toBe('#0a0');
        expect(replaced?.attributes?.transform).toContain('translate(2 3)');
        expect(replaced?.attributes?.href).toBeUndefined();
        expect(replaced?.attributes?.x).toBeUndefined();
        expect(replaced?.attributes?.y).toBeUndefined();

        // …whose child is a clone of the path (same data, distinct object).
        const cloned = onlyChild(replaced as XastElement);
        expect(cloned.name).toBe('path');
        expect(cloned.attributes?.d).toBe('M0 0h8v8z');
        expect(cloned).not.toBe(path);

        // The original path inside <defs> is untouched (cloned, not moved).
        expect(defs?.name).toBe('defs');
        expect(defs?.children?.[0]).toBe(path);
        expect(path.attributes?.d).toBe('M0 0h8v8z');
    });

    it('supports the legacy xlink:href attribute', () => {
        const tree = root([
            el('svg', {}, [
                el('defs', {}, [el('rect', { id: 'r', width: '4', height: '4' })]),
                el('use', { 'xlink:href': '#r' }),
            ]),
        ]);

        resolveUses(tree);

        const svg = onlyChild(tree);
        const replaced = svg.children?.[1];
        expect(replaced?.name).toBe('g');
        expect(onlyChild(replaced as XastElement).name).toBe('rect');
    });

    it('treats a <symbol> target as a group (clones it but renames to g)', () => {
        const tree = root([
            el('svg', {}, [
                el('defs', {}, [el('symbol', { id: 's' }, [el('path', { d: 'M0 0z' })])]),
                el('use', { href: '#s' }),
            ]),
        ]);

        resolveUses(tree);

        const svg = onlyChild(tree);
        const wrapper = svg.children?.[1];
        expect(wrapper?.name).toBe('g'); // the wrapping group

        const symbolAsGroup = onlyChild(wrapper as XastElement);
        expect(symbolAsGroup.name).toBe('g'); // symbol renamed to g
        expect(onlyChild(symbolAsGroup).name).toBe('path');
    });

    it('leaves a <use> with a missing reference untouched', () => {
        const use = el('use', { href: '#missing' });
        const tree = root([el('svg', {}, [use])]);

        resolveUses(tree);

        const svg = onlyChild(tree);
        const child = svg.children?.[0];
        expect(child).toBe(use); // same node, not replaced
        expect(child?.name).toBe('use');
        expect(child?.attributes?.href).toBe('#missing');
    });

    it('leaves a <use> with a non-fragment href untouched', () => {
        const use = el('use', { href: 'other.svg#p' });
        const tree = root([el('svg', {}, [use])]);

        resolveUses(tree);

        expect(onlyChild(onlyChild(tree))).toBe(use);
    });

    it('does not loop forever when a target transitively references itself', () => {
        // <g id="a"> contains <use href="#b">, and <g id="b"> contains <use href="#a">.
        const tree = root([
            el('svg', {}, [
                el('defs', {}, [
                    el('g', { id: 'a' }, [el('use', { href: '#b' })]),
                    el('g', { id: 'b' }, [el('use', { href: '#a' })]),
                ]),
                el('use', { href: '#a' }),
            ]),
        ]);

        // The assertion that matters is simply that this returns (no stack overflow / hang).
        expect(() => resolveUses(tree)).not.toThrow();

        const svg = onlyChild(tree);
        const top = svg.children?.[1];
        expect(top?.name).toBe('g');
    });

    it('composes the use transform before the x/y translate', () => {
        const tree = root([
            el('svg', {}, [
                el('defs', {}, [el('path', { id: 'p', d: 'M0 0z' })]),
                el('use', { href: '#p', transform: 'rotate(45)', x: '1', y: '2' }),
            ]),
        ]);

        resolveUses(tree);

        const replaced = onlyChild(tree).children?.[1];
        expect(replaced?.attributes?.transform).toBe('rotate(45) translate(1 2)');
    });

    it('keeps <defs> in the tree after resolution', () => {
        const tree = root([
            el('svg', {}, [el('defs', {}, [el('path', { id: 'p', d: 'M0 0z' })]), el('use', { href: '#p' })]),
        ]);

        resolveUses(tree);

        const svg = onlyChild(tree);
        expect(svg.children?.some((c) => c.name === 'defs')).toBe(true);
    });
});

describe('resolveUses — <symbol viewBox> viewport', () => {
    /** Resolves a single `<use>` of a single `<symbol>` and returns the replacement wrapper. */
    const resolveSymbol = (symbolAttrs: Record<string, string>, useAttrs: Record<string, string>): XastElement => {
        const tree = root([
            el('svg', {}, [
                el('defs', {}, [el('symbol', { id: 's', ...symbolAttrs }, [el('path', { d: 'M0 0h1v1h-1z' })])]),
                el('use', { href: '#s', ...useAttrs }),
            ]),
        ]);
        resolveUses(tree);
        return onlyChild(tree).children?.[1] as XastElement;
    };

    /** Walks wrapper → clip group → content group and returns the pieces (clip may be absent). */
    const parts = (wrapper: XastElement): { clipGroup?: XastElement; clipPath?: XastElement; content: XastElement } => {
        const first = onlyChild(wrapper);
        if (first.attributes?.['clip-path'] === undefined) return { content: first };
        const clipPath = first.children?.find((c) => c.name === 'clipPath');
        const content = first.children?.find((c) => c.name === 'g') as XastElement;
        return { clipGroup: first, clipPath, content };
    };

    it('scales the symbol viewBox onto the use width/height', () => {
        const wrapper = resolveSymbol({ viewBox: '0 0 1 1' }, { x: '2', y: '3', width: '10', height: '10' });

        expect(wrapper.attributes?.transform).toBe('translate(2 3)');
        expect(wrapper.attributes?.width).toBeUndefined();
        const { content } = parts(wrapper);
        expect(content.attributes?.transform).toBe('matrix(10 0 0 10 0 0)');
        const symbolAsGroup = onlyChild(content);
        expect(symbolAsGroup.name).toBe('g');
        expect(symbolAsGroup.attributes?.viewBox).toBeUndefined();
        expect(onlyChild(symbolAsGroup).name).toBe('path');
    });

    it('centres with xMidYMid meet by default', () => {
        const { content } = parts(resolveSymbol({ viewBox: '0 0 10 20' }, { width: '40', height: '40' }));
        expect(content.attributes?.transform).toBe('matrix(2 0 0 2 10 0)');
    });

    it('honours an explicit alignment with slice and a non-zero viewBox origin', () => {
        const { content } = parts(
            resolveSymbol(
                { viewBox: '5 5 10 20', preserveAspectRatio: 'xMinYMax slice' },
                { width: '40', height: '40' },
            ),
        );
        // scale = max(4, 2) = 4; ty = 1 · (40 − 80) = −40; then − origin · scale.
        expect(content.attributes?.transform).toBe('matrix(4 0 0 4 -20 -60)');
    });

    it('stretches non-uniformly with preserveAspectRatio="none"', () => {
        const { content } = parts(
            resolveSymbol({ viewBox: '0 0 10 20', preserveAspectRatio: 'none' }, { width: '40', height: '40' }),
        );
        expect(content.attributes?.transform).toBe('matrix(4 0 0 2 0 0)');
    });

    it('falls back to the symbol width/height when the use has none', () => {
        const { content } = parts(resolveSymbol({ viewBox: '0 0 1 1', width: '5', height: '5' }, {}));
        expect(content.attributes?.transform).toBe('matrix(5 0 0 5 0 0)');
    });

    it('lets the use width/height override the symbol ones', () => {
        const { content } = parts(
            resolveSymbol({ viewBox: '0 0 1 1', width: '5', height: '5' }, { width: '8', height: '8' }),
        );
        expect(content.attributes?.transform).toBe('matrix(8 0 0 8 0 0)');
    });

    it('keeps the unscaled behaviour when no absolute size is known', () => {
        const wrapper = resolveSymbol({ viewBox: '0 0 1 1' }, { x: '1', y: '1' });
        expect(wrapper.attributes?.transform).toBe('translate(1 1)');
        const symbolAsGroup = onlyChild(wrapper);
        expect(symbolAsGroup.attributes?.['clip-path']).toBeUndefined();
        expect(symbolAsGroup.attributes?.transform).toBeUndefined();
        expect(onlyChild(symbolAsGroup).name).toBe('path');
    });

    it('clips to the viewport with a generated <clipPath>', () => {
        const { clipGroup, clipPath } = parts(resolveSymbol({ viewBox: '0 0 1 1' }, { width: '10', height: '6' }));
        expect(clipPath).toBeDefined();
        const id = clipPath?.attributes?.id as string;
        expect(clipGroup?.attributes?.['clip-path']).toBe(`url(#${id})`);
        const rect = onlyChild(clipPath as XastElement);
        expect(rect.name).toBe('rect');
        expect(rect.attributes).toEqual({ x: '0', y: '0', width: '10', height: '6' });
    });

    it.each(['visible', 'auto'])('does not clip when the symbol has overflow="%s"', (overflow) => {
        const { clipGroup, content } = parts(
            resolveSymbol({ viewBox: '0 0 1 1', overflow }, { width: '10', height: '10' }),
        );
        expect(clipGroup).toBeUndefined();
        expect(content.attributes?.transform).toBe('matrix(10 0 0 10 0 0)');
    });

    it('also reads overflow from the symbol style', () => {
        const { clipGroup } = parts(
            resolveSymbol({ viewBox: '0 0 1 1', style: 'overflow:visible' }, { width: '10', height: '10' }),
        );
        expect(clipGroup).toBeUndefined();
    });

    it('generates clip ids that collide neither with existing ids nor with each other', () => {
        const tree = root([
            el('svg', {}, [
                el('defs', {}, [
                    el('clipPath', { id: 'svgvd-symbol-viewport-1' }, [el('rect', { width: '1', height: '1' })]),
                    el('symbol', { id: 's', viewBox: '0 0 1 1' }, [el('path', { d: 'M0 0h1v1h-1z' })]),
                ]),
                el('use', { href: '#s', width: '2', height: '2' }),
                el('use', { href: '#s', width: '3', height: '3' }),
            ]),
        ]);
        resolveUses(tree);

        const svg = onlyChild(tree);
        const ids = [svg.children?.[1], svg.children?.[2]].map((w) => parts(w as XastElement).clipPath?.attributes?.id);
        expect(ids[0]).toBeDefined();
        expect(ids[1]).toBeDefined();
        expect(ids[0]).not.toBe('svgvd-symbol-viewport-1');
        expect(ids[1]).not.toBe('svgvd-symbol-viewport-1');
        expect(ids[0]).not.toBe(ids[1]);
    });

    it('renders nothing for a zero-sized viewport', () => {
        const wrapper = resolveSymbol({ viewBox: '0 0 1 1' }, { width: '0', height: '10' });
        expect(wrapper.name).toBe('g');
        expect(wrapper.children).toEqual([]);
    });

    it('clips a symbol without viewBox to the use viewport, without scaling it', () => {
        const wrapper = resolveSymbol({}, { x: '2', y: '3', width: '10', height: '6' });
        expect(wrapper.attributes).toEqual({ transform: 'translate(2 3)', [USE_INSTANCE_ATTR]: '' });
        const { clipGroup, clipPath, content } = parts(wrapper);
        expect(clipGroup).toBeDefined();
        expect(onlyChild(clipPath as XastElement).attributes).toEqual({ x: '0', y: '0', width: '10', height: '6' });
        // No viewBox: the symbol content keeps its own coordinates (no scale group).
        expect(content.attributes).toEqual({ id: 's' });
        expect(onlyChild(content).name).toBe('path');
    });

    it('clips a symbol without viewBox to its own width/height when the use has none', () => {
        const { clipPath } = parts(resolveSymbol({ width: '4', height: '5' }, {}));
        expect(onlyChild(clipPath as XastElement).attributes).toEqual({ x: '0', y: '0', width: '4', height: '5' });
    });

    it('does not clip a symbol without viewBox whose overflow is visible', () => {
        const wrapper = resolveSymbol({ overflow: 'visible' }, { width: '10', height: '10' });
        const symbolAsGroup = onlyChild(wrapper);
        expect(symbolAsGroup.attributes?.['clip-path']).toBeUndefined();
        expect(symbolAsGroup.attributes).toEqual({ id: 's' });
    });

    it('renders nothing for a symbol without viewBox and a zero-sized use', () => {
        expect(resolveSymbol({}, { width: '10', height: '0' }).children).toEqual([]);
    });

    it('leaves a symbol without viewBox nor absolute size unclipped', () => {
        const wrapper = resolveSymbol({}, { x: '2', y: '3', width: '50%' });
        expect(wrapper.attributes).toEqual({ transform: 'translate(2 3)', [USE_INSTANCE_ATTR]: '' });
        const symbolAsGroup = onlyChild(wrapper);
        expect(symbolAsGroup.attributes).toEqual({ id: 's' });
        expect(onlyChild(symbolAsGroup).name).toBe('path');
    });

    it('scales and clips end to end through convert()', () => {
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
            '<defs><symbol id="s" viewBox="0 0 1 1"><path d="M0 0h2v2h-2z" fill="#000"/></symbol></defs>' +
            '<use href="#s" x="2" y="2" width="10" height="10"/></svg>';
        for (const optimize of [false, true]) {
            const { xml, warnings } = convert(svg, { optimize });
            expect(warnings).toEqual([]);
            expect(xml).toContain('android:scaleX="10"');
            expect(xml).toContain('android:scaleY="10"');
            // The viewport clip (10×10 at the use origin) must reach the output.
            expect(xml).toContain('<clip-path android:pathData="M0,0h10v10h-10z" />');
        }
    });
});

describe('resolveUses — <symbol> with a percentage or absent size', () => {
    const doc = (viewBox: string, body: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
    /** A 10×10 viewBox whose green content overflows it (the clip is visible). */
    const symbol =
        '<defs><symbol id="s" viewBox="0 0 10 10"><rect width="20" height="20" fill="green"/></symbol></defs>';

    // What a browser draws (SVG 2 §5.6.2: use size, else symbol size, else 100% of the use's viewport).
    for (const [label, source, expected] of [
        [
            'use width / height in % of the root viewBox',
            doc('0 0 100 50', `${symbol}<use href="#s" x="10" width="50%" height="100%"/>`),
            doc('0 0 100 50', '<rect x="10" width="50" height="50" fill="green"/>'),
        ],
        [
            'absent sizes: 100% of the root viewBox, centred by xMidYMid meet',
            doc('0 0 100 50', `${symbol}<use href="#s" x="10"/>`),
            doc('0 0 100 50', '<rect x="35" width="65" height="50" fill="green"/>'),
        ],
        [
            'symbol width / height in %, without viewBox: clipped, not scaled',
            doc(
                '0 0 200 100',
                '<defs><symbol id="s" width="25%" height="50%"><rect width="100" height="100" fill="green"/></symbol></defs><use href="#s"/>',
            ),
            doc('0 0 200 100', '<rect width="50" height="50" fill="green"/>'),
        ],
        [
            'use in a nested <svg>: % of the nested viewport',
            doc(
                '0 0 100 100',
                `${symbol}<svg x="10" y="10" width="40" height="40"><use href="#s" x="10" y="10" width="50%" height="50%"/></svg>`,
            ),
            doc('0 0 100 100', '<rect x="20" y="20" width="20" height="20" fill="green"/>'),
        ],
        [
            'use nested in an instanced symbol: % of that symbol viewport',
            doc(
                '0 0 100 100',
                `${symbol}<defs><symbol id="outer" viewBox="0 0 40 40"><use href="#s" width="50%" height="50%"/></symbol></defs>` +
                    '<use href="#outer" width="80" height="80"/>',
            ),
            doc('0 0 100 100', '<rect width="40" height="40" fill="green"/>'),
        ],
    ] as const)
        for (const optimize of [false, true])
            it(`${label} (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(source, { optimize, strict: true });
                expect(warnings).toEqual([]);
                const result = compareSvgs(expected, vdToSvg(xml));
                expect(result.sizeMismatch).toBeNull();
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

    for (const optimize of [false, true])
        it(`warns (unsupported-attribute) when the size cannot be resolved (optimize: ${optimize})`, () => {
            const source = doc('0 0 100 50', `${symbol}<use href="#s" width="2ex" height="10"/>`);
            const { warnings } = convert(source, { optimize });
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
            expect(warnings[0]?.message).toContain('the <symbol> viewport size');
            expect(() => convert(source, { optimize, strict: true })).toThrow();
        });

    it('does not warn when an unresolved viewport changes nothing (no viewBox, overflow visible)', () => {
        const source = doc(
            '0 0 100 50',
            '<defs><symbol id="s" overflow="visible"><rect width="20" height="20"/></symbol></defs><use href="#s" width="2ex"/>',
        );
        for (const optimize of [false, true]) expect(convert(source, { optimize }).warnings).toEqual([]);
    });

    it('reports to warn against an unknown root viewport, and keeps the unscaled content', () => {
        const tree = root([
            el('svg', {}, [
                el('defs', {}, [el('symbol', { id: 's', viewBox: '0 0 1 1' }, [el('path', { d: 'M0 0h1v1h-1z' })])]),
                el('use', { href: '#s' }),
            ]),
        ]);
        const codes: string[] = [];
        resolveUses(tree, (w) => codes.push(w.code));
        expect(codes).toEqual(['unsupported-attribute']);
        expect(onlyChild(onlyChild(tree).children?.[1] as XastElement).name).toBe('g');
    });

    it('expands a bare <symbol> content after its instances, without reporting it', () => {
        const inner = el('use', { href: '#p' });
        const tree = root([
            el('svg', { viewBox: '0 0 10 10' }, [
                el('defs', {}, [
                    el('path', { id: 'p', d: 'M0 0h1v1h-1z' }),
                    el('symbol', { id: 's' }, [inner, el('use', { href: '#t' })]),
                    el('symbol', { id: 't', viewBox: '0 0 1 1', width: '2ex' }),
                ]),
            ]),
        ]);
        const reported: string[] = [];
        resolveUses(tree, (w) => reported.push(w.code));
        expect(reported).toEqual([]);
        const bare = onlyChild(onlyChild(tree)).children?.[1] as XastElement;
        expect(bare.children?.map((c) => c.name)).toEqual(['g', 'g']);
    });
});

describe('resolveUses — <svg> target', () => {
    /** Resolves a single `<use>` of a single `<svg>` and returns the cloned `<svg>`. */
    const resolveSvg = (svgAttrs: Record<string, string>, useAttrs: Record<string, string>): XastElement => {
        const tree = root([
            el('svg', {}, [
                el('defs', {}, [el('svg', { id: 'v', ...svgAttrs }, [el('path', { d: 'M0 0h1v1h-1z' })])]),
                el('use', { href: '#v', ...useAttrs }),
            ]),
        ]);
        resolveUses(tree);
        return onlyChild(onlyChild(tree).children?.[1] as XastElement);
    };

    it('lets the use width/height override the svg ones', () => {
        const svg = resolveSvg({ width: '200', height: '200', viewBox: '0 0 1 1' }, { width: '100', height: '50' });
        expect(svg.name).toBe('svg');
        expect(svg.attributes).toEqual({ id: 'v', width: '100', height: '50', viewBox: '0 0 1 1' });
    });

    it('overrides each dimension independently', () => {
        expect(resolveSvg({ width: '200', height: '200' }, { height: '30%' }).attributes).toEqual({
            id: 'v',
            width: '200',
            height: '30%',
        });
    });

    it('keeps the svg dimensions when the use has none or says auto', () => {
        const attrs = { width: '200', height: '150' };
        expect(resolveSvg(attrs, {}).attributes).toEqual({ id: 'v', ...attrs });
        expect(resolveSvg(attrs, { width: 'auto', height: ' auto ' }).attributes).toEqual({ id: 'v', ...attrs });
    });

    it('leaves the original svg in <defs> untouched', () => {
        const target = el('svg', { id: 'v', width: '200', height: '200' });
        const tree = root([el('svg', {}, [el('defs', {}, [target]), el('use', { href: '#v', width: '1' })])]);
        resolveUses(tree);
        expect(target.attributes).toEqual({ id: 'v', width: '200', height: '200' });
    });
});

describe('resolveUses — wpt reproductions render like their source', () => {
    const reproDir = join(fileURLToPath(new URL('.', import.meta.url)), 'wpt-repro');

    it.each(['wpt-use-symbol-size.svg', 'wpt-use-svg-size.svg'])('%s', (file) => {
        const svg = readFileSync(join(reproDir, file), 'utf8');
        // Expected rendering of both reftests: a green 100x100 square.
        const reference =
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
            '<rect width="100" height="100" fill="green"/></svg>';
        for (const optimize of [false, true]) {
            const { xml, warnings } = convert(svg, { optimize, strict: true });
            expect(warnings).toEqual([]);
            for (const expected of [svg, reference]) {
                const result = compareSvgs(expected, vdToSvg(xml));
                expect(result.sizeMismatch).toBeNull();
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            }
        }
    });
});

describe('resolveUses — context-fill / context-stroke', () => {
    it('wpt-paint-context-fill.svg renders like the wpt reference (the use fill)', () => {
        const svg = readFileSync(
            join(fileURLToPath(new URL('.', import.meta.url)), 'wpt-repro', 'wpt-paint-context-fill.svg'),
            'utf8',
        );
        // resvg 2.6 paints context-fill black: compare with the source as a browser resolves it.
        const reference = svg.replaceAll('fill="context-fill"', 'fill="green"');
        for (const optimize of [false, true]) {
            const { xml, warnings } = convert(svg, { optimize, strict: true });
            expect(warnings).toEqual([]);
            const result = compareSvgs(reference, vdToSvg(xml));
            expect(result.sizeMismatch).toBeNull();
            expect(result.inked).toBeGreaterThan(0);
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        }
    });

    const doc = (defs: string, body: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs>${defs}</defs>${body}</svg>`;
    const rect = (paint: string): string => `<rect id="r" width="10" height="10" ${paint}/>`;
    const run = (svg: string): { xml: string; codes: string[] } => {
        const { xml, warnings } = convert(svg, { optimize: false });
        return { xml, codes: warnings.map((w) => w.code) };
    };

    it("resolves context-fill / context-stroke to the <use>'s fill / stroke", () => {
        const { xml, codes } = run(
            doc(
                rect('fill="context-fill" stroke="context-stroke" stroke-width="2"'),
                '<use href="#r" fill="#00f" stroke="#f00"/>',
            ),
        );
        expect(codes).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF0000FF"');
        expect(xml).toContain('android:strokeColor="#FFFF0000"');
    });

    it('crosses the paints: context-fill on stroke, context-stroke on fill', () => {
        const { xml, codes } = run(
            doc(
                rect('fill="context-stroke" stroke="context-fill" stroke-width="2"'),
                '<use href="#r" fill="#00f" stroke="#f00"/>',
            ),
        );
        expect(codes).toEqual([]);
        expect(xml).toContain('android:fillColor="#FFFF0000"');
        expect(xml).toContain('android:strokeColor="#FF0000FF"');
    });

    it("takes the use's inherited paint (style or ancestor), not the target's ancestors", () => {
        const { xml, codes } = run(
            doc(
                '<g id="t" fill="#f00"><rect width="10" height="10" style="fill:context-fill"/></g>',
                '<g fill="#0f0"><use href="#t"/></g>',
            ),
        );
        expect(codes).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF00FF00"');
    });

    it('an unset use paint is the initial one: black fill, no stroke', () => {
        const { xml, codes } = run(
            doc(rect('fill="context-fill" stroke="context-stroke" stroke-width="2"'), '<use href="#r"/>'),
        );
        expect(codes).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF000000"');
        expect(xml).not.toContain('strokeColor');
    });

    it('currentcolor on the use is resolved with the color of the painted element (wpt paint-context-003)', () => {
        const { xml, codes } = run(
            doc(
                '<g id="g" color="#008000"><rect width="10" height="10" fill="context-fill"/></g>',
                '<g color="#f00"><use href="#g" fill="currentcolor"/></g>',
            ),
        );
        expect(codes).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF008000"');
    });

    it('uses the nearest <use> as context element through nested instances', () => {
        const { xml, codes } = run(
            doc(
                `${rect('fill="context-fill"')}<g id="mid" fill="#f00"><use href="#r" fill="#0f0"/></g>`,
                '<use href="#mid" fill="#00f"/>',
            ),
        );
        expect(codes).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF00FF00"');
        // The inner use passes on its context's paint when it is itself context-fill.
        const passed = run(
            doc(
                `${rect('fill="context-fill"')}<g id="mid"><use href="#r" fill="context-fill"/></g>`,
                '<use href="#mid" fill="#00f"/>',
            ),
        );
        expect(passed.codes).toEqual([]);
        expect(passed.xml).toContain('android:fillColor="#FF0000FF"');
    });

    describe('a gradient context paint is laid out over the <use> (SVG 2 §13.3)', () => {
        const stops = '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>';
        const obb = `<linearGradient id="lg">${stops}</linearGradient>`;
        const user = `<linearGradient id="lu" gradientUnits="userSpaceOnUse" x1="2" y1="0" x2="22" y2="6">${stops}</linearGradient>`;
        const radial = `<radialGradient id="rg">${stops}</radialGradient>`;
        /** Two rects, the second transformed: the box is the use's, not either shape's. */
        const shapes = (paint: string, id = ' id="t"'): string =>
            `<g${id}><rect x="2" y="2" width="8" height="8" ${paint}/>` +
            `<rect x="4" y="4" width="6" height="6" transform="rotate(30 8 8)" ${paint}/></g>`;
        /** Converts in both optimize modes (strict; the size of the wpt canvas aside): renders like `reference`. */
        const expectRendersLike = (svg: string, reference: string): void => {
            for (const optimize of [false, true]) {
                const { xml, warnings } = convert(svg, { optimize, strict: true });
                expect(warnings.filter((w) => w.code !== 'large-vector')).toEqual([]);
                expect(xml).toContain('<gradient');
                const result = compareSvgs(reference, vdToSvg(xml));
                expect(result.sizeMismatch).toBeNull();
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch, `optimize: ${optimize}`).toBeLessThan(DEFAULT_MAX_MISMATCH);
            }
        };

        it('wpt paint-context-007: objectBoundingBox fill over the use box, shapes transformed', () => {
            // resvg 2.6 paints context-fill black: compare with the wpt reference (rel="match").
            const svg =
                '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 400 300">' +
                '<defs><linearGradient id="lg"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>' +
                '<g id="shapes"><rect x="50" y="90" width="240" height="120" fill="context-fill"/>' +
                '<path d="M 170 -30 l -120 240 l 240 0 Z" fill="context-fill" transform-origin="170 150" transform="rotate(90)"/></g></defs>' +
                '<g><use x="0" y="0" fill="url(#lg)" xlink:href="#shapes"/></g></svg>';
            const reference =
                '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 400 300"><defs>' +
                '<linearGradient id="lg1" x2="125%"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>' +
                '<linearGradient id="lg2" x1="-25%"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>' +
                '<rect x="50" y="90" width="240" height="120" fill="url(#lg1)"/>' +
                '<path d="M 110 30 l 240 120 l -240 120 Z" fill="url(#lg2)"/></svg>';
            expectRendersLike(svg, reference);
        });

        it('objectBoundingBox fill, with the use x / y offset', () => {
            const svg = doc(`${obb}${shapes('fill="context-fill"')}`, '<use href="#t" x="1" y="3" fill="url(#lg)"/>');
            // The rotated rect's corners around (8, 8): its far right corner sets the box's right edge.
            const a = Math.PI / 6;
            const xs = [
                [4, 4],
                [10, 4],
                [4, 10],
                [10, 10],
            ].map(([x, y]) => 8 + (x! - 8) * Math.cos(a) - (y! - 8) * Math.sin(a));
            const left = Math.min(2, ...xs);
            const right = Math.max(10, ...xs);
            const byHand = `<linearGradient id="h" gradientUnits="userSpaceOnUse" x1="${left}" x2="${right}">${stops}</linearGradient>`;
            expectRendersLike(svg, doc(byHand, `<g transform="translate(1 3)">${shapes('fill="url(#h)"', '')}</g>`));
        });

        it('objectBoundingBox stroke (the geometry box, not the stroke extent)', () => {
            const ring = (paint: string): string =>
                `<rect x="2" y="2" width="8" height="8" fill="none" stroke="${paint}" stroke-width="2"/>` +
                `<rect x="12" y="12" width="8" height="8" fill="none" stroke="${paint}" stroke-width="2"/>`;
            const svg = doc(`${obb}<g id="t">${ring('context-stroke')}</g>`, '<use href="#t" stroke="url(#lg)"/>');
            const byHand = `<linearGradient id="h" gradientUnits="userSpaceOnUse" x1="2" x2="20">${stops}</linearGradient>`;
            expectRendersLike(svg, doc(byHand, ring('url(#h)')));
        });

        it('objectBoundingBox radial fill', () => {
            const two = (paint: string): string =>
                `<rect x="2" y="2" width="8" height="20" fill="${paint}"/><rect x="12" y="2" width="8" height="20" fill="${paint}"/>`;
            const svg = doc(`${radial}<g id="t">${two('context-fill')}</g>`, '<use href="#t" fill="url(#rg)"/>');
            // Box (2, 2) 18×20: the gradient's ellipse, by hand.
            const byHand = `<radialGradient id="h" gradientUnits="userSpaceOnUse" cx="0.5" cy="0.5" r="0.5" gradientTransform="matrix(18 0 0 20 2 2)">${stops}</radialGradient>`;
            expectRendersLike(svg, doc(byHand, two('url(#h)')));
        });

        it('userSpaceOnUse fill and stroke, in the use space through the shapes transforms', () => {
            const paint = 'stroke-width="1.5"';
            const svg = doc(
                `${user}${shapes(`fill="context-fill" stroke="context-stroke" ${paint}`)}`,
                '<use href="#t" fill="url(#lu)" stroke="url(#lu)"/>',
            );
            expectRendersLike(svg, doc(user, shapes(`fill="url(#lu)" stroke="url(#lu)" ${paint}`, '')));
        });

        // SVG 2 §5.6.2: the use's user space includes its `transform` and its x / y offset (Chromium agrees).
        for (const [label, use, space] of [
            ['x / y offset', 'x="6" y="2"', 'translate(6 2)'],
            ['transform', 'transform="scale(0.5)"', 'scale(0.5)'],
            ['transform and x / y offset', 'transform="rotate(10 12 12)" x="5"', 'rotate(10 12 12) translate(5 0)'],
        ] as const)
            it(`userSpaceOnUse fill, in the use space with its ${label}`, () => {
                const svg = doc(`${user}${shapes('fill="context-fill"')}`, `<use href="#t" ${use} fill="url(#lu)"/>`);
                expectRendersLike(svg, doc(user, `<g transform="${space}">${shapes('fill="url(#lu)"', '')}</g>`));
            });

        it('userSpaceOnUse fill on a symbol with a viewBox: in the use space, outside the viewBox scale', () => {
            const symbol = `<symbol id="s" viewBox="0 0 12 12">${shapes('fill="context-fill"', '')}</symbol>`;
            const svg = doc(`${user}${symbol}`, '<use href="#s" x="6" width="24" height="24" fill="url(#lu)"/>');
            // In the symbol's space (scaled by 2), the use-space gradient spans half the coordinates.
            const half = `<linearGradient id="h" gradientUnits="userSpaceOnUse" x1="1" y1="0" x2="11" y2="3">${stops}</linearGradient>`;
            expectRendersLike(
                svg,
                doc(half, `<g transform="translate(6 0) scale(2)">${shapes('fill="url(#h)"', '')}</g>`),
            );
        });

        it('keeps the warning for a pattern (wpt paint-context-008), a nested context server, an unmeasurable box', () => {
            const pattern =
                '<pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#f00"/></pattern>';
            for (const optimize of [false, true]) {
                const codes = (svg: string): string[] => convert(svg, { optimize }).warnings.map((w) => w.code);
                expect(
                    codes(doc(`${pattern}${rect('fill="context-fill"')}`, '<use href="#r" fill="url(#p)"/>')),
                ).toEqual(['unsupported-paint']);
                // The inner use passes on the outer use's gradient: whose box lays it out is ambiguous.
                const nested = `${obb}${rect('fill="context-fill"')}<g id="mid"><use href="#r" fill="context-fill"/></g>`;
                expect(codes(doc(nested, '<use href="#mid" fill="url(#lg)"/>'))).toEqual(['unsupported-paint']);
                const nestedUser = `${user}${rect('fill="context-fill"')}<g id="mid"><use href="#r" fill="context-fill"/></g>`;
                expect(codes(doc(nestedUser, '<use href="#mid" x="1" fill="url(#lu)"/>'))).toEqual([
                    'unsupported-paint',
                ]);
                // A nested <svg> in the content: its box is not measured.
                const inner = '<svg x="12" width="10" height="10"><rect width="5" height="5"/></svg>';
                expect(
                    codes(
                        doc(
                            `${obb}<g id="t">${rect('fill="context-fill"')}${inner}</g>`,
                            '<use href="#t" fill="url(#lg)"/>',
                        ),
                    ),
                ).toEqual(['unsupported-paint']);
            }
        });

        it('falls back like a direct paint for an unknown gradient (fallback color)', () => {
            const { xml, codes } = run(doc(rect('fill="context-fill"'), '<use href="#r" fill="url(#nope) #0f0"/>'));
            expect(codes).toEqual([]);
            expect(xml).toContain('android:fillColor="#FF00FF00"');
        });
    });

    it('keeps the warning outside a <use> instance', () => {
        const { codes } = run(doc('', rect('fill="context-fill"')));
        expect(codes).toEqual(['unsupported-paint']);
        // Rendered directly (not through the use), the target has no context element either.
        expect(run(doc('', `${rect('fill="context-fill"')}<use href="#r" fill="#00f"/>`)).codes).toEqual([
            'unsupported-paint',
        ]);
    });
});

describe('resolveUses — <symbol> size', () => {
    it('ignores CSS width / height on the <symbol>: its attributes size the viewport (wpt use-symbol-inline-css-003)', () => {
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs>' +
            '<symbol id="sym" width="100" height="100" style="width:150px;height:150px">' +
            '<rect width="200" height="200" fill="green"/></symbol></defs><use href="#sym"/></svg>';
        const { xml } = convert(svg, { optimize: false });
        expect(xml).toContain('<clip-path android:pathData="M0,0h100v100h-100z" />');
    });
});

describe('resolveUses — expansion budget', () => {
    /** `levels` nested groups of `fanout` `<use>` each: fanout^levels instances of one path. */
    const bomb = (levels: number, fanout: number): string => {
        let defs = '<path id="u0" d="M0 0h1v1z"/>';
        for (let i = 1; i <= levels; i++) defs += `<g id="u${i}">${`<use href="#u${i - 1}"/>`.repeat(fanout)}</g>`;
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs>${defs}</defs><use href="#u${levels}"/></svg>`;
    };

    it('refuses a document whose <use> nesting multiplies past the budget', () => {
        const started = performance.now();
        expect(() => convert(bomb(9, 10), { optimize: false })).toThrow(`exceeds ${MAX_EXPANDED_NODES} elements`);
        // A bound against the blow-up (10^9 instances without the budget), not a benchmark: ~70 ms alone.
        expect(performance.now() - started).toBeLessThan(10_000);
    }, 30_000);

    it('still expands a large but bounded document', () => {
        const { xml } = convert(bomb(3, 10), { optimize: false });
        expect(xml.match(/<path/g)).toHaveLength(1000);
    });
});

describe('resolveUses — <symbol> and <use> x / y (SVG 2 §5.6)', () => {
    const doc = (viewBox: string, body: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="${viewBox}">${body}</svg>`;
    const green = '<rect width="200" height="200" fill="green"/>';
    const rect = (x: number, y: number, w: number, h: number): string =>
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="green"/>`;

    // Expected renderings checked in Chromium (headless shell) against the source.
    for (const [label, source, expected] of [
        [
            'symbol x / y without viewBox: clip moved with the content',
            doc(
                '0 0 100 100',
                `<defs><symbol id="s" x="50" y="40" width="30" height="20">${green}</symbol></defs><use href="#s"/>`,
            ),
            doc('0 0 100 100', rect(50, 40, 30, 20)),
        ],
        [
            'symbol x / y with viewBox: translate around the scale',
            doc(
                '0 0 100 100',
                '<defs><symbol id="s" x="50" y="40" width="40" height="40" viewBox="0 0 10 10"><rect width="5" height="20" fill="green"/></symbol></defs><use href="#s"/>',
            ),
            doc('0 0 100 100', rect(50, 40, 20, 40)),
        ],
        [
            'symbol x / y with overflow="visible"',
            doc(
                '0 0 100 100',
                '<defs><symbol id="s" x="50" y="40" width="10" height="10" overflow="visible"><rect width="30" height="30" fill="green"/></symbol></defs><use href="#s"/>',
            ),
            doc('0 0 100 100', rect(50, 40, 30, 30)),
        ],
        [
            'use x / y add to the symbol x / y',
            doc(
                '0 0 100 100',
                `<defs><symbol id="s" x="20" y="5" width="30" height="30">${green}</symbol></defs><use href="#s" x="10" y="15"/>`,
            ),
            doc('0 0 100 100', rect(30, 20, 30, 30)),
        ],
        [
            'symbol x / y in % of the root viewport',
            doc(
                '0 0 200 100',
                `<defs><symbol id="s" x="50%" y="25%" width="20" height="20">${green}</symbol></defs><use href="#s"/>`,
            ),
            doc('0 0 200 100', rect(100, 25, 20, 20)),
        ],
        [
            'symbol x in % of the nested <svg> viewport of the use',
            doc(
                '0 0 100 100',
                `<defs><symbol id="s" x="50%" width="10" height="10">${green}</symbol></defs><svg width="40" height="40"><use href="#s"/></svg>`,
            ),
            doc('0 0 100 100', rect(20, 0, 10, 10)),
        ],
        [
            'use x / y with units and percentages',
            doc(
                '0 0 100 100',
                '<defs><rect id="r" width="10" height="10" fill="green"/></defs>' +
                    '<use href="#r" x="10px"/><use href="#r" x="1cm" y="30"/><use href="#r" x="50%" y="5"/>',
            ),
            doc('0 0 100 100', rect(10, 0, 10, 10) + rect(96 / 2.54, 30, 10, 10) + rect(50, 5, 10, 10)),
        ],
        [
            'a <use> inside <defs> resolves its % against the viewport it is instanced in',
            doc(
                '0 0 100 100',
                '<defs><symbol id="s" viewBox="0 0 1 1"><rect width="1" height="1" fill="green"/></symbol>' +
                    '<g id="g"><use href="#s" width="50%" height="50%"/></g></defs>' +
                    '<svg width="50" height="50" viewBox="0 0 200 200"><use href="#g"/></svg>',
            ),
            doc('0 0 100 100', rect(0, 0, 25, 25)),
        ],
    ] as const)
        for (const optimize of [false, true])
            it(`${label} (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(source, { optimize, strict: true });
                expect(warnings).toEqual([]);
                const result = compareSvgs(expected, vdToSvg(xml));
                expect(result.sizeMismatch).toBeNull();
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

    /** Resolves `<use href="#r" …>` in a 100×100 viewport and returns the replacement's transform. */
    const useTransform = (useAttrs: Record<string, string>): string | undefined => {
        const tree = root([
            el('svg', { viewBox: '0 0 100 100' }, [
                el('defs', {}, [el('rect', { id: 'r' })]),
                el('use', { href: '#r', ...useAttrs }),
            ]),
        ]);
        resolveUses(tree);
        return onlyChild(tree).children?.[1]?.attributes?.transform;
    };

    it.each([
        [{ x: '10px' }, 'translate(10 0)'],
        [{ x: '1cm' }, `translate(${96 / 2.54} 0)`],
        [{ x: '50%' }, 'translate(50 0)'],
        [{ x: '50%', y: '5' }, 'translate(50 5)'],
        [{ y: '1em' }, 'translate(0 16)'],
    ])('writes the use %o as numbers: %s', (attrs, expected) => {
        expect(useTransform(attrs)).toBe(expected);
    });

    /** Resolves `<use href="#s" …>` of a symbol in a 100×100 viewport and returns the wrapper. */
    const symbolWrapper = (
        symbolAttrs: Record<string, string>,
        useAttrs: Record<string, string>,
        report?: (w: { code: string; message: string }) => void,
    ): XastElement => {
        const tree = root([
            el('svg', { viewBox: '0 0 100 100' }, [
                el('defs', {}, [el('symbol', { id: 's', ...symbolAttrs }, [el('path', { d: 'M0 0h1v1h-1z' })])]),
                el('use', { href: '#s', ...useAttrs }),
            ]),
        ]);
        resolveUses(tree, report);
        return onlyChild(tree).children?.[1] as XastElement;
    };

    it('translates the symbol viewport by its x / y inside the use wrapper, and drops them', () => {
        const wrapper = symbolWrapper(
            { x: '20%', y: '3', width: '10', height: '10' },
            { x: '1', transform: 'rotate(90)', 'clip-path': 'url(#c)' },
        );
        // The use's clip-path stays in the use's space: the symbol offset is on an inner group.
        expect(wrapper.attributes?.transform).toBe('rotate(90) translate(1 0)');
        expect(wrapper.attributes?.['clip-path']).toBe('url(#c)');
        const offset = onlyChild(wrapper);
        expect(offset.attributes).toEqual({ transform: 'translate(20 3)' });
        const clipGroup = onlyChild(offset);
        expect(clipGroup.attributes?.['clip-path']).toMatch(/^url\(#svgvd-symbol-viewport-/);
        const symbolAsGroup = clipGroup.children?.find((c) => c.name === 'g') as XastElement;
        expect(symbolAsGroup.attributes?.x).toBeUndefined();
        expect(symbolAsGroup.attributes?.y).toBeUndefined();
    });

    it('also offsets a symbol whose viewport size is unresolved', () => {
        const wrapper = symbolWrapper({ x: '5', y: '6', viewBox: '0 0 1 1' }, { width: '2ex' }, () => undefined);
        expect(onlyChild(wrapper).attributes).toEqual({ transform: 'translate(5 6)' });
    });

    it('adds no group for a symbol without x / y, nor for an empty viewport', () => {
        expect(onlyChild(symbolWrapper({ width: '10', height: '10' }, {})).attributes?.transform).toBeUndefined();
        expect(symbolWrapper({ x: '5', width: '0', height: '10' }, {}).children).toEqual([]);
    });

    for (const [label, useAttrs] of [
        ['use x="2ex"', { x: '2ex' }],
        ['use y="calc(1px)"', { y: 'calc(1px)' }],
    ] as const)
        it(`reports an unresolved ${label} (unsupported-attribute) and takes 0`, () => {
            const tree = root([
                el('svg', { viewBox: '0 0 100 100' }, [
                    el('defs', {}, [el('rect', { id: 'r' })]),
                    el('use', { href: '#r', ...useAttrs }),
                ]),
            ]);
            const warnings: { code: string; message: string }[] = [];
            resolveUses(tree, (w) => warnings.push(w));
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
            expect(warnings[0]?.message).toContain('taken as 0');
            expect(onlyChild(tree).children?.[1]?.attributes?.transform).toBe('translate(0 0)');
        });

    it('reports an unresolved symbol x="1ch" (unsupported-attribute) and takes 0', () => {
        const warnings: { code: string; message: string }[] = [];
        const wrapper = symbolWrapper({ x: '1ch', width: '10', height: '10' }, {}, (w) => warnings.push(w));
        expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
        expect(warnings[0]?.message).toContain('x="1ch" on <symbol>');
        expect(onlyChild(wrapper).attributes).toEqual({ transform: 'translate(0 0)' });
    });

    for (const optimize of [false, true])
        it(`rejects an unresolved use / symbol x in strict mode (optimize: ${optimize})`, () => {
            for (const body of [
                '<defs><rect id="r" width="10" height="10"/></defs><use href="#r" x="2ex"/>',
                '<defs><symbol id="r" x="2ex" width="10" height="10"><rect width="10" height="10"/></symbol></defs><use href="#r"/>',
            ])
                expect(() => convert(doc('0 0 100 100', body), { optimize, strict: true })).toThrow(/x="2ex"/);
        });

    it('reports a % use x against an unknown viewport', () => {
        const tree = root([
            el('svg', {}, [el('defs', {}, [el('rect', { id: 'r' })]), el('use', { href: '#r', x: '50%' })]),
        ]);
        const codes: string[] = [];
        resolveUses(tree, (w) => codes.push(w.code));
        expect(codes).toEqual(['unsupported-attribute']);
    });

    // Chrome draws these at (0, 0): an invalid x / y is the initial value, 0.
    for (const [label, body] of [
        ['use x=""', `<defs><rect id="r" width="10" height="10" fill="green"/></defs><use href="#r" x=""/>`],
        ['use x="foo"', `<defs><rect id="r" width="10" height="10" fill="green"/></defs><use href="#r" x="foo"/>`],
        ['use y=""', `<defs><rect id="r" width="10" height="10" fill="green"/></defs><use href="#r" y=""/>`],
        ['symbol x=""', `<defs><symbol id="s" x="" width="10" height="10">${green}</symbol></defs><use href="#s"/>`],
        [
            'symbol x="foo"',
            `<defs><symbol id="s" x="foo" width="10" height="10">${green}</symbol></defs><use href="#s"/>`,
        ],
        ['symbol y=""', `<defs><symbol id="s" y="" width="10" height="10">${green}</symbol></defs><use href="#s"/>`],
    ] as const)
        for (const optimize of [false, true])
            it(`takes an invalid ${label} as 0 without warning, strict (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(doc('0 0 100 100', body), { optimize, strict: true });
                expect(warnings).toEqual([]);
                const result = compareSvgs(doc('0 0 100 100', rect(0, 0, 10, 10)), vdToSvg(xml));
                expect(result.sizeMismatch).toBeNull();
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

    for (const optimize of [false, true])
        it(`reports an unresolved x once per symbol, whatever its number of <use> (optimize: ${optimize})`, () => {
            const symbol = (id: string): string =>
                `<symbol id="${id}" x="1ex" width="10" height="10"><rect width="10" height="10"/></symbol>`;
            const warningsOf = (body: string): string[] =>
                convert(doc('0 0 100 100', body), { optimize }).warnings.map((w) => w.message);
            const one = warningsOf(
                `<defs>${symbol('s')}</defs><use href="#s"/><use href="#s" y="20"/><use href="#s" y="40"/>`,
            );
            expect(one).toHaveLength(1);
            expect(one[0]).toContain('x="1ex" on <symbol>');
            const two = warningsOf(
                `<defs>${symbol('s')}${symbol('t')}</defs><use href="#s"/><use href="#t"/><use href="#s"/>`,
            );
            expect(two).toHaveLength(2);
        });

    for (const optimize of [false, true])
        it(`writes the same offsets in both modes, strict (optimize: ${optimize})`, () => {
            const source = doc(
                '0 0 100 100',
                '<defs><rect id="r" width="10" height="10" fill="green"/></defs><use href="#r" x="50%" y="5"/>',
            );
            const { xml, warnings } = convert(source, { optimize, strict: true });
            expect(warnings).toEqual([]);
            expect(xml).toMatch(/android:translateX="50"/);
            expect(xml).toMatch(/android:translateY="5"/);
        });
});
