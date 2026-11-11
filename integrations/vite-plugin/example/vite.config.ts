import { defineConfig } from 'vite';
import svgVectorDrawable from 'vite-plugin-svg-vectordrawable';

export default defineConfig({
    plugins: [
        svgVectorDrawable({
            input: 'icons',
            output: 'android/app/src/main/res/drawable',
            strict: true,
            // CSS color (`#RRGGBB[AA]`), not Android's `#AARRGGBB`.
            currentColor: '#1F1F1F',
            minSdk: 24,
        }),
    ],
});
