// Builds the plugin into dist/: code.js (main thread) and ui.html (UI, fully inline).
//   node scripts/build.ts            (from integrations/figma-plugin, Node >= 22.18 / 23.6)
// Needs `pnpm run build` at the repository root first: ui.html inlines dist/browser-lite.global.js.
// Bundling uses tsup, already a devDependency of the repository: nothing to install here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (...parts: string[]) => join(root, ...parts);
const LITE_BUNDLE = at('../../dist/browser-lite.global.js');

/** An inline `<script>` must not contain these: the HTML parser would end the element early. */
const UNSAFE_IN_SCRIPT = /<\/script|<script/i;

function assertInlineSafe(name: string, source: string): string {
    if (UNSAFE_IN_SCRIPT.test(source)) throw new Error(`${name} contains "<script" or "</script": cannot be inlined.`);
    return source;
}

/** Bundles `entry` into one IIFE and returns its code. */
async function bundle(
    entry: string,
    target: string,
    { define = {}, banner }: { define?: Record<string, string>; banner?: string } = {},
): Promise<string> {
    const outDir = mkdtempSync(join(tmpdir(), 'svgvd-figma-'));
    try {
        await build({
            entry: { out: at('src', entry) },
            outDir,
            format: ['iife'],
            platform: 'browser',
            target,
            define,
            ...(banner ? { banner: { js: banner } } : {}),
            minify: false,
            sourcemap: false,
            dts: false,
            clean: false,
            silent: true,
            config: false,
            tsconfig: at('tsconfig.json'),
        });
        return readFileSync(join(outDir, 'out.global.js'), 'utf8');
    } finally {
        rmSync(outDir, { recursive: true, force: true });
    }
}

/** Replaces the `/* inline:<name> *\/` placeholder (and the whitespace around it) by `code`. */
function inline(html: string, name: string, code: string): string {
    const placeholder = new RegExp(`\\s*/\\* inline:${name} \\*/\\s*`);
    if (!placeholder.test(html)) throw new Error(`ui.template.html has no inline:${name} placeholder.`);
    // A replacer function: `$&`, `$1`… in the bundle must stay literal.
    return html.replace(placeholder, () => `\n${code}\n`);
}

export async function buildPlugin(): Promise<void> {
    if (!existsSync(LITE_BUNDLE))
        throw new Error(`${LITE_BUNDLE} is missing: run \`pnpm run build\` at the repository root first.`);
    process.chdir(root); // tsup reads package.json (for externals) from the working directory
    const lite = assertInlineSafe('browser-lite.global.js', readFileSync(LITE_BUNDLE, 'utf8').trim());
    // The Figma sandbox runs a restricted JS engine: keep the main thread at ES2017.
    // The banner names the globals Figma provides (lint-clean output if a linter ever reads it).
    const code = await bundle('main.ts', 'es2017', { banner: '/* global figma, __html__ */' });
    const worker = await bundle('worker.ts', 'es2020');
    const ui = assertInlineSafe(
        'ui script',
        await bundle('ui.ts', 'es2020', { define: { __WORKER_SOURCE__: JSON.stringify(worker) } }),
    );

    let html = readFileSync(at('src/ui.template.html'), 'utf8');
    html = inline(html, 'svgvd', lite);
    html = inline(html, 'ui', ui);

    mkdirSync(at('dist'), { recursive: true });
    writeFileSync(at('dist/code.js'), code);
    writeFileSync(at('dist/ui.html'), html);
    const kb = (text: string) => `${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`;
    console.log(`dist/code.js ${kb(code)}, dist/ui.html ${kb(html)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildPlugin();
