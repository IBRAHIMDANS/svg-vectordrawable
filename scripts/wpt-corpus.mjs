#!/usr/bin/env node
// Checks the `strict` promise on the SVG files of web-platform-tests (wpt/svg/, BSD-3-Clause): every
// file converted with `strict: true` must either be REJECTED, or render (resvg) like its source within
// the visual-test threshold (test/visual/compare.ts). A file that converts without error but renders
// differently is a silent wrong render, i.e. a converter bug — unless listed in KNOWN_ARTEFACTS.
//
//   node scripts/wpt-corpus.mjs [--out <png-dir>]
//
// Report only: the exit code is 0 whatever the categories, non-zero only when the run itself fails
// (missing build, git error, dead worker). `--out` writes the source / converted PNG pair of every
// mismatch, for triage.
//
// The wpt `svg/` directory is sparse-checked-out at a PINNED commit into a cache OUTSIDE the project:
// `${os.tmpdir()}/svgvd-wpt` by default, overridable with SVGVD_WPT_DIR. It is fetched only when the
// cache is not at WPT_SHA, so subsequent runs are offline. Converts through the BUILT library
// (`dist/index.js`): run `pnpm run build` first. Requires Node >= 22.18 / 23.6 (imports the
// test/visual .ts helpers natively, like scripts/compare-svg2vector/compare.mjs).

import { execFileSync, spawnSync } from 'node:child_process';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** wpt commit the corpus is read at; bump deliberately (a new upstream test must never change a run). */
const WPT_SHA = '76f5455a0a266f098dd8bd888a8a84b0cad0350d';
const WPT_REPO = 'https://github.com/web-platform-tests/wpt.git';
const WPT_DIR = 'svg';

/**
 * `converted+mismatch` files known to be harness artefacts, not converter bugs (path relative to
 * `svg/` → reason): resvg 2.6 renders the SOURCE differently from the wpt reference, while the
 * converter follows the reference. They are still reported, separately. A real bug never goes here:
 * it gets a fixture `test/fixtures/wpt-<name>.svg` and a correction task. Some entries are currently
 * rejected by `strict` for another reason and only show up once that is fixed.
 */
const RESVG_HSL =
    'resvg paints hsl() with fractional or space-separated components black; the converter emits #339377 like the reference';
const RESVG_PATH_LENGTH =
    'resvg ignores pathLength when laying out dashes; the converter scales the dashes like the reference';
const SIZELESS = 'Until the 24×24 fallback for a root without size is fixed, it adds to the mismatch';
const RESVG_EMPTY_GRADIENT_TRANSFORM = `resvg reads gradientTransform="" as identity instead of inheriting the href gradient transform; the converter (optimize: true) inherits it like the reference. ${SIZELESS}`;
const KNOWN_ARTEFACTS = new Map([
    [
        'painting/currentColor-override-pserver-fallback.svg',
        `resvg ignores the fallback color after an unresolved url(#…) and paints black; the converter paints limegreen like the reference. ${SIZELESS}`,
    ],
    ['pservers/reftests/linear-gradient-transform-empty-attr.svg', RESVG_EMPTY_GRADIENT_TRANSFORM],
    ['pservers/reftests/radial-gradient-transform-empty-attr.svg', RESVG_EMPTY_GRADIENT_TRANSFORM],
    [
        'struct/reftests/use-symbol-display-none.svg',
        'resvg draws a display="none" <symbol> through <use>; the converter does not, like the reference',
    ],
    [
        'struct/reftests/use-encoding.svg',
        'resvg does not percent-decode href="#a%20b"; the converter resolves it like the reference',
    ],
    ['painting/reftests/paint-fill-attr-hsl.svg', RESVG_HSL],
    ['painting/reftests/paint-fill-attr-hsl-legacy.svg', RESVG_HSL],
    ['painting/reftests/paint-fill-hsl.svg', RESVG_HSL],
    ['painting/reftests/paint-fill-hsl-legacy.svg', RESVG_HSL],
    ['path/distance/pathlength-path.svg', RESVG_PATH_LENGTH],
    ['path/distance/pathlength-rect.svg', RESVG_PATH_LENGTH],
    ['shapes/reftests/pathlength-001.svg', RESVG_PATH_LENGTH],
    ['shapes/reftests/pathlength-002.svg', RESVG_PATH_LENGTH],
    ['shapes/reftests/pathlength-004a.svg', RESVG_PATH_LENGTH],
]);

