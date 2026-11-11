import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convert, ConversionError } from '../src/index.js';
import type { XastElement } from '../src/ast.js';
import { parseSvg } from '../src/normalize.js';
import { vdToSvg } from './visual/vdToSvg.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';

const svg = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">${inner}</svg>`;

// Dense, same-style, touching unit squares: the worst case for svgo's mergePaths.
const grid = (n: number): string => {
    let out = '';
    for (let i = 0; i < n; i++) {
        out += `<path fill="#333" d="M${i % 1000} ${Math.floor(i / 10) % 1000}h1v1h-1z"/>`;
    }
    return out;
};

const countPaths = (xml: string): number => xml.split('<path').length - 1;

const twoMergeable = '<path fill="#f00" d="M0 0h10v10H0z"/><path fill="#f00" d="M20 0h10v10H20z"/>';

describe('normalize: mergePaths threshold', () => {
    it('merges adjacent same-style paths on small inputs', () => {
        expect(countPaths(convert(svg(twoMergeable)).xml)).toBe(1);
    });

    it('skips mergePaths above the threshold', () => {
        expect(countPaths(convert(svg(grid(600))).xml)).toBe(600);
    });

    it('ignores drawable tags inside comments when counting', () => {
        const xml = convert(svg(`<!--${grid(600)}-->${twoMergeable}`)).xml;
        expect(countPaths(xml)).toBe(1);
    });

    it('converts 10,000 paths with optimize:true in near-linear time', () => {
        const input = svg(grid(10_000));
        const start = performance.now();
        const { xml } = convert(input);
        const elapsed = performance.now() - start;
        expect(countPaths(xml)).toBe(10_000);
        // ~0.5-1.7 s locally (24.6 s before the threshold). The path count above is the deterministic
        // check; this bound only catches a return of the quadratic blow-up on a loaded CI runner.
        expect(elapsed).toBeLessThan(8_000);
    }, 20_000);
});

describe('normalize: convertPathData threshold', () => {
    const zigzag = (n: number): string => `<path fill="none" stroke="#000" d="M0 0${'l1 1l1-1'.repeat(n / 2)}"/>`;

    it('keeps svgo path optimization on ordinary paths', () => {
        // svgo rewrites `L10 0` as the shorter `h10`.
        expect(convert(svg('<path d="M0 0L10 0L10 10z"/>')).xml).toContain('android:pathData="M0 0h10v10z"');
    });

    it('converts a 40,000-segment path with optimize:true in near-linear time', () => {
        const input = svg(zigzag(40_000));
        const start = performance.now();
        const { xml } = convert(input);
        const elapsed = performance.now() - start;
        // Same geometry as without svgo: the path is emitted as authored.
        expect(xml).toBe(convert(input, { optimize: false }).xml);
        // ~0.1 s locally (about 10 s with convertPathData on); the bound only catches the blow-up.
        expect(elapsed).toBeLessThan(5_000);
    }, 30_000);
});

describe('normalize: user svgoConfig', () => {
    it('is used as-is: mergePaths stays on for large inputs', () => {
        const svgoConfig = { plugins: ['preset-default' as const] };
        expect(countPaths(convert(svg(grid(600)), { svgoConfig }).xml)).toBe(1);
    });

    it('is used as-is: mergePaths can be turned off for small inputs', () => {
        const svgoConfig = {
            plugins: [{ name: 'preset-default' as const, params: { overrides: { mergePaths: false as const } } }],
        };
        expect(countPaths(convert(svg(twoMergeable), { svgoConfig }).xml)).toBe(2);
    });
});

