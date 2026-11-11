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

describe('normalize: shapes with a zero size warn in both modes', () => {
    const codes = (source: string, optimize: boolean): string[] =>
        convert(source, { optimize }).warnings.map((w) => w.code);

    for (const shape of [
        '<rect width="0" height="10"/>',
        '<rect width="10" height="0"/>',
        '<rect width="0.0" height="10"/>',
        "<circle cx='50' cy='50' r='0'/>",
        '<ellipse cx="50" cy="50" rx="0" ry="10"/>',
        '<ellipse cx="50" cy="50" rx="5" ry="0"/>',
    ]) {
        it(`${shape}: optimize: true emits the same warnings as optimize: false`, () => {
            const source = svg(`${shape}<path d="M0 0h10v10z"/>`);
            expect(codes(source, true)).toEqual(codes(source, false));
            // The 1000×1000 viewport adds `large-vector`.
            expect(codes(source, true)).toEqual(['empty-path', 'large-vector']);
            expect(countPaths(convert(source).xml)).toBe(1);
        });

        it(`${shape}: strict rejects it with empty-path in both modes`, () => {
            for (const optimize of [true, false]) {
                let error: unknown;
                try {
                    convert(svg(shape), { optimize, strict: true });
                } catch (err) {
                    error = err;
                }
                expect(error).toBeInstanceOf(ConversionError);
                expect((error as ConversionError).warning.code).toBe('empty-path');
            }
        });
    }

    it('keeps converting shapes to paths otherwise (a zero position does not count)', () => {
        expect(elementNames(svg('<rect x="0" y="0" width="10" height="10"/><circle cx="0" cy="0" r="5"/>'))).toEqual([
            'svg',
            'path',
            'path',
        ]);
    });
});

describe('normalize: elements with empty geometry warn in both modes', () => {
    const codes = (source: string, optimize: boolean): string[] =>
        convert(source, { optimize }).warnings.map((w) => w.code);

    for (const shape of [
        '<path d=""/>',
        "<path d=''/>",
        '<path fill="#f00"/>',
        '<polyline points=""/>',
        '<polygon points=""/>',
        '<polyline/>',
        '<polygon fill="#f00"/>',
        '<polyline points="10 10"/>',
        '<polygon points="10,10 20"/>',
        '<circle cx="50" cy="50"/>',
        '<circle cx="50" cy="50" style="r:0"/>',
        '<ellipse cx="50" cy="50" rx="5"/>',
        '<ellipse cx="50" cy="50" ry="5"/>',
    ]) {
        it(`${shape}: optimize: true emits the same warnings as optimize: false`, () => {
            const source = svg(`${shape}<path d="M0 0h10v10z"/>`);
            expect(codes(source, true)).toEqual(codes(source, false));
            // The 1000×1000 viewport adds `large-vector`.
            expect(codes(source, true)).toEqual(['empty-path', 'large-vector']);
            expect(countPaths(convert(source).xml)).toBe(1);
        });

        it(`${shape}: strict rejects it with empty-path in both modes`, () => {
            for (const optimize of [true, false]) {
                let error: unknown;
                try {
                    convert(svg(shape), { optimize, strict: true });
                } catch (err) {
                    error = err;
                }
                expect(error).toBeInstanceOf(ConversionError);
                expect((error as ConversionError).warning.code).toBe('empty-path');
            }
        });
    }

    it('keeps converting shapes to paths otherwise', () => {
        const names = elementNames(
            svg(
                '<path d="M0 0h1"/><polyline points="0 0 10 10"/><circle cx="5" cy="5" r="5"/><ellipse rx="5" ry="2"/>',
            ),
        );
        expect(names.filter((n) => n !== 'path')).toEqual(['svg']);
    });
});

