#!/usr/bin/env node
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colorRefs } from './colorRef.js';
import { convert } from './convert.js';
import { assertDistinctOutputs, defaultOutputPath, listSvgFiles, writeOutput, type FileNamingOptions } from './file.js';
import { WARNING_CODES, type ConvertOptions, type Severity, type WarningCode } from './types.js';

const HELP = `svgvd — convert SVG to Android VectorDrawable

Usage:
  svgvd <input.svg|dir> [options]

Options:
  -s, --string <svg>   Convert an inline SVG string (prints to stdout)
  -o, --out <path>     Output file (single input) or directory (batch)
  --stdout             Print result to stdout instead of writing a file
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

/** Output sinks, injectable so the CLI can be exercised in-process. */
export interface CliIo {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}

const processIo: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
};

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
    opts: ConvertOptions;
    naming: FileNamingOptions;
} {
    const inputs: string[] = [];
    const opts: ConvertOptions = {};
    const naming: FileNamingOptions = {};
    let out: string | undefined;
    let inline: string | undefined;
    let stdout = false;
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
        else if (arg === '--no-optimize') opts.optimize = false;
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
        } else if (arg === '-') fail('Reading from stdin is not supported; pass a file or use -s <svg>');
        else if (arg.startsWith('-')) fail(`Unknown option: ${arg}`);
        else inputs.push(arg);
    }
    // Reported once here rather than as a conversion failure of every input.
    try {
        colorRefs(opts.currentColor ?? '#000000', opts.colorMap);
    } catch (err) {
        fail((err as Error).message);
    }
    return { inputs, inline, out, stdout, opts, naming };
}

/** The files an input argument stands for: itself, or the `*.svg` of a directory. */
function listSvgs(path: string): string[] {
    return statSync(path).isDirectory() ? listSvgFiles(path) : [path];
}

/** Runs the CLI against `argv` (without the node/script prefix) and returns the exit code. */
export function run(argv: string[], io: CliIo = processIo): number {
    let args: ReturnType<typeof parseArgs>;
    try {
        args = parseArgs(argv, io);
    } catch (err) {
        if (err instanceof CliExit) return err.code;
        throw err;
    }
    const { inputs, inline, out, stdout, opts, naming } = args;

    if (inline !== undefined) {
        try {
            const { xml, warnings } = convert(inline, opts);
            for (const w of warnings) io.stderr(`  ⚠ [${w.code}] ${w.message}\n`);
            if (out && extname(out) === '.xml') writeOutput(out, xml);
            else io.stdout(xml);
            return 0;
        } catch (err) {
            io.stderr(`✗ ${(err as Error).message}\n`);
            return 1;
        }
    }

    if (inputs.length === 0) {
        io.stderr(HELP);
        return 1;
    }

    let failures = 0;
    const files = inputs.flatMap((input) => {
        try {
            return listSvgs(input);
        } catch (err) {
            failures++;
            const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
            io.stderr(`✗ ${input}: ${missing ? 'no such file or directory' : (err as Error).message}\n`);
            return [];
        }
    });
    const explicitTarget = out && files.length === 1 && extname(out) === '.xml' ? out : undefined;
    const jobs = files.map((input) => ({ input, output: explicitTarget ?? defaultOutputPath(input, out, naming) }));
    if (!stdout) {
        try {
            assertDistinctOutputs(jobs, naming);
        } catch (err) {
            io.stderr(`✗ ${(err as Error).message}\n`);
            return 1;
        }
    }
    for (const { input: file, output: target } of jobs) {
        try {
            const { xml, warnings } = convert(readFileSync(file, 'utf8'), opts);
            for (const w of warnings) io.stderr(`  ⚠ ${basename(file)}: [${w.code}] ${w.message}\n`);
            if (stdout) {
                io.stdout(xml);
            } else {
                writeOutput(target, xml);
                io.stderr(`✓ ${file} → ${target}\n`);
            }
        } catch (err) {
            failures++;
            io.stderr(`✗ ${file}: ${(err as Error).message}\n`);
        }
    }
    return failures ? 1 : 0;
}

/** True when this module is the process entry point (also through an npm bin symlink). */
function isMain(): boolean {
    try {
        return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
}

if (isMain()) process.exitCode = run(process.argv.slice(2));
