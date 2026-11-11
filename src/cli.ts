#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, join, sep } from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { colorRefs } from './colorRef.js';
import { convert } from './convert.js';
import { ConversionError } from './errors.js';
import { DENSITIES, renderFallbackPng, type Density } from './fallback.js';
import {
    assertDistinctOutputs,
    batchOutputPath,
    defaultOutputPath,
    fallbackPngPath,
    findOutputCollisions,
    listSvgFiles,
    writeOutput,
    type FileNamingOptions,
} from './file.js';
import {
    WARNING_CATEGORIES,
    WARNING_CODES,
    type ConvertOptions,
    type Severity,
    type Warning,
    type WarningCategory,
    type WarningCode,
} from './types.js';

const HELP = `svgvd — convert SVG to Android VectorDrawable

Usage:
  svgvd <input.svg|dir…> [options]
  svgvd - [options]          Read the SVG from stdin (also without input when
                             stdin is not a terminal); prints to stdout

Options:
  -s, --string <svg>   Convert an inline SVG string (prints to stdout)
  -o, --out <path>     Output file (single input, stdin, -s) or directory (batch)
  --stdout             Print result to stdout instead of writing a file
  -r, --recursive      Also convert the subdirectories of an input directory,
                       reproducing the tree under -o (flat with --android-names)
  --json               Print a JSON report on stdout (input, output, warnings,
                       minSdk, error per file); XML must go to files (-o)
  --dry-run            Convert and report, but write nothing
  -w, --watch          Convert, then keep watching the inputs: reconvert an
                       added or changed SVG, delete the output of a removed
                       one (Ctrl+C to stop). Not with stdin, -s, --stdout,
                       --json or --dry-run; with -r, needs Node.js 20+ on Linux
  --fallback-png <d>   When a file is rejected (--strict, --rule <code>=error),
                       render it to PNG instead of failing: <name>.png in
                       drawable-<density>/ inside the XML's directory (beside it
                       when that directory is named drawable). <d>: all, or a
                       comma list of mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi. Needs the
                       optional dependency @resvg/resvg-js
  --no-optimize        Skip svgo normalization (not recommended)
  --strict             Fail on the first lossy or approximated construct
  --strict=lossy       Fail only when content is lost (approximations stay warnings)
  --rule <code=level>  Per-warning severity: off | warn | error (repeatable),
                       e.g. --strict --rule opacity-approximated=warn
  --min-sdk <n>        Warn when the output needs a higher Android API level
                       (gradients and fillType need API 24)
  --xml-tag            Prepend an XML declaration
  --tint <color>       Add android:tint to the <vector>
  --current-color <c>  What currentColor stands for: a CSS color or an Android
                       reference (?attr/colorPrimary, @color/icon…), emitted as is
  --color-map <c=ref>  Map an SVG color to an Android reference (repeatable),
                       e.g. --color-map '#1A73E8=@color/brand'
  --auto-mirrored      Add android:autoMirrored="true" (flipped in RTL layouts)
  --width <dp>         Set android:width, keeping the viewport; alone, the
                       height follows the aspect ratio
  --height <dp>        Set android:height (same rules as --width)
  --android-names      Name outputs as valid Android resources (Arrow-Left.svg →
                       arrow_left.xml); fails if two inputs map to the same name.
                       An explicit -o file.xml is used as is
  -p, --precision <n>  Decimal places for numbers (default 3)
  -h, --help           Show this help
`;

const SEVERITIES = new Set(['off', 'warn', 'error']);

/** Input and output streams, injectable so the CLI can be exercised in-process. */
export interface CliIo {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    /** Standard input; absent when there is none to read (`-` is then rejected). */
    stdin?: {
        /** Reads stdin to the end, as UTF-8. */
        read: () => string;
        /** True when stdin is a terminal: it is then only read for an explicit `-`. */
        readonly isTTY: boolean;
    };
}

const processIo: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdin: {
        read: () => readFileSync(0, 'utf8'),
        get isTTY() {
            return isatty(0);
        },
    },
};

