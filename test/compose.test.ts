import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kotlinName, kotlinPackage } from '../src/compose.js';
import { ConversionError, convert, toImageVector, vectorDrawableToImageVector } from '../src/index.js';
import * as browser from '../src/browser.js';
import * as lite from '../src/browser-lite.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const files = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.svg'))
    .sort();

const svg = (body: string, attrs = ''): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${attrs}>${body}</svg>`;
const SQUARE = 'M0 0h24v24H0z';
const BLUR = svg(
    '<filter id="f"><feGaussianBlur stdDeviation="1"/></filter><circle cx="12" cy="12" r="8" fill="#1A73E8" filter="url(#f)"/>',
);

/** The Kotlin of `body` (default options, name `Icon`). */
const kt = (body: string, options: Partial<Parameters<typeof toImageVector>[1]> = {}): string =>
    toImageVector(svg(body), { name: 'Icon', ...options }).kotlin;

/** The value thrown by `fn`. */
function thrown(fn: () => unknown): unknown {
    try {
        fn();
    } catch (err) {
        return err;
    }
    throw new Error('expected a throw');
}

describe('toImageVector: fixture snapshots (optimize:false, deterministic)', () => {
    for (const file of files) {
        it(file, () => {
            const source = readFileSync(join(FIXTURES, file), 'utf8');
            const { kotlin, warnings } = toImageVector(source, {
                name: file.replace(/\.svg$/, ''),
                packageName: 'com.example.icons',
                optimize: false,
            });
            expect({ kotlin, warnings: warnings.map((w) => w.code) }).toMatchSnapshot();
        });
    }
});

describe('toImageVector: file structure', () => {
    it('declares a lazy val with the builder size, viewport, used imports only', () => {
        const { kotlin, name } = toImageVector(svg(`<path d="${SQUARE}" fill="#1A73E8"/>`, ' width="48"'), {
            name: 'ic_brand-logo',
            packageName: 'com.example.icons',
        });
        expect(name).toBe('IcBrandLogo');
        expect(kotlin).toBe(
            [
                'package com.example.icons',
                '',
                'import androidx.compose.ui.graphics.Color',
                'import androidx.compose.ui.graphics.SolidColor',
                'import androidx.compose.ui.graphics.vector.ImageVector',
                'import androidx.compose.ui.graphics.vector.path',
                'import androidx.compose.ui.unit.dp',
                '',
                'val IcBrandLogo: ImageVector by lazy {',
                '    ImageVector.Builder(',
                '        name = "IcBrandLogo",',
                '        defaultWidth = 48.dp,',
                '        defaultHeight = 48.dp,',
                '        viewportWidth = 24f,',
                '        viewportHeight = 24f,',
                '    ).apply {',
                '        path(',
                '            fill = SolidColor(Color(0xFF1A73E8)),',
                '        ) {',
                '            moveTo(0f, 0f)',
                '            horizontalLineToRelative(24f)',
                '            verticalLineToRelative(24f)',
                '            horizontalLineTo(0f)',
                '            close()',
                '        }',
                '    }.build()',
                '}',
                '',
            ].join('\n'),
        );
    });

    it('omits the package line without packageName', () => {
        expect(kt(`<path d="${SQUARE}"/>`)).toMatch(/^import /);
    });

    it('passes tint and autoMirrored to the builder, the width / height options to the size', () => {
        const out = kt(`<path d="${SQUARE}"/>`, { tint: '#80FF0000', autoMirrored: true, width: 36 });
        expect(out).toContain('        tintColor = Color(0x80FF0000),\n        autoMirror = true,\n');
        expect(out).toContain('defaultWidth = 36.dp,\n        defaultHeight = 36.dp,');
    });
});

describe('toImageVector: paths', () => {
    it('writes colors as Color(0xAARRGGBB), translucency as fillAlpha / strokeAlpha', () => {
        const out = kt(`<path d="${SQUARE}" fill="rgba(0,0,255,.5)" stroke="#0f0" stroke-opacity=".25"/>`);
        expect(out).toContain('fill = SolidColor(Color(0x800000FF)),');
        expect(out).toMatch(/stroke = SolidColor\(Color\(0xFF00FF00\)\),\n\s+strokeAlpha = 0.25f,/);
    });

    it('maps the fill type: EvenOdd, NonZero by default (not written)', () => {
        const evenOdd = kt(`<path d="${SQUARE}" fill-rule="evenodd"/>`);
        expect(evenOdd).toContain('pathFillType = PathFillType.EvenOdd,');
        expect(evenOdd).toContain('import androidx.compose.ui.graphics.PathFillType\n');
        expect(kt(`<path d="${SQUARE}"/>`)).not.toContain('PathFillType');
    });

    it('maps the stroke attributes, defaults omitted', () => {
        const out = kt(
            '<path d="M2 2L20 20" fill="none" stroke="#000" stroke-width="3" stroke-linecap="square" stroke-linejoin="bevel" stroke-miterlimit="8"/>',
        );
        expect(out).toContain(
            [
                'stroke = SolidColor(Color(0xFF000000)),',
                '            strokeLineWidth = 3f,',
                '            strokeLineCap = StrokeCap.Square,',
                '            strokeLineJoin = StrokeJoin.Bevel,',
                '            strokeLineMiter = 8f,',
            ].join('\n'),
        );
        expect(out).not.toContain('fill =');
        expect(kt('<path d="M2 2L20 20" stroke="#000" stroke-linecap="butt" stroke-linejoin="miter"/>')).not.toMatch(
            /StrokeCap|StrokeJoin|strokeLineMiter/,
        );
    });

    it('maps every path command to its PathBuilder call (arc flags as booleans)', () => {
        const d =
            'M1 2m1 1L3 4l1 1H5h1V6v1C1 2 3 4 5 6c1 2 3 4 5 6S1 2 3 4s1 2 3 4Q1 2 3 4q1 2 3 4T5 6t1 1A5 6 7 1 0 8 9a5 6 7 0 1 -.5 -1Zz';
        const out = toImageVector(svg(`<path d="${d}"/>`), { name: 'p', optimize: false }).kotlin;
        for (const call of [
            'moveTo(1f, 2f)',
            'moveToRelative(1f, 1f)',
            'lineTo(3f, 4f)',
            'lineToRelative(1f, 1f)',
            'horizontalLineTo(5f)',
            'horizontalLineToRelative(1f)',
            'verticalLineTo(6f)',
            'verticalLineToRelative(1f)',
            'curveTo(1f, 2f, 3f, 4f, 5f, 6f)',
            'curveToRelative(1f, 2f, 3f, 4f, 5f, 6f)',
            'reflectiveCurveTo(1f, 2f, 3f, 4f)',
            'reflectiveCurveToRelative(1f, 2f, 3f, 4f)',
            'quadTo(1f, 2f, 3f, 4f)',
            'quadToRelative(1f, 2f, 3f, 4f)',
            'reflectiveQuadTo(5f, 6f)',
            'reflectiveQuadToRelative(1f, 1f)',
            'arcTo(5f, 6f, 7f, true, false, 8f, 9f)',
            'arcToRelative(5f, 6f, 7f, false, true, -0.5f, -1f)',
            'close()',
        ])
            expect(out).toContain(`            ${call}\n`);
    });
});

describe('toImageVector: groups and clips', () => {
    it('maps a group transform to rotate / pivot / scale / translation', () => {
        const out = kt(`<g transform="translate(2 3) rotate(30) scale(2 0.5)"><path d="${SQUARE}"/></g>`, {
            optimize: false,
        });
        expect(out).toMatch(
            /group\(\n\s+rotate = 30f,\n\s+scaleX = 2f,\n\s+scaleY = 0.5f,\n\s+translationX = 2f,\n\s+translationY = 3f,\n\s+\) \{\n\s+path\(/,
        );
        expect(out).toContain('import androidx.compose.ui.graphics.vector.group\n');
    });

    it('keeps the preserveIds names, escaped as Kotlin strings', () => {
        const out = kt(`<g id="a$b" transform="rotate(10)"><path id="p&quot;1\\" d="${SQUARE}"/></g>`, {
            preserveIds: true,
        });
        expect(out).toContain('name = "a\\$b",');
        expect(out).toContain('name = "p\\"1\\\\",');
    });

    it('wraps the siblings after a clip-path in a group with clipPathData', () => {
        const out = kt(
            `<clipPath id="c"><circle cx="12" cy="12" r="6"/></clipPath><path d="${SQUARE}" fill="#f00" clip-path="url(#c)"/>`,
        );
        expect(out).toMatch(
            /group\(\n\s+clipPathData = PathData \{\n\s+moveTo\([^)]*\)\n[\s\S]*?\n\s+\},\n\s+\) \{\n\s+path\(/,
        );
        expect(out).toContain('import androidx.compose.ui.graphics.vector.PathData\n');
    });
});

describe('toImageVector: gradients', () => {
    it('writes a linear gradient as Brush.linearGradient with color stops, start and end', () => {
        const out = kt(
            `<linearGradient id="g" x1="0" y1="0" x2="24" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient><path d="${SQUARE}" fill="url(#g)"/>`,
        );
        expect(out).toContain(
            [
                'fill = Brush.linearGradient(',
                '                0f to Color(0xFFFF0000),',
                '                1f to Color(0xFF0000FF),',
                '                start = Offset(0f, 0f),',
                '                end = Offset(24f, 0f),',
                '            ),',
            ].join('\n'),
        );
        expect(out).not.toContain('TileMode');
    });

    it('writes a radial gradient with center, radius and a non-clamp tile mode', () => {
        const out = kt(
            `<radialGradient id="g" cx="12" cy="12" r="10" gradientUnits="userSpaceOnUse" spreadMethod="reflect"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f" stop-opacity=".5"/></radialGradient><path d="${SQUARE}" stroke="url(#g)"/>`,
        );
        expect(out).toContain('stroke = Brush.radialGradient(');
        expect(out).toContain('1f to Color(0x800000FF),');
        expect(out).toContain('center = Offset(12f, 12f),');
        expect(out).toContain('radius = 10f,');
        expect(out).toContain('tileMode = TileMode.Mirror,');
        expect(out).toContain('import androidx.compose.ui.graphics.TileMode\n');
    });
});

