import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { resolveUses } from '../src/useResolver.js';
import type { XastElement } from '../src/gradient.js';

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

    it('leaves a symbol without viewBox exactly as before, even with a use size', () => {
        const wrapper = resolveSymbol({}, { x: '2', y: '3', width: '10', height: '10' });
        expect(wrapper.attributes).toEqual({ transform: 'translate(2 3)' });
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
