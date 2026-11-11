#!/usr/bin/env node
// Generates docs/assets/radial-gradient-comparison.png, the before/after image shown at the top of the
// README: one fixture rendered three ways, side by side.
//
//   1. the source SVG, rendered directly by resvg (the reference);
//   2. the VectorDrawable emitted by svg2vectordrawable@2.9.1, previewed back to SVG and rendered;
//   3. the VectorDrawable emitted by this library (the BUILT dist/index.js), previewed and rendered.
//
// Rendering follows the test/visual harness: resvg, system fonts off, VectorDrawable → SVG through the
// public `vectorDrawableToSvg` preview. The three renders are embedded as SVG images in one composite
// SVG (labels included) that resvg rasterizes to a single PNG, so no image tool is needed.
//
// svg2vectordrawable and the label font (DejaVu Sans) are installed into a cache directory OUTSIDE the
// project (never in package.json): `${os.tmpdir()}/svgvd-s2vd` by default, overridable with
// SVGVD_S2VD_DIR. They are installed only when missing, so subsequent runs are offline. Both are pinned
// and system fonts are never loaded: the PNG is byte-identical from one run (and machine) to the next.
//
//   pnpm build && node docs/assets/generate-comparison.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const fixture = join(root, 'test/fixtures/radial-gradient-transform.svg');
const output = join(here, 'radial-gradient-comparison.png');

/** Packages installed outside the project, pinned so the image never changes without a code change. */
const PACKAGES = { svg2vectordrawable: '2.9.1', 'dejavu-fonts-ttf': '2.37.3' };
const cacheDir = process.env.SVGVD_S2VD_DIR || join(tmpdir(), 'svgvd-s2vd');
const modulesDir = join(cacheDir, 'node_modules');
const fontDir = join(modulesDir, 'dejavu-fonts-ttf', 'ttf');

/**
 * Layout, in px. Rasterized at 1×: smooth gradients compress poorly, a 2× render weighs ~230 KB
 * against ~75 KB here, and the image must stay well under 100 KB.
 */
const TILE = 224;
const GAP = 24;
const MARGIN = 24;
const LABEL_HEIGHT = 56;
const WIDTH = 2 * MARGIN + 3 * TILE + 2 * GAP;
const HEIGHT = 2 * MARGIN + TILE + LABEL_HEIGHT;

/** Installs the pinned packages into the cache unless they are all already there. */
function ensurePackages() {
    const installedVersion = (p) => {
        const manifest = join(modulesDir, p, 'package.json');
        return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : undefined;
    };
    if (Object.entries(PACKAGES).every(([p, version]) => installedVersion(p) === version)) return;
    // Always the full set: an npm install with --no-save prunes packages it was not asked for.
    const specs = Object.entries(PACKAGES).map(([p, version]) => `${p}@${version}`);
    console.log(`[comparison] Installing ${specs.join(', ')} into ${cacheDir} …`);
    mkdirSync(cacheDir, { recursive: true });
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['install', '--prefix', cacheDir, '--no-save', '--no-audit', '--no-fund', ...specs], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
}

/** Reads the radial gradient geometry of a VectorDrawable, for the panel label. */
function describeGradient(xml) {
    const attr = (name) => xml.match(new RegExp(`android:${name}="([^"]*)"`))?.[1] ?? '?';
    return `center (${attr('centerX')}, ${attr('centerY')}), radius ${attr('gradientRadius')}`;
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const svgDataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

/** One panel: the render on a dark tile (the gradient fades to transparent), a title and a verdict line. */
function panel(index, { svg, title, note, noteColor }) {
    const x = MARGIN + index * (TILE + GAP);
    const y = MARGIN;
    return [
        `<rect x="${x}" y="${y}" width="${TILE}" height="${TILE}" fill="#161b22"/>`,
        `<image x="${x}" y="${y}" width="${TILE}" height="${TILE}" href="${svgDataUri(svg)}"/>`,
        `<rect x="${x + 0.5}" y="${y + 0.5}" width="${TILE - 1}" height="${TILE - 1}" fill="none" stroke="#d0d7de"/>`,
        `<text x="${x + TILE / 2}" y="${y + TILE + 26}" text-anchor="middle" font-size="15" font-weight="bold" fill="#1f2328">${escapeXml(title)}</text>`,
        `<text x="${x + TILE / 2}" y="${y + TILE + 47}" text-anchor="middle" font-size="13" fill="${noteColor}">${escapeXml(note)}</text>`,
    ].join('');
}

async function main() {
    const distEntry = join(root, 'dist', 'index.js');
    if (!existsSync(distEntry)) {
        console.error(`[comparison] ${distEntry} not found. Run \`pnpm build\` first.`);
        process.exit(1);
    }
    const { convert, vectorDrawableToSvg } = await import(pathToFileURL(distEntry).href);
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

    ensurePackages();
    const svg2vectordrawable = createRequire(join(modulesDir, 'noop.js'))('svg2vectordrawable');

    const source = readFileSync(fixture, 'utf8');
    const theirs = await svg2vectordrawable(source);
    const ours = convert(source).xml;

    const panels = [
        { svg: source, title: 'Source SVG', note: 'radial with gradientTransform', noteColor: '#59636e' },
        {
            svg: vectorDrawableToSvg(theirs),
            title: `svg2vectordrawable ${PACKAGES.svg2vectordrawable}`,
            note: `✗ ${describeGradient(theirs)}`,
            noteColor: '#cf222e',
        },
        {
            svg: vectorDrawableToSvg(ours),
            title: `svg-vectordrawable ${version}`,
            note: `✓ ${describeGradient(ours)}`,
            noteColor: '#1a7f37',
        },
    ];

    const composite =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="DejaVu Sans">` +
        `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="12" fill="#ffffff" stroke="#d0d7de"/>` +
        panels.map((p, i) => panel(i, p)).join('') +
        `</svg>`;

    const png = new Resvg(composite, {
        font: {
            loadSystemFonts: false,
            fontFiles: [join(fontDir, 'DejaVuSans.ttf'), join(fontDir, 'DejaVuSans-Bold.ttf')],
            defaultFontFamily: 'DejaVu Sans',
        },
    })
        .render()
        .asPng();
    writeFileSync(output, png);
    console.log(`[comparison] Wrote ${relative(root, output)} (${png.length} bytes)`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
