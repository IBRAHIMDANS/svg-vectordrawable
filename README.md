# svg-vectordrawable

Convert SVG to **Android VectorDrawable** XML — robustly, across SVGs from any editor.

Built on [svgo](https://github.com/svg/svgo) (v4) for parsing and normalization, with a hand‑written
walker that emits the VectorDrawable. Notably handles **gradients including `gradientTransform`**
(linear & radial), which the popular but unmaintained `svg2vectordrawable` gets wrong.

```
npm i svg-vectordrawable
```

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
    currentColor: '#000', // value substituted for `currentColor`
    floatPrecision: 3,
    fillBlackForUnfilled: true, // unfilled paths get black (SVG default)
    xmlTag: false, // prepend <?xml ...?>
    tint: '#FFFFFFFF', // android:tint on <vector> (Android color literal)
    strict: false, // true: throw on lossy and approximated output; 'lossy': only on lossy output
    minSdk: 21, // warn (`min-sdk-exceeded`) when the output needs a higher API level
    rules: {}, // per-code severity, overrides `strict` (see below)
    onWarn: (w) => console.warn(w.code, w.message),
});
```

`convert` is synchronous and returns `{ xml, warnings, minSdk }`. `minSdk` is the Android API level the
output needs: 24 when it uses gradients or `fillType="evenOdd"`, otherwise 21.

### Preview

`vectorDrawableToSvg` turns a VectorDrawable back into SVG, to preview the result in a browser or a PR:

```ts
import { convert, vectorDrawableToSvg } from 'svg-vectordrawable';
const preview = vectorDrawableToSvg(convert(svg).xml, { density: 2, applyTint: true });
```

### Warnings, errors and `rules`

Every construct that cannot be converted faithfully emits a warning with a stable `code` (listed in
the exported `WARNING_CODES`). Each code has a category (exported `WARNING_CATEGORIES`): **lossy**
(content lost or wrong), **approximation** (rendering slightly differs) or **info** (Android lint
style, API level). `strict: true` turns lossy and approximation warnings into errors, `strict: 'lossy'`
only lossy ones; info warnings are never raised by `strict`. `rules` sets the severity per code
(`'off' | 'warn' | 'error'`) and wins over `strict`. Errors are thrown as a
`ConversionError` carrying the offending `warning`, so you can fall back (e.g. to a PNG):

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

| Code                           | Meaning                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `unsupported-element`          | `<text>`, `<image>`, `<foreignObject>`, `<switch>` — skipped                                 |
| `unsupported-attribute`        | non-clip `mask`, `filter`, `marker*`, `vector-effect`, `paint-order`, `arcs` joins — ignored |
| `unsupported-stroke-dasharray` | dash pattern that cannot be resolved (`em`/`ex` units) — drawn solid                         |
| `unsupported-stroke-gradient`  | no longer emitted (gradient strokes are supported); kept for compatibility                   |
| `unsupported-paint`            | `<pattern>` paint — fallback color or black                                                  |
| `unsupported-style`            | CSS left in a `<style>` that could not be applied to elements — ignored                      |
| `unsupported-clip-path`        | `objectBoundingBox` clip, evenodd clip with crossing contours, unconvertible content         |
| `gradient-approximated`        | radial focal point; elliptical radial on a path that also has a solid stroke                 |
| `opacity-approximated`         | opacity folded onto overlapping children / fill+stroke — overlaps look darker                |
| `missing-gradient`             | `url(#id)` paint pointing at nothing, no fallback — black                                    |
| `missing-clip-path`            | `clip-path` pointing at nothing — ignored                                                    |
| `group-skew`                   | skewed `<g>` baked into path geometry                                                        |
| `gradient-under-skew`          | gradient placement under a baked skew is approximate                                         |
| `gradient-bbox-unavailable`    | `objectBoundingBox` gradient without a measurable path box                                   |
| `empty-path`                   | shape without geometry — skipped                                                             |
| `min-sdk-exceeded` (info)      | the output needs a higher API level than the `minSdk` option                                 |
| `large-vector` (info)          | `android:width`/`height` above 200 dp (Android lint `VectorRaster`)                          |
| `long-path-data` (info, off)   | a `pathData` longer than 800 characters (lint `VectorPath`); enable it with `rules`          |

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
svgvd icon.svg --strict        # fail on anything not representable
svgvd icon.svg --strict --rule opacity-approximated=warn   # per-code severity
svgvd icon.svg --strict=lossy  # fail only when content would be lost
svgvd icon.svg --min-sdk 21    # warn when the output needs a higher API level
svgvd icons/ -o res/drawable/ --android-names   # Arrow-Left.svg → arrow_left.xml (valid resource names)
```

### Browser

A browser build (svgo's browser bundle, no Node built-ins) is published under the `./browser`
subpath:

```ts
import { convert } from 'svg-vectordrawable/browser';
const { xml } = convert(svgString);
```

`svg-vectordrawable/browser-lite` is the same API without svgo (116 KB instead of 1.1 MB for the
IIFE build): conversion always runs with `optimize: false`, so `<style>` CSS is not inlined and
shapes are converted as authored.

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

- `<filter>`, `<pattern>`, `<image>`, `<text>` — not representable. A `<mask>` is converted to a
  `<clip-path>` when it is clip-equivalent (opaque white content, or opaque content with `mask-type: alpha`);
  any other mask (gray, translucent, stroked, gradient…) is warned with the reason.
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
  through Paparazzi on the JVM) and compared with the source SVG (`pnpm run validate:android`; needs a
  full JDK 17+ and the Android SDK).
- **Golden snapshots** lock the exact XML against regressions.

## Documentation

- [Migrating from `svg2vectordrawable`](docs/migration-from-svg2vectordrawable.md)
- [Integrations](docs/integrations.md) (Node scripts, React Native icons, Gradle, Vite/webpack, CI)
- [Comparison with `svg2vectordrawable` and Android Studio's Svg2Vector](docs/comparison.md)

## License

MIT
