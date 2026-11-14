import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { convert, ConversionError } from '../src/index.js';
import type { XastElement } from '../src/ast.js';
import { parseSvg, prepareSource } from '../src/normalize.js';
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

    it('converts paths with optimize:true in near-linear time', () => {
        // A ratio of two timings on the same machine, not an absolute bound: load slows both runs.
        // Measured for 5x the paths: 3-7.5 as is (also at load 35), ~24 with the threshold removed.
        const small = 1_000;
        const large = 5 * small;
        const maxRatio = 11;
        const inputs = { small: svg(grid(small)), large: svg(grid(large)) };
        const time = (input: string): { ms: number; xml: string } => {
            const start = performance.now();
            const { xml } = convert(input);
            return { ms: performance.now() - start, xml };
        };
        time(inputs.small); // warm-up
        let best = { small: Infinity, large: Infinity };
        let largeXml: string;
        // Min of a few interleaved runs filters out load spikes; stop as soon as the ratio holds.
        let attempt = 0;
        do {
            const s = time(inputs.small);
            const l = time(inputs.large);
            largeXml = l.xml;
            best = { small: Math.min(best.small, s.ms), large: Math.min(best.large, l.ms) };
        } while (++attempt < 3 && best.large / best.small >= maxRatio);
        expect(best.large / best.small).toBeLessThan(maxRatio);
        expect(countPaths(largeXml)).toBe(large);
    }, 120_000);
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
        // One path past MERGE_PATHS_MAX_ELEMENTS (500), where the default config turns mergePaths off.
        const svgoConfig = { plugins: ['preset-default' as const] };
        expect(countPaths(convert(svg(grid(501)), { svgoConfig }).xml)).toBe(1);
        expect(countPaths(convert(svg(grid(501))).xml)).toBe(501);
    }, 30_000);

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
        // would give 1.386987 instead of 1.386983. The scale above 1 adds a decimal (7).
        const scaled =
            '<g transform="scale(1.23456789)"><path fill="none" stroke="#000" stroke-width="1.123456" d="M1.111111 1L5 5"/></g>';
        const path = firstPath(scaled, 6);
        expect(path.d).toBe('m1.371742 1.2345679 4.8010974 4.9382715');
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

