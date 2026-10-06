#!/usr/bin/env node
// Benchmarks this library against Android Studio's SVG importer (Svg2Vector, com.android.tools:sdk-common)
// on the same inputs and with the same rendering metric as test/visual (resvg + mismatch ratio over
// inked pixels, threshold 1 %). See README.md.
//
//   node scripts/compare-svg2vector/compare.mjs [--set fixtures,probes,feather,...] [--limit 500]
//        [--top 10] [--png] [--no-build]
//
// Requires Node >= 23.6 (imports the harness .ts files natively) and `pnpm run build` (dist/index.js).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';


const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const outDir = join(here, 'out');
const corpusModules = join(process.env.SVGVD_CORPUS_DIR || join(tmpdir(), 'svgvd-corpus'), 'node_modules');

/** Input sets. `sample: false` sets are always converted in full (they are small, hand-written). */
const SETS = {
    fixtures: { dir: join(root, 'test/fixtures'), sample: false },
    probes: { dir: join(root, 'android-render/probes'), sample: false },
    feather: { dir: join(corpusModules, 'feather-icons/dist/icons'), sample: true },
    bootstrap: { dir: join(corpusModules, 'bootstrap-icons/icons'), sample: true },
    'heroicons-outline': { dir: join(corpusModules, 'heroicons/24/outline'), sample: true },
    'heroicons-solid': { dir: join(corpusModules, 'heroicons/24/solid'), sample: true },
    'tabler-outline': { dir: join(corpusModules, '@tabler/icons/icons/outline'), sample: true },
    'tabler-filled': { dir: join(corpusModules, '@tabler/icons/icons/filled'), sample: true },
};

function parseArgs(argv) {
    const opts = { sets: Object.keys(SETS), limit: 500, top: 10, png: false, build: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--set') opts.sets = argv[++i].split(',');
        else if (a === '--limit') opts.limit = Number(argv[++i]);
        else if (a === '--top') opts.top = Number(argv[++i]);
        else if (a === '--png') opts.png = true;
        else if (a === '--no-build') opts.build = false;
        else if (a === '--help' || a === '-h') {
            console.log('usage: compare.mjs [--set a,b] [--limit N (0 = all)] [--top N] [--png] [--no-build]');
            console.log(`sets: ${Object.keys(SETS).join(', ')}`);
            process.exit(0);
        } else throw new Error(`Unknown argument ${a}`);
    }
    for (const s of opts.sets) if (!SETS[s]) throw new Error(`Unknown set "${s}" (known: ${Object.keys(SETS).join(', ')})`);
    return opts;
}

/** Evenly spaced deterministic sample of a sorted file list (covers the whole alphabet, not just "a…"). */
function sample(files, limit) {
    if (!limit || files.length <= limit) return files;
    const step = files.length / limit;
    return Array.from({ length: limit }, (_, i) => files[Math.floor(i * step)]);
}

const runnerBin = join(here, 'build/install/svg2vector-runner/bin/svg2vector-runner');

function buildRunner(force) {
    if (!force && existsSync(runnerBin)) return;
    console.log('[s2v] Building the Svg2Vector runner (Gradle) …');
    execFileSync(join(here, 'gradlew'), ['-q', '-p', here, 'installDist'], { stdio: 'inherit' });
}

/** Converts every job in one JVM; returns the results keyed by source path. */
function runSvg2Vector(jobs) {
    const jobsFile = join(outDir, 'jobs.tsv');
    const resultsFile = join(outDir, 'svg2vector-results.jsonl');
    writeFileSync(jobsFile, jobs.map((j) => `${j.src}\t${j.s2vXml}`).join('\n') + '\n');
    const started = performance.now();
    execFileSync(runnerBin, [jobsFile, resultsFile], { stdio: 'inherit' });
    const wall = performance.now() - started;
    const results = new Map();
    for (const line of readFileSync(resultsFile, 'utf8').split('\n')) {
        if (!line) continue;
        const r = JSON.parse(line);
        results.set(r.src, r);
    }
    return { results, wall };
}

/** Whitespace-insensitive size: what remains once indentation and line breaks are collapsed. */
function compactBytes(xml) {
    return Buffer.byteLength(xml.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim());
}