describe('toImageVector: warnings, strict and rules', () => {
    it('reports the warnings of convert, in the same order', () => {
        const source = svg(`<path d="${SQUARE}" stroke="#000" stroke-dasharray="1ex"/>`);
        expect(toImageVector(source, { name: 'x' }).warnings).toEqual(convert(source).warnings);
    });

    it('fails on an unrepresentable SVG in strict exactly like convert', () => {
        const fromXml = thrown(() => convert(BLUR, { strict: true }));
        const fromKotlin = thrown(() => toImageVector(BLUR, { name: 'x', strict: true }));
        expect(fromKotlin).toBeInstanceOf(ConversionError);
        expect(fromKotlin).toEqual(fromXml);
        expect((fromKotlin as ConversionError).warning.code).toBe('unsupported-attribute');
    });

    it('draws a color reference in the placeholder color, with one unsupported-color-reference warning', () => {
        const onWarn: string[] = [];
        const { kotlin, warnings } = toImageVector(
            svg(
                `<path d="M0 0h4v4z" fill="currentColor"/><path d="M5 5h4v4z" fill="currentColor" stroke="currentColor"/>`,
            ),
            { name: 'x', currentColor: '?attr/colorPrimary', onWarn: (w) => onWarn.push(w.code) },
        );
        expect(kotlin).not.toContain('colorPrimary');
        expect(kotlin.match(/Color\(0xFF808080\)/g)).toHaveLength(3);
        expect(warnings.map((w) => w.code)).toEqual(['unsupported-color-reference']);
        expect(warnings[0]!.message).toContain('?attr/colorPrimary cannot be expressed in an ImageVector');
        expect(onWarn).toEqual(['unsupported-color-reference']);
    });

    it('also replaces a reference in a gradient stop', () => {
        const { kotlin, warnings } = toImageVector(
            svg(
                `<linearGradient id="g"><stop offset="0" stop-color="#1A73E8"/><stop offset="1" stop-color="#fff"/></linearGradient><path d="${SQUARE}" fill="url(#g)"/>`,
            ),
            { name: 'x', colorMap: { '#1A73E8': '@color/brand' } },
        );
        expect(kotlin).toContain('0f to Color(0xFF808080),');
        expect(warnings.map((w) => w.message)).toEqual([expect.stringContaining('@color/brand')]);
    });

    it('rejects a color reference in strict, or not at all with rules off', () => {
        const options = { name: 'x', currentColor: '@color/icon' };
        const source = svg(`<path d="${SQUARE}" fill="currentColor"/>`);
        const err = thrown(() => toImageVector(source, { ...options, strict: 'lossy' }));
        expect(err).toBeInstanceOf(ConversionError);
        expect((err as ConversionError).warning.code).toBe('unsupported-color-reference');
        const quiet = toImageVector(source, {
            ...options,
            strict: true,
            rules: { 'unsupported-color-reference': 'off' },
        });
        expect(quiet.warnings).toEqual([]);
    });

    it('folds the root opacity into the path alphas, approximated with several paints', () => {
        const one = toImageVector(svg(`<path d="${SQUARE}" fill-opacity=".5"/>`, ' opacity="0.5"'), { name: 'x' });
        expect(one.kotlin).toContain('fillAlpha = 0.25f,');
        expect(one.warnings).toEqual([]);
        const two = toImageVector(svg(`<path d="${SQUARE}" stroke="#f00"/>`, ' opacity="0.5"'), { name: 'x' });
        expect(two.kotlin).toContain('fillAlpha = 0.5f,');
        expect(two.kotlin).toContain('strokeAlpha = 0.5f,');
        expect(two.warnings.map((w) => w.code)).toEqual(['opacity-approximated']);
        expect(() =>
            toImageVector(svg(`<path d="${SQUARE}" stroke="#f00"/>`, ' opacity="0.5"'), { name: 'x', strict: true }),
        ).toThrow(ConversionError);
    });
});

