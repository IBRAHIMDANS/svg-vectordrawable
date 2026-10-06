import { defineConfig } from 'tsup';

export default defineConfig([
    // Node library: ESM + CJS + types.
    {
        entry: ['src/index.ts'],
        format: ['esm', 'cjs'],
        dts: true,
        clean: true,
        sourcemap: false,
        target: 'node18',
    },
    // CLI: ESM only, no types. The `bin` points to dist/cli.js and the `import.meta.url`
    // entry-point guard in src/cli.ts only works in ESM. The shebang is preserved by tsup.
    {
        entry: ['src/cli.ts'],
        format: ['esm'],
        dts: false,
        sourcemap: false,
        target: 'node18',
    },
    // Browser build: same API, but svgo resolves to its browser bundle (no Node built-ins).
    {
        entry: { browser: 'src/browser.ts' },
        format: ['esm', 'iife'],
        globalName: 'svgvd',
        // Own declaration file: index.d.ts would advertise the Node-only file helpers.
        dts: { entry: { browser: 'src/browser.ts' } },
        sourcemap: false,
        platform: 'browser',
        esbuildOptions(o) {
            o.alias = { ...(o.alias ?? {}), svgo: 'svgo/browser' };
        },
    },
    // Lightweight browser build: same API (global `svgvd` too), optimize:false only. `svgo` is
    // bundled from src/svgo-lite.ts (small XML parser + color table) instead of svgo itself,
    // which keeps svgo's plugins and CSS tooling (~1 MB) out of both outputs.
    {
        entry: { 'browser-lite': 'src/browser-lite.ts' },
        format: ['esm', 'iife'],
        globalName: 'svgvd',
        dts: { entry: { 'browser-lite': 'src/browser-lite.ts' } },
        sourcemap: false,
        platform: 'browser',
        noExternal: ['svgo'],
        esbuildOptions(o) {
            o.alias = { ...(o.alias ?? {}), svgo: './src/svgo-lite.ts' };
        },
    },
]);
