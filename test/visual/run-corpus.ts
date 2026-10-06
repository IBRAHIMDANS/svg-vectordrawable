/**
 * Runs the visual comparison over directories of SVGs and prints the worst offenders.
 *
 *   npx vite-node test/visual/run-corpus.ts -- <dir> [<dir> …] [--no-optimize] [--top 15] [--out <png-dir>]
 *        [--batch 600]
 *   (or `npx tsx test/visual/run-corpus.ts <dir> …`)
 *
 * Offenders are listed separately depending on whether the converter warned: a mismatch with a
 * warning is a documented loss, a mismatch *without* one is a silent wrong render (the real bugs).
 * With `--out`, the source and converted renders of the listed offenders are written as PNGs.
 *
 * resvg-js never releases the native pixel buffers of a render (≈ 0.5 MB each, even after a GC), so
 * a single process over a large corpus grows past 15 GB. Files are therefore converted and compared
 * in child processes of `--batch` files each (0 = everything in this process); the child is this
 * same script relaunched with the same runner (vite-node or tsx) in a hidden `--worker` mode.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { convert } from '../../src/index.js';
import { vdToSvg } from './vdToSvg.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH, RENDER_WIDTH } from './compare.js';

interface Row {
    file: string;
    mismatch: number;
    maxDelta: number;
    inked: number;
    warnings: string[];
    error?: string;
}

/** Batch description handed to a worker, and what it hands back (both as JSON files). */
interface WorkerInput {
    dir: string;
    optimize: boolean;
    files: string[];
}
interface WorkerOutput {
    rows: Row[];
    peakRss: number;
}

const WORKER_FLAG = '--worker';
const DEFAULT_BATCH = 600;

interface Options {
    dirs: string[];
    optimize: boolean;
    top: number;
    out?: string;
    batch: number;
}

function parseArgs(args: string[]): Options {
    const dirs: string[] = [];
    let optimize = true;
    let top = 15;
    let out: string | undefined;
    let batch = DEFAULT_BATCH;
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === '--no-optimize') optimize = false;
        else if (a === '--top') top = Number(args[++i]);
        else if (a === '--out') out = args[++i];
        else if (a === '--batch') batch = Number(args[++i]);
        else dirs.push(a);
    }
    if (dirs.length === 0 || !Number.isInteger(batch) || batch < 0) {
        console.error(
            'usage: run-corpus.ts <dir> [<dir> …] [--no-optimize] [--top N] [--out <png-dir>] [--batch N (0 = in-process)]',
        );
        process.exit(2);
    }
    return { dirs, optimize, top, out, batch };
}

function evaluate(dir: string, file: string, optimize: boolean): Row {
    const svg = readFileSync(join(dir, file), 'utf8');
    try {
        const { xml, warnings } = convert(svg, { optimize });
        const result = compareSvgs(svg, vdToSvg(xml));
        return {
            file,
            mismatch: result.mismatch,
            maxDelta: result.maxDelta,
            inked: result.inked,
            warnings: [...new Set(warnings.map((w) => w.code))],
            ...(result.sizeMismatch ? { error: `size ${result.sizeMismatch}` } : {}),
        };
    } catch (err) {
        return { file, mismatch: 1, maxDelta: 255, inked: 0, warnings: [], error: (err as Error).message };
    }
}

/** Child-process entry: evaluates one batch and writes the rows (plus its peak RSS) to `outputPath`. */
function runWorker(inputPath: string, outputPath: string): void {
    const { dir, optimize, files } = JSON.parse(readFileSync(inputPath, 'utf8')) as WorkerInput;
    let peakRss = process.memoryUsage().rss;
    const rows = files.map((file) => {
        const row = evaluate(dir, file, optimize);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        return row;
    });
    writeFileSync(outputPath, JSON.stringify({ rows, peakRss } satisfies WorkerOutput));
}

/**
 * Command relaunching this script in worker mode with the runner that started the parent.
 * tsx keeps the script in argv[1] and its loader in execArgv; vite-node replaces argv with
 * [node, vite-node, ...args after `--`], so the script must be passed again after the runner.
 */
function workerCommand(workerArgs: string[]): { command: string; args: string[] } {
    const script = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? resolve(process.argv[1]) : script;
    const launcher = entry === script ? [script] : [entry, script, '--'];
    return { command: process.execPath, args: [...process.execArgv, ...launcher, WORKER_FLAG, ...workerArgs] };
}

