# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-06

### Added

- `rules` option: per-warning-code severity (`'off' | 'warn' | 'error'`), overriding `strict` — e.g. `{ strict: true, rules: { 'opacity-approximated': 'warn' } }`. Unknown codes throw a `TypeError`.
- `ConversionError` (exported): thrown on an `'error'` severity, carries the offending `warning`.
- `WARNING_CODES` (exported) and the `WarningCode` / `Severity` types; `Warning.code` is now typed as `WarningCode`.
- CLI `--rule <code>=<off|warn|error>` (repeatable).
- `opacity-approximated` warning when `opacity` is folded onto overlapping children, or onto a path painted with both fill and stroke.
- `unsupported-paint` warning for `<pattern>` fills/strokes (previously reported as `missing-gradient`).
- Nested `<svg>` elements are converted (translate + viewBox scale + `preserveAspectRatio` + clip to their viewport, unless `overflow="visible"`), instead of their content being dropped.
- `<a>` is treated like `<g>` instead of its content being dropped.
- `result.minSdk` (24 when the output uses gradients or `fillType="evenOdd"`, else 21) and a `minSdk` option warning with `min-sdk-exceeded` when the output needs more; CLI `--min-sdk <n>`.
- Android-lint-style info warnings: `large-vector` (width/height above 200 dp, on by default) and `long-path-data` (`pathData` over 800 characters, off by default: it would fire on 525 of the 18,502 corpus conversions).
- Warning categories (`WARNING_CATEGORIES`: `lossy`, `approximation`, `info`) and `strict: 'lossy'` (errors only when content would be lost); CLI `--strict=lossy`. `strict: true` keeps raising every previously existing code; `info` codes are never raised by `strict`.
- `svg-vectordrawable/browser-lite`: a browser build without svgo (small built-in XML parser), 116 KB instead of 1.11 MB for the IIFE (33 KB vs 241 KB gzipped). Conversion always runs with `optimize: false` (output identical to the main entry with `optimize: false`); `optimize: true` throws a `TypeError`.
- `vectorDrawableToSvg(xml, { density, applyTint })` (exported, Node and browser): re-serializes a VectorDrawable into an equivalent SVG for previews and reviews; dependency-free, independent from the converter. Options: dp→px density, `android:tint` applied as an SVG filter (`src_in`, `src_atop`, `src_over`, `multiply`, `screen`, `add`).
- **`clip-rule="evenodd"` clips**: a VectorDrawable `<clip-path>` is always nonzero, so an evenodd clip whose contours are nested or disjoint (rings, holes, targets) is rewritten into the same region under nonzero by orienting each contour by nesting depth (exact signed areas, conservative crossing test). `clip-rule` is now inherited from `<clipPath>` and groups. Crossing contours keep the `unsupported-clip-path` warning. Verified at 0.07% on Android's renderer (Svg2Vector: 29%).
- **Masks that are clips**: a `<mask>` whose content renders as opaque white (luminance) or opaque (`mask-type: alpha`, e.g. Figma's `#D9D9D9`) becomes a `<clip-path>`, on paths and groups, with transforms, `<use>`, `maskContentUnits="objectBoundingBox"` and the mask region (extra clip when it cuts the content); combined with the element's own `clip-path`. Other masks keep `unsupported-attribute`, now with the reason. Verified at 0.03% on Android's renderer.
- **Exact elliptical radial gradients**: a radial whose effective matrix is not a similarity (Figma's `scale(sx sy)` `gradientTransform`, `objectBoundingBox` on a non-square shape, skew) is emitted inside a `<group>` carrying the ellipse's deformation (closed-form SVD), with the path geometry inverse-transformed and a circular gradient in local space. Verified at 0.00% mismatch with both resvg and Android's renderer. Still approximated (`gradient-approximated`): focal points, and an elliptical fill on a path that also has a solid stroke.
- **Dashed strokes**: `stroke-dasharray` / `stroke-dashoffset` (both inherited) and `pathLength` are baked into the stroke geometry (one sub-path per dash; lines cut exactly, curves cut at arc-length parameters into exact sub-curves). The dashed issue #1 logo renders within 0.22% of its source; in `strict` mode its remaining warning is `opacity-approximated` (overlapping children under `<g opacity>`), which `rules: { 'opacity-approximated': 'warn' }` accepts. A filled and dashed path becomes two paths (fill, then stroke, honoring `paint-order`). `unsupported-stroke-dasharray` remains for patterns that cannot be resolved (font-relative units). With the default svgo config, circles and ellipses stay elements when `stroke-dasharray` appears, so their dashes start where SVG specifies.
- **Gradient strokes**: `stroke="url(#gradient)"` is emitted as `<aapt:attr name="android:strokeColor">` (API 24+) instead of being dropped; a path can carry both a fill and a stroke gradient. `unsupported-stroke-gradient` is no longer emitted (the code stays exported).
- `gradient-approximated` warning: radial focal points (`fx`/`fy`), and elliptical radials on a path that also has a solid stroke — the cases VectorDrawable cannot represent exactly (other elliptical radials are exact, see below).
- `unsupported-style` warning when CSS in a `<style>` element could not be applied (`optimize: false`, `@media`, `:hover`, complex selectors).
- `unsupported-attribute` now also covers `vector-effect`, `paint-order` (stroke under fill) and `stroke-linejoin="arcs"/"miter-clip"`.
- `<use>` of a `<symbol viewBox>` is scaled into its viewport (`width`/`height`, `preserveAspectRatio`) and clipped to it.
- `androidResourceName()` (exported), CLI `--android-names` and a 4th `{ androidNames }` parameter on `convertFile` / `convertDir`: output names become valid Android resource names (`Arrow-Left.svg` → `arrow_left.xml`); colliding names fail the batch before anything is written. `FileNamingOptions` type exported.
- Dedicated `dist/browser.d.ts`: the `./browser` subpath no longer advertises the Node-only `convertFile` / `convertDir`.

### Changed

- Large inputs: svgo's quadratic `mergePaths` is skipped above 500 drawable elements with the default config (10,000 paths: 24.6 s → under 2 s). Such files keep one `<path>` per source element; a custom `svgoConfig` is never altered.
- Drawables that paint nothing (no visible fill and no visible stroke, e.g. Tabler's `fill="none" stroke="none"` bounding box) are dropped, with groups left empty: −5.2% output size on the icon corpus. Raw pathData is rounded to `floatPrecision` with `optimize: false` (other formatting kept byte-identical).
- Internal: `convert.ts` split into focused modules (`render`, `paint`, `viewport`, `clip`, `inherited`, `groupOpacity`, …); output verified byte-identical on 56,651 conversions.

- CI and releases use pnpm (`pnpm install --frozen-lockfile`); `package-lock.json` removed. Publishing still uses the npm CLI (OIDC trusted publishing, provenance).
- Android rendering check (`android-render/`, `pnpm run validate:android`, CI job): the generated VectorDrawables are rendered by layoutlib (Android's Skia/hwui via Paparazzi) and compared with resvg's render of the source SVG; all fixtures and Android-specific probes (single-stop gradients, clamped offsets, gradient strokes, normalized arc flags, evenOdd, baked dashes) match within 0.11%.
- Visual regression harness (`test/visual/`, `pnpm test:visual`): each fixture is rendered with resvg next to its VectorDrawable re-serialized to SVG, and must match within 1% of inked pixels; `test/visual/run-corpus.ts` runs it over an icon set.
- `pnpm run validate` (build + `aapt2` + corpus) and `packageManager: pnpm@12.9.1`.
- Validation: `aapt2 link` against `android.jar` in addition to `compile`; a pinned 9,251-icon corpus runs in CI; Node 20/22 test matrix plus a Node 18 runtime smoke test (the dev toolchain requires Node ≥ 20).

- `opacity` on the root `<svg>` maps to `android:alpha` on the `<vector>` (exact) instead of being folded into each path.
- Unreferenced `<mask>`, `<filter>`, `<pattern>` and `<marker>` definitions no longer warn (they are never rendered); references to them do.
- `pathBBox` is now the tight geometric box (exact curve extrema, arcs included), as SVG defines `objectBoundingBox`.
- Emitted `android:pathData` always separates elliptical-arc flags (`a2 2 0 0 1-2-2` → `a2 2 0 0 1 -2-2`, `0120` → `0 1 20`), so Android's `PathParser` never sees compact flags. Output changes for most arc-bearing icons; geometry is identical.
- Shape attributes and lengths are parsed strictly: an invalid value such as `10abc` is ignored (as browsers do) instead of being read as `10`. Generated shape coordinates are rounded to `floatPrecision` (no more `0.49999999999999994`).
- The CLI is built as ESM only (`dist/cli.cjs` and `dist/cli.d.*` are no longer published; the `bin` is unchanged).

### Fixed

- Honor a non-zero `viewBox` origin (e.g. `viewBox="-54 -54 208 208"`): content is translated back into the viewport instead of rendering shifted (#1).
- Apply `clip-path` set on a `<g>` to the whole group instead of silently dropping it (#1).
- Resolve `<clipPath>` content made of `<use>`, nested groups and transformed children; warn on `clipPathUnits="objectBoundingBox"`, `clip-rule="evenodd"` and unconvertible clip children.
- Detect `stroke-dasharray` inherited from a parent `<g>` (previously only checked on the element itself), so `strict` mode throws (#1).
- Warn (or throw in `strict`) on `mask`, `filter` and `marker*` references instead of silently ignoring them (`unsupported-attribute`).
- Apply a `transform` set directly on a `<path>`/shape (previously ignored with `optimize: false`).
- Skip elements with `display="none"` instead of drawing them.
- Skip drawables with `visibility="hidden"`/`"collapse"` (inherited, overridable by a child).
- `objectBoundingBox` gradients on circles/ellipses/arcs: the box used to collapse to the arc endpoints (e.g. a degenerate gradient on an svgo-optimized `<circle>`).
- Honor `preserveAspectRatio` (default `xMidYMid meet`, plus `slice` and `none`) when `width`/`height` and `viewBox` ratios differ, instead of stretching.
- Percentage `width`/`height` (e.g. `100%`) fall back to the `viewBox` size instead of becoming `100dp`.
- Paint fallback colors (`fill="url(#missing) red"`) and quoted `url('#id')` references.
- Compact elliptical-arc flags (`a10 10 0 0120 0`, valid SVG) are parsed correctly: baked (skewed) paths, transformed clips and `objectBoundingBox` gradients no longer destroy or collapse the geometry with `optimize: false`.
- Gradient stops read `stop-color` / `stop-opacity` / `offset` from inline `style` too (Illustrator / Inkscape output rendered black before); offsets are clamped to `[0, 1]` and made monotonic as in SVG; a single-stop gradient renders as a solid color.
- Percentages and units: `opacity` / `fill-opacity` / `stroke-opacity` in `%` (stayed opaque before), root `width`/`height` in `in`/`cm`/`mm`/`pt`/`pc` (`2in` became `2dp`), `stroke-width` and shape attributes in `%` (relative to the viewport).
- Linear gradients under a non-conformal `gradientTransform` (skew, non-uniform scale) are now exact: isolines are sheared as in SVG instead of only the endpoints being mapped.
- Smooth cubic segments (`c…s…`) are no longer distorted with `optimize: true`: svgo 4.1's `convertPathData.convertToQ` mis-reflected the control point of an `s` following a cubic rewritten as `q` (found by the visual harness on Tabler `ripple`/`network`); that conversion is now disabled in the default config.
- Radial gradients in `objectBoundingBox` units: `r` percentages (incl. the default `50%`) are resolved against a normalized diagonal of 1, not √2/2 — default radials were ~29% too small.
- Unsupported-attribute warnings are no longer emitted twice for an element with a `transform`.
- `inherit` keeps the parent value (`fill="inherit"` made paths invisible with `optimize: false`).
- `stroke-width` is scaled when a skewed transform is baked into the geometry.
- `tint` is XML-escaped.
- CLI: the output directory is created when missing (`svgvd dir/ -o out/` failed with `ENOENT`); `icon.SVG` produces `icon.xml` instead of `icon.SVG.xml` (also in `convertDir`).

## [0.1.1]

### Changed

- Add `repository`, `homepage`, `bugs` and `author` metadata so npm links back to the GitHub repository.
- Switch the npm release workflow to OIDC Trusted Publishing (no long-lived `NPM_TOKEN`); provenance is generated automatically.

## [0.1.0]

### Added

- SVG → Android VectorDrawable XML conversion, AST-based via svgo normalization.
- Linear and radial gradients, including `gradientTransform` baked into Android gradient coordinates.
- `objectBoundingBox` gradient units resolved through the filled path's bounding box (with a viewport fallback).
- `<use>` reference resolution by inlining the referenced geometry (supports `href` and legacy `xlink:href`).
- Baking of transforms that cannot map to an Android `<group>` (skew/shear) directly into path geometry.
- `clip-path` support via a `<group>` wrapping a `<clip-path>` element.
- Inheritance of presentation attributes set on the root `<svg>` element (Feather/Bootstrap icon style).
- Full CSS color support: hex, `rgb()`, `hsl()`, named colors, and `currentColor` substitution.
- Fail-loud behavior: warnings for every unrepresentable construct, with an optional `strict` mode that throws.
- CLI (`svgvd`) for single-file, batch, and inline-string conversion.
- Browser build exposing the same API (svgo resolved to its browser bundle, no Node built-ins).
