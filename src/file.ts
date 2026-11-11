import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, basename, dirname, relative } from 'node:path';
import { convert } from './convert.js';
import { androidResourceName, assertNoNameCollisions, findNameCollisions, type NameCollision } from './resourceName.js';
import type { ConvertOptions, ConvertResult, Warning } from './types.js';

/** How default output file names are derived from input file names. */
export interface FileNamingOptions {
    /**
     * Rewrite default output names into valid Android resource names (`Arrow-Left.svg` → `arrow_left.xml`).
     * An explicit output path is always used verbatim. Default `false`.
     */
    androidNames?: boolean;
}

/** Default output path for `inputPath`: `<outputDir>/<name>.xml`, `outputDir` defaulting to the input's directory. */
export function defaultOutputPath(inputPath: string, outputDir?: string, naming?: FileNamingOptions): string {
    const name = basename(inputPath, extname(inputPath));
    return join(outputDir ?? dirname(inputPath), `${naming?.androidNames ? androidResourceName(name) : name}.xml`);
}

/**
 * Output path of `input`, found under the input directory `root`, in a batch written to `outputDir`:
 * its path relative to `root` is kept (`root/a/b.svg` → `<outputDir>/a/b.xml`), except with
 * `androidNames`, where outputs are flat since an Android resource directory has no subdirectories.
 * Without `outputDir`, the output goes next to the input.
 */
export function batchOutputPath(input: string, root: string, outputDir?: string, naming?: FileNamingOptions): string {
    if (outputDir === undefined || naming?.androidNames) return defaultOutputPath(input, outputDir, naming);
    return defaultOutputPath(input, join(outputDir, relative(root, dirname(input))), naming);
}

/**
 * Path of the PNG fallback of the drawable `xmlOutput` for a `density` bucket:
 * `drawable-<density>/<name>.png` in the XML's directory (`out/icon.xml` → `out/drawable-mdpi/icon.png`),
 * or beside it when that directory is an Android `drawable` (`res/drawable/icon.xml` →
 * `res/drawable-mdpi/icon.png`), since a resource directory has no subdirectories.
 */
export function fallbackPngPath(xmlOutput: string, density: string): string {
    const dir = dirname(xmlOutput);
    const res = basename(dir) === 'drawable' ? dirname(dir) : dir;
    return join(res, `drawable-${density}`, `${basename(xmlOutput, extname(xmlOutput))}.png`);
}

/**
 * The output paths shared by several inputs, in input order; empty when all are distinct.
 * Only checked with `androidNames`, where distinct source names can collapse to the same resource name.
 */
export function findOutputCollisions(
    entries: readonly { input: string; output: string }[],
    naming?: FileNamingOptions,
): NameCollision[] {
    return naming?.androidNames
        ? findNameCollisions(entries.map(({ input, output }) => ({ input, name: output })))
        : [];
}

/**
 * Fails when several inputs would be written to the same output path, before anything is written.
 * Only checked with `androidNames` (see {@link findOutputCollisions}).
 */
export function assertDistinctOutputs(
    entries: readonly { input: string; output: string }[],
    naming?: FileNamingOptions,
): void {
    if (naming?.androidNames) assertNoNameCollisions(entries.map(({ input, output }) => ({ input, name: output })));
}

/**
 * The `*.svg` files inside `dir` (extension matched case-insensitively), sorted by name. With
 * `recursive`, also those of its subdirectories, depth first; symbolic links to directories are not
 * followed (no cycles).
 */
export function listSvgFiles(dir: string, recursive = false): string[] {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    return entries.flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return recursive ? listSvgFiles(path, true) : [];
        return extname(entry.name).toLowerCase() === '.svg' && statSync(path).isFile() ? [path] : [];
    });
}

/** Writes `content` to `target`, creating its parent directories first. */
export function writeOutput(target: string, content: string | Uint8Array): void {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

/**
 * Converts a single SVG file to a VectorDrawable XML file.
 * Defaults the output path to the input with a `.xml` extension. (Node only.)
 */
export function convertFile(
    inputPath: string,
    outputPath?: string,
    options?: ConvertOptions,
    naming?: FileNamingOptions,
): ConvertResult {
    const result = convert(readFileSync(inputPath, 'utf8'), options);
    writeOutput(outputPath ?? defaultOutputPath(inputPath, undefined, naming), result.xml);
    return result;
}

export interface ConvertDirResult {
    input: string;
    output: string;
    warnings: Warning[];
}

/**
 * Converts every `*.svg` in a directory to `*.xml` in `outputDir`. (Node only, non-recursive.)
 * With `naming.androidNames`, throws before writing anything if two inputs map to the same resource name.
 */
export function convertDir(
    inputDir: string,
    outputDir: string,
    options?: ConvertOptions,
    naming?: FileNamingOptions,
): ConvertDirResult[] {
    const jobs = listSvgFiles(inputDir).map((input) => ({
        input,
        output: defaultOutputPath(input, outputDir, naming),
    }));
    assertDistinctOutputs(jobs, naming);
    mkdirSync(outputDir, { recursive: true });
    return jobs.map(({ input, output }) => ({ input, output, warnings: convertFile(input, output, options).warnings }));
}
