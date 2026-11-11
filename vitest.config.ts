import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Agent worktrees under .claude/ are full copies of the repository: never collect their tests.
        exclude: [...configDefaults.exclude, '.claude/**'],
        coverage: {
            provider: 'v8',
            include: ['src/**'],
            reporter: ['text', 'lcov', 'json', 'json-summary'],
            // A few points under the current figures: catches a real drop, not noise.
            thresholds: { statements: 92, branches: 85, functions: 95, lines: 95 },
        },
    },
});
