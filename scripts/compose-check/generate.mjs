#!/usr/bin/env node
// Writes the Kotlin of toImageVector (dist/index.js) for every test fixture, a few hand-written cases
// (paints, clips, ids, colour references) and very large icons, then a Main.kt that builds each
// ImageVector and checks the path command count of the large ones. The Gradle build next to this file
// compiles and runs it against Compose Multiplatform (desktop JVM): an unknown Compose API name, a
// Kotlin syntax error, a method over the JVM's 64 KiB limit or a class over its 65,535 constant pool
// entries fails the build or the run.
//
//   pnpm run build
//   node scripts/compose-check/generate.mjs [--big 6000,20000]
//   gradle -p scripts/compose-check run --console=plain      # Gradle 9.8, JDK 21
//
// `--big` lists the curve counts of the single-path large icons (default 6000,20000).

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { values } = parseArgs({ options: { big: { type: 'string', default: '6000,20000' } } });
const bigCurves = values.big
    .split(',')
    .filter(Boolean)
    .map((n) => {
        const count = Number(n);
        if (!Number.isInteger(count) || count < 1) throw new Error(`--big: invalid curve count ${n}`);
        return count;
    });

const { toImageVector } = await import(pathToFileURL(join(root, 'dist/index.js')).href);

const svg = (body, extra = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"${extra}>${body}</svg>`;

/** `n` cubic curves after a moveTo: path data of `n + 1` commands. */
const curves = (n) => {
    let d = 'M1 1';
    for (let i = 0; i < n; i++)
        d += `C${(i % 20) + 1.5} ${(i % 7) + 2.25} ${(i % 11) + 3.125} ${(i % 5) + 4.5} ${(i % 13) + 5.75} ${(i % 3) + 6.5}`;
    return d;
};

/** [name, svg, options, expected path commands (large icons only)]. */
const cases = [];
const fixtures = join(root, 'test/fixtures');
for (const file of readdirSync(fixtures)
    .filter((f) => f.endsWith('.svg'))
    .sort())
    cases.push([file.replace(/\.svg$/, ''), readFileSync(join(fixtures, file), 'utf8'), {}]);
cases.push(
    [
        'x-linear-repeat',
        svg(
            '<defs><linearGradient id="g" x1="0" y1="0" x2="12" y2="0" gradientUnits="userSpaceOnUse" spreadMethod="repeat"><stop offset="0" stop-color="red"/><stop offset=".5" stop-color="#0f08"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="24" height="24" fill="url(#g)"/>',
        ),
        {},
    ],
    [
        'x-radial-reflect',
        svg(
            '<defs><radialGradient id="g" cx="12" cy="12" r="6" gradientUnits="userSpaceOnUse" spreadMethod="reflect"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient></defs><circle cx="12" cy="12" r="10" fill="url(#g)" stroke="url(#g)" stroke-width="2"/>',
        ),
        {},
    ],
    [
        'x-clip-groups',
        svg(
            '<defs><clipPath id="c"><circle cx="12" cy="12" r="8"/></clipPath></defs><g transform="rotate(30 12 12) translate(1 2) scale(1.5 0.5)"><g clip-path="url(#c)"><rect width="24" height="24" fill="#123456"/><path d="M0 0L24 24" stroke="#f00" stroke-width="1"/></g></g>',
        ),
        {},
    ],
    ['x-evenodd', svg('<path fill-rule="evenodd" d="M2 2h20v20H2zM6 6h12v12H6z"/>'), {}],
    [
        'x-strokes',
        svg(
            '<path d="M2 12h20" fill="none" stroke="#00f" stroke-width="3" stroke-linecap="round" stroke-linejoin="bevel" stroke-miterlimit="10" stroke-opacity=".5"/><path d="M2 18l10-6 10 6" fill="none" stroke="#0f0" stroke-width="2" stroke-linecap="square" stroke-linejoin="round"/><path d="M4 4a4 4 0 1 1 8 0a3 3 0 0 0-6 0q1 2 3 3t2 2s1 1 2 2c1 1 2 2 3 3v-1V3m1 1L5 5z" stroke="red"/>',
        ),
        {},
    ],
    [
        'x-alpha',
        svg(
            '<g opacity="0.5"><rect width="10" height="10" fill="red" fill-opacity="0.5"/></g><rect x="5" y="5" width="10" height="10" fill="blue"/>',
            ' opacity="0.7"',
        ),
        {},
    ],
    [
        'x-tint-mirror',
        svg('<path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/>'),
        { tint: '#80FF0000', autoMirrored: true },
    ],
    [
        'x-colorref',
        svg('<path d="M0 0h24v24H0z" fill="currentColor"/><path d="M0 0h4v4z" fill="#00f"/>'),
        { currentColor: '?attr/colorControlNormal', colorMap: { '#00f': '@color/brand' } },
    ],
    [
        'x-ids',
        svg(
            '<g id="grp $ &quot;quoted&quot; \\ back"><path id="p-1$x{y}" d="M0 0h10v10z"/><rect id="r\'é" width="5" height="5" fill="#0f0"/></g><g id="spin" transform="rotate(45)"><path id="tab&#9;here&#10;nl" d="M1 1h2v2z"/></g>',
        ),
        { preserveIds: true },
    ],
);
// Large icons (optimize: false keeps every command): one long path, many paths, a large clip.
for (const n of bigCurves)
    cases.push([
        `big-curves-${n}`,
        svg(`<path d="${curves(n)}" stroke="#000" fill="none"/>`),
        { optimize: false },
        n + 1,
    ]);
// Distinct coordinates (~84,000 distinct float literals): more than one class's constant pool holds.
const distinct = 14000;
let distinctPath = 'M1 1';
for (let i = 0; i < distinct; i++) {
    const v = (k) => (i * 6 + k) / 1000;
    distinctPath += `C${v(0)} ${v(1)} ${v(2)} ${v(3)} ${v(4)} ${v(5)}`;
}
cases.push([
    `big-distinct-${distinct}`,
    svg(`<path d="${distinctPath}" stroke="#000" fill="none"/>`),
    { optimize: false },
    distinct + 1,
]);
const paths = 5000;
cases.push([
    `big-paths-${paths}`,
    svg(
        Array.from(
            { length: paths },
            (_, i) => `<path d="M${i % 24} 0h1v${(i % 23) + 1}z" fill="#${(i % 4096).toString(16).padStart(3, '0')}"/>`,
        ).join(''),
    ),
    { optimize: false },
    paths * 4,
]);
// Paints dominate: one 8-stop gradient per path.
const gradients = 1500;
const stops = Array.from({ length: 8 }, (_, s) => `<stop offset="${s / 7}" stop-color="#${s}${s}${s}"/>`).join('');
cases.push([
    `big-gradients-${gradients}`,
    svg(
        Array.from(
            { length: gradients },
            (_, i) =>
                `<linearGradient id="g${i}" x1="0" y1="${i % 24}" x2="24" y2="0" gradientUnits="userSpaceOnUse">${stops}</linearGradient><path d="M${i % 24} 0h1v${(i % 23) + 1}z" fill="url(#g${i})"/>`,
        ).join(''),
    ),
    { optimize: false },
    gradients * 4,
]);
cases.push([
    'big-clip',
    svg(
        `<defs><clipPath id="c"><path d="${curves(4000)}"/></clipPath></defs><g transform="rotate(10 12 12)"><g clip-path="url(#c)"><path d="${curves(4000)}" fill="#0a0"/><rect width="24" height="24" fill="#00f" fill-opacity=".5"/></g></g>`,
    ),
    { optimize: false },
    4001 * 2 + 5,
]);

const outDir = join(here, 'build/generated/kotlin/check');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'icons'), { recursive: true });
const names = [];
const expected = [];
for (const [file, source, options, commands] of cases) {
    const { kotlin, name, warnings } = toImageVector(source, { name: file, packageName: 'check.icons', ...options });
    writeFileSync(join(outDir, 'icons', `${name}.kt`), kotlin);
    names.push(name);
    if (commands !== undefined) expected.push(`${name} to ${commands}`);
    if (warnings.length > 0) console.log(`${file}: ${warnings.map((w) => w.code).join(', ')}`);
}

const main = `package check

import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.VectorGroup
import androidx.compose.ui.graphics.vector.VectorNode
import androidx.compose.ui.graphics.vector.VectorPath
import check.icons.*

fun nodes(g: VectorGroup): Int = g.sumOf { if (it is VectorGroup) 1 + nodes(it) else 1 }

fun commands(n: VectorNode): Int = when (n) {
    is VectorGroup -> n.clipPathData.size + n.sumOf { commands(it) }
    is VectorPath -> n.pathData.size
}

fun main() {
    val all: List<ImageVector> = listOf(Sweep, ${names.join(', ')})
    for (v in all) println("\${v.name} \${v.defaultWidth}x\${v.defaultHeight} nodes=\${nodes(v.root)} commands=\${commands(v.root)}")
    val expected: List<Pair<ImageVector, Int>> = listOf(${expected.join(', ')})
    for ((v, count) in expected) check(commands(v.root) == count) { "\${v.name}: \${commands(v.root)} path commands, expected $count" }
    println("OK \${all.size} image vectors")
}
`;
writeFileSync(join(outDir, 'Main.kt'), main);
console.log(`compose-check: wrote ${names.length} icons + Main.kt to ${outDir}`);
