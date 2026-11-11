import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        coverage: {
            provider: 'v8',
            include: ['src/**'],
            reporter: ['text', 'lcov', 'json', 'json-summary'],
            // A few points under the current figures: catches a real drop, not noise.
            thresholds: { statements: 92, branches: 85, functions: 95, lines: 95 },
        },
    },
});