describe('normalize: floatPrecision', () => {
    const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

    /** Attributes of the first `<path>` in svgo's output tree. */
    const firstPath = (inner: string, floatPrecision?: number): Record<string, string> => {
        const find = (node: XastElement): XastElement | undefined =>
            node.name === 'path' ? node : (node.children ?? []).map(find).find(Boolean);
        const root = parseSvg(svg(inner), true, undefined, floatPrecision);
        return find({ type: 'root', children: root.children })?.attributes ?? {};
    };

    it('keeps svgo at 3 decimals by default', () => {
        expect(firstPath('<path d="M2.123456 2L10.987654 3.333333z"/>').d).toBe('m2.123 2 8.865 1.333z');
    });

    it('hands a precision above 3 to svgo', () => {
        expect(firstPath('<path d="M2.123456 2L10.987654 3.333333z"/>', 6).d).toBe('m2.123456 2 8.864198 1.333333z');
    });

    it('applies it to shapes converted to paths', () => {
        const rect = '<rect x="1.123456" y="2.654321" width="3.111111" height="4.222222"/>';
        expect(firstPath(rect, 6).d).toBe('M1.123456 2.654321h3.111111v4.222222H1.123456z');
    });

    it('keeps baked transforms finer than coordinates', () => {
        // The stroke scale goes through svgo's transformPrecision (5 by default): 1.23457 × 1.123456
        // would give 1.386987 instead of 1.386983.
        const scaled =
            '<g transform="scale(1.23456789)"><path fill="none" stroke="#000" stroke-width="1.123456" d="M1.111111 1L5 5"/></g>';
        const path = firstPath(scaled, 6);
        expect(path.d).toBe('m1.371742 1.234568 4.801097 4.938271');
        expect(Number(path['stroke-width']).toFixed(6)).toBe('1.386983');
    });

    it('never lets svgo fall back to integer rounding at the upper bound', () => {
        expect(firstPath('<path d="M2.123456 2L10.987654 3.333333z"/>', 20).d).toBe('M2.123456 2 10.987654 3.333333z');
    });

    it('leaves svgo untouched at 3 and below', () => {
        for (const file of readdirSync(fixtures).filter((f) => f.endsWith('.svg'))) {
            const source = readFileSync(join(fixtures, file), 'utf8');
            const reference = JSON.stringify(parseSvg(source, true));
            for (const floatPrecision of [0, 1, 2, 3])
                expect(JSON.stringify(parseSvg(source, true, undefined, floatPrecision)), file).toBe(reference);
        }
    });

    it('does not touch a caller-supplied svgoConfig', () => {
        const root = parseSvg(
            svg('<path d="M2.123456 2L10.987654 3.333333z"/>'),
            true,
            { plugins: ['preset-default'] },
            6,
        );
        expect(JSON.stringify(root)).toContain('"d":"m2.123 2 8.865 1.333z"');
    });
});

describe('convert() forwards floatPrecision to svgo', () => {
    const input =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2.123456 2L10.987654 3.333333z"/></svg>';

    it('keeps 6 decimals with optimize: true', () => {
        expect(convert(input, { floatPrecision: 6 }).xml).toContain('2.123456');
    });

    it('keeps the default 3-decimal output', () => {
        const xml = convert(input).xml;
        expect(xml).toContain('2.123');
        expect(xml).not.toContain('2.1234');
    });
});

const wptRepro = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`wpt-repro/${name}`, import.meta.url)), 'utf8');

/** Names of the elements in svgo's output tree, depth first. */
const elementNames = (input: string): string[] => {
    const names: string[] = [];
    const walk = (node: { children?: XastElement[] }): void => {
        for (const child of node.children ?? []) {
            if (child.type !== 'element' || child.name === undefined) continue;
            names.push(child.name);
            walk(child);
        }
    };
    walk(parseSvg(input, true));
    return names;
};

describe('normalize: shapes with a negative size are not drawn', () => {
    it('wpt-negative-size-shape.svg: optimize: true matches optimize: false and its blank source', () => {
        const source = wptRepro('wpt-negative-size-shape.svg');
        const reference = convert(source, { optimize: false });
        for (const optimize of [true, false]) {
            const { xml, warnings } = convert(source, { optimize });
            expect(xml).toBe(reference.xml);
            expect(countPaths(xml)).toBe(0);
            expect(warnings.map((w) => w.code)).toEqual(['empty-path', 'empty-path']);
            const result = compareSvgs(source, vdToSvg(xml));
            expect(result.sizeMismatch).toBeNull();
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        }
    });

    it('wpt-negative-size-shape.svg: strict rejects it with empty-path in both modes', () => {
        const source = wptRepro('wpt-negative-size-shape.svg');
        for (const optimize of [true, false]) {
            let error: unknown;
            try {
                convert(source, { optimize, strict: true });
            } catch (err) {
                error = err;
            }
            expect(error).toBeInstanceOf(ConversionError);
            expect((error as ConversionError).warning.code).toBe('empty-path');
        }
    });

    for (const shape of [
        '<rect width="-10" height="10"/>',
        '<rect width="10" height="-10"/>',
        '<rect width="10" height=" -10"/>',
        "<circle cx='50' cy='50' r='-5'/>",
        '<ellipse cx="50" cy="50" rx="-5" ry="10"/>',
        '<ellipse cx="50" cy="50" rx="5" ry="-10"/>',
    ]) {
        it(`skips ${shape}`, () => {
            const { xml, warnings } = convert(svg(shape));
            expect(countPaths(xml)).toBe(0);
            // The 1000×1000 viewport adds `large-vector`.
            expect(warnings.map((w) => w.code)).toEqual(['empty-path', 'large-vector']);
        });
    }

    it('keeps converting shapes to paths otherwise (a negative stroke-width does not count)', () => {
        expect(elementNames(svg('<rect stroke="#000" stroke-width="-1" width="10" height="10"/>'))).toEqual([
            'svg',
            'path',
        ]);
    });
});