const quantile = (values, q) => {
    if (values.length === 0) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)} %` : 'n/a');
const sum = (values) => values.reduce((a, b) => a + b, 0);

/**
 * Files rendered per child process. resvg-js does not release its native pixel buffers (≈ 0.5 MB per
 * 256 px render, even with explicit GCs), so a single process rendering the full corpus (≈ 28k renders)
 * would need > 15 GB; each chunk runs in a fresh process instead.
 */
const RENDER_CHUNK = 600;

/** Svg2Vector copies `currentColor` verbatim into android:fillColor / strokeColor: not an Android color. */
const CURRENT_COLOR = /"currentColor"/i;

async function loadHarness() {
    const { vdToSvg } = await import(pathToFileURL(join(root, 'test/visual/vdToSvg.ts')).href);
    const compare = await import(pathToFileURL(join(root, 'test/visual/compare.ts')).href);
    return { vdToSvg, ...compare };
}

/** XML → harness SVG; `currentColor` is replaced by the library's default (#000000) to compare geometry. */
function harnessSvg(vdToSvg, xml) {
    return vdToSvg(xml.replace(new RegExp(CURRENT_COLOR.source, 'gi'), '"#FF000000"'));
}

/** Child-process entry: renders and compares one chunk (see RENDER_CHUNK). */
async function renderWorker(inputPath, outputPath) {
    const { vdToSvg, renderSvg, compareRasters } = await loadHarness();
    const evaluate = (sourceRaster, xmlPath) => {
        let svg;
        try {
            svg = harnessSvg(vdToSvg, readFileSync(xmlPath, 'utf8'));
        } catch (err) {
            return { harnessError: `vdToSvg: ${err.message}` };
        }
        try {
            const r = compareRasters(sourceRaster, renderSvg(svg));
            return { mismatch: r.mismatch, maxDelta: r.maxDelta, inked: r.inked, sizeMismatch: r.sizeMismatch };
        } catch (err) {
            return { harnessError: `render: ${err.message}` };
        }
    };
    const results = JSON.parse(readFileSync(inputPath, 'utf8')).map((task) => {
        let sourceRaster;
        try {
            sourceRaster = renderSvg(readFileSync(task.src, 'utf8'));
        } catch (err) {
            return { sourceError: err.message };
        }
        return {
            lib: task.lib ? evaluate(sourceRaster, task.lib) : null,
            s2v: task.s2v ? evaluate(sourceRaster, task.s2v) : null,
        };
    });
    writeFileSync(outputPath, JSON.stringify(results));
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const distEntry = join(root, 'dist/index.js');
    if (!existsSync(distEntry)) throw new Error(`${distEntry} missing: run \`pnpm run build\` first`);
    const { convert } = await import(pathToFileURL(distEntry).href);
    const { vdToSvg, DEFAULT_MAX_MISMATCH } = await loadHarness();
    const { Resvg } = await import('@resvg/resvg-js');

    buildRunner(opts.build);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    // 1. Inputs.
    const jobs = [];
    for (const set of opts.sets) {
        const { dir, sample: sampled } = SETS[set];
        if (!existsSync(dir)) {
            console.warn(`[skip] ${set}: ${dir} not found (run scripts/corpus.mjs once to fetch the corpus)`);
            continue;
        }
        const files = readdirSync(dir).filter((f) => f.endsWith('.svg')).sort();
        for (const file of sampled ? sample(files, opts.limit) : files) {
            const stem = basename(file, '.svg');
            jobs.push({
                set,
                file,
                src: join(dir, file),
                libXml: join(outDir, 'lib', set, `${stem}.xml`),
                s2vXml: join(outDir, 'svg2vector', set, `${stem}.xml`),
            });
        }
    }
    console.log(`[inputs] ${jobs.length} SVGs from ${opts.sets.join(', ')} (limit ${opts.limit || 'none'} per corpus set)`);

    // 2. Svg2Vector, one JVM for every file.
    const s2v = runSvg2Vector(jobs);

    // 3. This library, in-process (warm-up call first so the first file does not pay module init).
    convert('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>', { optimize: true });
    const libStarted = performance.now();
    for (const job of jobs) {
        const svg = readFileSync(job.src, 'utf8');
        const t0 = performance.now();
        try {
            const { xml, warnings } = convert(svg, { optimize: true });
            job.lib = { ok: true, ms: performance.now() - t0, xml, warnings: [...new Set(warnings.map((w) => w.code))] };
            mkdirSync(dirname(job.libXml), { recursive: true });
            writeFileSync(job.libXml, xml);
        } catch (err) {
            job.lib = { ok: false, ms: performance.now() - t0, error: String(err?.message ?? err), warnings: [] };
        }
    }
    const libWall = performance.now() - libStarted;

    // 4. Render source + both outputs, compare each output to the source, in child processes (see
    //    RENDER_CHUNK). Svg2Vector output is read back from disk; the library's is passed as a path too.
    for (const job of jobs) {
        const r = s2v.results.get(job.src);
        job.s2v = r
            ? { ok: r.ok, ms: r.ms, messages: r.messages, exception: r.exception }
            : { ok: false, exception: 'no result from runner' };
        if (job.lib.ok) {
            job.lib.bytes = Buffer.byteLength(job.lib.xml);
            job.lib.compact = compactBytes(job.lib.xml);
            delete job.lib.xml;
        }
        if (job.s2v.ok) {
            const xml = readFileSync(job.s2vXml, 'utf8');
            job.s2v.bytes = Buffer.byteLength(xml);
            job.s2v.compact = compactBytes(xml);
            job.s2v.currentColor = CURRENT_COLOR.test(xml);
        }
    }
    const renderStarted = performance.now();
    for (let i = 0; i < jobs.length; i += RENDER_CHUNK) {
        const chunk = jobs.slice(i, i + RENDER_CHUNK);
        const input = join(outDir, 'render-chunk.in.json');
        const output = join(outDir, 'render-chunk.out.json');
        writeFileSync(
            input,
            JSON.stringify(chunk.map((j) => ({ src: j.src, lib: j.lib.ok ? j.libXml : null, s2v: j.s2v.ok ? j.s2vXml : null }))),
        );
        execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--render-worker', input, output], {
            stdio: 'inherit',
        });
        const rendered = JSON.parse(readFileSync(output, 'utf8'));
        chunk.forEach((job, k) => {
            const r = rendered[k];
            if (r.sourceError) job.sourceError = r.sourceError;
            if (r.lib) Object.assign(job.lib, r.lib);
            if (r.s2v) Object.assign(job.s2v, r.s2v);
        });
        process.stdout.write(`\r[render] ${Math.min(i + RENDER_CHUNK, jobs.length)} / ${jobs.length}`);
    }
    rmSync(join(outDir, 'render-chunk.in.json'), { force: true });
    rmSync(join(outDir, 'render-chunk.out.json'), { force: true });
    console.log(` in ${((performance.now() - renderStarted) / 1000).toFixed(1)} s`);

    // 5. Report.
    const threshold = DEFAULT_MAX_MISMATCH;
    /** Mismatch used for statistics: a failed conversion / unrenderable output counts as 100 %. */
    const score = (side) => (side?.ok && side.mismatch !== undefined ? side.mismatch : 1);
    const good = (side) => score(side) < threshold;
    const lines = [];
    const log = (s = '') => lines.push(s);
    const fmtMessages = (m) => (m ? m.replace(/\s*\n\s*/g, ' | ').slice(0, 160) : '');

    log(`# Svg2Vector vs svg-vectordrawable`);
    log();
    log(`Generated ${new Date().toISOString()} — threshold ${pct(threshold)} of inked pixels, render width 256 px (test/visual/compare.ts).`);
    log(`A failed conversion or an output the harness cannot render counts as 100 % in the statistics.`);
    log(`"s2v currentColor": Svg2Vector output containing the literal \`currentColor\` (invalid Android color); it is`);
    log(`measured after substituting #FF000000 (marked * per file), so the comparison is about geometry/paint, not validity.`);
    log();
    log('## Summary per set');
    log();
    log('| set | n | lib < 1 % | s2v < 1 % | lib fail | s2v fail | s2v msgs | s2v currentColor | harness err (lib/s2v) | median lib / s2v | p95 lib / s2v | lib ok, s2v bad | s2v ok, lib bad | bytes lib / s2v (compact) | time lib / s2v |');
    log('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
    const setsWithJobs = [...new Set(jobs.map((j) => j.set))];
    const summaryRow = (name, js) => {
        const valid = js.filter((j) => !j.sourceError);
        const both = valid.filter((j) => j.lib.ok && j.s2v.ok);
        const libBytes = sum(both.map((j) => j.lib.bytes));
        const s2vBytes = sum(both.map((j) => j.s2v.bytes));
        const libCompact = sum(both.map((j) => j.lib.compact));
        const s2vCompact = sum(both.map((j) => j.s2v.compact));
        const libMs = sum(valid.map((j) => j.lib.ms));
        const s2vMs = sum(valid.map((j) => j.s2v.ms ?? 0));
        log(
            `| ${name} | ${valid.length} | ${valid.filter((j) => good(j.lib)).length} | ${valid.filter((j) => good(j.s2v)).length}` +
                ` | ${valid.filter((j) => !j.lib.ok).length} | ${valid.filter((j) => !j.s2v.ok).length}` +
                ` | ${valid.filter((j) => j.s2v.messages).length} | ${valid.filter((j) => j.s2v.currentColor).length}` +
                ` | ${valid.filter((j) => j.lib.harnessError).length} / ${valid.filter((j) => j.s2v.harnessError).length}` +
                ` | ${pct(quantile(valid.map((j) => score(j.lib)), 0.5))} / ${pct(quantile(valid.map((j) => score(j.s2v)), 0.5))}` +
                ` | ${pct(quantile(valid.map((j) => score(j.lib)), 0.95))} / ${pct(quantile(valid.map((j) => score(j.s2v)), 0.95))}` +
                ` | ${valid.filter((j) => good(j.lib) && !good(j.s2v)).length} | ${valid.filter((j) => good(j.s2v) && !good(j.lib)).length}` +
                ` | ${(libBytes / 1024).toFixed(0)} / ${(s2vBytes / 1024).toFixed(0)} KiB (${(libCompact / 1024).toFixed(0)} / ${(s2vCompact / 1024).toFixed(0)})` +
                ` | ${libMs.toFixed(0)} / ${s2vMs.toFixed(0)} ms |`,
        );
    };
    for (const set of setsWithJobs) summaryRow(set, jobs.filter((j) => j.set === set));
    const corpusJobs = jobs.filter((j) => SETS[j.set].sample);
    if (corpusJobs.length) summaryRow('**corpus total**', corpusJobs);
    log();
    log(`Svg2Vector JVM wall time (incl. JVM start, class loading): ${(s2v.wall / 1000).toFixed(1)} s; library loop wall time: ${(libWall / 1000).toFixed(1)} s.`);
    const sourceErrors = jobs.filter((j) => j.sourceError);
    if (sourceErrors.length) log(`Source SVGs resvg cannot render (excluded): ${sourceErrors.map((j) => `${j.set}/${j.file}`).join(', ')}`);
    log();

    const cell = (side) => {
        if (!side.ok) return `FAIL ${(side.error ?? side.exception ?? 'empty output').slice(0, 80)}`;
        if (side.harnessError) return `harness: ${side.harnessError.slice(0, 80)}`;
        return `${pct(side.mismatch)}${side.sizeMismatch ? ` (size ${side.sizeMismatch})` : ''}${side.currentColor ? ' (currentColor*)' : ''}`;
    };
    for (const set of setsWithJobs.filter((s) => !SETS[s].sample)) {
        log(`## Per file: ${set}`);
        log();
        log('| file | lib | s2v | lib warnings | s2v messages | bytes lib / s2v |');
        log('|---|--:|--:|---|---|--:|');
        for (const j of jobs.filter((x) => x.set === set && !x.sourceError)) {
            log(
                `| ${j.file} | ${cell(j.lib)} | ${cell(j.s2v)} | ${j.lib.warnings.join(', ')} | ${fmtMessages(j.s2v.messages)} | ${j.lib.bytes ?? '-'} / ${j.s2v.bytes ?? '-'} |`,
            );
        }
        log();
    }

    const corpusValid = corpusJobs.filter((j) => !j.sourceError);
    const libBetter = corpusValid
        .filter((j) => good(j.lib) && !good(j.s2v))
        .sort((a, b) => score(b.s2v) - score(a.s2v));
    const s2vBetter = corpusValid
        .filter((j) => good(j.s2v) && !good(j.lib))
        .sort((a, b) => score(b.lib) - score(a.lib));
    const topTable = (title, rows) => {
        log(`## ${title} (${rows.length}, top ${opts.top})`);
        log();
        log('| set/file | lib | s2v | lib warnings | s2v messages |');
        log('|---|--:|--:|---|---|');
        for (const j of rows.slice(0, opts.top)) {
            log(`| ${j.set}/${j.file} | ${cell(j.lib)} | ${cell(j.s2v)} | ${j.lib.warnings.join(', ')} | ${fmtMessages(j.s2v.messages)} |`);
        }
        log();
    };
    if (corpusJobs.length) {
        topTable('Corpus: library good, Svg2Vector bad', libBetter);
        topTable('Corpus: Svg2Vector good, library bad', s2vBetter);
        const bothBad = corpusValid.filter((j) => !good(j.lib) && !good(j.s2v)).sort((a, b) => score(b.lib) - score(a.lib));
        topTable('Corpus: both bad', bothBad);

        // Distinct Svg2Vector messages / harness errors, so nothing is hidden behind a count.
        const tally = (values) => {
            const m = new Map();
            for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
            return [...m].sort((a, b) => b[1] - a[1]);
        };
        const msgTally = tally(
            corpusValid.flatMap((j) => (j.s2v.messages ? [...new Set(j.s2v.messages.split('\n').map((l) => l.trim().replace(/line \d+/g, 'line N')).filter(Boolean))] : [])),
        );
        const harnessTally = tally(corpusValid.flatMap((j) => [j.lib.harnessError, j.s2v.harnessError].filter(Boolean)));
        const warnTally = tally(corpusValid.flatMap((j) => j.lib.warnings));
        if (msgTally.length) {
            log('## Svg2Vector messages (corpus, per distinct line)');
            log();
            for (const [m, n] of msgTally.slice(0, 20)) log(`- ${n} × ${m}`);
            log();
        }
        if (warnTally.length) {
            log('## Library warning codes (corpus)');
            log();
            for (const [m, n] of warnTally) log(`- ${n} × ${m}`);
            log();
        }
        if (harnessTally.length) {
            log('## Harness errors (corpus)');
            log();
            for (const [m, n] of harnessTally) log(`- ${n} × ${m}`);
            log();
        }

        // Size: per-file ratio of compact sizes, where both converted.
        const ratios = corpusValid.filter((j) => j.lib.ok && j.s2v.ok).map((j) => j.lib.compact / j.s2v.compact);
        log(`Compact size ratio lib / s2v per file: median ${quantile(ratios, 0.5).toFixed(2)}, p5 ${quantile(ratios, 0.05).toFixed(2)}, p95 ${quantile(ratios, 0.95).toFixed(2)}.`);
        log();
    }

    const report = lines.join('\n');
    writeFileSync(join(outDir, 'report.md'), report + '\n');
    writeFileSync(
        join(outDir, 'results.json'),
        JSON.stringify(
            jobs,
            null,
            1,
        ),
    );
    console.log(report);
    console.log(`\n[out] ${join(outDir, 'report.md')}, results.json, lib/, svg2vector/`);

    // 6. Optional PNG triplets (source / lib / s2v) for the listed discrepancies.
    if (opts.png) {
        const pngDir = join(outDir, 'png');
        mkdirSync(pngDir, { recursive: true });
        const write = (path, svg) => {
            if (svg) writeFileSync(path, new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng());
        };
        const outputSvg = (side, xmlPath) => {
            if (!side.ok || side.harnessError) return null;
            return harnessSvg(vdToSvg, readFileSync(xmlPath, 'utf8'));
        };
        const listed = [
            ...libBetter.slice(0, opts.top),
            ...s2vBetter.slice(0, opts.top),
            ...jobs.filter((j) => !SETS[j.set].sample && !j.sourceError && (!good(j.lib) || !good(j.s2v))),
        ];
        for (const j of listed) {
            const stem = `${j.set}__${basename(j.file, '.svg')}`;
            write(join(pngDir, `${stem}.source.png`), readFileSync(j.src, 'utf8'));
            write(join(pngDir, `${stem}.lib.png`), outputSvg(j.lib, j.libXml));
            write(join(pngDir, `${stem}.s2v.png`), outputSvg(j.s2v, j.s2vXml));
        }
        console.log(`[out] PNG triplets in ${pngDir}`);
    }
}

const entry =
    process.argv[2] === '--render-worker' ? renderWorker(process.argv[3], process.argv[4]) : main();
entry.catch((err) => {
    console.error(err);
    process.exit(1);
});