describe('normalize: rotate / skew angles keep their decimals (svgo convertTransform)', () => {
    // svgo rounds `matrix(1,0,0.5,1,0,0)` to `skewX(27)` instead of skewX(26.565): ~2% of the
    // drawing moved, whether the transform is then baked into the path or kept on a group.
    const skewed = (inner: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g transform="matrix(1,0,0.5,1,0,0)">${inner}</g></svg>`;
    const TIGHT = 0.001;

    it('when the transform is baked into the path', () => {
        // The id keeps svgo from collapsing the group first, so convertTransform rewrites the matrix.
        const source = skewed('<path id="x" d="M0 0L0 10L10 10z"/>');
        const { xml } = convert(source);
        expect(xml).toContain('android:pathData="M0 0L5 10L15 10Z"');
        expect(compareSvgs(source, vdToSvg(xml)).mismatch).toBeLessThan(TIGHT);
    });

    it('when the transform stays on a group', () => {
        const source = skewed(
            '<clipPath id="c"><rect width="20" height="20"/></clipPath><g clip-path="url(#c)"><path d="M0 0L0 10L10 10z"/><path d="M12 0h6v6h-6z"/></g>',
        );
        const { xml } = convert(source);
        expect(compareSvgs(source, vdToSvg(xml)).mismatch).toBeLessThan(TIGHT);
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
        '<ellipse cx="50" cy="50" rx="-5" ry="-10"/>',
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
        // An empty or blank size is an invalid length, read as 0 (not rendered); svgo draws it.
        '<rect width="" height="10"/>',
        '<rect width="10" height=" "/>',
        "<rect width='\t' height='10'/>",
        '<circle cx="50" cy="50" r=""/>',
        '<circle cx="50" cy="50" r=" "/>',
        // cleanupNumericValues turns a zero in absolute units into "0", which removeHiddenElems deletes.
        '<rect width="0mm" height="10"/>',
        '<circle cx="50" cy="50" r="0mm"/>',
        '<ellipse cx="50" cy="50" rx="0pt" ry="5"/>',
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

    it('a stroked rect with an empty width draws nothing in both modes (Chrome, Firefox)', () => {
        const source = svg('<rect x="10" width="" height="50" stroke="#f00"/>');
        for (const optimize of [true, false]) {
            const { xml, warnings } = convert(source, { optimize });
            expect(countPaths(xml)).toBe(0);
            expect(warnings.map((w) => w.code)).toEqual(['empty-path', 'large-vector']);
        }
    });

    it('a circle with an empty r followed by a rect warns in both modes', () => {
        const source = svg('<circle cx="50" cy="50" r=""/><rect width="10" height="10"/>');
        for (const optimize of [true, false]) {
            const { xml, warnings } = convert(source, { optimize });
            expect(countPaths(xml)).toBe(1);
            expect(warnings.map((w) => w.code)).toEqual(['empty-path', 'large-vector']);
        }
    });

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
        '<ellipse cx="50" cy="50"/>',
        '<ellipse cx="50" cy="50" rx="-5"/>',
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

describe('normalize: internal data-svgvd-* markers written in the source are ignored', () => {
    const cases: [string, string, string, boolean][] = [
        [
            'data-svgvd-use-instance',
            '<g fill="red" data-svgvd-use-instance=""><rect width="10" height="10" fill="context-fill"/></g>',
            '<g fill="red"><rect width="10" height="10" fill="context-fill"/></g>',
            false,
        ],
        ['data-svgvd-id', '<path data-svgvd-id="evil" d="M0 0h10v10z"/>', '<path d="M0 0h10v10z"/>', true],
    ];
    for (const [label, marked, plain, preserveIds] of cases)
        for (const optimize of [false, true])
            for (const ids of [preserveIds, !preserveIds])
                it(`${label}: same output as without it (optimize: ${optimize}, preserveIds: ${ids})`, () => {
                    const options = { optimize, preserveIds: ids };
                    expect(convert(icon(marked), options)).toEqual(convert(icon(plain), options));
                });

    it('data-svgvd-use-instance: context-fill still reports unsupported-paint', () => {
        const { warnings } = convert(icon(cases[0]![1]), { optimize: false });
        expect(warnings.map((w) => w.code)).toContain('unsupported-paint');
    });

    it('data-svgvd-id: no android:name taken from it', () => {
        expect(convert(icon(cases[1]![1]), { preserveIds: true }).xml).not.toContain('evil');
    });

    it('is stripped before a custom svgoConfig', () => {
        const svgoConfig = { plugins: [] };
        expect(convert(icon(cases[0]![1]), { svgoConfig })).toEqual(convert(icon(cases[0]![2]), { svgoConfig }));
    });

    it('keeps an authored id under preserveIds', () => {
        expect(convert(icon('<path id="named" d="M0 0h10v10z"/>'), { preserveIds: true }).xml).toContain(
            'android:name="named"',
        );
    });
});

describe('normalize: an invalid transform list reaches the converter as authored', () => {
    /** The attributes of every element, in document order. */
    const attrsOf = (svgText: string): Record<string, string>[] => {
        const out: Record<string, string>[] = [];
        const walk = (n: { children?: unknown[] }): void => {
            for (const c of (n.children ?? []) as XastElement[]) {
                if (c.type !== 'element') continue;
                out.push(c.attributes ?? {});
                walk(c);
            }
        };
        walk(parseSvg(svgText, true));
        return out;
    };

    it.each([
        ['transform', 'translate(10px 5px)', '<path transform="translate(10px 5px)" d="M0 0h4v4z"/>'],
        [
            'gradientTransform',
            'translate(foo 5)',
            '<linearGradient id="a" gradientTransform="translate(foo 5)"/><path fill="url(#a)" d="M0 0h4v4z"/>',
        ],
        [
            'patternTransform',
            'scale(1,)',
            '<pattern id="p" patternTransform="scale(1,)"/><path fill="url(#p)" d="M0 0h4v4z"/>',
        ],
    ])('keeps an invalid %s untouched by svgo', (attr, authored, body) => {
        const attrs = attrsOf(svg(body));
        expect(attrs.map((a) => a[attr]).filter(Boolean)).toEqual([authored]);
        expect(attrs.some((a) => Object.keys(a).some((k) => k.startsWith('data-svgvd-')))).toBe(false);
    });

    it('ignores an authored stash marker', () => {
        const attrs = attrsOf(svg('<path data-svgvd-invalid-transform="translate(5 5)" d="M0 0h4v4z"/>'));
        expect(attrs.every((a) => a.transform === undefined)).toBe(true);
    });

    describe('under a custom svgoConfig that moves a group transform onto it', () => {
        const source = (inner: string): string =>
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;
        const strictCodeWith = (input: string, options: Parameters<typeof convert>[1]): string | undefined => {
            try {
                convert(input, { ...options, strict: true });
            } catch (err) {
                if (err instanceof ConversionError) return err.warning.code;
                throw err;
            }
            return undefined;
        };

        it.each([
            ['moveGroupAttrsToElems', '<g transform="translate(5)"><path transform="rotate(foo)" d="M0 0h4v4z"/></g>'],
            ['collapseGroups', '<g transform="translate(5)"><path transform="rotate(foo)" d="M0 0h4v4z"/></g>'],
            [
                'moveGroupAttrsToElems',
                '<g transform="translate(5)"><g transform="scale(1,)"><path transform="rotate(foo)" d="M0 0h4v4z"/></g><path d="M8 0h4v4z"/></g>',
            ],
        ])('%s: %s is drawn as svgo moves it and warns as without svgo', (plugin, inner) => {
            const input = source(inner);
            const svgoConfig = { plugins: [plugin] } as NonNullable<Parameters<typeof convert>[1]>['svgoConfig'];
            const reference = convert(input, { optimize: false });
            const custom = convert(input, { svgoConfig });
            expect(custom.warnings).toEqual(reference.warnings);
            expect(custom.warnings.length).toBeGreaterThan(0);
            expect(compareSvgs(vdToSvg(custom.xml), vdToSvg(reference.xml)).mismatch).toBe(0);
            expect(strictCodeWith(input, { svgoConfig })).toBe('unsupported-attribute');
            expect(strictCodeWith(input, { optimize: false })).toBe('unsupported-attribute');
        });

        it('leaves the default config output unchanged', () => {
            const input = source('<g transform="translate(5)"><path transform="rotate(foo)" d="M0 0h4v4z"/></g>');
            const { xml, warnings } = convert(input);
            expect(xml).toContain('android:translateX="5"');
            expect(xml.match(/<group/g)).toHaveLength(1);
            expect(warnings).toEqual(convert(input, { optimize: false }).warnings);
        });
    });
});

const small = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">${inner}</svg>`;
const MODES = [true, false] as const;
const strictCode = (source: string, optimize: boolean): string | undefined => {
    try {
        convert(source, { optimize, strict: true });
    } catch (err) {
        if (err instanceof ConversionError) return err.warning.code;
        throw err;
    }
    return undefined;
};

describe('normalize: numeric character references are decoded before the guards', () => {
    it.each([
        ['<rect width="&#10;-5" height="10"/>', '<rect width="\n-5" height="10"/>'],
        ['<rect width="&#32;-5" height="10"/>', '<rect width=" -5" height="10"/>'],
        ['<rect width="&#45;5" height="10"/>', '<rect width="-5" height="10"/>'],
        ['<rect width="&#x2D;5" height="10"/>', '<rect width="-5" height="10"/>'],
        ['<rect width="&#48;" height="10"/>', '<rect width="0" height="10"/>'],
        ['<circle cx="5" cy="5" r="&#10;-5"/>', '<circle cx="5" cy="5" r="\n-5"/>'],
        ['<circle cx="5" cy="5" r="&#x2d;5"/>', '<circle cx="5" cy="5" r="-5"/>'],
        ['<circle cx="5" cy="5" r="&#48;"/>', '<circle cx="5" cy="5" r="0"/>'],
        ['<ellipse cx="5" cy="5" rx="&#45;5" ry="-3"/>', '<ellipse cx="5" cy="5" rx="-5" ry="-3"/>'],
    ])('%s draws nothing and warns in both modes; strict rejects it', (encoded, literal) => {
        const reference = convert(small(literal), { optimize: false });
        for (const optimize of MODES) {
            const { xml, warnings } = convert(small(encoded), { optimize });
            expect(xml).toBe(reference.xml);
            expect(countPaths(xml)).toBe(0);
            expect(warnings).toEqual(reference.warnings);
            expect(warnings.map((w) => w.code)).toEqual(['empty-path']);
            expect(strictCode(small(encoded), optimize)).toBe('empty-path');
        }
    });

    it('an encoded negative rx on an ellipse falls back to ry (auto) in both modes', () => {
        const encoded = small('<ellipse cx="5" cy="5" rx="&#45;5" ry="3"/>');
        const reference = convert(small('<ellipse cx="5" cy="5" rx="-5" ry="3"/>'), { optimize: false });
        for (const optimize of MODES) {
            const { xml, warnings } = convert(encoded, { optimize });
            expect(xml).toBe(reference.xml);
            expect(warnings).toEqual(reference.warnings);
        }
    });

    it('a path whose d holds an encoded newline still merges with its sibling (optimize: true)', () => {
        const source = small('<path d="M0 0h5v5z&#10;M10 10h5v5z"/><path d="M0 10h5v5z"/>');
        expect(countPaths(convert(source).xml)).toBe(1);
    });

    it('leaves encoded markup characters encoded, so the guards still see one attribute', () => {
        // `&#34;` decoded in the guards' copy would close `width` early and look like an empty value.
        const source = small('<rect width="5" height="5" data-x="&#34;&#60;&#38;"/>');
        for (const optimize of MODES) expect(countPaths(convert(source, { optimize }).xml)).toBe(1);
    });
});

describe('normalize: a d whose exponent has no digits is cut there in both modes', () => {
    const dOf = (source: string): string[] => {
        const out: string[] = [];
        const walk = (n: { children?: unknown[] }): void => {
            for (const c of (n.children ?? []) as XastElement[]) {
                if (c.type !== 'element') continue;
                if (c.name === 'path') out.push(c.attributes?.d ?? '');
                walk(c);
            }
        };
        // An empty custom config: only the converter's own head plugins run on the tree.
        walk(parseSvg(source, true, { plugins: [] }));
        return out;
    };

    it.each([
        ['M0 0 L1e 5 9 5', null],
        ['M0 0 L1e- 5 9 5', null],
        ['M0 0 L1E+ 5 9 5', null],
        ['M0 0 L5 5 1e 9 9 9', 'M0 0 L5 5'],
    ])('d="%s" renders as its valid prefix', (d, prefix) => {
        expect(dOf(small(`<path d="${d}"/>`))).toEqual([prefix ?? '']);
        const reference = convert(small(prefix ? `<path d="${prefix}"/>` : '<path d="M0 0"/>'), { optimize: false });
        for (const optimize of MODES) {
            const { xml, warnings } = convert(small(`<path d="${d}"/>`), { optimize });
            expect(xml).toBe(convert(small(prefix ? `<path d="${prefix}"/>` : '<path d=""/>'), { optimize }).xml);
            expect(warnings.map((w) => w.code)).toEqual(reference.warnings.map((w) => w.code));
            expect(strictCode(small(`<path d="${d}"/>`), optimize)).toBe(prefix ? undefined : 'empty-path');
        }
        // Same geometry in both modes.
        const [a, b] = MODES.map((optimize) => convert(small(`<path d="${d}"/>`), { optimize }).xml);
        if (prefix) expect(compareSvgs(vdToSvg(a!), vdToSvg(b!)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        else expect(a).toBe(b);
    });

    it('keeps exponents with digits (2e1, 1e-5, 1E+2) untouched', () => {
        const d = 'M0 0 L2e1 5 1e-5 9 1E+2 3';
        expect(dOf(small(`<path d="${d}"/>`))).toEqual([d]);
        for (const optimize of MODES) expect(convert(small(`<path d="${d}"/>`), { optimize }).warnings).toEqual([]);
    });
});

describe('normalize: an empty width / height on <use> reaches the converter', () => {
    it('<use width=""> on a <symbol viewBox> is not scaled and warns alike in both modes', () => {
        const source = small(
            '<symbol id="mySymbol" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol>' +
                '<use href="#mySymbol" width="" height="20"/>',
        );
        const [a, b] = MODES.map((optimize) => convert(source, { optimize }));
        expect(a!.warnings).toEqual(b!.warnings);
        expect(a!.warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
        for (const { xml } of [a!, b!]) {
            expect(xml).not.toMatch(/scale[XY]=/);
            expect(xml).not.toMatch(/<clip-path/);
        }
        expect(compareSvgs(vdToSvg(a!.xml), vdToSvg(b!.xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        for (const optimize of MODES) expect(strictCode(source, optimize)).toBe('unsupported-attribute');
    });
});

describe('normalize: warnings quote the authored ids (svgo does not minify them)', () => {
    it.each([
        [
            'a gradient without stops',
            '<linearGradient id="emptyGradient"/><rect width="5" height="5" fill="url(#emptyGradient) red"/>',
            'url(#emptyGradient)',
        ],
        [
            'a clipPath with text',
            '<clipPath id="myClip"><text>a</text></clipPath><rect width="5" height="5" clip-path="url(#myClip)"/>',
            'clipPath "myClip"',
        ],
        [
            'a <pattern> fill',
            '<pattern id="myPattern" width="2" height="2"><rect width="1" height="1"/></pattern>' +
                '<rect width="5" height="5" fill="url(#myPattern)"/>',
            '"myPattern"',
        ],
        [
            'a mask with stroked content',
            '<mask id="myMask"><rect width="5" height="5" fill="#fff" stroke="#fff"/></mask>' +
                '<rect width="5" height="5" mask="url(#myMask)"/>',
            'mask "myMask"',
        ],
        [
            'a gradient length in ex',
            '<linearGradient id="myGrad" x2="1ex"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>' +
                '<rect width="5" height="5" fill="url(#myGrad)"/>',
            'Gradient "myGrad"',
        ],
        [
            'a <use> of a <symbol> with an empty width',
            '<symbol id="mySymbol" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol>' +
                '<use href="#mySymbol" width="" height="20"/>',
            '<use href="#mySymbol">',
        ],
    ])('%s', (_name, body, quoted) => {
        const [a, b] = MODES.map((optimize) => convert(small(body), { optimize }).warnings);
        expect(a!.length).toBeGreaterThan(0);
        expect(a).toEqual(b);
        expect(a!.some((w) => w.message.includes(quoted))).toBe(true);
    });
});

describe('normalize: svgo keeps the decimals a scale above 1 magnifies', () => {
    // svgo rounds where the numbers are authored, before the scale: under scale(1000), 0.0021 → 0.002
    // is drawn at 2 instead of 2.1 (~12% of the square) with no warning.
    const square = 'M0.0021 0.0021h0.0104v0.0104h-0.0104z';
    const icon = (body: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">${body}</svg>`;
    const CASES = {
        'a path under a clipped group (the transform stays on it)':
            `<defs><clipPath id="c"><rect width="24" height="24"/></clipPath></defs>` +
            `<g transform="scale(1000)" clip-path="url(#c)"><path d="${square}"/></g>`,
        'a gradient-filled path and its gradient':
            '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0.0021" x2="0.0201">' +
            '<stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>' +
            `<g transform="scale(1000)"><path d="${square}" fill="url(#g)"/></g>`,
        'a CSS transform': `<g style="transform:scale(1000)"><path d="${square}"/></g>`,
        'a <use> of a scaled path': `<defs><path id="p" d="${square}"/></defs><use href="#p" transform="scale(1000)"/>`,
        'an ellipse': '<ellipse transform="scale(1000)" cx="0.0121" cy="0.0121" rx="0.0051" ry="0.0031"/>',
        'a line':
            '<line transform="scale(1000)" x1="0.0021" y1="0.0021" x2="0.0211" y2="0.0151" stroke="#000" stroke-width="0.0015"/>',
    };
    for (const optimize of [true, false])
        for (const [name, body] of Object.entries(CASES))
            it(`${name} renders like the source (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(icon(body), { optimize });
                expect(warnings).toEqual([]);
                const result = compareSvgs(icon(body), vdToSvg(xml));
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

    it('reads the two components of a CSS scale property: x="0.0021" kept in both modes', () => {
        const body = '<g style="scale: 1000 1000"><rect x="0.0021" width="0.004" height="0.004"/></g>';
        const startX = (optimize: boolean): number =>
            parseFloat(/pathData="M([\d.]+)/.exec(convert(icon(body), { optimize }).xml)![1]!);
        expect(startX(true)).toBe(0.0021);
        expect(startX(false)).toBe(0.0021);
    });

    /** `d` of the drawn path (not the clip rectangle) in svgo's output tree. */
    const pathData = (body: string, floatPrecision?: number): string | undefined => {
        const paths = (node: XastElement): XastElement[] =>
            node.name === 'path' ? [node] : (node.children ?? []).flatMap((c) => paths(c as XastElement));
        const root = parseSvg(icon(body), true, undefined, floatPrecision);
        return paths({ type: 'root', children: root.children } as XastElement)
            .map((p) => p.attributes?.d)
            .find((d) => d !== 'M0 0h24v24H0z');
    };
    const clipped = (transform: string): string =>
        `<defs><clipPath id="c"><rect width="24" height="24"/></clipPath></defs>` +
        `<g transform="${transform}" clip-path="url(#c)"><path d="M0.123456789 1h1z"/></g>`;

    it('adds ceil(log10(scale)) decimals, multiplying the scales of the document', () => {
        expect(pathData(clipped('scale(1000)'))).toBe('M.123457 1h1z');
        expect(pathData(clipped('scale(2)'))).toBe('M.1235 1h1z');
        expect(pathData(clipped('matrix(0 50 -50 0 0 0)'))).toBe('M.12346 1h1z');
        expect(pathData(`<g transform="scale(10)">${clipped('scale(10)')}</g>`)).toBe('M.12346 1h1z');
        expect(pathData(clipped('scale(1000)'), 5)).toBe('M.12345679 1h1z');
    });

    it('leaves svgo at floatPrecision when no transform scales up', () => {
        for (const transform of ['scale(0.5)', 'rotate(45)', 'translate(1000 1000)', 'scale(1)'])
            expect(pathData(clipped(transform)), transform).toBe('M.123 1h1z');
        expect(pathData('<path d="M0.123456789 1h1z"/>')).toBe('M.123 1h1z');
        expect(pathData('<g style="transform:rotate(30)"><path d="M0.123456789 1h1z"/></g>')).toBe('M.123 1h1z');
    });
});

describe('normalize: an ellipse sized from CSS is not turned into a circle (svgo convertEllipseToCircle)', () => {
    // convertEllipseToCircle reads the rx / ry attributes alone; a <circle> has no rx, so the CSS rx
    // was lost (drawn with r=2) in optimize: true only.
    const doc = (attrs: string, head = '', radii = 'rx="2" ry="2"'): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-12 -12 24 24">${head}<ellipse cx="1" cy="1" ${radii} fill="green" ${attrs}/></svg>`;
    // The reference renderer does not read CSS geometry: compare with the attributes it resolves to.
    const CASES: Record<string, [string, string]> = {
        'style rx': [doc('style="rx:10"'), doc('', '', 'rx="10" ry="2"')],
        'style rx / ry': [doc('style="rx:10px;ry:5px"'), doc('', '', 'rx="10" ry="5"')],
        '<style> rule': [doc('', '<style>ellipse{rx:10px}</style>'), doc('', '', 'rx="10" ry="2"')],
    };
    for (const optimize of [true, false])
        for (const [name, [input, reference]] of Object.entries(CASES))
            // optimize: false does not apply <style> (it warns): only the inline cases there.
            it.skipIf(!optimize && name === '<style> rule')(
                `${name} renders like the source (optimize: ${optimize})`,
                () => {
                    const { xml, warnings } = convert(input, { optimize });
                    expect(warnings).toEqual([]);
                    const result = compareSvgs(reference, vdToSvg(xml));
                    expect(result.inked).toBeGreaterThan(0);
                    expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
                },
            );

    it('still converts an ellipse with equal radii and no CSS to a circle', () => {
        const json = JSON.stringify(parseSvg(doc('stroke-dasharray="1"'), true));
        expect(json).toContain('"name":"circle"');
    });
});

describe('normalize: a <use> in a <clipPath> keeps referencing a <g> (svgo collapseGroups)', () => {
    // collapseGroups moves the id of a one-child <g> onto that child: the clip <use> would then
    // reference a shape and clip, whereas a <use> of a <g> in a <clipPath> contributes nothing.
    const G = '<g id="t"><rect width="12" height="12"/></g>';
    const doc = (body: string): string => icon(`<defs>${G}</defs>${body}<rect width="24" height="24" fill="red"/>`);
    const targetName = (input: string): string | undefined => {
        let name: string | undefined;
        const walk = (node: { children?: XastElement[] }): void => {
            for (const child of node.children ?? []) {
                if (child.type !== 'element') continue;
                if (child.attributes?.id === 't') name = child.name;
                walk(child);
            }
        };
        walk(parseSvg(input, true));
        return name;
    };

    it('keeps the <g> when a <clipPath> holds a <use>', () => {
        expect(targetName(doc('<clipPath id="c"><use href="#t"/></clipPath>'))).toBe('g');
        expect(targetName(doc('<clipPath id="c"><rect width="2" height="2"/><use href="#t"></use></clipPath>'))).toBe(
            'g',
        );
    });

    it('still collapses the <g> when no <use> is inside a <clipPath>', () => {
        expect(targetName(doc('<clipPath id="c"><rect width="2" height="2"/></clipPath><use href="#t"/>'))).toBe(
            'path',
        );
        expect(targetName(doc('<use href="#t"/>'))).toBe('path');
    });
});

/** The browser-lite entry as its bundle sees it: `svgo` replaced by svgo-lite (see browser-lite.test.ts). */
let lite: typeof import('../src/browser-lite.js');
beforeAll(async () => {
    vi.resetModules();
    vi.doMock('svgo', () => import('../src/svgo-lite.js'));
    lite = await import('../src/browser-lite.js');
    vi.doUnmock('svgo');
});

describe('normalize: numeric character references do not count as entities (T-163)', () => {
    const accented = (n: number): string =>
        icon(`<desc>${'&#xe9;'.repeat(n)}</desc><path aria-label="caf&#233;" d="M2 2h20v20H2z" fill="red"/>`);
    const plain = icon('<path d="M2 2h20v20H2z" fill="red"/>');

    it.each([600, 5000])('%i references convert like the same icon without them, both modes and browser-lite', (n) => {
        for (const optimize of MODES) {
            const { xml, warnings } = convert(accented(n), { optimize, strict: true });
            expect(warnings).toEqual([]);
            expect(xml).toBe(convert(plain, { optimize }).xml);
        }
        expect(lite.convert(accented(n), { strict: true }).xml).toBe(lite.convert(plain).xml);
    });

    it('a document with many declared entities is still rejected, both modes and browser-lite', () => {
        const bomb =
            '<!DOCTYPE svg [<!ENTITY a "x">]>' +
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><desc>${'&a;'.repeat(600)}</desc></svg>`;
        for (const optimize of MODES) expect(() => convert(bomb, { optimize })).toThrow(/max entity count/);
        expect(() => lite.convert(bomb)).toThrow(/max entity count/);
    });

    it('parses to the same tree as the encoded source', () => {
        const source =
            '<svg xmlns="http://www.w3.org/2000/svg"><!-- &#xe9; --><style><![CDATA[ /* &#xe9; */ ]]></style>' +
            '<text x="&#49;" title="a&#38;b &#x22; &#60; &#xe9; &#10;">&#xe9;&#38;lt;&#xD800;&#X41;</text></svg>';
        const prepared = prepareSource(source);
        expect(prepared).toContain('<!-- &#xe9; -->');
        expect(prepared).toContain('/* &#xe9; */');
        expect(prepared).toContain('title="a&#38;b &#x22; &#60; é &#10;"');
        expect(prepared).toContain('>é&#38;lt;&#xD800;A</text>');
        // the invalid &#xD800; is left for the parser to reject, as before
        expect(() => parseSvg(source, false)).toThrow(/Invalid character entity/);
        const valid = source.replace('&#xD800;', '');
        expect(parseSvg(valid, false)).toEqual(parseSvg(prepareSource(valid), false));
    });

    it('returns a source without references nor prefixes unchanged', () => {
        const source = icon('<path d="M2 2h20v20H2z"/>');
        expect(prepareSource(source)).toBe(source);
    });
});

describe('normalize: prepareSource drops the declaration of an SVG prefix it removes', () => {
    const NS = 'http://www.w3.org/2000/svg';

    it('replaces it with a default xmlns on an element that has none', () => {
        expect(prepareSource(`<ns0:svg xmlns:ns0="${NS}" viewBox="0 0 24 24"><ns0:path d="M2 2h9"/></ns0:svg>`)).toBe(
            `<svg xmlns="${NS}" viewBox="0 0 24 24"><path d="M2 2h9"/></svg>`,
        );
    });

    it('only drops it when the element already has a default xmlns', () => {
        expect(prepareSource(`<svg xmlns="${NS}" xmlns:s="${NS}"><s:g><s:path d="M2 2h9"/></s:g></svg>`)).toBe(
            `<svg xmlns="${NS}"><g><path d="M2 2h9"/></g></svg>`,
        );
    });

    it('keeps it while an attribute still uses the prefix (an unbound prefix is not well-formed)', () => {
        expect(prepareSource(`<ns0:svg xmlns:ns0="${NS}" ns0:foo="1"><ns0:path/></ns0:svg>`)).toBe(
            `<svg xmlns:ns0="${NS}" ns0:foo="1"><path/></svg>`,
        );
    });

    it('still renames an XLink alias next to it', () => {
        expect(
            prepareSource(
                `<svg:svg xmlns:svg="${NS}" xmlns:xl="http://www.w3.org/1999/xlink"><svg:use xl:href="#p"/></svg:svg>`,
            ),
        ).toBe(`<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#p"/></svg>`);
    });
});

describe('normalize: an id targeted by a <style> rule and referenced survives inlineStyles (T-168)', () => {
    const STYLE = '<style>#t{fill:red}</style>';
    const RECT = '<rect id="t" width="12" height="12"/>';
    const red = icon(`<rect width="12" height="12" fill="red"/>`);

    it('a <use> of the styled element draws it red with optimize: true, like the browser', () => {
        const doc = icon(`${STYLE}<defs>${RECT}</defs><use href="#t"/>`);
        const { xml, warnings } = convert(doc, { optimize: true, strict: true });
        expect(warnings).toEqual([]);
        expect(xml).toBe(convert(red, { optimize: true }).xml);
        expect(compareSvgs(red, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        // optimize: false does not apply <style>: the rect is drawn, the rule reported
        const unoptimized = convert(doc, { optimize: false });
        expect(unoptimized.warnings.map((w) => w.code)).toEqual(['unsupported-style']);
        expect(countPaths(unoptimized.xml)).toBe(1);
    });

    it('xlink:href and preserveIds too', () => {
        const doc = icon(
            `${STYLE}<defs>${RECT}</defs><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#t"/>`,
        );
        expect(convert(doc, { optimize: true }).xml).toBe(convert(red, { optimize: true }).xml);
        const named = convert(doc, { optimize: true, preserveIds: true });
        expect(named.warnings).toEqual([]);
        expect(named.xml).toContain('android:name="t"');
        expect(named.xml).toContain('#FFFF0000');
    });

    it('a <use> of it in a <clipPath> still clips, both modes', () => {
        const clipped = (defs: string): string =>
            icon(
                `${STYLE}<defs>${defs}<clipPath id="c"><use href="#t"/></clipPath></defs><rect width="24" height="24" clip-path="url(#c)"/>`,
            );
        for (const optimize of MODES) {
            const { xml, warnings } = convert(clipped(RECT), { optimize });
            expect(warnings.map((w) => w.code)).toEqual(optimize ? [] : ['unsupported-style']);
            expect(xml).toContain('<clip-path');
            const reference = icon('<rect width="12" height="12"/>');
            expect(compareSvgs(reference, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        }
    });

    it('leaves the output unchanged when the styled id is not referenced', () => {
        const unreferenced = icon(`${STYLE}${RECT}<defs><path id="u" d="M0 0h1v1z"/></defs><use href="#u"/>`);
        const without = icon(`${STYLE}${RECT}`);
        // a reference to another id: the same pipeline as a document without any reference
        expect(convert(unreferenced, { optimize: true }).xml).toBe(
            convert(icon(`${STYLE}${RECT}<path d="M0 0h1v1z"/>`), { optimize: true }).xml,
        );
        expect(convert(without, { optimize: true }).xml).toBe(convert(red, { optimize: true }).xml);
    });
});

/**
 * T-185: prepareSource decodes numeric references and drops SVG prefixes before parsing, which
 * shortens lines; a parse error is reported at its place in the original source. The parser points
 * at the `>` closing the tag in error (`</svg>` at column 44 is reported at 49).
 */
describe('parse error positions refer to the original source (T-185)', () => {
    const errorOf = (svg: string, optimize: boolean): string => {
        try {
            convert(svg, { optimize });
        } catch (err) {
            return (err as Error).message;
        }
        throw new Error('expected a parse error');
    };
    const NS = 'xmlns="http://www.w3.org/2000/svg"';

    it.each([
        ['no rewrite', `<svg ${NS}><g></svg>`, '1:49'],
        ['decoded references before the error', `<svg ${NS}><title>&#x41;&#65;&amp;</title><g></svg>`, '1:80'],
        ['on a later line', `<svg ${NS}>\n<title>&#x1F600;&#233;&#233;</title>\n  <g>\n</svg>`, '4:6'],
        [
            'in a tag whose SVG prefix is dropped',
            '<ns0:svg xmlns:ns0="http://www.w3.org/2000/svg"><ns0:g></ns0:svg>',
            '1:65',
        ],
    ])('%s', (_, svg, position) => {
        for (const optimize of [true, false]) {
            expect(errorOf(svg, optimize), `optimize: ${optimize}`).toBe(
                `Invalid SVG: <input>:${position}: Unexpected close tag`,
            );
        }
    });
});
