import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { androidResourceName, convert, type ConvertOptions } from 'svg-vectordrawable';
import type { Logger, Plugin } from 'vite';

export interface SvgVectorDrawableOptions extends Omit<ConvertOptions, 'onWarn'> {
    /** Folder holding the source `*.svg` files (non-recursive). Relative to the Vite root, or the cwd under Rollup. */
    input: string;
    /** Output folder, e.g. `android/app/src/main/res/drawable`. Must not be inside Vite's `build.outDir`. */
    output: string;
    /**
     * Name outputs as valid Android resource names (`Arrow-Left.svg` → `arrow_left.xml`).
     * Default `true` here (unlike the library), since the output is meant for `res/drawable`.
     */
    androidNames?: boolean;
    /**
     * Folder for the manifest that records what was converted (incremental builds, deletion of stale outputs).
     * Default: `<Vite cacheDir>/svg-vectordrawable`, or `node_modules/.cache/svg-vectordrawable` under Rollup.
     */
    cacheDir?: string;
}

/** What the plugin did in one pass; also logged as a one-line summary. */
export interface SyncStats {
    converted: number;
    upToDate: number;
    removed: number;
    failed: number;
}

/** Source file name → generated file name and source content hash. */
interface Manifest {
    key: string;
    files: Record<string, { output: string; hash: string }>;
}

/** The subset of the Rollup / Vite plugin context the plugin reports through. */
interface Reporter {
    warn: (message: string) => void;
    info: (message: string) => void;
}

const NAME = 'svg-vectordrawable';

const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex');

/** Installed `svg-vectordrawable` version: an upgrade invalidates every previous conversion. */
function libraryVersion(): string {
    const require = createRequire(import.meta.url);
    const pkg = join(dirname(require.resolve('svg-vectordrawable')), '..', 'package.json');
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
}

/**
 * Converts every `*.svg` of `input` into a VectorDrawable XML in `output`, at build start and on every
 * change of the folder in watch mode / dev server. Unchanged files (same content, same options, same
 * library version) are not converted again; outputs whose source was removed are deleted.
 */
