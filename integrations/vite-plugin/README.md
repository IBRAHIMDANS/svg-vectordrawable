# vite-plugin-svg-vectordrawable

Vite (and Rollup) plugin that converts a folder of SVGs into Android VectorDrawable XML files with
[`svg-vectordrawable`](https://github.com/IBRAHIMDANS/svg-vectordrawable), at build time and in watch
mode. Useful when the web app and the Android app (Capacitor, React Native, a design-system repo…) share
the same icons.

```sh
npm install --save-dev vite-plugin-svg-vectordrawable
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import svgVectorDrawable from 'vite-plugin-svg-vectordrawable';

export default defineConfig({
    plugins: [
        svgVectorDrawable({
            input: 'design/icons', // *.svg, non-recursive
            output: 'android/app/src/main/res/drawable',
            strict: true, // any lossy construct fails the build
            minSdk: 24,
        }),
    ],
});
```

## Behaviour

- **`vite build`**: every `*.svg` of `input` is converted to `output/<name>.xml`. Warnings are reported
  through the Vite / Rollup logger (`file.svg: [code] message`); conversion errors (`strict`, `rules`, an
  invalid SVG) fail the build after the other files are converted.
- **Incremental**: a file is converted again only when its content, the options or the installed
  `svg-vectordrawable` version change. A manifest kept in Vite's `cacheDir` (`node_modules/.vite`)
  records what was generated; a second build with nothing changed converts 0 files.
- **Watch mode** (`vite` dev server, `vite build --watch`): only the changed file is converted; removing an
  SVG deletes its output. In the dev server, errors are logged and the server keeps running.
- **Ownership**: only files the plugin generated are ever deleted, so `output` can hold hand-written
  drawables too. Keep `output` out of Vite's `build.outDir`, which is emptied on build.

## Options

`input` and `output` are resolved against the Vite `root` (the cwd under Rollup). Every other option is
passed to [`convert`](https://github.com/IBRAHIMDANS/svg-vectordrawable#usage) (`strict`, `rules`,
`currentColor`, `minSdk`, `tint`, `floatPrecision`, …), except:

| Option         | Default                         | Effect                                                                                   |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `androidNames` | `true`                          | `Arrow-Left.svg` → `arrow_left.xml`; two sources mapping to the same name fail the build |
| `cacheDir`     | `<cacheDir>/svg-vectordrawable` | Where the manifest is stored (`node_modules/.cache/svg-vectordrawable` under Rollup)     |

`currentColor` takes a CSS color: `#RRGGBB` or `#RRGGBBAA`, not Android's `#AARRGGBB`.

## Development

```sh
pnpm install       # this folder is its own pnpm workspace (pnpm-workspace.yaml, pnpm-lock.yaml)
pnpm test          # build + node:test (incremental builds, watch mode, dev server)
pnpm run example   # vite build of example/, writes example/android/app/src/main/res/drawable
```
