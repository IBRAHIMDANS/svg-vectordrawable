# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-11-11

### Breaking / stricter

- **TypeScript ≥ 5.3 is required to read the type declarations**: the svgo types are now imported with `resolution-mode: 'import'`, which fixes `TS1479` for `moduleResolution: node16` CommonJS consumers with `skipLibCheck: false`; TypeScript 5.2 and older fail with `TS1005` on `dist/index.d.cts`, even with `skipLibCheck: true`. (#64)
- `strict` (`true` or `'lossy'`) now rejects files that used to convert silently wrong. Each case raises a lossy warning:
    - a root `<svg>` without `viewBox`, `width` or `height` (`unsupported-attribute`; the non-strict output is still 24×24) (#27);
    - a paint value that cannot be parsed (`var()`, `env()`, `color-mix()`, malformed hex…) (`unsupported-paint`; the shape used to vanish) (#29), and an unreadable `stop-color` (`unsupported-paint`, the stop is kept black) (#56);
    - SMIL animations (`<animate>`, `<set>`…), also inside a path or a gradient (`unsupported-element`) (#35, #56);
    - a `clip-path` other than `none` / `url(#id)`: CSS basic shapes, reference boxes, external URLs (`unsupported-clip-path`) (#33), and a `clip-path: url(#unknown)` in `style` (`missing-clip-path`) (#25);
    - CSS transforms that cannot be converted: `%` / `em` / 3D / `calc()` / `var()` transforms, `transform-origin` keywords other than `left` / `top`, `transform-box` other than `view-box`, `mix-blend-mode` other than `normal`, the `path-length` property (`unsupported-style`) (#37);
    - viewport-relative units (`vw`, `vh`, `vmin`, `cq*`…) on a root or nested `<svg>` (`unsupported-attribute` / `unsupported-style`) (#50);
    - a root `<svg>` failing conditional processing (`requiredExtensions=""` or unsupported, `systemLanguage=""`): empty `<vector>` with `unsupported-attribute`; a non-empty `systemLanguage` raises `unsupported-attribute` (device-dependent) on the root and on descendants (#35, #53);
    - a singular `gradientTransform` without fallback color (`missing-gradient`, was `gradient-approximated`) (#26);
    - with `optimize: true` only, cases that already failed with `optimize: false`: negative-size shapes (`empty-path`, they used to be drawn) (#32), zero-size shapes (`empty-path`, svgo removed them silently) (#60), a tiny `stroke-dasharray` rounded to `0` by svgo (`unsupported-stroke-dasharray`) (#15).
- `currentColor` / `colorMap` keys: a fully transparent color now throws a `TypeError` (`currentColor: '#FF000000'` is CSS `#RRGGBBAA`, red at alpha 0, and made every shape disappear) (#68); malformed colors the old parser accepted (`rgb(1 2)`, `#ggg`) now throw too (#29).
- `missing-gradient` no longer paints a black fill when the gradient is an invalid paint server (no usable stop, non-invertible `gradientTransform`) and has no fallback color: the fill is not painted, as SVG 2 specifies. An unknown gradient id is still painted black. (#54)
- New warning code `mask-approximated` (category `approximation`, appended to `WARNING_CODES`): a mask with stroked content is converted into a clip ignoring the strokes, instead of being refused with `unsupported-attribute`. `strict: 'lossy'` now accepts these files; `strict: true` still rejects them. (#62)
- `vectorDrawableToSvg` no longer throws on an Android color reference: it draws it in gray unless `colors` maps it (see Added). Code that caught the exception to detect references should use `onUnresolvedColor`. (#69)
- CLI: with no input argument and a stdin that is not a terminal, `svgvd` reads stdin instead of printing the help; a runner that keeps stdin open (`docker run -i`) now waits. Directory inputs are processed in name order. (#55)
- Outputs that change (no API change):
    - `floatPrecision` above 3 is honoured with `optimize: true` (svgo used to round to 3 decimals first) (#14);
    - svgo no longer rewrites curves as arcs (`makeArcs: false`): circles drawn with cubics stay cubics, longer but without the up-to-0.12-unit drift of svgo's rounded arcs (+0.07 % on the icon corpus, up to +14 % on some icon sets) (#58);
    - `em` / `rem` lengths resolve at 16 px (root size, stroke widths, shape geometry, gradients, nested `<svg>`, `<use>` sizes) instead of falling back to 24 dp, `1` or `0` (#38, #44);
    - dashes on circles, ellipses and arcs are cut on the true conic, not on its cubic approximation: cut points move by up to 0.09 unit (#73);
    - `color-interpolation="linearRGB"` gradients get intermediate stops (up to 64 items) (#75);
    - a root with a `viewBox` and a single dimension derives the other from the viewBox ratio (`viewBox="0 0 10 20" width="5"` → 5×10 dp, was 5×20) (#34);
    - a root `transform` (and `transform-origin`) is applied (#27, #50); CSS `transform` / `transform-origin` are applied (#37);
    - a `<symbol>` without `viewBox` is clipped to the `<use>` size, and a `<use>` size overrides a referenced `<svg>`'s (#23);
    - a negative or invalid `rx` / `ry` on `<rect>` is `auto` (rounded corners from the other radius) (#24);
    - with `optimize: true`, files containing a CSS transform, a `<switch>`, a dashed `pathLength`, a negative or zero size keep more groups / shapes (svgo plugins disabled for them) (#32, #37, #59, #60).

### Added

- `autoMirrored` option: adds `android:autoMirrored="true"` to the `<vector>` so Android flips it in right-to-left layouts; CLI `--auto-mirrored`. (#16)
- `width` / `height` options (dp): replace `android:width` / `android:height` without touching the viewport. Given alone, the other dimension follows the SVG size's aspect ratio (rounded to `floatPrecision`); both with another ratio stretch the drawing, as on Android. A non-finite or non-positive value throws a `TypeError`. The `large-vector` warning is checked on the final size. CLI `--width <dp>` / `--height <dp>`. (#16)
- Theme colors: the `currentColor` option accepts an Android color reference (`?attr/…`, `?android:attr/…`, `@color/…`, `@android:color/…`, optional `package:` prefix), emitted as is in `android:fillColor` / `android:strokeColor`; a malformed reference throws a `TypeError`. New `colorMap` option: SVG colors (any notation, compared as `#AARRGGBB`) → references. A reference carries no alpha: opacities and the mapped color's own alpha go to `fillAlpha` / `strokeAlpha` (an exact `#AARRGGBB` key wins over an opaque key, which matches its color at any alpha). Opaque gradient stops get the reference too (accepted by `aapt2` in `<item android:color>`); translucent ones keep their literal color with an `unsupported-paint` warning. CLI `--current-color <color|ref>` and `--color-map <color>=<ref>` (repeatable). (#31)
- `vectorDrawableToSvg` previews drawables holding color references: `colors` option (reference → Android color literal, validated up front), `onUnresolvedColor` callback; an unmapped reference is drawn in gray (`#FF808080`). Applies to fills, strokes, gradient colors and `android:tint`. (#69)
- CSS Color 4 colors in fill, stroke, `stop-color`, masks and the `currentColor` option: `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color()` (srgb, srgb-linear, display-p3, a98-rgb, prophoto-rgb, rec2020, xyz…), modern `rgb()` / `hsl()` syntax, `none` components, hue units. Out-of-gamut colors are clipped per channel. (#29)
- `<switch>` is rendered by its first child passing conditional processing (the first one without `systemLanguage` when the choice depends on the language, with `unsupported-attribute`), instead of `unsupported-element`. (#59)
- `context-fill` / `context-stroke` are resolved from the `<use>` that instantiates the content (a gradient or pattern context paint, or one outside a `<use>`, keeps `unsupported-paint`). (#65)
- Masks whose content uses `fill-rule="evenodd"` (nested or disjoint contours) become an exact clip-path instead of being refused; overlapping mask shapes no longer cancel each other. (#46)
- CLI: stdin input (`svgvd -`, or no input argument when stdin is not a terminal; an empty pipe prints the help), written to stdout or to `-o file.xml`. `-r` / `--recursive` converts subdirectories, reproducing the tree under `-o` (flat with `--android-names`, where a name collision across subdirectories fails before writing). `--json` prints a report on stdout, `[{ input, output, warnings, minSdk, error, fallback }]`, warnings and escalated errors carrying their `code` and `category`; refused when the XML would also go to stdout. `--dry-run` converts and reports without writing. Exit codes are unchanged (1 when any file fails). (#55)
- CLI `--fallback-png <all|mdpi,hdpi,…>`: a file the conversion rejects (`--strict`, `--rule <code>=error`) is rendered to PNG with resvg instead of failing, one per density bucket (`drawable-mdpi` … `drawable-xxxhdpi`, 1× to 4× the `<vector>`'s dp size, `--width` / `--height` included), in the XML's directory or beside it when it is named `drawable`; its XML is not written and the run succeeds. A file that converts never gets a PNG. The `--json` report gains a `fallback` field on every entry (`null`, or `{ outputs, reason }` with the rejecting warning). `@resvg/resvg-js` becomes an optional peer dependency, loaded only when a fallback is needed (a one-line error tells how to install it when absent). (#74)

### Fixed

- The package resolves with `moduleResolution: node` / `node10` and old bundlers (`main`, `module`, `types`, `typesVersions`), and `require` gets the CommonJS declarations (`index.d.cts`) instead of the ESM ones. (#39)
- `fillBlackForUnfilled: false` with `optimize: true` keeps an explicit black fill (`fill="#000"` was dropped by svgo as a default, and the path was not emitted). (#49)
- Non-rendered content no longer raises `empty-path` or `unsupported-*` warnings that made `strict` reject faithful files: `<script>` (#22); foreign-namespace elements, `<view>`, `<cursor>`, fonts, `<color-profile>`, `<hatch>`, unsupported elements under `display:none` (#35); `<title>`, `<desc>`, `<script>` inside a `<clipPath>` (#28). Elements failing `requiredExtensions` / `systemLanguage=""` are no longer drawn (#35), and no longer count as overlapping for `opacity-approximated` (#41).
- `clip-path` is read from `style` (including a `<style>` rule inlined by svgo), not only from the attribute; quoted `url('#c')` is accepted. (#25)
- Gradients: absolute units (`in`, `cm`, `mm`, `pt`, `pc`) are resolved with `optimize: false`; a singular `gradientTransform` drops the gradient (its fallback color is used) instead of emitting a radius-0 radial that Android rejects (#26); `href` inheritance skips empty or invalid attributes, as browsers do (#56); `color-interpolation` is inherited from ancestors (#75).
- `pathLength` is kept on basic shapes with `optimize: true`, and paths carrying it are no longer merged (dashes were scaled on the summed length) (#32); `pathLength="0"` draws the stroke solid (#42).
- A `<switch>` is no longer broken by svgo with `optimize: true` (sibling alternatives merged, hidden first child removed), and its chosen child counts for `opacity-approximated`. (#59)
- An invalid `transform-origin` without a reference box (`top 10px`) is reported with `unsupported-style` instead of being read. (#61)

### Documentation

- README: online playground (`browser-lite`, deployed to GitHub Pages) and before/after radial-gradient rendering (#17, #19, #30); migration guide from `svg2vectordrawable` corrected against five real migrations (#45); `docs/comparison.md` re-measured on the published 0.3.0 (#47). Gradle plugin, Vite plugin, MCP server and Figma plugin added under `integrations/` and documented in `docs/integrations.md`, **not published yet** (#36, #40, #43, #70, #71).

## [0.3.0] - 2026-11-11

### Fixed

- `floatPrecision` and `indent` are validated (`TypeError`): a non-numeric precision used to write `NaN` into every coordinate (`android:width="NaNdp"`), a negative one rounded to tens. `floatPrecision` must be an integer from 0 to 20, `indent` a non-negative integer.
- An unparseable `currentColor` option throws a `TypeError` instead of silently dropping every shape painted with it.
- A root `viewBox` with a zero or negative width / height throws instead of emitting `android:viewportWidth="0"`; a zero or negative `width` / `height` falls back to the viewBox, like a percentage (it used to be emitted as `android:width="-5dp"`).
- `<use>` expansion is bounded (100,000 cloned nodes per document): nested references multiply instances, and a 700-byte SVG could exhaust the heap. Beyond the limit the conversion throws.
- `vectorDrawableToSvg` validates `android:strokeLineCap` / `android:strokeLineJoin` against their keywords instead of copying them into the SVG (attribute injection from an untrusted VectorDrawable), rejects a non-numeric `android:width` / `android:height` (it produced `width="NaN"`) and reports a character reference outside Unicode as an `Error` (it was a raw `RangeError`).
- `browser-lite`: custom entity expansion is capped at 512 per document, as in svgo's parser (it was bounded in depth only).
- A document holding a `d` attribute longer than 50,000 characters skips svgo's `convertPathData`, which is quadratic in the number of relative commands: an 80,000-segment path went from 53 s to under 0.1 s. Such paths are emitted as authored, as with `optimize: false`.
- CLI: a missing input file, a rejected (`--strict`) or invalid inline SVG (`-s`) print a one-line error and exit with 1 instead of a Node stack trace; the other inputs are still converted. An option given without its value, a non-integer `--precision` and `-` (stdin is not read) are rejected with a message.

### Changed

- The IIFE browser builds are minified: `browser-lite.global.js` 133 KB → 68 KB (26 KB gzipped), `browser.global.js` 1.13 MB → 625 KB (189 KB gzipped).
- `dist/cli.js` shares the converter with `dist/index.js` through a common chunk instead of bundling a second copy (113 KB → 6 KB).
- CLI: a directory named `*.svg` inside an input directory is no longer treated as a file.

### Internal

- Path-data code split into `pathParse`, `pathAbsolute`, `pathBBox` and `pathContours` (`pathData` re-exports them); AST types moved to `src/ast.ts`. Output identical on 18,522 conversions (icon corpus and fixtures, with and without svgo).
- CI: toolchain jobs run on Node 22 and 24 (the versions tsup 9 and vitest 5 declare), `format:check` is enforced, coverage thresholds are set.

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