describe('normalize: pathLength on basic shapes', () => {
    const dashed = 'fill="none" stroke="#000" stroke-width="10" stroke-dasharray="1 1" pathLength="4"';

    it('wpt-pathlength-shape.svg: optimize: true emits the dashes of optimize: false', () => {
        const source = wptRepro('wpt-pathlength-shape.svg');
        const { xml } = convert(source);
        expect(xml).toBe(convert(source, { optimize: false }).xml);
        // Perimeter 200, pathLength 4: dashes and gaps of 50, offset by 50 → the right and left sides.
        expect(xml).toContain('android:pathData="M60 10L60 60M10 60L10 10"');
    });

    for (const shape of [
        `<rect x="10" y="10" width="200" height="100" ${dashed}/>`,
        `<line x1="10" y1="10" x2="210" y2="10" ${dashed}/>`,
        `<polyline points="10 10 210 10 210 110" ${dashed}/>`,
        `<polygon points="10 10 210 10 210 110" ${dashed}/>`,
        `<circle cx="100" cy="100" r="50" ${dashed}/>`,
        `<ellipse cx="100" cy="100" rx="80" ry="50" ${dashed}/>`,
    ]) {
        it(`keeps it on ${shape.slice(0, shape.indexOf(' '))}>`, () => {
            const input = svg(shape);
            expect(convert(input).xml).toBe(convert(input, { optimize: false }).xml);
        });
    }

    it('does not merge paths that each carry a pathLength', () => {
        const path = (y: number): string => `<path d="M10 ${y}h200" ${dashed}/>`;
        const input = svg(path(10) + path(50));
        expect(convert(input).xml).toBe(convert(input, { optimize: false }).xml);
    });
});

describe('normalize: CSS transform, transform-origin, transform-box', () => {
    /** Attributes of the first `<path>` in svgo's output tree. */
    const firstPath = (input: string, floatPrecision?: number): Record<string, string> => {
        const find = (node: XastElement): XastElement | undefined =>
            node.name === 'path' ? node : (node.children ?? []).map(find).find(Boolean);
        return (
            find({ type: 'root', children: parseSvg(input, true, undefined, floatPrecision).children })?.attributes ??
            {}
        );
    };
    const group = (style: string): string =>
        svg(`<g transform="translate(10 20)"${style}><path d="M0 0h10v10H0z"/></g>`);

    it('keeps group transforms where they are authored when one may be set', () => {
        expect(elementNames(group(''))).toEqual(['svg', 'path']);
        for (const style of [
            ' style="transform: scale(2)"',
            ' style="transform-origin: 5px 5px"',
            ' transform-origin="5 5"',
            ' style="transform-box: view-box"',
        ])
            expect(elementNames(group(style)), style).toEqual(['svg', 'g', 'path']);
    });

    it('keeps transform-origin on the group', () => {
        const root = parseSvg(group(' transform-origin="5 5"'), true);
        expect(JSON.stringify(root)).toContain('"transform-origin":"5 5"');
    });

    it('does not bake transforms into path data, even at a higher floatPrecision', () => {
        const input = svg('<path transform="rotate(90)" transform-origin="5 5" d="M0 0h10v10H0z"/>');
        for (const floatPrecision of [3, 6]) expect(firstPath(input, floatPrecision).transform).toBeDefined();
        expect(firstPath(svg('<path transform="translate(1 1)" d="M0 0h10v10H0z"/>')).transform).toBeUndefined();
    });

    it('keeps a long path as authored (convertPathData stays off)', () => {
        const d = `M0 0${'l1 1l1-1'.repeat(7_000)}`;
        expect(firstPath(svg(`<path style="transform: scale(2)" d="${d}"/>`)).d).toBe(d);
    });

    it('is not triggered by a property merely ending in transform', () => {
        expect(
            elementNames(
                svg('<g transform="translate(10 20)" style="-webkit-transform: none"><path d="M0 0h10"/></g>'),
            ),
        ).toEqual(['svg', 'path']);
    });
});
