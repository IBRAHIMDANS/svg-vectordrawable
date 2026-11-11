import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    // Build artifacts and generated/snapshot content are never linted.
    {
        ignores: [
            'dist',
            'node_modules',
            'coverage',
            'test/__snapshots__',
            // Gradle state and outputs of the Android rendering check.
            'android-render/build',
            'android-render/render/build',
            'android-render/.gradle',
            // Gradle state and outputs of the Compose compile check.
            'scripts/compose-check/build',
            'scripts/compose-check/.gradle',
            'scripts/compose-check/.kotlin',
            // Local copy of the IIFE build used to serve the playground (see playground/README.md).
            'playground/browser-lite.global.js',
            // Agent worktrees (full copies of the repo) and local, unversioned drafts.
            '.claude/**',
            'docs/drafts/**',
        ],
    },
    // Integrations (integrations/*): build outputs and generated files. `dist` above is the root one only.
    {
        ignores: [
            // Figma plugin bundles, MCP server tsc output, Vite plugin build.
            'integrations/*/dist',
            // Written by the Vite plugin example build.
            'integrations/vite-plugin/example/android',
            'integrations/vite-plugin/example/dist',
            // Gradle / Kotlin state and outputs of the Gradle plugin and its example app.
            'integrations/gradle-plugin/**/build',
            'integrations/gradle-plugin/**/.gradle',
            'integrations/gradle-plugin/**/.kotlin',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts', 'test/**/*.ts'],
        languageOptions: {
            globals: { ...globals.node },
        },
        rules: {
            // The codebase deliberately uses non-null assertions after guarded access
            // (e.g. regex captures, array indices known-present). Allowed by design.
            '@typescript-eslint/no-non-null-assertion': 'off',
            // Unused vars are an error, except intentionally-ignored ones prefixed with `_`.
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
    // Node tooling: validation scripts, the Android rendering pipeline and config files run on Node.
    {
        files: ['scripts/**/*.{js,mjs,cjs}', 'android-render/*.mjs', '*.config.{js,mjs,cjs,ts}'],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
    // Documentation asset generators (e.g. the README before/after image) run on Node.
    {
        files: ['docs/assets/**/*.mjs'],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
    // Playground (static page on GitHub Pages): browser modules, a classic worker, a Node smoke test.
    {
        files: ['playground/*.js'],
        languageOptions: {
            globals: { ...globals.browser },
        },
    },
    {
        files: ['playground/worker.js'],
        languageOptions: {
            sourceType: 'script',
            globals: { ...globals.worker, svgvd: 'readonly' },
        },
    },
    {
        files: ['playground/*.mjs'],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
    // Vite plugin: Node code (plugin, tests, example config).
    {
        files: ['integrations/vite-plugin/**/*.{ts,js,mjs}'],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
    // MCP server (standalone package built on the published library): Node code.
    {
        files: ['integrations/mcp-server/**/*.{ts,mjs}'],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
);
