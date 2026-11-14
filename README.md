# svg-vectordrawable

[![npm version](https://img.shields.io/npm/v/svg-vectordrawable)](https://www.npmjs.com/package/svg-vectordrawable)
[![npm downloads](https://img.shields.io/npm/dm/svg-vectordrawable)](https://www.npmjs.com/package/svg-vectordrawable)
[![CI](https://github.com/IBRAHIMDANS/svg-vectordrawable/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/IBRAHIMDANS/svg-vectordrawable/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/IBRAHIMDANS/svg-vectordrawable/graph/badge.svg)](https://codecov.io/gh/IBRAHIMDANS/svg-vectordrawable)
[![types included](https://img.shields.io/npm/types/svg-vectordrawable)](https://www.npmjs.com/package/svg-vectordrawable)
[![license](https://img.shields.io/npm/l/svg-vectordrawable)](LICENSE)

Convert SVG to **Android VectorDrawable** XML — robustly, across SVGs from any editor.

Built on [svgo](https://github.com/svg/svgo) (v4) for parsing and normalization, with a hand‑written
walker that emits the VectorDrawable. Notably handles **gradients including `gradientTransform`**
(linear & radial), which the popular but unmaintained `svg2vectordrawable` gets wrong.

**[Try it online](https://ibrahimdans.github.io/svg-vectordrawable/)**: paste or drop an SVG, get the
XML, the warnings and a side-by-side preview, nothing to install.

![A radial gradient with gradientTransform: svg2vectordrawable moves it to the corner, svg-vectordrawable keeps it centered](https://raw.githubusercontent.com/IBRAHIMDANS/svg-vectordrawable/main/docs/assets/radial-gradient-comparison.png)

_Same SVG ([`radial-gradient-transform.svg`](test/fixtures/radial-gradient-transform.svg)), rendered
with resvg: the source, the `svg2vectordrawable` 2.9.1 output and the `svg-vectordrawable` output.
Regenerated at each release by [`docs/assets/generate-comparison.mjs`](docs/assets/generate-comparison.mjs)._

```sh
npm install svg-vectordrawable    # npm
pnpm add svg-vectordrawable       # pnpm
yarn add svg-vectordrawable       # Yarn
bun add svg-vectordrawable        # Bun
```

Add `-D` (`--save-dev` with npm) when you only use it at build time, through the CLI or a script. To run
the CLI once without installing anything:

```sh
npx -p svg-vectordrawable svgvd icon.svg                  # npm
pnpm --package=svg-vectordrawable dlx svgvd icon.svg      # pnpm
yarn dlx -p svg-vectordrawable svgvd icon.svg             # Yarn 2+ (Yarn 1 has no dlx: use npx)
bunx -p svg-vectordrawable svgvd icon.svg                 # Bun
```

Requires Node.js 20 or later (the browser builds run in any modern browser). The optional dependencies
below (`opentype.js`, `@resvg/resvg-js`) are added the same way with your package manager.

## Why another one?

`svg2vectordrawable` is unmaintained (last release 2022), depends on `svgo@^2.8`, and ignores
`gradientTransform` (Figma radial gradients render at the wrong place). This library is on
`svgo@4`, bakes `gradientTransform` into the Android coordinates, and **fails loud** instead of
emitting plausible‑but‑wrong output.

## Usage

```ts
import { convert } from 'svg-vectordrawable';

const { xml, warnings, minSdk } = convert(svgString, {
    optimize: true, // run svgo normalization first (recommended)
    currentColor: '#000', // value substituted for `currentColor`: a CSS color or an Android reference (see below)
    colorMap: { '#1A73E8': '@color/brand' }, // SVG colors → Android color references
    floatPrecision: 3,
    fillBlackForUnfilled: true, // unfilled paths get black (SVG default)
    xmlTag: false, // prepend <?xml ...?>
    tint: '#FFFFFFFF', // android:tint on <vector> (Android color literal)
    autoMirrored: false, // true: android:autoMirrored="true" (flipped in right-to-left layouts)
    width: 24, // android:width in dp (viewport unchanged); alone, the height follows the aspect ratio
    height: 24, // android:height in dp; both set with another ratio stretch the drawing
    strict: false, // true: throw on lossy and approximated output; 'lossy': only on lossy output
    minSdk: 21, // warn (`min-sdk-exceeded`) when the output needs more; below 24, evenodd fills become nonzero when possible
    preserveIds: false, // true: SVG ids → android:name (AnimatedVectorDrawable targets), see below
    rules: {}, // per-code severity, overrides `strict` (see below)
    onWarn: (w) => console.warn(w.code, w.message),
});
```

`convert` is synchronous and returns `{ xml, warnings, minSdk }`. `minSdk` is the Android API level the
output needs: 24 when it uses gradients or `fillType="evenOdd"`, otherwise 21. With a `minSdk` below 24, an
evenodd fill whose contours are nested or disjoint (a ring, a target) is rewritten as nonzero geometry without
`fillType`; crossing contours, or a stroke on an open subpath of the same path, keep it.

### Animation targets (`preserveIds`)

An `AnimatedVectorDrawable` targets `<path>` and `<group>` by `android:name`. With `preserveIds: true`
(CLI `--preserve-ids`), the `id` of a `<path>`, a basic shape or a `<g>` (also `<a>`, `<switch>`, a nested
`<svg>`) becomes its `android:name`, XML-escaped and otherwise as written:

- a named `<g>` is kept as a `<group>` even without a transform (a skew it cannot carry is baked into its
  content, the group stays);
- names are unique: an id met again (every `<use>` instance after the first, a duplicated id) is not
  emitted, nor are the ids the converter generates itself;
- the default svgo config keeps named elements separate and in place: `mergePaths`, `collapseGroups` and
  `moveGroupAttrsToElems` are turned off and ids are not minified (the output may hold a few more
  `<path>` / `<group>` than without the option). A custom `svgoConfig` is used as is: keep ids there
  yourself (`cleanupIds: { minify: false }`, and the plugins above off).
- not named: the `<group>` a `<path>` or shape `transform` becomes (the `id` names the `<path>` inside),
  the `<group>` of a `<use>` `x` / `y` / `transform` (its `id` is not used) and a `<clip-path>` (the
  `<clipPath>` `id` is not used either). `rotation`, `scaleX`, `translateX`… animate a `<group>` only:
  wrap the element in a `<g id>` to get a named one.

Off by default: the output is then unchanged.

### Theme colors (`currentColor` and `colorMap`)

`currentColor` also accepts an Android color reference, emitted as is in `android:fillColor` /
`android:strokeColor` so the icon follows the app theme (dark mode included): `?attr/colorOnSurface`,
`?android:attr/colorAccent`, `@color/icon`, `@android:color/white`, with an optional `package:`
prefix (`@com.example.lib:color/icon`). `colorMap` maps literal SVG colors to such references:

```ts
convert(svg, {
    currentColor: '?attr/colorOnSurface',
    colorMap: { '#1A73E8': '@color/brand', red: '?attr/colorError' },
});
```

- Keys are any CSS color, compared after normalization to `#AARRGGBB`: `#f00`, `red` and `rgb(255,0,0)`
  are the same key (two keys for one color with different references throw).
- A reference carries no alpha: `fill-opacity`, `stroke-opacity` and `opacity` go to `fillAlpha` /
  `strokeAlpha` as usual. The color's own alpha too: an exact `#AARRGGBB` key wins, otherwise an opaque
  key matches its color at any alpha, e.g. `rgba(26,115,232,0.5)` with the map above gives
  `@color/brand` and `android:fillAlpha="0.502"` (the reference's own alpha is multiplied by Android).
- Gradient stops (`<item android:color>`, checked with `aapt2 link`) get the reference when opaque. An
  `<item>` has no alpha, so a translucent stop keeps its literal color (black for a `currentColor`
  reference) and is reported as `unsupported-color-reference`.
- Only `currentColor` and `colorMap` produce references: a `fill="@color/x"` written in the SVG is not
  copied. A malformed reference (`?colorPrimary`, `@color/1x`, `@drawable/x`…) throws a `TypeError`.
- A fully transparent `currentColor` or `colorMap` key (`transparent`, `#0000`, alpha rounding to 0)
  throws a `TypeError` too. Eight hex digits are CSS `#RRGGBBAA`, so the Android black `#FF000000` is
  red at alpha 0 here: write `#000000`. A non-zero alpha stays CSS (`#FF1A73E8` is pink at alpha 0.91).
- The resources must exist in the app (`aapt2 link` fails on an unknown `@color/…` or `?attr/…`).
  `vectorDrawableToSvg` draws them in gray unless `colors` maps them (e.g. `{ '?attr/colorPrimary': '#6750A4' }`, Android `#AARRGGBB` literals); `onUnresolvedColor` reports the missing ones.

### Text (`fonts`)

A VectorDrawable has no text. With `fonts` (Node only; CLI `--font <family>=<file>`, repeatable), a simple
`<text>` is drawn as the outlines of its glyphs, a `<path>` painted like any shape (fill, stroke, opacity,
transform, clip):

```ts
convert(svg, {
    fonts: { Inter: 'fonts/Inter-Regular.ttf', 'Inter bold': 'fonts/Inter-Bold.ttf' },
});
```

- Keys are font-family names, matched case-insensitively; the first family of `font-family` found in
  `fonts` is used. Values are a TrueType / OpenType / WOFF file path, or its bytes (`Uint8Array`). A bold
  or italic text needs its own key: `"Inter bold"` (or `"Inter 700"`), `"Inter italic"`, `"Inter bold italic"`.
- It needs the optional peer dependency [opentype.js](https://github.com/opentypejs/opentype.js) (MIT, `npm install opentype.js`), loaded
  only when a `<text>` is drawn; when it is missing, each `<text>` is reported with the install command.
- Supported: one line of text at a single `x` / `y` (lengths or percentages), `font-size`, `font-family`,
  `font-weight` / `font-style` (by key), `text-anchor`, kerning, inherited properties, `<tspan>`s without
  attributes, and a first `<tspan>` carrying the position (as Figma exports text).
- Everything else keeps the `unsupported-element` warning, with the reason: no font for the family,
  `<textPath>`, positioned or styled `<tspan>`s (multi-line text), per-character `x` / `y`, `dx` / `dy` /
  `rotate` / `textLength`, non-zero `letter-spacing` / `word-spacing`, vertical or right-to-left text,
  baseline shifts, `text-decoration`, the `font` shorthand, scripts needing complex shaping (combining
  marks), a glyph missing from the font (no font fallback), color fonts.
- The text no longer follows the device font settings: it is geometry, at the size it was drawn. A
  `<text>` without `font-size` is 16 px (the CSS default; resvg uses 12).
- The browser builds do not include it: `fonts` throws a `TypeError` there.

### Preview

`vectorDrawableToSvg` turns a VectorDrawable back into SVG, to preview the result in a browser or a PR:

```ts
import { convert, vectorDrawableToSvg } from 'svg-vectordrawable';
const preview = vectorDrawableToSvg(convert(svg).xml, { density: 2, applyTint: true });
```

The CLI does the same for existing drawables with `--format svg` (`ic_back.xml` → `ic_back.svg`; a
directory is read for its `*.xml`). It takes no conversion option, and says on stderr what the SVG does
not carry over (a color reference drawn gray, `android:tint`, the `android:trimPath*` of a filled path;
that of a stroked path is drawn):

```sh
svgvd app/src/main/res/drawable/ic_back.xml --format svg -o preview/
```

### Warnings, errors and `rules`

Every construct that cannot be converted faithfully emits a warning with a stable `code` (listed in
the exported `WARNING_CODES`). Each code has a category (exported `WARNING_CATEGORIES`): **lossy**
(content lost or wrong), **approximation** (rendering slightly differs) or **info** (Android lint
style, API level). `strict: true` turns lossy and approximation warnings into errors, `strict: 'lossy'`
only lossy ones; info warnings are never raised by `strict`. `rules` sets the severity per code
(`'off' | 'warn' | 'error'`) and wins over `strict`. Errors are thrown as a
`ConversionError` carrying the offending `warning`, so you can fall back (e.g. to a PNG, which the
CLI does with [`--fallback-png`](#png-fallback)):

```ts
import { convert, ConversionError } from 'svg-vectordrawable';

try {
    // Reject anything lossy, but accept approximated group opacity.
    const { xml } = convert(svg, { strict: true, rules: { 'opacity-approximated': 'warn' } });
} catch (err) {
    if (err instanceof ConversionError) console.log('cannot convert:', err.warning.code);
    else throw err;
}
```

| Code                            | Meaning                                                                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported-element`           | `<text>`, `<image>`, `<foreignObject>`, `<switch>` — skipped                                                                                                                                                |
| `unsupported-attribute`         | non-clip `mask`, `filter`, `marker*`, `vector-effect`, `paint-order`, `arcs` joins — ignored                                                                                                                |
| `unsupported-stroke-dasharray`  | dash pattern that cannot be resolved (`em`/`ex` units) — drawn solid                                                                                                                                        |
| `unsupported-stroke-gradient`   | no longer emitted (gradient strokes are supported); kept for compatibility                                                                                                                                  |
| `unsupported-paint`             | `<pattern>` paint (fallback color, else not painted); unreadable `fill` / `stroke` / `stop-color`; context paint outside a `<use>` or from a gradient                                                       |
| `unsupported-color-reference`   | color reference (`currentColor` / `colorMap`) the output cannot carry: translucent gradient stop (literal kept), any reference in Compose output (drawn gray)                                               |
| `unsupported-style`             | CSS left in a `<style>` that could not be applied to elements — ignored                                                                                                                                     |
| `unsupported-clip-path`         | `objectBoundingBox` clip, evenodd clip with crossing contours, unconvertible content, CSS shape it cannot lay out (`inset(… round …)`, `path()`, painted stroke-box…)                                       |
| `gradient-approximated`         | radial focal point; elliptical radial on a path that also has a solid stroke; `linearRGB` needing over 64 stops or with a stop mapped to a reference; linear gradient with a degenerate `gradientTransform` |
| `opacity-approximated`          | opacity folded onto overlapping children / fill+stroke — overlaps look darker                                                                                                                               |
| `mask-approximated`             | `<mask>` with stroked content converted to a clip-path without the strokes                                                                                                                                  |
| `missing-gradient`              | `url(#id)` paint not painted: no fallback and pointing at nothing or at an invalid gradient; a gradient without stops (even with a fallback)                                                                |
| `missing-clip-path`             | `clip-path` pointing at nothing — ignored                                                                                                                                                                   |
| `group-skew`                    | skewed `<g>` baked into path geometry                                                                                                                                                                       |
| `gradient-under-skew`           | gradient placement under a baked skew is approximate                                                                                                                                                        |
| `gradient-bbox-unavailable`     | `objectBoundingBox` gradient without a measurable path box                                                                                                                                                  |
| `empty-path`                    | shape without geometry — skipped                                                                                                                                                                            |
| `min-sdk-exceeded` (info)       | the output needs a higher API level than the `minSdk` option                                                                                                                                                |
| `large-vector` (info)           | `android:width`/`height` above 200 dp (Android lint `VectorRaster`)                                                                                                                                         |
| `long-path-data` (info, off)    | a `pathData` longer than 800 characters (lint `VectorPath`); enable it with `rules`                                                                                                                         |
| `invalid-path-data` (info, off) | a `<path>` `d` with a typo after a valid start, drawn up to its last valid segment as browsers do; enable it with `rules`                                                                                   |

Node file helpers:

```ts
import { convertFile, convertDir } from 'svg-vectordrawable';
convertFile('icon.svg', 'res/drawable/icon.xml');
convertDir('svg/', 'res/drawable/');
convertDir('svg/', 'res/drawable/', {}, { androidNames: true }); // valid Android resource names
```

### CLI

```
svgvd icon.svg                 # writes icon.xml next to it
svgvd icons/ -o out/           # batch a directory
svgvd icon.svg --stdout        # print to stdout
svgvd -s '<svg>…</svg>'        # convert an inline SVG string
svgvd icon.svg --xml-tag --tint '#FFFFFFFF'
svgvd icon.svg --current-color '?attr/colorOnSurface' --color-map '#1A73E8=@color/brand'   # theme colors (repeatable map)
svgvd icon.svg --strict        # fail on anything not representable
svgvd icon.svg --strict --rule opacity-approximated=warn   # per-code severity
svgvd icon.svg --strict=lossy  # fail only when content would be lost
svgvd icon.svg --min-sdk 21    # warn when the output needs a higher API level
svgvd arrow.svg --auto-mirrored --width 24   # RTL mirroring, 24dp wide (height follows the ratio)
svgvd icon.svg --preserve-ids  # SVG ids → android:name (AnimatedVectorDrawable targets)
svgvd logo.svg --font 'Inter=fonts/Inter-Regular.ttf'   # <text> as glyph outlines (repeatable, see Text)
svgvd icons/ -o res/drawable/ --android-names   # Arrow-Left.svg → arrow_left.xml (valid resource names)
cat icon.svg | svgvd > icon.xml   # stdin → stdout (also `svgvd -`, or `svgvd - -o icon.xml`)
svgvd icons/ -r -o out/        # recursive: icons/a/b.svg → out/a/b.xml
svgvd icons/ -o out/ --json    # JSON report on stdout, for CI (see below)
svgvd icons/ -r --dry-run      # convert and report, write nothing
svgvd icons/ -o res/drawable --strict --fallback-png all   # PNGs for what cannot be a vector
svgvd icons/ -r -o out/ --watch   # convert, then reconvert on every save (Ctrl+C to stop)
```

`--json` prints one entry per file, `[{ input, output, warnings, minSdk, error, fallback }]`, and nothing else on
stdout (human-readable lines stay on stderr). Each warning carries its `code` and `category`
(`lossy`, `approximation`, `info`); `error` is `null` or `{ message, code?, category? }` (`code` when a
warning was escalated by `--strict` / `--rule`). The XML then has to go to files: `--json` is refused
with `--stdout`, or with stdin / `-s` without `-o file.xml`, unless `--dry-run`. The exit code is 1
when any file fails, as without `--json`. `fallback` is `null`, or `{ outputs, reason }` for a file
rendered to PNG (below): `output` is then `null`, and `reason` is the warning that rejected it.

Two inputs that would be written to the same file (`a.svg` and `a.SVG`, or `x/a.svg` and `y/a.svg`
with one `-o` directory) fail before anything is written, with exit code 1. With `--recursive` and
`--android-names`, the outputs are written flat into `-o` (an Android resource directory has no
subdirectories) and a name collision across subdirectories fails the same way. Symbolic links to directories are not followed. Without an input argument, `svgvd` reads
stdin only when it is not a terminal, and prints the help when nothing is piped.

`--watch` (`-w`) converts everything once, then keeps watching the inputs, for projects without a build
plugin: an added or changed SVG is converted again (shortly after the last write, since editors save in
several steps), the XML (and fallback PNGs) of a removed one is deleted, and a conversion error is
reported without stopping the watch. A file whose output is taken by another one (same name, or same
resource name with `--android-names`) is not written until the collision is resolved. An input
directory that is removed (or the directory of an input file) is reported and no longer watched, even
if it comes back; when no input is left, the watch stops with exit code 1. It needs files or directories (not stdin
or `-s`), cannot be combined with `--stdout`, `--json` or `--dry-run`, and with `-r` it needs Linux
(recursive `fs.watch`). Ctrl+C stops it with exit code 0.

#### PNG fallback

`<filter>`, `<text>`, a gradient `<mask>`… will never be a VectorDrawable. With `--fallback-png <densities>`,
a file that the conversion **rejects** (`--strict`, `--strict=lossy` or `--rule <code>=error`) is
rendered to PNG instead, one per density bucket, and its XML is not written:

```
svgvd icons/ -o app/src/main/res/drawable --android-names --strict --fallback-png all
# blur.svg → res/drawable-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/blur.png, the others → res/drawable/*.xml
```

The XML and the PNGs replace each other: a fallback deletes the XML an earlier run left, a file that
converts again deletes its PNGs, and the PNGs of densities not asked for this time are deleted
(reported on stderr; `--dry-run` deletes nothing).

`<densities>` is `all` or a comma list of `mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi` (1×, 1.5×, 2×, 3×, 4×). The
PNG has the size the `<vector>` would have had in dp (`--width` / `--height` included) times the
density, rendered by [resvg](https://github.com/linebender/resvg). It goes to `drawable-<density>/` in
the directory of the XML, or beside it when that directory is named `drawable`. A file that converts,
even with warnings, never gets a PNG; an invalid SVG still fails. The renderer is an optional
dependency, loaded only when a fallback is needed: `npm install @resvg/resvg-js`.

The same renderer is exported by the Node API (ESM and CommonJS, not the browser builds):

```ts
import { convert, ConversionError, renderFallbackPng, DENSITIES, type Density } from 'svg-vectordrawable';

try {
    writeFileSync('res/drawable/blur.xml', convert(svg, { strict: true }).xml);
} catch (err) {
    if (!(err instanceof ConversionError)) throw err;
    for (const density of Object.keys(DENSITIES) as Density[])
        writeFileSync(`res/drawable-${density}/blur.png`, renderFallbackPng(svg, { density }));
}
```

`renderFallbackPng(svg, { density, width, height })` returns a PNG `Buffer`: `density` is one of the
`DENSITIES` keys (default `'mdpi'`), `width` / `height` are in dp as for `convert`. It throws on an
invalid SVG or option, and with a one-line `npm install @resvg/resvg-js` message when the renderer is
not installed.

### Android Studio / IntelliJ (External Tools)

No plugin needed: an External Tool adds a right-click **Convert to VectorDrawable** action on a `.svg` file or a
folder, using the CLI installed in the project (`npm install --save-dev svg-vectordrawable`).

In **Settings → Tools → External Tools**, add a tool:

| Field             | Value                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Name              | `Convert to VectorDrawable`                                                                       |
| Program           | `npx` (`npx.cmd` on Windows)                                                                      |
| Arguments         | `--no-install svgvd "$FilePath$" -o "$ProjectFileDir$/app/src/main/res/drawable" --android-names` |
| Working directory | `$ProjectFileDir$`                                                                                |

Right-click an SVG (or a folder of SVGs) → **External Tools → Convert to VectorDrawable**: the drawable is written
to `res/drawable` under a valid resource name (`Arrow-Left.svg` → `arrow_left.xml`), and the warnings show in the
Run console. Add `--strict` to fail on anything not representable, or any other [CLI option](#cli); adjust the
`-o` path to your module. A shortcut can be bound in **Settings → Keymap → External Tools**. To convert at build
time instead, use the [Gradle plugin](integrations/gradle-plugin).

### Jetpack Compose (`ImageVector`)

`toImageVector` writes a Kotlin file declaring a Compose `ImageVector` instead of the XML. It takes the
options of `convert` (same warnings, `strict` and `rules`) plus `name` and `packageName`:

```ts
import { toImageVector } from 'svg-vectordrawable';
const { kotlin, name, warnings } = toImageVector(svg, { name: 'arrow-back', packageName: 'com.example.icons' });
// name === 'ArrowBack'; kotlin declares `val ArrowBack: ImageVector by lazy { ImageVector.Builder(…)…build() }`
```

```sh
svgvd icons/ -o app/src/main/java/com/example/icons --format compose --package com.example.icons
# arrow-left.svg → ArrowLeft.kt (val ArrowLeft), flat, fails if two files get the same name
```

The output uses `path(fill = SolidColor(…) / Brush.linearGradient(…) / Brush.radialGradient(…), …,
pathFillType = PathFillType.EvenOdd) { moveTo(…) … }`, `group(rotate, pivotX, …, translationY)` and
`group(clipPathData = PathData { … })` for clips. `name` becomes a PascalCase Kotlin identifier
(`Icon` prefix before a leading digit). An `ImageVector` has no app resources: a color reference from
`currentColor` / `colorMap` is drawn gray (`#FF808080`) with an `unsupported-color-reference` warning
(an error under `strict`); tint the `Icon` where it is drawn instead. A root `opacity` is folded into the path
alphas (`opacity-approximated` when several paints may overlap). `indent`, `xmlTag` and `minSdk` do
not apply (`--min-sdk`, `--xml-tag` and `--fallback-png` are rejected with `--format compose`).

An existing VectorDrawable converts too, whatever tool wrote it: `vectorDrawableToImageVector(xml,
{ name, packageName })`, or an `.xml` file (stdin, `-s`) given to `--format compose`. It is serialized as
is (the SVG conversion options do not apply), `android:trimPath*` included; an attribute with no
`ImageVector` equivalent here (`android:tintMode`…) is reported with `unsupported-attribute`.

```sh
svgvd app/src/main/res/drawable/ic_*.xml -o app/src/main/java/com/example/icons --format compose --package com.example.icons
```

### Browser

A browser build (svgo's browser bundle, no Node built-ins) is published under the `./browser`
subpath:

```ts
import { convert } from 'svg-vectordrawable/browser';
const { xml } = convert(svgString);
```

`svg-vectordrawable/browser-lite` is the same API without svgo (157 KB instead of 702 KB for the minified
IIFE build, 58 KB instead of 217 KB gzipped): conversion always runs with `optimize: false`, so `<style>` CSS is not inlined and
shapes are converted as authored. The [online playground](https://ibrahimdans.github.io/svg-vectordrawable/)
runs on this build, so its output can differ from the CLI on SVGs that rely on `<style>`.

Both browser entries are ESM only: `require('svg-vectordrawable/browser')` fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED`, so CommonJS code uses `import()` or the main entry.

## What it handles

| Feature                                                                                                                                                   | Status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Paths, `fill`, `stroke` (width/cap/join/miter), `fill-rule` → `fillType`                                                                                  | ✅     |
| Shapes (`rect`/`circle`/`ellipse`/`line`/`poly*`) → path                                                                                                  | ✅     |
| Colors: `#rgb[a]`, `#rrggbb[aa]`, `rgb()/rgba()`, `hsl()/hsla()`, named, `currentColor`                                                                   | ✅     |
| Attribute inheritance (incl. presentation attrs on the `<svg>` root and `<g>`)                                                                            | ✅     |
| Inline `style="…"` and `<style>` (via svgo)                                                                                                               | ✅     |
| Linear & radial **gradients**, `gradientTransform`, **`objectBoundingBox`** (via path bbox), `href` sharing, `spreadMethod` → `tileMode`                  | ✅     |
| `<g transform>` → `<group>` (translate/rotate/scale); **skew/shear baked into geometry**                                                                  | ✅     |
| **`<use>` / `<symbol>`** references — inlined before conversion                                                                                           | ✅     |
| `clip-path` → `<clip-path>` (on shapes and `<g>`, incl. `<use>` / transformed clip content)                                                               | ✅     |
| `opacity` folded into `fillAlpha`/`strokeAlpha` (root `<svg>` opacity → exact `android:alpha`)                                                            | ✅     |
| `viewBox` origin, `preserveAspectRatio` (meet / slice / none), nested `<svg>`, `<a>`, `display` / `visibility`, units (`px`/`in`/`cm`/`mm`/`pt`/`pc`/`%`) | ✅     |

## Known limitations

A VectorDrawable simply cannot represent some SVG features. These are **warned** (or throw in
`strict` mode), never silently mis‑rendered:

- `<filter>`, `<pattern>`, `<image>` — not representable (the CLI can render such files to
  PNG: [`--fallback-png`](#png-fallback)). `<text>` has no VectorDrawable equivalent either: a simple
  single-line text is converted to glyph outlines with the [`fonts` option](#text-fonts), any other text
  (or text without a matching font) stays warned (`unsupported-element`). A `<mask>` is converted to a `<clip-path>` when its content has
  one uniform value (luminance × alpha, or alpha with `mask-type: alpha`): opaque white is a plain clip, a gray or
  translucent value adds an opacity. Nested masks that are each exact are intersected, and a white rectangle
  with opaque black shapes inside it (Figma "outside stroke" masks) becomes a clip with those shapes cut out.
  Stroked content is kept without its strokes (`mask-approximated`: a `<clip-path>` has no stroke); any other
  mask (non-uniform values, gradient, strokes only…) is warned with the reason.
- `stroke-dasharray` in font-relative units (`em`, `ex`) — the stroke is drawn solid. Other dash
  patterns are baked into the path geometry (VectorDrawable has no native dashes).
- Radial gradients are circles in VectorDrawable. Elliptical radials (non-uniform `gradientTransform`,
  `objectBoundingBox` on a non-square shape) are made exact by drawing the fill inside a `<group>`
  carrying the ellipse's deformation; they stay approximated only when the same path also has a solid
  stroke (it would be distorted). Focal points (`fx`/`fy`) are approximated (`gradient-approximated`).
- CSS that svgo cannot inline (`@media`, `:hover`, complex selectors) — `unsupported-style`.
- `gradientUnits="objectBoundingBox"` is resolved from the path's bounding box; only when that box
  is unavailable does it fall back to the viewport (with a warning).
- `filter`, `marker-*`, non-clip `mask` references and `clipPathUnits="objectBoundingBox"` — warned, not applied.
- Group `opacity` has no VectorDrawable equivalent: it is folded onto each child, which is exact only
  when the children do not overlap (`opacity-approximated` otherwise).

Limits of the converter itself, some of them **not warned**:

- A `transform` on the root `<svg>`, attribute or CSS (`style="transform: rotate(90deg)"`, units
  required as in any CSS), is applied, but the content stays clipped to the untransformed viewport (a
  browser moves the whole box).
- A custom `svgoConfig` is used as is: the raw `preset-default` moves or bakes transforms without reading
  a CSS `transform` / `translate` / `rotate` / `scale` / `transform-origin`, so such groups can render
  wrong (`unsupported-style`, naming the plugins to disable). The default config and `optimize: false` handle them.
- CLI without an input argument: stdin is read whenever it is not a TTY, so a pipe that is never closed
  (`docker run -i`) waits instead of printing the help.
- `clip-path: polygon(evenodd, …)` whose contours touch (a keyhole) stays nonzero, with `unsupported-clip-path`.
- Unitless lengths are accepted in CSS `clip-path` shapes, where a browser drops the declaration (no warning).
- A unitless shape geometry property in CSS (`style="width:50"`, `r:10`; also `x`, `y`, `height`, `cx`, `cy`,
  `rx`, `ry`) is applied over the attribute, as Chrome does; Firefox and the CSS grammar (unitless numbers
  are valid for `0` only) keep the attribute (no warning).
- With `optimize: true`, the time grows with the square of the number of sibling elements (svgo 4.1 checks
  each element against its parent's children, once per plugin): 40,000 shapes side by side take about 17 s,
  against 1.5 s with `optimize: false`. Wrapping them in `<g>`s of 100 brings it down to about 7 s.

## Robustness

- **Icon corpus in CI** (`scripts/corpus.mjs`): 9,251 icons (Feather, Bootstrap Icons, Heroicons,
  Tabler, pinned versions) converted with and without svgo on every push — zero exceptions, zero
  warnings required.
- **Android toolchain**: the fixtures (gradients, `gradientTransform`, `objectBoundingBox`, `<use>`,
  sheared groups, clip-path, nested transforms) are **compiled and linked with `aapt2`** against
  `android.jar`, so attribute names and values are validated, not just XML well-formedness.
- **Visual regression**: every fixture is rendered with resvg next to its VectorDrawable and must match
  within 1% of inked pixels (`pnpm test:visual`).
- **Android's own renderer**: the generated VectorDrawables are drawn by layoutlib (Android's Skia/hwui,
  through Paparazzi on the JVM) and compared with the source SVG (`pnpm run validate:android`; needs the
  Android SDK and runs on a JDK 21 toolchain, which Gradle downloads when none is installed).
- **Golden snapshots** lock the exact XML against regressions.

## Documentation

- [Migrating from `svg2vectordrawable`](docs/migration-from-svg2vectordrawable.md)
- [Integrations](docs/integrations.md) (Node scripts, React Native icons, Gradle, Vite/webpack, CI)
- Build plugins / MCP server: [Gradle plugin](integrations/gradle-plugin/README.md), [Vite plugin](integrations/vite-plugin/README.md), [MCP server](integrations/mcp-server/README.md), [Figma plugin](integrations/figma-plugin/README.md) (Gradle, Vite and MCP published; the Figma plugin not yet; [overview](docs/integrations.md#plugins-and-mcp-server))
- [Comparison with `svg2vectordrawable` and Android Studio's Svg2Vector](docs/comparison.md)

## Questions and feedback

Questions, ideas and conversion results are welcome in
[GitHub Discussions](https://github.com/IBRAHIMDANS/svg-vectordrawable/discussions) (Q&A, Ideas, Show and tell).
For a bug, [open an issue](https://github.com/IBRAHIMDANS/svg-vectordrawable/issues) with the SVG that converts
wrongly.

## License

MIT