/** One entry of the `--json` report. */
export interface ReportEntry {
    /** The SVG file, `-` for stdin, `null` for `-s`. */
    input: string | null;
    /** The file written (or that `--dry-run` would write); `null` for stdout or on error. */
    output: string | null;
    warnings: (Warning & { category: WarningCategory })[];
    /** `ConvertResult.minSdk`; `null` on error. */
    minSdk: number | null;
    /** Why nothing was produced; `code` / `category` when a warning was escalated to an error. */
    error: { message: string; code?: WarningCode; category?: WarningCategory } | null;
    /**
     * The PNGs written instead of the XML (`--fallback-png`), with the warning that made the
     * conversion fail; `null` when the file was not rendered to bitmaps.
     */
    fallback: { outputs: string[]; reason: Warning & { category: WarningCategory } } | null;
}

/** One conversion: a file, stdin or the `-s` string. */
interface Job {
    /** As in {@link ReportEntry.input}. */
    input: string | null;
    read: () => string;
    /** Target file; `undefined` prints the XML to stdout. */
    output?: string;
}

/** A job reading a file into a file; `root` is the input directory it was found in, if any. */
type FileJob = Job & { input: string; output: string; root?: string };

/** Thrown during argument parsing to stop early with an exit code. */
class CliExit {
    constructor(readonly code: number) {}
}

function parseArgs(
    argv: string[],
    io: CliIo,
): {
    inputs: string[];
    inline?: string;
    out?: string;
    stdout: boolean;
    recursive: boolean;
    json: boolean;
    dryRun: boolean;
    watch: boolean;
    fallback?: Density[];
    opts: ConvertOptions;
    naming: FileNamingOptions;
} {
    const inputs: string[] = [];
    const opts: ConvertOptions = {};
    const naming: FileNamingOptions = {};
    let out: string | undefined;
    let inline: string | undefined;
    let stdout = false;
    let recursive = false;
    let json = false;
    let dryRun = false;
    let watch = false;
    let fallback: Density[] | undefined;
    const fail = (message: string): never => {
        io.stderr(`${message}\n`);
        throw new CliExit(1);
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        /** The value following the current option. */
        const value = (): string => argv[++i] ?? fail(`Missing value for ${arg}`);
        if (arg === '-h' || arg === '--help') {
            io.stdout(HELP);
            throw new CliExit(0);
        } else if (arg === '-s' || arg === '--string') inline = value();
        else if (arg === '-o' || arg === '--out') out = value();
        else if (arg === '--stdout') stdout = true;
        else if (arg === '-r' || arg === '--recursive') recursive = true;
        else if (arg === '--json') json = true;
        else if (arg === '--dry-run') dryRun = true;
        else if (arg === '-w' || arg === '--watch') watch = true;
        else if (arg === '--fallback-png') {
            const list = value();
            const names = list === 'all' ? Object.keys(DENSITIES) : list.split(',').map((d) => d.trim());
            if (!names.every((d) => Object.hasOwn(DENSITIES, d)))
                fail(
                    `Invalid --fallback-png (expected all, or a comma list of ${Object.keys(DENSITIES).join(',')}): ${list}`,
                );
            fallback = [...new Set(names)] as Density[];
        } else if (arg === '--no-optimize') opts.optimize = false;
        else if (arg === '--strict') opts.strict = true;
        else if (arg === '--strict=lossy') opts.strict = 'lossy';
        else if (arg === '--min-sdk') {
            const minSdk = value();
            if (!/^[1-9]\d*$/.test(minSdk)) fail(`Invalid --min-sdk (expected a positive integer): ${minSdk}`);
            opts.minSdk = Number(minSdk);
        } else if (arg === '--rule') {
            const rule = value();
            const [code, level] = rule.split('=');
            if (!(WARNING_CODES as readonly string[]).includes(code ?? '') || !SEVERITIES.has(level ?? ''))
                fail(
                    `Invalid --rule (expected <code>=off|warn|error): ${rule}\nKnown codes: ${WARNING_CODES.join(', ')}`,
                );
            opts.rules = { ...opts.rules, [code as WarningCode]: level as Severity };
        } else if (arg === '--xml-tag') opts.xmlTag = true;
        else if (arg === '--android-names') naming.androidNames = true;
        else if (arg === '--tint') opts.tint = value();
        else if (arg === '--current-color') opts.currentColor = value();
        else if (arg === '--color-map') {
            const entry = value();
            const eq = entry.indexOf('=');
            if (eq <= 0) fail(`Invalid --color-map (expected <color>=<reference>): ${entry}`);
            opts.colorMap = { ...opts.colorMap, [entry.slice(0, eq).trim()]: entry.slice(eq + 1) };
        } else if (arg === '--auto-mirrored') opts.autoMirrored = true;
        else if (arg === '--width' || arg === '--height') {
            const dp = value();
            if (!/^(\d+\.?\d*|\.\d+)$/.test(dp) || !(Number(dp) > 0))
                fail(`Invalid ${arg} (expected a positive number of dp): ${dp}`);
            opts[arg === '--width' ? 'width' : 'height'] = Number(dp);
        } else if (arg === '-p' || arg === '--precision') {
            const precision = value();
            if (!/^\d+$/.test(precision)) fail(`Invalid --precision (expected a non-negative integer): ${precision}`);
            opts.floatPrecision = Number(precision);
        } else if (arg.startsWith('-') && arg !== '-') fail(`Unknown option: ${arg}`);
        else inputs.push(arg);
    }
    if (inputs.includes('-') && inputs.length > 1) fail('- (stdin) cannot be combined with other inputs');
    // Reported once here rather than as a conversion failure of every input.
    try {
        colorRefs(opts.currentColor ?? '#000000', opts.colorMap);
    } catch (err) {
        fail((err as Error).message);
    }
    return { inputs, inline, out, stdout, recursive, json, dryRun, watch, fallback, opts, naming };
}