describe('toImageVector: root opacity warns only when two paints may overlap (T-93)', () => {
    const RED = '<rect x="0" y="0" width="10" height="10" fill="#f00"/>';
    const codes = (body: string, optimize: boolean): string[] =>
        toImageVector(svg(body, ' opacity="0.5"'), { name: 'x', optimize }).warnings.map((w) => w.code);

    for (const optimize of [false, true]) {
        describe(`optimize: ${optimize}`, () => {
            it('disjoint paints: no warning, strict passes, alpha folded on each', () => {
                const body = `${RED}<rect x="14" y="14" width="10" height="10" fill="#00f"/>`;
                expect(codes(body, optimize)).toEqual([]);
                const { kotlin } = toImageVector(svg(body, ' opacity="0.5"'), { name: 'x', optimize, strict: true });
                expect(kotlin.match(/fillAlpha = 0\.5f,/g)).toHaveLength(2);
                // Same verdict as the XML: android:alpha is exact there.
                expect(convert(svg(body, ' opacity="0.5"'), { optimize }).warnings).toEqual([]);
            });

            it('touching edges do not overlap; a stroke widens the extent', () => {
                expect(codes(`${RED}<rect x="10" y="0" width="10" height="10" fill="#00f"/>`, optimize)).toEqual([]);
                expect(
                    codes(
                        `${RED}<rect x="11" y="0" width="10" height="10" fill="none" stroke="#00f" stroke-width="4"/>`,
                        optimize,
                    ),
                ).toEqual(['opacity-approximated']);
            });

            it('overlapping paints: warning, strict throws', () => {
                const body = `${RED}<rect x="5" y="5" width="10" height="10" fill="#00f"/>`;
                expect(codes(body, optimize)).toEqual(['opacity-approximated']);
                expect(() => toImageVector(svg(body, ' opacity="0.5"'), { name: 'x', optimize, strict: true })).toThrow(
                    ConversionError,
                );
            });

            it('fill and stroke of one path always overlap', () => {
                expect(codes(`<rect x="2" y="2" width="10" height="10" fill="#f00" stroke="#00f"/>`, optimize)).toEqual(
                    ['opacity-approximated'],
                );
            });

            it('a translated group that brings disjoint paints together: warning', () => {
                const body = `${RED}<g transform="translate(-12 -12)"><rect x="14" y="14" width="10" height="10" fill="#00f"/><rect x="14" y="0" width="1" height="1" fill="#0f0"/></g>`;
                expect(codes(body, optimize)).toEqual(['opacity-approximated']);
                const apart = `${RED}<g transform="translate(2 2)"><rect x="14" y="14" width="8" height="8" fill="#00f"/></g>`;
                expect(codes(apart, optimize)).toEqual([]);
                // Kept as a rotated group without optimize: its matrix is resolved, not counted as overlapping.
                const rotated = `${RED}<g transform="rotate(45 18 18)"><rect x="15" y="15" width="6" height="6" fill="#00f"/><circle cx="18" cy="5" r="1" fill="#0f0"/></g>`;
                expect(codes(rotated, optimize)).toEqual([]);
            });

            it('a paint under a clip-path counts as overlapping', () => {
                const body = `<clipPath id="c"><rect x="14" y="14" width="5" height="5"/></clipPath>${RED}<rect x="14" y="14" width="10" height="10" fill="#00f" clip-path="url(#c)"/>`;
                expect(codes(body, optimize)).toEqual(['opacity-approximated']);
            });
        });
    }

    it('no root opacity: no warning whatever overlaps', () => {
        const body = `${RED}<rect x="5" y="5" width="10" height="10" fill="#00f" stroke="#0f0"/>`;
        expect(toImageVector(svg(body), { name: 'x' }).warnings).toEqual([]);
    });
});

