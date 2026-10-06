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
);