/** The error of a failed job, for the report. */
function reportError(err: unknown): NonNullable<ReportEntry['error']> {
    const message = (err as Error).message;
    if (!(err instanceof ConversionError)) return { message };
    return { message, code: err.warning.code, category: WARNING_CATEGORIES[err.warning.code] };
}

/** How the jobs of a run are carried out. */
interface RunSettings {
    opts: ConvertOptions;
    dryRun: boolean;
    /** Densities of the PNG fallback (`--fallback-png`), undefined without it. */
    fallback?: readonly Density[];
}

/** A warning with its category, as reported. */
const categorized = (w: Warning): Warning & { category: WarningCategory } => ({
    ...w,
    category: WARNING_CATEGORIES[w.code],
});

/**
 * Renders the SVG of a job its conversion rejected to one PNG per fallback density next to its
 * `output` and writes them (unless `dryRun`). Never throws: a rendering failure (resvg missing,
 * invalid SVG) is returned in the entry's `error`, with the rejection's code.
 */
function runFallback(
    job: Job & { output: string },
    svg: string,
    rejection: ConversionError,
    { opts, dryRun, fallback = [] }: RunSettings,
    file: string | undefined,
    io: CliIo,
): ReportEntry {
    try {
        const pngs = fallback.map((density) => ({
            path: fallbackPngPath(job.output, density),
            png: renderFallbackPng(svg, { density, width: opts.width, height: opts.height }),
        }));
        if (!dryRun) for (const { path, png } of pngs) writeOutput(path, png);
        // One line for all densities: out/drawable-{mdpi,hdpi}/icon.png.
        const target = fallbackPngPath(job.output, fallback.length > 1 ? `{${fallback.join(',')}}` : fallback[0]!);
        const source = file === undefined ? '' : `${file} `;
        io.stderr(`✓ ${source}→ ${target}${dryRun ? ' (dry run)' : ''} (PNG fallback: ${rejection.message})\n`);
        return {
            input: job.input,
            output: null,
            warnings: [],
            minSdk: null,
            error: null,
            fallback: { outputs: pngs.map((p) => p.path), reason: categorized(rejection.warning) },
        };
    } catch (err) {
        const message = `${rejection.message} PNG fallback failed: ${(err as Error).message}`;
        io.stderr(`✗ ${file === undefined ? '' : `${file}: `}${message}\n`);
        return { ...failedEntry(job.input, message), error: { ...reportError(rejection), message } };
    }
}