describe('toImageVector: large icons split into private objects (JVM method and constant pool limits)', () => {
    /** `n` cubic curves after a moveTo. */
    const curves = (n: number): string =>
        'M1 1' + Array.from({ length: n }, (_, i) => `C${i % 20} 2 3 ${i % 7} 5 ${i % 11}`).join('');
    const big = (body: string): string => toImageVector(svg(body), { name: 'big_icon', optimize: false }).kotlin;

    /** The private part objects of `kotlin`: name → body lines of their function (without indentation). */
    function parts(kotlin: string): Map<string, string[]> {
        const out = new Map<string, string[]>();
        for (const m of kotlin.matchAll(
            /^private object (\w+) \{\n {4}fun (?:ImageVector\.Builder|PathBuilder)\.content\(\) \{\n([^]*?)\n {4}\}\n\}$/gm,
        ))
            out.set(
                m[1]!,
                m[2]!.split('\n').map((l) => l.trim()),
            );
        return out;
    }

    /** Every line of `kotlin`'s builder, each `with(BigIconPartN) { content() }` call replaced by that part's lines. */
    function inlined(kotlin: string): string[] {
        const fns = parts(kotlin);
        const expand = (lines: string[]): string[] =>
            lines.flatMap((l) => {
                const fn = /^with\((\w+Part\d+)\) \{ content\(\) \}$/.exec(l)?.[1];
                return fn === undefined ? [l] : expand(fns.get(fn)!);
            });
        const builder = kotlin.slice(kotlin.indexOf('val '), kotlin.indexOf('\nprivate object'));
        return expand(builder.split('\n').map((l) => l.trim()));
    }

    it('keeps an icon within the budget in one block', () => {
        const kotlin = big(`<path d="${curves(1500)}" stroke="#000"/>`);
        expect(kotlin).not.toContain('private ');
        expect(kotlin).not.toContain('PathBuilder');
    });

    it('splits a long path into PathBuilder part objects, every command kept in order', () => {
        const kotlin = big(`<path d="${curves(6000)}" stroke="#000"/>`);
        const fns = parts(kotlin);
        expect([...fns.keys()]).toEqual(['BigIconPart1', 'BigIconPart2', 'BigIconPart3', 'BigIconPart4']);
        expect(kotlin).toContain('import androidx.compose.ui.graphics.vector.PathBuilder\n');
        expect(kotlin).toContain(
            'private object BigIconPart1 {\n    fun PathBuilder.content() {\n        moveTo(1f, 1f)\n        curveTo(',
        );
        // One JVM class (one constant pool) per part: no top-level function shares the file class's.
        expect(kotlin).not.toContain('private fun');
        expect(kotlin).toMatch(/\) \{\n {12}with\(BigIconPart1\) \{ content\(\) \}\n {12}with\(BigIconPart2\)/);
        for (const lines of fns.values()) expect(lines.length).toBeLessThanOrEqual(2000);
        // The unsplit output, as long as the budget allows it (the same test on fewer curves).
        const commands = inlined(kotlin).filter((l) => /^(moveTo|curveTo)\(/.test(l));
        expect(commands).toHaveLength(6001);
        expect(commands.slice(0, 3)).toEqual([
            'moveTo(1f, 1f)',
            'curveTo(0f, 2f, 3f, 0f, 5f, 0f)',
            'curveTo(1f, 2f, 3f, 1f, 5f, 1f)',
        ]);
        expect(commands[6000]).toBe(`curveTo(${5999 % 20}f, 2f, 3f, ${5999 % 7}f, 5f, ${5999 % 11}f)`);
    });

    it('splits many paths into ImageVector.Builder part objects, in document order', () => {
        const body = Array.from({ length: 600 }, (_, i) => `<path d="M${i} 0h1v1z" fill="#f00"/>`).join('');
        const kotlin = big(body);
        expect(kotlin).toMatch(
            /^private object BigIconPart1 \{\n {4}fun ImageVector\.Builder\.content\(\) \{\n {8}path\($/m,
        );
        expect(kotlin).not.toContain('PathBuilder');
        const moves = inlined(kotlin).filter((l) => l.startsWith('moveTo('));
        expect(moves).toEqual(Array.from({ length: 600 }, (_, i) => `moveTo(${i}f, 0f)`));
    });

    it('splits a large clip path and the clipped content', () => {
        const kotlin = big(
            `<clipPath id="c"><path d="${curves(3000)}"/></clipPath><g clip-path="url(#c)"><path d="${curves(3000)}" fill="#0f0"/></g>`,
        );
        expect(kotlin).toMatch(
            /clipPathData = PathData \{\n\s+with\(BigIconPart1\) \{ content\(\) \}\n\s+with\(BigIconPart2\) \{ content\(\) \}\n\s+\},/,
        );
        expect(inlined(kotlin).filter((l) => l.startsWith('curveTo('))).toHaveLength(6000);
    });
});

describe('Kotlin names', () => {
    it.each([
        ['ic_arrow-back', 'IcArrowBack'],
        ['arrowBack', 'ArrowBack'],
        ['ArrowBack', 'ArrowBack'],
        ['24px', 'Icon24px'],
        ['café au lait', 'CafeAuLait'],
        ['class', 'Class'],
    ])('%s → %s', (raw, name) => {
        expect(kotlinName(raw)).toBe(name);
    });

    it('rejects a name with no ASCII letter or digit, or a missing one', () => {
        expect(() => kotlinName('--')).toThrow(TypeError);
        expect(() => toImageVector(svg(''), {} as never)).toThrow(TypeError);
    });

    it('validates the package, backquoting keyword segments', () => {
        expect(kotlinPackage('com.example.icons')).toBe('com.example.icons');
        expect(kotlinPackage('com.example.in.fun')).toBe('com.example.`in`.`fun`');
        for (const bad of ['', 'com..x', 'com.1x', 'com.ex-ample', '_.x'])
            expect(() => kotlinPackage(bad)).toThrow(TypeError);
        expect(() => toImageVector(svg(''), { name: 'x', packageName: 'a b' })).toThrow(TypeError);
    });
});

describe('browser entries', () => {
    it('export toImageVector; the lite one runs without svgo and rejects optimize: true', () => {
        const source = svg(`<path d="${SQUARE}" fill="#f00"/>`);
        expect(browser.toImageVector(source, { name: 'x' })).toEqual(toImageVector(source, { name: 'x' }));
        expect(lite.toImageVector(source, { name: 'x' })).toEqual(
            toImageVector(source, { name: 'x', optimize: false }),
        );
        expect(() => lite.toImageVector(source, { name: 'x', optimize: true as never })).toThrow(TypeError);
    });
});

describe('toImageVector: root opacity, the stroke margin covers miter tips and square caps (T-128)', () => {
    const MODES = [true, false] as const;
    const CODES = (body: string, optimize: boolean): string[] =>
        toImageVector(svg(body, ' opacity="0.5"'), { name: 'x', optimize }).warnings.map((w) => w.code);
    // A sharp miter (half-width / sin(θ/2) ≈ 5.1) tips at x≈15.1, past the rect at x=13; the box widened
    // by half the stroke width stops at x=11.
    const chevron = (attrs = ''): string =>
        `<path d="M0 10L10 12L0 14" fill="none" stroke="#000" stroke-width="2" stroke-miterlimit="10"${attrs}/>` +
        '<rect x="13" y="11" width="7" height="2" fill="red"/>';
    // A square cap on a diagonal line reaches √2 × half-width past the endpoint (x≈11.41 > 11.2).
    const diagonal = (cap: string): string =>
        `<path d="M0 0L10 10" fill="none" stroke="#000" stroke-width="2" stroke-linecap="${cap}"/>` +
        '<rect x="11.2" y="9" width="2" height="2" fill="red"/>';

    it.each(MODES)('a sharp miter tip reaching a sibling warns (optimize: %s)', (optimize) => {
        expect(CODES(chevron(), optimize)).toEqual(['opacity-approximated']);
        expect(CODES(chevron(' stroke-linejoin="miter-clip"'), optimize)).toContain('opacity-approximated');
    });

    it.each(MODES)('a round or bevel join does not reach it: no warning (optimize: %s)', (optimize) => {
        expect(CODES(chevron(' stroke-linejoin="round"'), optimize)).toEqual([]);
        expect(CODES(chevron(' stroke-linejoin="bevel"'), optimize)).toEqual([]);
    });

    it.each(MODES)('a square cap reaches √2 × half its width (optimize: %s)', (optimize) => {
        expect(CODES(diagonal('square'), optimize)).toEqual(['opacity-approximated']);
        expect(CODES(diagonal('butt'), optimize)).toEqual([]);
    });

    it.each(MODES)('clearly disjoint mitered strokes do not warn (optimize: %s)', (optimize) => {
        const apart = chevron().replace('x="13"', 'x="40"').replace('width="7"', 'width="2"');
        expect(CODES(apart, optimize)).toEqual([]);
    });
});

describe('vectorDrawableToImageVector (T-181)', () => {
    const vd = (body: string, attrs = ''): string =>
        `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24"${attrs}>${body}</vector>`;

    it('gives the same file as toImageVector for the drawable convert writes', () => {
        const source = svg('<g transform="rotate(30 12 12)"><path d="M2 2h20v20H2z" fill="#1A73E8" stroke="red"/></g>');
        const { xml } = convert(source);
        expect(vectorDrawableToImageVector(xml, { name: 'Icon', packageName: 'com.example' }).kotlin).toBe(
            toImageVector(source, { name: 'Icon', packageName: 'com.example' }).kotlin,
        );
    });

    it('keeps trim paths, which convert never writes', () => {
        const { kotlin, warnings } = vectorDrawableToImageVector(
            vd(
                '<path android:pathData="M0 0h24" android:strokeColor="#000" android:strokeWidth="1" android:trimPathStart="0.25" android:trimPathOffset="0.5"/>',
            ),
            { name: 'Icon' },
        );
        expect(kotlin).toContain('trimPathStart = 0.25f');
        expect(kotlin).toContain('trimPathOffset = 0.5f');
        expect(kotlin).not.toContain('trimPathEnd');
        expect(warnings).toEqual([]);
    });

    it('reports an attribute it does not read, and rejects it under strict', () => {
        const xml = vd(
            '<path android:pathData="M0 0h24v24z" android:fillColor="#000"/>',
            ' android:tintMode="multiply"',
        );
        const { warnings } = vectorDrawableToImageVector(xml, { name: 'Icon' });
        expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
        expect(() => vectorDrawableToImageVector(xml, { name: 'Icon', strict: true })).toThrow(ConversionError);
    });

    it('throws when the root is not <vector> or holds an element it cannot express', () => {
        expect(() => vectorDrawableToImageVector('<selector/>', { name: 'Icon' })).toThrow(
            'Root element is <selector>, expected <vector>',
        );
        expect(() => vectorDrawableToImageVector(vd('<target/>'), { name: 'Icon' })).toThrow(
            'Unsupported VectorDrawable element <target>',
        );
    });
});
