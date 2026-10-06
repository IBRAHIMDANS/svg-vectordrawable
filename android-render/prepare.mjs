#!/usr/bin/env node
// Step 1/3 of the Android rendering check (TASK-020). resvg is not Android's renderer: this pipeline
// renders the generated VectorDrawables with Android's own graphics stack (layoutlib = the platform's
// native Skia/hwui, run on the JVM through Paparazzi) and compares them with resvg's render of the source.
//
//   pnpm run build                                   # the library under test is dist/index.js
//   node android-render/prepare.mjs                  # SVG -> res/drawable/*.xml + resvg reference PNGs
//   (cd android-render && ./gradlew :render:testDebugUnitTest)   # Android -> build/render/android/*.png
//   node android-render/compare.mjs                  # pixel comparison, exit 1 above threshold
//
// Inputs: test/fixtures/*.svg (the library's fixtures) and android-render/probes/*.svg (targeted cases
// for Android-specific behaviours: single-stop gradients, clamped offsets, gradient strokes, arc flags,
// evenOdd). Each is converted with `optimize: true`.
//
// Outputs (all git-ignored):
//   render/src/main/res/drawable/<name>.xml      generated VectorDrawables
//   build/render/reference/<name>.png            resvg render of the (variant of the) source SVG
//   build/render/reference/<name>.svg            that reference SVG, for inspection
//   build/render/fixtures.tsv                    name, width, height, kind, source, note
//
// Two deliberately broken drawables (kind `broken`) are added: compare.mjs requires them to FAIL,
// proving the comparison actually detects a wrong Android render.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { RENDER_WIDTH } from '../test/visual/compare.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const drawableDir = join(here, 'render', 'src', 'main', 'res', 'drawable');
const outDir = join(here, 'build', 'render');
const referenceDir = join(outDir, 'reference');

const { convert } = await import(join(root, 'dist', 'index.js')).catch(() => {
    console.error('dist/index.js not found: run `pnpm run build` first.');
    process.exit(1);
});

/**
 * Features the converter drops *by design* (with a warning) are modelled on the reference side, never
 * by loosening the threshold. A variant step applies only when its warning is actually emitted, so the
 * reference follows the library: once a feature becomes supported (e.g. dashes, TASK-021), the warning
 * disappears and the raw source becomes the reference again.
 */
const REFERENCE_VARIANTS = {
    'issue-1-react-logo.svg': [
        {
            // Group opacity folded onto each leaf's fill/stroke alpha = inherited fill-/stroke-opacity.
            warning: 'opacity-approximated',
            note: 'group opacity per leaf',
            apply: (svg) => svg.replace(/\bopacity="0\.2"/, 'fill-opacity="0.2" stroke-opacity="0.2"'),
        },
    ],
};

/** Resource names: [a-z0-9_], starting with a letter. */
function resourceName(prefix, file) {
    return `${prefix}_${file
        .replace(/\.svg$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')}`;
}

function renderReference(svg) {
    const image = new Resvg(svg, {
        fitTo: { mode: 'width', value: RENDER_WIDTH },
        font: { loadSystemFonts: false },
    }).render();
    return { width: image.width, height: image.height, png: image.asPng() };
}

function listSvgs(dir) {
    return readdirSync(dir)
        .filter((f) => f.endsWith('.svg'))
        .sort()
        .map((f) => ({ file: f, path: join(dir, f) }));
}

rmSync(drawableDir, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });
mkdirSync(drawableDir, { recursive: true });
mkdirSync(referenceDir, { recursive: true });

const manifest = [];

function emit(name, kind, sourcePath, xml, referenceSvg, note) {
    writeFileSync(join(drawableDir, `${name}.xml`), xml);
    writeFileSync(join(referenceDir, `${name}.svg`), referenceSvg);
    const { width, height, png } = renderReference(referenceSvg);
    writeFileSync(join(referenceDir, `${name}.png`), png);
    manifest.push([name, width, height, kind, relative(root, sourcePath), note || '-'].join('\t'));
}

const inputs = [
    ...listSvgs(join(root, 'test', 'fixtures')).map((s) => ({ ...s, kind: 'fixture', prefix: 'fx' })),
    ...listSvgs(join(here, 'probes')).map((s) => ({ ...s, kind: 'probe', prefix: 'probe' })),
];

const converted = new Map();
for (const { file, path, kind, prefix } of inputs) {
    const svg = readFileSync(path, 'utf8');
    const { xml, warnings } = convert(svg, { optimize: true });
    const codes = new Set(warnings.map((w) => w.code));
    let reference = svg;
    const notes = [];
    for (const variant of REFERENCE_VARIANTS[file] ?? []) {
        if (!codes.has(variant.warning)) continue;
        reference = variant.apply(reference);
        notes.push(variant.note);
        codes.delete(variant.warning);
    }
    for (const code of codes) console.warn(`${file}: warning ${code} not modelled by a reference variant`);
    const name = resourceName(prefix, file);
    emit(name, kind, path, xml, reference, notes.join('; '));
    converted.set(file, { name, path, xml, reference });
}

// Deliberately wrong drawables: the comparison must flag them.
const logo = converted.get('issue-1-react-logo.svg');
if (logo) {
    const start = logo.xml.lastIndexOf('<path');
    const dropped = logo.xml.slice(0, start) + logo.xml.slice(logo.xml.indexOf('/>', start) + 2);
    if (dropped === logo.xml) throw new Error('could not drop the last <path> of the react logo');
    emit('broken_dropped_path', 'broken', logo.path, dropped, logo.reference, 'last <path> removed');
}
const gradient = converted.get('linear-gradient.svg');
if (gradient) {
    const recolored = gradient.xml.replace('#FF07B8D8', '#FFD8B807');
    if (recolored === gradient.xml) throw new Error('could not recolor the linear-gradient end stop');
    emit('broken_wrong_stop', 'broken', gradient.path, recolored, gradient.reference, 'end stop recolored');
}

writeFileSync(join(outDir, 'fixtures.tsv'), manifest.join('\n') + '\n');
console.log(`prepared ${manifest.length} drawables in ${relative(root, drawableDir)}`);