/**
 * Converts one job, writes or prints its XML (unless `dryRun`) and logs to stderr; a job rejected by
 * the conversion goes to {@link runFallback} with `fallback` and a file target. Never throws: a
 * failure is returned in the entry's `error`.
 */
function runJob(job: Job, settings: RunSettings, io: CliIo): ReportEntry {
    const { opts, dryRun } = settings;
    const file = job.input !== null && job.input !== '-' ? job.input : undefined;
    const label = file === undefined ? '' : `${basename(file)}: `;
    let svg: string | undefined;
    try {
        svg = job.read();
        const { xml, warnings, minSdk } = convert(svg, opts);
        for (const w of warnings) io.stderr(`  ⚠ ${label}[${w.code}] ${w.message}\n`);
        if (job.output === undefined) {
            if (!dryRun) io.stdout(xml);
        } else {
            if (!dryRun) writeOutput(job.output, xml);
            if (file !== undefined) io.stderr(`✓ ${file} → ${job.output}${dryRun ? ' (dry run)' : ''}\n`);
        }
        return {
            input: job.input,
            output: job.output ?? null,
            warnings: warnings.map(categorized),
            minSdk,
            error: null,
            fallback: null,
        };
    } catch (err) {
        const { output } = job;
        if (err instanceof ConversionError && settings.fallback && output !== undefined && svg !== undefined)
            return runFallback({ ...job, output }, svg, err, settings, file, io);
        io.stderr(`✗ ${file === undefined ? '' : `${file}: `}${(err as Error).message}\n`);
        return {
            input: job.input,
            output: null,
            warnings: [],
            minSdk: null,
            error: reportError(err),
            fallback: null,
        };
    }
}

/** A failed entry that produced nothing. */
function failedEntry(input: string | null, message: string): ReportEntry {
    return { input, output: null, warnings: [], minSdk: null, error: { message }, fallback: null };
}

/** The `--json` report. */
function report(entries: readonly ReportEntry[]): string {
    return `${JSON.stringify(entries, null, 2)}\n`;
}

/** Report entries when output names collide: nothing is converted, every file is reported failed. */
function collisionEntries(jobs: readonly FileJob[], naming: FileNamingOptions): ReportEntry[] {
    const colliding = new Map(
        findOutputCollisions(jobs, naming).flatMap((c) => c.inputs.map((input) => [input, c] as const)),
    );
    return jobs.map(({ input }) => {
        const c = colliding.get(input);
        return failedEntry(
            input,
            c
                ? `Android resource name collision (nothing written): ${c.name} ← ${c.inputs.join(', ')}`
                : 'Not converted: Android resource name collision in this batch (nothing written)',
        );
    });
}

/** The job of the stdin or `-s` source, or an exit code when there is nothing to convert. */
function sourceJob(inline: string | undefined, explicit: boolean, output: string | undefined, io: CliIo): Job | number {
    if (inline !== undefined) return { input: null, read: () => inline, output };
    if (io.stdin === undefined) {
        io.stderr('Reading from stdin is not available here; pass a file or use -s <svg>\n');
        return 1;
    }
    let text: string | Error;
    try {
        text = io.stdin.read();
    } catch (err) {
        text = err as Error;
    }
    // `svgvd < /dev/null` and the like: nothing piped, so behave as without input.
    if (!explicit && typeof text === 'string' && text.trim() === '') {
        io.stderr(HELP);
        return 1;
    }
    const read = (): string => {
        if (text instanceof Error) throw text;
        return text;
    };
    return { input: '-', read, output };
}

/**
 * The file jobs of the input arguments (a file, or the `*.svg` of a directory), plus a failed entry
 * for each argument that cannot be listed.
 */
