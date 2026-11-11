import { fileURLToPath } from 'node:url';
import { defineConfig, type Options } from 'tsup';

/**
 * Resolves `./text.js` (the `fonts` option: Node file reads and opentype.js loaded with createRequire)
 * to src/text-browser.ts, which rejects the option, so that the browser bundles carry neither.
 */
const browserText: NonNullable<Options['esbuildPlugins']>[number] = {
    name: 'svgvd-browser-text',
    setup(build) {
        build.onResolve({ filter: /^\.\/text\.js$/ }, () => ({
            path: fileURLToPath(new URL('./src/text-browser.ts', import.meta.url)),
        }));
    },
};

/**
 * A browser entry: an ESM build with its own declaration file (index.d.ts would advertise the
 * Node-only file helpers) and a minified IIFE exposing the global `svgvd` for a `<script>` tag.
 */
function browserBuilds(name: string, svgoAlias: string, extra: Options = {}): Options[] {
    const entry = { [name]: `src/${name}.ts` };
    const shared: Options = {
        entry,
        sourcemap: false,
        platform: 'browser',
        esbuildPlugins: [browserText],
        esbuildOptions(o) {
            o.alias = { ...(o.alias ?? {}), svgo: svgoAlias };
        },
        ...extra,
    };
    return [
        { ...shared, format: ['esm'], dts: { entry } },
        { ...shared, format: ['iife'], globalName: 'svgvd', minify: true, dts: false },
    ];
}

// No `clean` here: these builds run in parallel, and a config that empties dist/ can delete files
// another one has already written (browser.d.ts went missing in CI). The build script cleans first.
export default defineConfig([
    // Node library, CommonJS + its types. `shims` replaces `import.meta.url` (renderFallbackPng
    // loads its optional peer @resvg/resvg-js with createRequire(import.meta.url)), which is empty
    // in CommonJS. Only this build needs it: the ESM build has a real import.meta and the browser
    // builds never import src/fallback.ts.
    {
        entry: ['src/index.ts'],
        format: ['cjs'],
        dts: true,
        sourcemap: false,
        target: 'node18',
        shims: true,
    },
    // Node library and CLI, ESM. Built together with code splitting so that dist/cli.js shares the
    // converter with dist/index.js (one chunk) instead of carrying a second copy. The CLI is ESM
    // only: `bin` points to dist/cli.js and its `import.meta.url` entry-point guard needs ESM. The
    // shebang is preserved by tsup.
    {
        entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
        format: ['esm'],
        splitting: true,
        dts: { entry: { index: 'src/index.ts' } },
        sourcemap: false,
        target: 'node18',
    },
    // Browser build: same API, but svgo resolves to its browser bundle (no Node built-ins).
    ...browserBuilds('browser', 'svgo/browser'),
    // Lightweight browser build: same API (global `svgvd` too), optimize:false only. `svgo` is
    // bundled from src/svgo-lite.ts (small XML parser + color table) instead of svgo itself,
    // which keeps svgo's plugins and CSS tooling (~1 MB) out of both outputs.
    ...browserBuilds('browser-lite', './src/svgo-lite.ts', { noExternal: ['svgo'] }),
]);