describe('normalize: rgb() percentages', () => {
    // wpt painting/reftests/paint-fill-attr-rgb-percent-rounding.svg: 20% of 255 = 51 (0x33),
    // 50% = 127.5 → 128 (0x80); svgo's convertColors rounds 127.5 down to 0x7f.
    for (const paint of ['fill="rgb(20% 50% 50%)"', 'style="fill: rgb(20% 50% 50%)"', 'fill="rgb(20%, 50%, 50%)"']) {
        it(`${paint}: optimize: true matches optimize: false`, () => {
            const source = svg(`<rect width="120" height="120" x="10" y="10" ${paint}/>`);
            for (const optimize of [true, false])
                expect(convert(source, { optimize }).xml).toContain('android:fillColor="#FF338080"');
        });
    }

    it('keeps converting rgb() colors to hex otherwise', () => {
        const [path] = parseSvg(svg('<path fill="rgb(255, 0, 0)" d="M0 0h10v10z"/>'), true).children[0]!
            .children as XastElement[];
        expect(path!.attributes?.fill).toBe('red');
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

describe('normalize: explicit black fill with fillBlackForUnfilled: false', () => {
    /** Effective `fill` attribute of every `<path>` in svgo's output tree (inherited from ancestors). */
    const pathFills = (input: string, optimize: boolean, fillBlackForUnfilled?: boolean): (string | undefined)[] => {
        const out: (string | undefined)[] = [];
        const walk = (node: XastElement, inherited: string | undefined): void => {
            const fill = node.attributes?.fill ?? inherited;
            if (node.name === 'path') out.push(fill);
            for (const child of node.children ?? []) if (child.type === 'element') walk(child, fill);
        };
        const root = parseSvg(input, optimize, undefined, undefined, fillBlackForUnfilled);
        for (const child of root.children ?? []) if (child.type === 'element') walk(child, undefined);
        return out;
    };
    const square = (attrs: string, x = 0): string => `<path${attrs} d="M${x} 0h10v10H${x}z"/>`;
    const BLACK = /^(?:#000|#000000|black|rgb\(0,\s*0,\s*0\))$/;

    for (const black of ['#000', '#000000', 'black', 'rgb(0,0,0)', 'rgb(0, 0, 0)'])
        for (const optimize of [true, false]) {
            it(`keeps fill="${black}" on a path (optimize: ${optimize})`, () => {
                const fills = pathFills(svg(square(` fill="${black}"`)), optimize, false);
                expect(fills).toHaveLength(1);
                expect(fills[0]).toMatch(BLACK);
            });

            it(`keeps fill="${black}" on a group (optimize: ${optimize})`, () => {
                const fills = pathFills(svg(`<g fill="${black}">${square('')}${square('', 20)}</g>`), optimize, false);
                expect(fills.length).toBeGreaterThan(0); // mergePaths may join the two squares
                for (const fill of fills) expect(fill).toMatch(BLACK);
            });
        }

    it('keeps a black child fill overriding a colored parent fill', () => {
        const input = svg(`<g fill="#f00">${square('')}<g>${square(' fill="black"', 20)}</g></g>`);
        for (const fillBlackForUnfilled of [true, false])
            for (const optimize of [true, false]) {
                const [red, black] = pathFills(input, optimize, fillBlackForUnfilled);
                expect(red).toMatch(/^(?:#f00|red)$/);
                expect(black).toMatch(BLACK);
            }
    });

    it('leaves the default svgo config unchanged when fillBlackForUnfilled is true', () => {
        const input = svg(`<g fill="#000">${square(' stroke-width="1" fill-opacity="1" fill-rule="nonzero"')}</g>`);
        expect(parseSvg(input, true, undefined, undefined, true)).toEqual(parseSvg(input, true));
    });

    it('keeps the pathLength override (unknownAttrs: false) when both apply', () => {
        const input = svg('<rect width="10" height="10" fill="#000" stroke-dasharray="1 1" pathLength="4"/>');
        const json = JSON.stringify(parseSvg(input, true, undefined, undefined, false));
        expect(json).toContain('"pathLength":"4"');
        expect(json).toMatch(/"fill":"(?:#000|black)"/);
    });
});

describe('convert() keeps an explicit black fill with fillBlackForUnfilled: false', () => {
    const doc = (fill: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z" fill="${fill}"/></svg>`;

    for (const fill of ['#000', '#000000', 'black', 'rgb(0,0,0)'])
        it(`emits fill="${fill}" in both modes`, () => {
            for (const optimize of [true, false]) {
                const { xml } = convert(doc(fill), { optimize, fillBlackForUnfilled: false });
                expect(xml).toContain('android:fillColor="#FF000000"');
            }
        });
});

describe('normalize: curves are not rewritten as arcs (svgo makeArcs)', () => {
    // salute-developers/plasma, sdds-icons 16/MinusCircleOutline.svg: two rings drawn with cubics.
    // makeArcs turned the outer one into `a6.999 6.999 0 1 0 0 13.996` (radius and end point rounded
    // separately): the centre moved ~0.12 unit off the chord, 10 % of the inked pixels mismatched.
    const minusCircle =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path fill-rule="evenodd" clip-rule="evenodd" d="M2 7.99821C2 4.68561 4.68611 2 7.99987 2C11.3136 2 ' +
        '13.9997 4.68561 13.9997 7.99821C13.9997 11.3108 11.3136 13.9964 7.99987 13.9964C4.68611 13.9964 2 ' +
        '11.3108 2 7.99821ZM7.99987 1C4.13407 1 1 4.13308 1 7.99821C1 11.8633 4.13407 14.9964 7.99987 ' +
        '14.9964C11.8657 14.9964 14.9997 11.8633 14.9997 7.99821C14.9997 4.13308 11.8657 1 7.99987 1ZM3.78392 ' +
        '7.49854C3.50777 7.49854 3.28392 7.72239 3.28392 7.99854C3.28392 8.27468 3.50777 8.49854 3.78392 ' +
        '8.49854H12.2162C12.4923 8.49854 12.7162 8.27468 12.7162 7.99854C12.7162 7.72239 12.4923 7.49854 ' +
        '12.2162 7.49854H3.78392Z" fill="black"/></svg>';
    const pathData = (xml: string): string => xml.match(/android:pathData="([^"]*)"/)?.[1] ?? '';
    // Four cubic quarters of a circle of radius 7 centred on (12, 12).
    const cubicCircle =
        'd="M12 5C15.866 5 19 8.134 19 12C19 15.866 15.866 19 12 19C8.134 19 5 15.866 5 12C5 8.134 8.134 5 12 5Z"';

    it('plasma MinusCircleOutline renders like its source (< 1 % mismatch)', () => {
        const { xml } = convert(minusCircle, { floatPrecision: 3, fillBlackForUnfilled: true });
        const result = compareSvgs(minusCircle, vdToSvg(xml));
        expect(result.inked).toBeGreaterThan(0);
        expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        expect(pathData(xml)).not.toMatch(/a/i);
    });

    it('keeps cubics as cubics alongside the other convertPathData overrides', () => {
        const doc = (attrs: string): string =>
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path ${attrs} ${cubicCircle}/></svg>`;
        for (const attrs of ['', 'style="transform: scale(0.5)"'])
            for (const floatPrecision of [3, 6]) {
                const d = pathData(convert(doc(attrs), { floatPrecision }).xml);
                expect(d, `${attrs} / ${floatPrecision}`).toMatch(/c/i);
                expect(d, `${attrs} / ${floatPrecision}`).not.toMatch(/a/i);
            }
    });

    it('still emits arcs for circles and authored arcs', () => {
        const doc = (inner: string): string =>
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;
        expect(pathData(convert(doc('<circle cx="12" cy="12" r="7"/>')).xml)).toMatch(/a/i);
        expect(pathData(convert(doc('<path d="M5 12a7 7 0 0 1 14 0z"/>')).xml)).toMatch(/a/i);
    });
});

describe('normalize: <symbol> geometry (SVG 2) survives svgo', () => {
    // svgo's removeUnknownsAndDefaults strips x / y / width / height from <symbol> (SVG 1.1).
    const doc = (symbolAttrs: string): string =>
        '<svg width="500" height="500" xmlns="http://www.w3.org/2000/svg"><defs>' +
        `<symbol id="sym" ${symbolAttrs}><rect width="400" height="400" fill="green"/></symbol>` +
        '</defs><use href="#sym"/></svg>';
    const green100 =
        '<svg width="500" height="500" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="100" height="100" fill="green"/></svg>';
    const render = (input: string, optimize: boolean): string => vdToSvg(convert(input, { optimize }).xml);

    it('clips a symbol without viewBox to its width / height in both modes', () => {
        const input = doc('width="100" height="100"');
        for (const optimize of [true, false]) {
            const result = compareSvgs(green100, render(input, optimize));
            expect(result.inked, `optimize: ${optimize}`).toBeGreaterThan(0);
            expect(result.mismatch, `optimize: ${optimize}`).toBe(0);
        }
    });

    it('keeps x / y / width / height on the symbol in svgo output', () => {
        const json = JSON.stringify(parseSvg(doc('x="1" y="2" width="100" height="100"'), true));
        for (const attr of ['"x":"1"', '"y":"2"', '"width":"100"', '"height":"100"']) expect(json).toContain(attr);
    });

    it('renders a symbol with viewBox alike in both modes', () => {
        for (const attrs of ['viewBox="0 0 800 800"', 'viewBox="0 0 800 800" width="100" height="100"']) {
            const input = doc(attrs);
            const result = compareSvgs(render(input, false), render(input, true));
            expect(result.inked, attrs).toBeGreaterThan(0);
            expect(result.mismatch, attrs).toBe(0);
        }
    });
});

const icon = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;
/** Distinct fill / stroke colors of a VectorDrawable (svgo may merge same-paint paths). */
const fillColors = (xml: string): string[] => [
    ...new Set([...xml.matchAll(/android:(?:fill|stroke)Color="([^"]*)"/g)].map((m) => m[1]!)),
];

describe('normalize: a descendant made visible from CSS survives a hidden group', () => {
    const rect = '<rect width="10" height="10" fill="#0f0"/>';
    const visible = (attrs: string): string => rect.replace('<rect', `<rect ${attrs}`);

    for (const optimize of [true, false])
        it(`style attribute: the rect is drawn (optimize: ${optimize})`, () => {
            const input = icon(`<g visibility="hidden">${visible('style="visibility:visible"')}</g>`);
            const { xml, warnings } = convert(input, { optimize });
            expect(warnings).toEqual([]);
            expect(fillColors(xml)).toEqual(['#FF00FF00']);
        });

    // `<style>` is only applied with optimize: true (svgo inlines it).
    it('<style> rule: the rect is drawn', () => {
        const input = icon(`<style>.v{visibility:visible}</style><g visibility="hidden">${visible('class="v"')}</g>`);
        const { xml, warnings } = convert(input);
        expect(warnings).toEqual([]);
        expect(fillColors(xml)).toEqual(['#FF00FF00']);
    });

    it('still drops hidden elements otherwise', () => {
        expect(elementNames(icon(`<g visibility="hidden">${rect}</g>`))).toEqual(['svg']);
        expect(elementNames(icon(`<g visibility="hidden">${visible('visibility="visible"')}</g>`))).toContain('path');
    });
});

describe('normalize: an unusable fill / stroke keeps the inherited value', () => {
    for (const [label, body] of <[string, string][]>[
        ['fill', '<g fill="#0f0"><rect width="10" height="10" fill="env(--x)"/></g>'],
        ['stroke', '<g fill="none" stroke="#0f0"><rect width="10" height="10" stroke="var(--x)"/></g>'],
        ['style declaration', '<g fill="#0f0"><g style="fill:env(--x)"><rect width="10" height="10"/></g></g>'],
        [
            'two children sharing the invalid value',
            '<g fill="#0f0"><rect width="10" height="10" fill="env(--x)"/><rect x="12" width="1" height="1" fill="env(--x)"/></g>',
        ],
    ])
        it(`${label}: optimize: true paints like optimize: false`, () => {
            const optimized = convert(icon(body));
            const plain = convert(icon(body), { optimize: false });
            expect(fillColors(optimized.xml)).toContain('#FF00FF00');
            expect(fillColors(optimized.xml)).toEqual(fillColors(plain.xml));
            // Same messages; mergePaths may join the shapes that report them.
            const messages = (ws: { message: string }[]): Set<string> => new Set(ws.map((w) => w.message));
            expect(messages(optimized.warnings)).toEqual(messages(plain.warnings));
        });

    it('keeps collapsing groups otherwise', () => {
        expect(elementNames(icon('<g fill="#0f0"><rect width="10" height="10" fill="currentColor"/></g>'))).toEqual([
            'svg',
            'path',
        ]);
    });
});