function fileJobs(
    inputs: readonly string[],
    out: string | undefined,
    recursive: boolean,
    naming: FileNamingOptions,
    io: CliIo,
): { jobs: FileJob[]; unreadable: ReportEntry[] } {
    const unreadable: ReportEntry[] = [];
    const found = inputs.flatMap((input): { file: string; root?: string }[] => {
        try {
            if (!statSync(input).isDirectory()) return [{ file: input }];
            return listSvgFiles(input, recursive).map((file) => ({ file, root: input }));
        } catch (err) {
            const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
            const message = missing ? 'no such file or directory' : (err as Error).message;
            io.stderr(`✗ ${input}: ${message}\n`);
            unreadable.push(failedEntry(input, message));
            return [];
        }
    });
    const explicitTarget = out && found.length === 1 && extname(out) === '.xml' ? out : undefined;
    const jobs = found.map(({ file, root }) => fileJob(file, root, out, explicitTarget, naming));
    return { jobs, unreadable };
}

/** The job converting `file`, found in the input directory `root` (if any); see {@link fileJobs}. */
function fileJob(
    file: string,
    root: string | undefined,
    out: string | undefined,
    explicitTarget: string | undefined,
    naming: FileNamingOptions,
): FileJob {
    return {
        input: file,
        root,
        read: () => readFileSync(file, 'utf8'),
        output:
            explicitTarget ??
            (root === undefined ? defaultOutputPath(file, out, naming) : batchOutputPath(file, root, out, naming)),
    };
}

/** How long a path stays quiet before it is handled: editors save in several events. */
const WATCH_DEBOUNCE_MS = 100;

/** What `--watch` needs to turn a path back into a job. */
interface WatchContext {
    inputs: readonly string[];
    out?: string;
    recursive: boolean;
    naming: FileNamingOptions;
    settings: RunSettings;
}

/** A started `--watch`: `track` registers the jobs of the initial conversion, `done` settles on SIGINT / SIGTERM. */
interface WatchSession {
    track: (jobs: readonly FileJob[]) => void;
    done: () => Promise<number>;
}

