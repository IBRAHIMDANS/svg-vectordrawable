# Migrating from `svg2vectordrawable`

This guide maps the API, options and CLI of
[`svg2vectordrawable`](https://github.com/Ashung/svg2vectordrawable) (last published version **2.9.1**,
June 2022, depends on `svgo@^2.8.0`) to `svg-vectordrawable`.

Everything stated about `svg2vectordrawable` below was checked against the 2.9.1 tarball from npm
(`src/*.js`, `bin/`, `README.md`) and by running it on small probe SVGs on 2026-10-05.

> The `rules` option, `ConversionError`, `--rule`, `--android-names`, dashed strokes, gradient strokes
> and several fixes mentioned here are in the `[Unreleased]` section of the changelog: they ship with
> the release after 0.1.1.

## TL;DR

```js
// Before — svg2vectordrawable (CommonJS, Promise<string>)
const svg2vectordrawable = require('svg2vectordrawable');

const xml = await svg2vectordrawable(svgCode, {
    floatPrecision: 2,
    strict: true,
    fillBlack: true,
    xmlTag: true,
});
```

```js
// After — svg-vectordrawable (ESM or CommonJS, synchronous, returns { xml, warnings })
const { convert, ConversionError } = require('svg-vectordrawable'); // or: import { … } from 'svg-vectordrawable'

try {
    const { xml, warnings } = convert(svgCode, {
        floatPrecision: 2, // default is 3
        strict: true,
        // fillBlack: true is the default here (fillBlackForUnfilled)
        xmlTag: true,
    });
    for (const w of warnings) console.warn(`[${w.code}] ${w.message}`);
} catch (err) {
    if (!(err instanceof ConversionError)) throw err;
    console.error('not representable as a VectorDrawable:', err.warning.code);
}
```

## JavaScript API

### Entry points

| `svg2vectordrawable` 2.9.1                                                                                                                                | `svg-vectordrawable`                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `require('svg2vectordrawable')` — default export `(svgCode, options?) => Promise<string>`; runs svgo 2 with its own config, then converts                 | `convert(svg, options?) => { xml, warnings }` — **synchronous**; runs svgo 4 first unless `optimize: false`       |
| `require('svg2vectordrawable/src/main.browser')` (svgo browser bundle)                                                                                    | `import { convert } from 'svg-vectordrawable/browser'` (ESM; same `convert`, no file helpers)                     |
| `require('svg2vectordrawable/src/svg-file-to-vectordrawable-file').convertFile(input, output, options) => Promise<void>`                                  | `convertFile(inputPath, outputPath?, options?, naming?) => { xml, warnings }` — synchronous                       |
| `require('svg2vectordrawable/src/svg-file-to-vectordrawable-file').outputFile(content, filePath) => Promise<void>` (write a file, creating its directory) | No equivalent — use `fs.mkdirSync(dir, { recursive: true })` + `fs.writeFileSync`                                 |
| No directory helper in the API (only in the CLI)                                                                                                          | `convertDir(inputDir, outputDir, options?, naming?) => { input, output, warnings }[]` (non-recursive)             |
| No equivalent                                                                                                                                             | `androidResourceName(name)` — turns a file name into a valid Android resource name                                |
| No equivalent                                                                                                                                             | `WARNING_CODES`, `ConversionError`, types `ConvertOptions`, `ConvertResult`, `Warning`, `WarningCode`, `Severity` |

Notes on the old file helper, useful when you replace it:

- Its README documents `require('svg2vectordrawable/lib/svg-file-to-vectordrawable-file')` as a
  default-exported function. In 2.9.1 there is no `lib/` directory (`MODULE_NOT_FOUND`) and the module
  exports an object `{ outputFile, convertFile }`.
- `convertFile` reads `options.floatPrecision` before doing anything, so calling it without an
  `options` object throws a `TypeError`.
- `convertFile` calls the converter **directly, without svgo**, unlike the default export. Shapes
  other than `<rect>` (`<circle>`, `<ellipse>`, `<line>`, `<polygon>`, `<polyline>`) are then dropped,
  and non-hex colors (`red`, `rgb()`) become black. The CLI uses the same code path.