/** Evaluates `files` in child processes of `batch` files each; throws if a worker fails. */
function evaluateInWorkers(dir: string, files: string[], optimize: boolean, batch: number): WorkerOutput {
    const tmp = mkdtempSync(join(tmpdir(), 'run-corpus-'));
    const rows: Row[] = [];
    let peakRss = 0;
    try {
        for (let start = 0; start < files.length; start += batch) {
            const chunk = files.slice(start, start + batch);
            const range = `batch ${start}–${start + chunk.length - 1} of ${dir} (${chunk[0]} … ${chunk.at(-1)})`;
            const input = join(tmp, `in-${start}.json`);
            const output = join(tmp, `out-${start}.json`);
            writeFileSync(input, JSON.stringify({ dir, optimize, files: chunk } satisfies WorkerInput));
            const { command, args } = workerCommand([input, output]);
            // stdout is ignored (runners may print to it); stderr stays visible for diagnostics.
            const child = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
            if (child.error) throw new Error(`worker for ${range} could not start: ${child.error.message}`);
            if (child.status !== 0) {
                const how = child.signal ? `signal ${child.signal}` : `exit code ${child.status}`;
                throw new Error(`worker for ${range} died (${how})`);
            }
            let result: WorkerOutput;
            try {
                result = JSON.parse(readFileSync(output, 'utf8')) as WorkerOutput;
            } catch (err) {
                throw new Error(`worker for ${range} left no readable result: ${(err as Error).message}`, {
                    cause: err,
                });
            }
            if (result.rows.length !== chunk.length) {
                throw new Error(`worker for ${range} returned ${result.rows.length} rows, expected ${chunk.length}`);
            }
            rows.push(...result.rows);
            peakRss = Math.max(peakRss, result.peakRss);
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
    return { rows, peakRss };
}

function writePng(path: string, svg: string): void {
    writeFileSync(path, new Resvg(svg, { fitTo: { mode: 'width', value: RENDER_WIDTH } }).render().asPng());
}

function report(dir: string, { optimize, top, out, batch }: Options): void {
    const files = readdirSync(dir)
        .filter((f) => f.endsWith('.svg'))
        .sort();
    const started = Date.now();
    const { rows, peakRss } =
        batch === 0
            ? {
                  rows: files.map((file) => evaluate(dir, file, optimize)),
                  peakRss: process.resourceUsage().maxRSS * 1024,
              }
            : evaluateInWorkers(dir, files, optimize, batch);

    const failing = rows.filter((r) => r.mismatch >= DEFAULT_MAX_MISMATCH);
    const silent = failing.filter((r) => r.warnings.length === 0).sort((a, b) => b.mismatch - a.mismatch);
    const warned = failing.filter((r) => r.warnings.length > 0).sort((a, b) => b.mismatch - a.mismatch);
    const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
    const line = (r: Row): string =>
        `  ${pct(r.mismatch).padStart(8)}  maxΔ ${String(r.maxDelta).padStart(3)}  ${r.file}` +
        (r.warnings.length ? `  [${r.warnings.join(', ')}]` : '') +
        (r.error ? `  ERROR: ${r.error}` : '');

    console.log(`${dir} (optimize: ${optimize}) — ${rows.length} SVGs in ${Date.now() - started} ms`);
    console.log(`  over ${pct(DEFAULT_MAX_MISMATCH)} mismatch: ${failing.length} (${silent.length} without warning)`);
    console.log(
        `  errors: ${rows.filter((r) => r.error).length}, empty renders: ${rows.filter((r) => !r.inked).length}`,
    );
    const worst = [...rows].sort((a, b) => b.mismatch - a.mismatch);
    console.log(`\nWorst overall (any threshold):`);
    worst.slice(0, 5).forEach((r) => console.log(line(r)));
    console.log(`\nWorst silent offenders (no warning):`);
    silent.slice(0, top).forEach((r) => console.log(line(r)));
    console.log(`\nWorst warned offenders:`);
    warned.slice(0, top).forEach((r) => console.log(line(r)));

    if (out) {
        mkdirSync(out, { recursive: true });
        for (const r of [...silent.slice(0, top), ...warned.slice(0, top)]) {
            if (r.error) continue;
            const svg = readFileSync(join(dir, r.file), 'utf8');
            const stem = basename(r.file, '.svg');
            writePng(join(out, `${stem}.source.png`), svg);
            writePng(join(out, `${stem}.vd.png`), vdToSvg(convert(svg, { optimize }).xml));
        }
        console.log(`\nPNG pairs written to ${out}`);
    }
    // Memory diagnostics go to stderr so the report on stdout stays unchanged.
    const mb = (n: number): string => `${Math.round(n / 2 ** 20)} MB`;
    console.error(
        `[run-corpus] ${dir}: ${batch === 0 ? 'in-process' : `batches of ${batch}`}, ` +
            `peak RSS evaluator ${mb(peakRss)}, parent ${mb(process.resourceUsage().maxRSS * 1024)}`,
    );
}

function main(): void {
    const args = process.argv.slice(2).filter((a) => a !== '--');
    if (args[0] === WORKER_FLAG) {
        runWorker(args[1]!, args[2]!);
        return;
    }
    const options = parseArgs(args);
    options.dirs.forEach((dir, i) => {
        if (i > 0) console.log('\n' + '='.repeat(80) + '\n');
        report(dir, options);
    });
}

try {
    main();
} catch (err) {
    console.error(`[run-corpus] ${(err as Error).message}`);
    process.exit(1);
}