/** Why a watcher could not start, made readable (`-r` on Node.js < 20 on Linux in particular). */
function watchFailure(err: unknown, input: string, recursive: boolean): string {
    const code = (err as NodeJS.ErrnoException).code;
    if (recursive && code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM')
        return `--watch with -r needs Node.js 20 or later on this platform (recursive fs.watch), got ${process.version}`;
    return `Cannot watch ${input}: ${code === 'ENOENT' ? 'no such file or directory' : (err as Error).message}`;
}

/**
 * Starts watching the inputs: a directory (recursively with `-r`) for its `*.svg`, a file through its
 * parent directory (editors often replace a file rather than write it in place). An added or changed
 * SVG is converted again, the output of a removed one is deleted, and a failure is reported without
 * stopping. With `--android-names`, a file whose output name is taken by another one is not written
 * while the collision lasts. Returns the exit code when a watcher cannot be started.
 */
function startWatch(ctx: WatchContext, io: CliIo): WatchSession | number {
    const { inputs, out, recursive, naming, settings } = ctx;
    // Checked by watchUsageError: -o file.xml only goes with a single file input.
    const explicitTarget = out !== undefined && extname(out) === '.xml' ? out : undefined;
    /** Input file → its job, for the outputs to delete and the name collisions. */
    const known = new Map<string, FileJob>();
    const timers = new Map<string, NodeJS.Timeout>();
    const watchers: FSWatcher[] = [];
    let stopped = false;

    const convertOne = (file: string, root: string | undefined): void => {
        const job = fileJob(file, root, out, explicitTarget, naming);
        known.set(file, job);
        const collision = findOutputCollisions([...known.values()], naming).find((c) => c.inputs.includes(file));
        if (collision) {
            io.stderr(
                `✗ ${file}: Android resource name collision (not written): ${collision.name} ← ${collision.inputs.join(', ')}\n`,
            );
            return;
        }
        runJob(job, settings, io);
    };

    const forget = (job: FileJob): void => {
        known.delete(job.input);
        const sharing = [...known.values()].filter((other) => other.output === job.output);
        // The collision is over: the remaining file owns the output again.
        if (sharing.length === 1) return convertOne(sharing[0]!.input, sharing[0]!.root);
        if (sharing.length > 1) return;
        const pngs = (settings.fallback ?? []).map((density) => fallbackPngPath(job.output, density));
        for (const path of [job.output, ...pngs]) {
            if (lstatOrUndefined(path) === undefined) continue;
            rmSync(path, { force: true });
            io.stderr(`✓ ${job.input} removed → ${path} deleted\n`);
        }
    };

    /** Brings the outputs of `path` (a file, a directory, or something removed) up to date. */
    const handle = (path: string, root: string | undefined): void => {
        const link = lstatOrUndefined(path);
        if (link === undefined) {
            for (const job of known.values()) if (isUnder(job.input, path)) forget(job);
        } else if (link.isDirectory()) {
            // A directory input to rescan, or a subdirectory added or moved in under -r.
            if (root === undefined || (path !== root && !recursive)) return;
            for (const job of known.values())
                if (isUnder(job.input, path) && lstatOrUndefined(job.input) === undefined) forget(job);
            for (const file of listSvgFiles(path, path === root ? recursive : true)) convertOne(file, root);
        } else if (statOrUndefined(path)?.isFile() && (root === undefined || extname(path).toLowerCase() === '.svg')) {
            convertOne(path, root);
        }
    };

    const schedule = (path: string, root: string | undefined): void => {
        if (stopped) return;
        clearTimeout(timers.get(path));
        timers.set(
            path,
            setTimeout(() => {
                timers.delete(path);
                handle(path, root);
            }, WATCH_DEBOUNCE_MS),
        );
    };

    const close = (): void => {
        stopped = true;
        for (const watcher of watchers) watcher.close();
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
    };

    for (const input of inputs) {
        try {
            const watcher =
                statOrUndefined(input)?.isDirectory() === true
                    ? watch(input, { recursive }, (_event, name) =>
                          schedule(name === null ? input : join(input, name.toString()), input),
                      )
                    : watch(dirname(input), (_event, name) => {
                          if (name === null || name.toString() === basename(input)) schedule(input, undefined);
                      });
            watcher.on('error', (err) => io.stderr(`✗ ${input}: ${err.message}\n`));
            watchers.push(watcher);
        } catch (err) {
            close();
            io.stderr(`${watchFailure(err, input, recursive)}\n`);
            return 1;
        }
    }

    return {
        track: (jobs) => {
            for (const job of jobs) known.set(job.input, job);
        },
        done: () =>
            new Promise((resolve) => {
                const stop = (): void => {
                    process.off('SIGINT', stop);
                    process.off('SIGTERM', stop);
                    close();
                    io.stderr('Stopped watching\n');
                    resolve(0);
                };
                process.on('SIGINT', stop);
                process.on('SIGTERM', stop);
                io.stderr(`Watching ${inputs.join(', ')} for changes (Ctrl+C to stop)\n`);
            }),
    };
}

/** True when `path` is `dir` or inside it. */
function isUnder(path: string, dir: string): boolean {
    return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
    try {
        return lstatSync(path);
    } catch {
        return undefined;
    }
}

function statOrUndefined(path: string): ReturnType<typeof statSync> | undefined {
    try {
        return statSync(path);
    } catch {
        return undefined;
    }
}

/**
 * Runs the CLI against `argv` (without the node/script prefix) and returns the exit code; with
 * `--watch`, a promise of it, settled when SIGINT / SIGTERM stops the watch.
 */
export function run(argv: string[], io: CliIo = processIo): number | Promise<number> {
    let args: ReturnType<typeof parseArgs>;
    try {
        args = parseArgs(argv, io);
    } catch (err) {
        if (err instanceof CliExit) return err.code;
        throw err;
    }
    const { inputs, inline, out, stdout, recursive, json, dryRun, watch: watching, fallback, opts, naming } = args;

    const explicitStdin = inline === undefined && inputs[0] === '-';
    const implicitStdin = inline === undefined && inputs.length === 0 && io.stdin !== undefined && !io.stdin.isTTY;
    const single = inline !== undefined || explicitStdin || implicitStdin;
    if (!single && inputs.length === 0) {
        io.stderr(HELP);
        return 1;
    }
    // An -o that is not a .xml file is ignored for a single source, which then prints to stdout.
    const singleTarget = out !== undefined && extname(out) === '.xml' ? out : undefined;
    if (json && !dryRun && (single ? singleTarget === undefined : stdout)) {
        io.stderr('--json prints the report on stdout: write the XML with -o <file.xml>, or add --dry-run\n');
        return 1;
    }
    if (watching) {
        const usage = watchUsageError({ single, stdout, json, dryRun, inputs, out });
        if (usage !== undefined) {
            io.stderr(`${usage}\n`);
            return 1;
        }
    }
    if (fallback && (single ? singleTarget === undefined : stdout)) {
        io.stderr(
            '--fallback-png writes PNG files next to the XML: write it to files (-o <file.xml> for a single source)\n',
        );
        return 1;
    }

    const entries: ReportEntry[] = [];
    let jobs: Job[];
    if (single) {
        const job = sourceJob(inline, explicitStdin, singleTarget, io);
        if (typeof job === 'number') return job;
        jobs = [job];
    } else {
        // Watchers first, so that nothing saved during the initial conversion is missed.
        const session = watching
            ? startWatch({ inputs, out, recursive, naming, settings: { opts, dryRun, fallback } }, io)
            : undefined;
        if (typeof session === 'number') return session;
        const listed = fileJobs(inputs, out, recursive, naming, io);
        entries.push(...listed.unreadable);
        jobs = stdout ? listed.jobs.map((job) => ({ ...job, output: undefined })) : listed.jobs;
        try {
            if (!stdout) assertDistinctOutputs(listed.jobs, naming);
        } catch (err) {
            io.stderr(`✗ ${(err as Error).message}\n`);
            if (session === undefined) {
                if (json) io.stdout(report([...entries, ...collisionEntries(listed.jobs, naming)]));
                return 1;
            }
            // Watching goes on, writing nothing yet: a file is converted once its collision is resolved.
            jobs = [];
        }
        if (session !== undefined) {
            session.track(listed.jobs);
            for (const job of jobs) runJob(job, { opts, dryRun, fallback }, io);
            return session.done();
        }
    }
    for (const job of jobs) entries.push(runJob(job, { opts, dryRun, fallback }, io));
    if (json) io.stdout(report(entries));
    return entries.some((entry) => entry.error !== null) ? 1 : 0;
}

/** Why `--watch` cannot go with the other arguments, if it cannot. */
function watchUsageError(args: {
    single: boolean;
    stdout: boolean;
    json: boolean;
    dryRun: boolean;
    inputs: readonly string[];
    out?: string;
}): string | undefined {
    const { single, stdout, json, dryRun, inputs, out } = args;
    if (single) return '--watch needs files or directories to watch: it cannot read stdin or -s';
    const conflict = stdout ? '--stdout' : json ? '--json' : dryRun ? '--dry-run' : undefined;
    if (conflict) return `--watch cannot be combined with ${conflict}: it writes the outputs to files`;
    if (out !== undefined && extname(out) === '.xml') {
        const input = inputs.length === 1 ? statOrUndefined(inputs[0]!) : undefined;
        if (input === undefined || input.isDirectory())
            return '--watch with -o <file.xml> needs a single existing input file; use -o <dir> otherwise';
    }
    return undefined;
}

/** True when this module is the process entry point (also through an npm bin symlink). */
function isMain(): boolean {
    try {
        return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
}

if (isMain()) {
    const code = run(process.argv.slice(2));
    if (typeof code === 'number') process.exitCode = code;
    else void code.then((settled) => (process.exitCode = settled));
}