- It does not forward `tint`.

### Options

| `svg2vectordrawable` option    | `svg-vectordrawable` option                 | Notes                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `floatPrecision` (default `2`) | `floatPrecision` (default `3`)              | Set `2` explicitly to keep the old rounding. In the old library it was also passed to svgo.                                                                                                               |
| `strict` (default `false`)     | `strict` (default `false`) + `rules`        | Different semantics, see [Strict mode](#strict-mode-and-errors).                                                                                                                                          |
| `fillBlack` (default `false`)  | `fillBlackForUnfilled` (default **`true`**) | Same meaning (unfilled shapes get `#FF000000`, as SVG paints them). The default flipped: pass `fillBlackForUnfilled: false` to keep the old output.                                                       |
| `xmlTag` (default `false`)     | `xmlTag` (default `false`)                  | Same declaration: `<?xml version="1.0" encoding="utf-8"?>`.                                                                                                                                               |
| `tint`                         | `tint`                                      | The old library upper-cases hex values and writes the rest unescaped. This one writes the value verbatim, XML-escaped: pass an Android color literal (`#AARRGGBB`, `#RRGGBB`, …) or a resource reference. |
| —                              | `optimize` (default `true`)                 | svgo normalization. The old default export always ran svgo; its file helper and CLI never did.                                                                                                            |
| —                              | `svgoConfig`                                | Replace the svgo config used when `optimize` is on.                                                                                                                                                       |
| —                              | `currentColor` (default `'#000000'`)        | The color substituted for `currentColor`. The old library also ended up with black, because it maps any color it cannot parse to black.                                                                   |
| —                              | `indent` (default `4`)                      | The old library always indents with 4 spaces.                                                                                                                                                             |
| —                              | `onWarn`                                    | Callback per warning, in addition to the returned `warnings`.                                                                                                                                             |
| —                              | `rules`                                     | Per-warning-code severity: `'off' \| 'warn' \| 'error'`, overrides `strict`. Unknown codes throw a `TypeError`.                                                                                           |

### Return value: `string` → `{ xml, warnings }`

The old function resolves to the XML string. `convert` returns an object; this is the change most
likely to break a migration silently (writing `[object Object]` to a file):

```js
// Before
fs.writeFileSync(out, await svg2vectordrawable(svg));
// After
fs.writeFileSync(out, convert(svg).xml);
```

`await convert(svg)` still works (awaiting a non-promise is a no-op), so an existing `async` call site
only needs the `.xml`.

### Strict mode and errors

The two `strict` options have the same goal (fail rather than emit a wrong drawable) but work
differently.

**`svg2vectordrawable`**: after its own rewriting pass, it walks the remaining tree and rejects the
promise with a plain `Error('Unsupported element <name>')` or `Error('Unsupported attribute <name>')`
for the first element or attribute it has no mapping for. It checks names, not rendering. Observed on
2.9.1 (default export, svgo on):

| Input                                                                   | `strict: true` result                                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Any SVG where svgo keeps a `<defs>` (e.g. a `<linearGradient>` in defs) | Rejected: `Unsupported element defs` — gradients cannot pass strict mode                |
| `clip-path` on a `<g>`                                                  | Rejected: `Unsupported element clipPath`                                                |
| `stroke-dasharray`                                                      | Rejected: `Unsupported attribute stroke-dasharray`                                      |
| `<text>`, `<image>`                                                     | Rejected                                                                                |
| `<mask>`                                                                | Accepted: the mask's first child becomes a `<clip-path>`, whatever its color or opacity |
| `fill="hsl(…)"`                                                         | Accepted: becomes black                                                                 |
| Feather-style icon (`fill="none" stroke="currentColor"` on the `<svg>`) | Accepted: root presentation attributes are dropped, the paths have no paint (invisible) |
| `viewBox="-12 -12 24 24"`                                               | Accepted: the viewBox origin is ignored, content is shifted                             |

**`svg-vectordrawable`**: every lossy or unsupported construct is reported as a `Warning` with a
stable `code` (see `WARNING_CODES` and the README table). `strict: true` makes every code an error;
`rules` overrides per code. An error is thrown synchronously as a `ConversionError` whose `warning`
property carries `code`, `message` and, when known, `node`.

```js
// Fail on anything lossy, except approximated group opacity.
convert(svg, { strict: true, rules: { 'opacity-approximated': 'warn' } });

// Not strict, but fail on two specific codes and silence one.
convert(svg, { rules: { 'unsupported-element': 'error', 'unsupported-paint': 'error', 'empty-path': 'off' } });
```

If your code matched the old error messages (`/Unsupported element/`), switch to
`err instanceof ConversionError` and `err.warning.code`.

### Behavioural differences that change the output

These are differences in what gets drawn, not in the API. All were observed on 2026-10-05 with
`svg2vectordrawable` 2.9.1 and the current `svg-vectordrawable` sources.

| Input                                            | `svg2vectordrawable` 2.9.1                                                                                                                      | `svg-vectordrawable`                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `gradientTransform`                              | Ignored (only `x1…y2` / `cx`, `cy`, `r` are read)                                                                                               | Baked into the gradient coordinates; elliptical radials are emitted inside a deformed `<group>` |
| Non-zero `viewBox` origin                        | Ignored                                                                                                                                         | Content translated back into the viewport                                                       |
| Presentation attributes on the root `<svg>`      | Dropped                                                                                                                                         | Inherited by the children                                                                       |
| `clip-path` on shapes and groups                 | Dropped (`<clipPath>` is not converted)                                                                                                         | `<clip-path>` inside a `<group>`                                                                |
| `stroke-dasharray` / `stroke-dashoffset`         | Dropped (solid stroke)                                                                                                                          | Dashes baked into the path geometry                                                             |
| `hsl()` / `hsla()` colors                        | Black                                                                                                                                           | Converted                                                                                       |
| Unfilled shapes                                  | No `fillColor` unless `fillBlack: true`                                                                                                         | `#FF000000` unless `fillBlackForUnfilled: false`                                                |
| Gradient strokes (`stroke="url(#g)"`)            | Gradient emitted but `stroke-width` is not converted (Android's default width is 0); `strict` rejects it (`Unsupported attribute stroke-width`) | Emitted with its width (`<aapt:attr name="android:strokeColor">`)                               |
| `<mask>`                                         | First child used as a clip, silently                                                                                                            | Warned (`unsupported-attribute`) when not representable                                         |
| Attribute order, color format, number formatting | `fillColor` before `pathData`, `#FF000000` shortened to `#000`                                                                                  | `pathData` first, colors always `#AARRGGBB`                                                     |

The last row means the XML is not byte-identical even for simple icons: regenerate snapshots or
golden files once after migrating.

## CLI

`svg2vectordrawable` installs six aliases of the same binary (`s2v`, `svg2avd`, `svg2android`,
`svg2vector`, `svg2drawable`, `svg2vectordrawable`); this package installs one: `svgvd`.

| `s2v` 2.9.1                             | `svgvd`                                        | Notes                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <file.svg>`                | positional `svgvd file.svg`                    |                                                                                                                                                                                                                                                                                                                                     |
| `-f, --folder <dir>`                    | positional `svgvd dir/`                        | Several inputs can be given. Non-recursive in both.                                                                                                                                                                                                                                                                                 |
| `-s, --string <svg>`                    | `-s, --string <svg>`                           | `s2v` prints a `Android Vector Drawable Code:` header before the XML; `svgvd` prints the XML only. With `-o`, `s2v` appends `.xml` if missing; `svgvd` writes the file only if `-o` ends with `.xml`, otherwise prints to stdout.                                                                                                   |
| `-o, --output <file\|dir>`              | `-o, --out <file\|dir>`                        | A path ending in `.xml` is a file (single input only), anything else a directory.                                                                                                                                                                                                                                                   |
| `-p, --precision <n>` (default 2, 1–10) | `-p, --precision <n>` (default 3)              |                                                                                                                                                                                                                                                                                                                                     |
| `-x, --xml`                             | `--xml-tag`                                    |                                                                                                                                                                                                                                                                                                                                     |
| `-t, --tint <color>`                    | `--tint <color>`                               | See the `tint` option above.                                                                                                                                                                                                                                                                                                        |
| `-v, --version`                         | No equivalent                                  | Use `npm ls svg-vectordrawable`.                                                                                                                                                                                                                                                                                                    |
| (always) output names rewritten         | `--android-names` (opt-in)                     | `s2v` always lower-cases, replaces non-`[a-z0-9]` with `_` and **strips** leading digits (`2fa.svg` → `fa.xml`). `svgvd` keeps the input name unless `--android-names`, which prefixes instead (`2fa` → `ic_2fa`), avoids Java keywords (`class` → `class_`) and fails the batch before writing if two inputs map to the same name. |
| No strict mode in the CLI               | `--strict`, `--rule <code>=<off\|warn\|error>` | `s2v` hard-codes `strict: false`.                                                                                                                                                                                                                                                                                                   |
| svgo never runs                         | svgo runs by default; `--no-optimize` skips it | Because `s2v` skips svgo, it drops `<circle>`, `<ellipse>`, `<line>`, `<polygon>`, `<polyline>` and turns named / `rgb()` colors black. Expect visibly different (correct) output after switching.                                                                                                                                  |
| —                                       | `--stdout`                                     | Print instead of writing files.                                                                                                                                                                                                                                                                                                     |

Exit codes: `s2v` calls `process.exit(1)` on the first failing file. `svgvd` converts every file,
reports each failure on stderr (`✗ file: [code] message`) and exits with `1` at the end if any file
failed; warnings go to stderr as `⚠ file: [code] message` and do not change the exit code.

```sh
# Before
s2v -f icons -o app/src/main/res/drawable -p 3
# After (same file naming as s2v, except for names starting with a digit)
svgvd icons -o app/src/main/res/drawable -p 3 --android-names
```

## Migration checklist

1. Replace the dependency: `npm rm svg2vectordrawable && npm i svg-vectordrawable` (Node ≥ 18). If you
   depended on `svgo@2` only for this library, you can drop it as well; this package brings `svgo@4`.
2. Replace imports: `require('svg2vectordrawable')` → `const { convert } = require('svg-vectordrawable')`
   (or the ESM `import`). Browser builds: `svg-vectordrawable/browser`.
3. Replace calls: `await svg2vectordrawable(svg, opts)` → `convert(svg, opts).xml`.
4. Rename options: `fillBlack` → `fillBlackForUnfilled`. Decide on the defaults that changed:
   `floatPrecision` (2 → 3) and unfilled shapes (no fill → black).
5. Replace the file helper: `convertFile(input, output, options)` from
   `src/svg-file-to-vectordrawable-file` → `convertFile(input, output, options)` from the package root
   (synchronous, returns the warnings). Batches: `convertDir`.
6. Strict mode: replace message matching (`/Unsupported (element|attribute)/`) with
   `err instanceof ConversionError` / `err.warning.code`. Review which codes you actually want to fail
   on and set them with `rules`.
7. Surface warnings: log `warnings` (or pass `onWarn`) instead of discarding them; they are how
   approximations are reported outside strict mode.
8. CLI scripts: `s2v -i a.svg -o b.xml` → `svgvd a.svg -o b.xml`; `-f dir` → positional `dir`; `-x` →
   `--xml-tag`; `-t` → `--tint`; add `--android-names` where you relied on `s2v`'s renaming.
9. Regenerate committed drawables and golden files once, and review the diff visually: gradients with
   `gradientTransform`, shifted `viewBox`, Feather-style stroked icons and dashed strokes change on
   purpose.
10. If you build for Android below API 24: gradients (fill and stroke) are emitted through
    `<aapt:attr>`, which needs API 24+ (as with `svg2vectordrawable`).