/**
 * Files rendered per child process: resvg-js never releases its native pixel buffers (see
 * test/visual/run-corpus.ts), so the renders run in fresh processes of this many files each.
 */
const BATCH = 300;
const WORKER_FLAG = '--worker';
const MODES = [true, false]; // optimize

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cacheDir = process.env.SVGVD_WPT_DIR || join(tmpdir(), 'svgvd-wpt');
const svgRoot = join(cacheDir, WPT_DIR);

// ---------------------------------------------------------------------------------------------------
// Cache

function git(...args) {
    return execFileSync('git', ['-C', cacheDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Sparse-checks-out wpt `svg/` at WPT_SHA into the cache unless it is already there. */
function ensureCorpus() {
    const isRepo = existsSync(join(cacheDir, '.git'));
    if (isRepo && existsSync(svgRoot)) {
        let head = '';
        try {
            head = git('rev-parse', 'HEAD').trim();
        } catch {
            // No commit checked out yet: fetch below.
        }
        if (head === WPT_SHA) {
            console.log(`[wpt] Using cached corpus: ${cacheDir}`);
            return;
        }
    }
    console.log(`[wpt] Fetching ${WPT_REPO} ${WPT_DIR}/ at ${WPT_SHA} into ${cacheDir} …`);
    mkdirSync(cacheDir, { recursive: true });
    if (!isRepo) {
        git('init', '--quiet');
        git('remote', 'add', 'origin', WPT_REPO);
    }
    git('sparse-checkout', 'set', WPT_DIR);
    git('fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', WPT_SHA);
    git('checkout', '--quiet', '--force', 'FETCH_HEAD');
}

// ---------------------------------------------------------------------------------------------------
// Filtering

/** `<link rel="match">` and friends are reftest metadata, not resources the rendering loads. */
const METADATA_LINK = /<(?:[\w-]+:)?link\b[^>]*\brel\s*=\s*["'](?:match|mismatch|help|author)["'][^>]*>/gi;

/** True when the SVG loads anything outside itself (other file, URL, stylesheet, external entity). */
function hasExternalResource(svg) {
    const body = svg.replace(METADATA_LINK, '');
    if (/<\?xml-stylesheet\b/i.test(body) || /<!ENTITY\b[^>]*\b(?:SYSTEM|PUBLIC)\b/i.test(body)) return true;
    if (/@import\b/i.test(body)) return true;
    // url(...) to anything but a local fragment or a data: URI.
    for (const [, target] of body.matchAll(/url\(\s*["']?([^"')]*)/gi)) {
        if (!target.startsWith('#') && !target.startsWith('data:')) return true;
    }
    // href / src attributes, except navigation links (`<a href>` draws its content like a `<g>`).
    for (const [, tag, attrs] of body.matchAll(/<([\w:.-]+)\b([^>]*)>/g)) {
        if (/^(?:[\w-]+:)?a$/.test(tag)) continue;
        for (const [, , value] of attrs.matchAll(/(?:^|\s)(?:[\w-]+:)?(?:href|src)\s*=\s*(["'])(.*?)\1/g)) {
            if (!value.startsWith('#') && !value.startsWith('data:')) return true;
        }
    }
    return false;
}

/** Root element is `<svg>`, after the prolog (XML declaration, PIs, comments, doctype). */
function isStandaloneSvg(svg) {
    const body = svg
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\?[\s\S]*?\?>/g, '')
        .replace(/<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>/i, '');
    return /^\s*<(?:[\w-]+:)?svg[\s>]/.test(body);
}

/**
 * Reftest references and helper files, by wpt's own naming conventions: `-ref` / `-notref` names
 * (`x-ref.svg`, `x-ref.tentative.svg`), Blink's `-expected.svg`, and the `reference(s)/`, `support/`,
 * `resources/` directories (images loaded by other tests, often deliberately without a size).
 */
const REFERENCE_OR_SUPPORT =
    /-(?:not)?ref(?:\.[\w-]+)?\.svg$|-expected\.svg$|(?:^|\/)(?:references?|support|resources)\//;

/** Exclusion rules, first match wins; `test` receives the file content. */
const EXCLUSIONS = [
    { reason: 'not a standalone <svg>', test: (svg) => !isStandaloneSvg(svg) },
    { reason: '<script>', test: (svg) => /<(?:[\w-]+:)?script[\s>/]/i.test(svg) },
    { reason: 'SMIL animation', test: (svg) => /<(?:[\w-]+:)?(?:animate\w*|set)[\s>/]/.test(svg) },
    { reason: '<text>', test: (svg) => /<(?:[\w-]+:)?(?:text|tspan|textPath)[\s>/]/.test(svg) },
    { reason: '<foreignObject>', test: (svg) => /<(?:[\w-]+:)?foreignObject[\s>/]/.test(svg) },
    { reason: 'external resource', test: hasExternalResource },
];

/** Every `.svg` under `dir`, as `/`-separated paths relative to `svgRoot`, sorted. */
function listSvgs(dir) {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.svg'))
        .map((e) => relative(svgRoot, join(e.parentPath, e.name)).split(sep).join('/'))
        .sort();
}

/** Splits the corpus into the files to evaluate and the per-reason exclusion counts. */
function selectFiles() {
    const all = listSvgs(svgRoot);
    const excluded = new Map();
    const exclude = (reason) => excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
    const selected = [];
    for (const file of all) {
        if (REFERENCE_OR_SUPPORT.test(file)) {
            exclude('reference / support file');
            continue;
        }
        // Comments are dropped first: a test describing `<text>` in prose must not be excluded for it.
        const svg = readFileSync(join(svgRoot, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        const rule = EXCLUSIONS.find((r) => r.test(svg));
        if (rule) exclude(rule.reason);
        else selected.push(file);
    }
    return { total: all.length, selected, excluded };
}

// ---------------------------------------------------------------------------------------------------
// Evaluation (worker side)

function formatError(err) {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Child-process entry: evaluates `units` ({ file, optimize }) in order and appends one JSON row per
 * unit to `outputPath` as soon as it is done. Before each resvg render it records the stage in
 * `progressPath`, so the parent can tell which unit (and which render) a native crash killed.
 */
async function runWorker(inputPath, outputPath, progressPath) {
    const { units, out } = JSON.parse(readFileSync(inputPath, 'utf8'));
    const { convert } = await import(pathToFileURL(join(root, 'dist', 'index.js')).href);
    const { vdToSvg } = await import(pathToFileURL(join(root, 'test/visual/vdToSvg.ts')).href);
    const { renderSvg, compareRasters, DEFAULT_MAX_MISMATCH, RENDER_WIDTH } = await import(
        pathToFileURL(join(root, 'test/visual/compare.ts')).href
    );
    const { Resvg } = await import('@resvg/resvg-js');
    const writePng = (path, svg) =>
        writeFileSync(
            path,
            new Resvg(svg, { fitTo: { mode: 'width', value: RENDER_WIDTH }, font: { loadSystemFonts: false } })
                .render()
                .asPng(),
        );
    const stage = (name) => writeFileSync(progressPath, name);

    let cached = { file: undefined, source: undefined }; // source raster, shared by the modes of a file
    const evaluateUnit = (file, optimize) => {
        const svg = readFileSync(join(svgRoot, file), 'utf8');
        const row = { file, optimize };
        let result;
        try {
            result = convert(svg, { strict: true, optimize });
        } catch (err) {
            const warningCode = err?.warning?.code;
            const code = warningCode ?? err?.name ?? 'Error';
            return { ...row, category: 'rejected', warningCode, code, message: formatError(err) };
        }
        row.warnings = [...new Set(result.warnings.map((w) => w.code))];
        if (cached.file !== file) {
            stage('source');
            try {
                cached = { file, source: renderSvg(svg) };
            } catch (err) {
                cached = { file, source: formatError(err) };
            }
        }
        if (typeof cached.source === 'string') {
            return { ...row, category: 'unrenderable-source', message: cached.source };
        }
        let back;
        try {
            back = vdToSvg(result.xml);
            stage('output');
            const r = compareRasters(cached.source, renderSvg(back));
            Object.assign(row, { mismatch: r.mismatch, maxDelta: r.maxDelta, inked: r.inked });
            if (r.sizeMismatch) row.message = `size ${r.sizeMismatch}`;
        } catch (err) {
            // The converter's output cannot be rendered back: the invariant does not hold.
            Object.assign(row, { mismatch: 1, maxDelta: 255, inked: 0, message: `output: ${formatError(err)}` });
        }
        row.category = row.mismatch < DEFAULT_MAX_MISMATCH ? 'match' : 'mismatch';
        if (row.category === 'mismatch' && out && back) {
            const stem = `${file.replace(/\.svg$/, '').replaceAll('/', '__')}.optimize-${optimize}`;
            stage('png');
            writePng(join(out, `${stem}.source.png`), svg);
            writePng(join(out, `${stem}.vd.png`), back);
        }
        return row;
    };
    for (const { file, optimize } of units) {
        appendFileSync(outputPath, JSON.stringify(evaluateUnit(file, optimize)) + '\n');
    }
}

/** Row for the unit a worker died on: resvg (native code) crashed instead of throwing. */
function crashRow({ file, optimize }, stage) {
    const message = `resvg crashed rendering the ${stage === 'source' ? 'source' : 'converted output'}`;
    return stage === 'source'
        ? { file, optimize, category: 'unrenderable-source', message }
        : { file, optimize, category: 'mismatch', mismatch: 1, maxDelta: 255, inked: 0, message };
}

/**
 * Evaluates every (file, optimize) unit in child processes of BATCH files each. A worker killed by a
 * native resvg crash costs only the unit it was on: it is recorded with crashRow() and a new worker
 * resumes at the next unit. Throws when a worker fails for any other reason.
 */
function evaluateInWorkers(files, out) {
    const units = files.flatMap((file) => MODES.map((optimize) => ({ file, optimize })));
    const tmp = mkdtempSync(join(tmpdir(), 'svgvd-wpt-run-'));
    const input = join(tmp, 'in.json');
    const output = join(tmp, 'out.jsonl');
    const progress = join(tmp, 'progress');
    const rows = [];
    try {
        while (rows.length < units.length) {
            const batch = units.slice(rows.length, rows.length + BATCH * MODES.length);
            writeFileSync(input, JSON.stringify({ units: batch, out }));
            writeFileSync(output, '');
            writeFileSync(progress, '');
            const child = spawnSync(
                process.execPath,
                [fileURLToPath(import.meta.url), WORKER_FLAG, input, output, progress],
                { stdio: ['ignore', 'inherit', 'inherit'] },
            );
            if (child.error) throw new Error(`worker could not start: ${child.error.message}`);
            const done = readFileSync(output, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line));
            rows.push(...done);
            if (child.status !== 0) {
                const stage = readFileSync(progress, 'utf8');
                const unit = batch[done.length];
                const how = child.signal ? `signal ${child.signal}` : `exit code ${child.status}`;
                if (!child.signal || !unit || !stage)
                    throw new Error(`worker died (${how}) after ${done.length} units`);
                console.error(`[wpt] resvg crashed (${how}) on ${unit.file} (optimize=${unit.optimize}), resuming`);
                rows.push(crashRow(unit, stage));
            }
            process.stdout.write(`\r[wpt] Evaluated ${rows.length} / ${units.length} conversions`);
        }
        process.stdout.write('\n');
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
    return rows;
}

// ---------------------------------------------------------------------------------------------------
// Report

function parseArgs(argv) {
    const opts = { out: undefined };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out' && argv[i + 1]) opts.out = resolve(argv[++i]);
        else {
            console.error('usage: node scripts/wpt-corpus.mjs [--out <png-dir>]');
            process.exit(2);
        }
    }
    return opts;
}

function report({ total, selected, excluded }, rows, seconds) {
    const pct = (n) => `${(n * 100).toFixed(2)}%`;
    const count = (category, optimize) => rows.filter((r) => r.category === category && r.optimize === optimize).length;
    const modes = (category) => MODES.map((m) => String(count(category, m)).padStart(5)).join(' / ');

    console.log(
        `[wpt] web-platform-tests/wpt@${WPT_SHA.slice(0, 12)} ${WPT_DIR}/: ${total} .svg files, ` +
            `${selected.length} after filtering, evaluated in ${seconds}s`,
    );
    console.log('[wpt] Excluded:');
    for (const [reason, n] of [...excluded].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${reason.padEnd(26)} ${String(n).padStart(5)}`);
    }
    console.log('[wpt] strict: true, per mode (optimize: true / false):');
    console.log(`    rejected                   ${modes('rejected')}`);
    console.log(`    converted+match            ${modes('match')}`);
    console.log(`    converted+mismatch         ${modes('mismatch')}`);
    const unrenderable = rows.filter((r) => r.category === 'unrenderable-source');
    if (unrenderable.length > 0) console.log(`    source not renderable      ${modes('unrenderable-source')}`);

    const codes = new Map();
    for (const r of rows.filter((x) => x.category === 'rejected')) codes.set(r.code, (codes.get(r.code) ?? 0) + 1);
    console.log('[wpt] Rejections by code (both modes):');
    for (const [code, n] of [...codes].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${code.padEnd(30)} ${String(n).padStart(5)}`);
    }

    // A rejection that is not a ConversionError is a parse failure or a crash, worth a look.
    const thrown = rows.filter((r) => r.category === 'rejected' && !r.warningCode);
    if (thrown.length > 0) {
        console.log(`[wpt] Rejected by an exception other than ConversionError: ${thrown.length}`);
        thrown.forEach((r) => console.log(`    ${r.file} (optimize=${r.optimize}): ${r.code}: ${r.message}`));
    }

    const line = (r) =>
        `    ${pct(r.mismatch).padStart(8)}  maxΔ ${String(r.maxDelta).padStart(3)}  ${r.file} (optimize=${r.optimize})` +
        (r.warnings?.length ? `  [${r.warnings.join(', ')}]` : '') +
        (r.message ? `  ${r.message}` : '');
    const mismatches = rows.filter((r) => r.category === 'mismatch').sort((a, b) => b.mismatch - a.mismatch);
    const bugs = mismatches.filter((r) => !KNOWN_ARTEFACTS.has(r.file));
    const artefacts = mismatches.filter((r) => KNOWN_ARTEFACTS.has(r.file));
    console.log(`[wpt] converted+mismatch, not in KNOWN_ARTEFACTS (converter bugs): ${bugs.length}`);
    bugs.forEach((r) => console.log(line(r)));
    console.log(`[wpt] converted+mismatch, known harness artefacts: ${artefacts.length}`);
    artefacts.forEach((r) => console.log(`${line(r)}\n        ↳ ${KNOWN_ARTEFACTS.get(r.file)}`));
    for (const file of KNOWN_ARTEFACTS.keys()) {
        const own = rows.filter((r) => r.file === file);
        if (own.length > 0 && own.every((r) => r.category === 'match')) {
            console.log(`    (stale) ${file} now matches in both modes: remove it from KNOWN_ARTEFACTS`);
        }
    }
    if (unrenderable.length > 0) {
        console.log(`[wpt] Sources resvg cannot render (not judged): ${unrenderable.length}`);
        unrenderable.forEach((r) => console.log(`    ${r.file} (optimize=${r.optimize}): ${r.message}`));
    }
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv[0] === WORKER_FLAG) return runWorker(argv[1], argv[2], argv[3]);

    const opts = parseArgs(argv);
    const distEntry = join(root, 'dist', 'index.js');
    if (!existsSync(distEntry)) {
        console.error(`[wpt] ${distEntry} missing. Did you run \`pnpm run build\`?`);
        process.exit(1);
    }
    ensureCorpus();
    if (opts.out) mkdirSync(opts.out, { recursive: true });

    const started = Date.now();
    const selection = selectFiles();
    const rows = evaluateInWorkers(selection.selected, opts.out);
    report(selection, rows, ((Date.now() - started) / 1000).toFixed(1));
    if (opts.out) console.log(`[wpt] PNG pairs of the mismatches written to ${opts.out}`);
}

main().catch((err) => {
    console.error(`[wpt] Unexpected error: ${err instanceof Error ? err.stack : err}`);
    process.exit(1);
});