export function svgVectorDrawable(options: SvgVectorDrawableOptions): Plugin {
    const { input, output, androidNames = true, cacheDir, ...convertOptions } = options;
    let root = process.cwd();
    let viteCacheDir: string | undefined;
    let logger: Logger | undefined;
    let inputDir = '';
    let outputDir = '';
    let manifestPath = '';
    let manifest: Manifest = { key: '', files: {} };
    let key = '';
    let isServe = false;

    const outputName = (file: string): string => {
        const name = basename(file, extname(file));
        return `${androidNames ? androidResourceName(name) : name}.xml`;
    };
    const isSource = (file: string): boolean =>
        resolve(dirname(file)) === inputDir && extname(file).toLowerCase() === '.svg';

    function init(): void {
        inputDir = resolve(root, input);
        outputDir = resolve(root, output);
        const dir = cacheDir
            ? resolve(root, cacheDir)
            : join(viteCacheDir ?? join(root, 'node_modules', '.cache'), NAME);
        manifestPath = join(dir, `${sha256(`${inputDir}\0${outputDir}`).slice(0, 16)}.json`);
        key = sha256(JSON.stringify({ version: libraryVersion(), androidNames, convertOptions }));
        try {
            const saved = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
            manifest = saved.key === key ? saved : { key, files: {} };
        } catch {
            manifest = { key, files: {} };
        }
    }

    function saveManifest(): void {
        mkdirSync(dirname(manifestPath), { recursive: true });
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }

    /** Deletes the output generated from `source` (only files this plugin wrote are ever deleted). */
    function remove(source: string): boolean {
        const entry = manifest.files[source];
        if (!entry) return false;
        rmSync(join(outputDir, entry.output), { force: true });
        delete manifest.files[source];
        return true;
    }

    /** Converts one source unless its output is up to date. Throws `<source>: <reason>` on failure. */
    function convertOne(source: string, report: Reporter, stats: SyncStats): void {
        const svg = readFileSync(join(inputDir, source), 'utf8');
        const hash = sha256(svg);
        const target = outputName(source);
        const entry = manifest.files[source];
        if (entry && entry.hash === hash && entry.output === target && existsSync(join(outputDir, target))) {
            stats.upToDate++;
            return;
        }
        if (entry && entry.output !== target) remove(source);
        try {
            const { xml, warnings } = convert(svg, convertOptions);
            for (const w of warnings) report.warn(`${source}: [${w.code}] ${w.message}`);
            mkdirSync(outputDir, { recursive: true });
            writeFileSync(join(outputDir, target), xml);
            manifest.files[source] = { output: target, hash };
            stats.converted++;
        } catch (err) {
            // Forget the entry so the file is retried on the next pass; the previous output is left as is.
            delete manifest.files[source];
            stats.failed++;
            throw new Error(`${source}: ${(err as Error).message}`, { cause: err });
        }
    }

    function summary(stats: SyncStats): string {
        return `${NAME}: ${stats.converted} converted, ${stats.upToDate} up to date, ${stats.removed} removed${
            stats.failed ? `, ${stats.failed} failed` : ''
        } (${relative(root, inputDir) || '.'} → ${relative(root, outputDir) || '.'})`;
    }

    /** Full pass over the input folder. Returns the failures, one message per file. */
    function sync(report: Reporter): { stats: SyncStats; errors: string[] } {
        const stats: SyncStats = { converted: 0, upToDate: 0, removed: 0, failed: 0 };
        const sources = readdirSync(inputDir).filter(
            (f) => extname(f).toLowerCase() === '.svg' && statSync(join(inputDir, f)).isFile(),
        );
        // Two sources mapping to the same resource name: fail before writing anything.
        const owners = new Map<string, string>();
        for (const source of sources) {
            const other = owners.get(outputName(source));
            if (other) throw new Error(`${NAME}: ${other} and ${source} both map to ${outputName(source)}`);
            owners.set(outputName(source), source);
        }
        for (const source of Object.keys(manifest.files)) {
            if (!sources.includes(source) && remove(source)) stats.removed++;
        }
        const errors: string[] = [];
        for (const source of sources) {
            try {
                convertOne(source, report, stats);
            } catch (err) {
                errors.push((err as Error).message);
            }
        }
        saveManifest();
        return { stats, errors };
    }

    return {
        name: NAME,

        configResolved(config) {
            root = config.root;
            viteCacheDir = config.cacheDir;
            logger = config.logger;
            isServe = config.command === 'serve';
        },

        configureServer(server) {
            // Input folders outside the Vite root are not watched by default.
            server.watcher.add(resolve(root, input));
        },

        buildStart() {
            init();
            if (!existsSync(inputDir)) this.error(`${NAME}: input folder not found: ${inputDir}`);
            const report: Reporter = {
                warn: (message) => this.warn(message),
                info: (message) => (logger ? logger.info(message) : this.info(message)),
            };
            const { stats, errors } = sync(report);
            report.info(summary(stats));
            // Under Rollup / `vite build --watch`, a new file in the folder must trigger a rebuild too.
            this.addWatchFile(inputDir);
            if (errors.length) {
                const message = `${NAME}: ${errors.length} file(s) failed:\n  ${errors.join('\n  ')}`;
                // The dev server keeps running and shows the error; a build fails.
                if (isServe) logger?.error(message);
                else this.error(message);
            }
        },

        watchChange(id, change) {
            if (!inputDir || !isSource(id)) return;
            const source = basename(id);
            const stats: SyncStats = { converted: 0, upToDate: 0, removed: 0, failed: 0 };
            const report: Reporter = {
                warn: (message) => (logger ? logger.warn(message) : this.warn(message)),
                info: (message) => (logger ? logger.info(message) : this.info(message)),
            };
            try {
                if (change.event === 'delete') {
                    if (remove(source)) stats.removed++;
                } else {
                    const owner = Object.entries(manifest.files).find(
                        ([other, entry]) => other !== source && entry.output === outputName(source),
                    );
                    if (owner) throw new Error(`${owner[0]} and ${source} both map to ${outputName(source)}`);
                    convertOne(source, report, stats);
                }
            } catch (err) {
                // Reported here; under Rollup watch, the rebuild that follows fails on the same file.
                const message = `${NAME}: ${(err as Error).message}`;
                if (logger) logger.error(message);
                else this.warn(message);
            }
            saveManifest();
            report.info(summary(stats));
        },
    };
}

export default svgVectorDrawable;
