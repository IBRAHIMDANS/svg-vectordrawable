# Changelog

All notable changes to this project are documented in this file. The detailed notes of each published version are
on the [GitHub releases](https://github.com/IBRAHIMDANS/svg-vectordrawable/releases).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **Fixed:** a shape or path number beyond the float range (`1e39`, `1e400`) no longer writes `Infinity` into `android:pathData` with `optimize: false`: the shape is not drawn (`empty-path`) and path data stops at that number, as in Firefox and with `optimize: true`; an invalid `style` declaration (`stroke-width 2`, no colon) is ignored as in a browser instead of failing the default conversion with "Invalid SVG"; a CSS comment in `style` (`/*c*/fill:red`) no longer hides the declaration with `optimize: false`.

## [1.0.0] - 2026-11-12

The converter now warns (and `strict` rejects) where it used to draw wrong silently, matches Chrome and Firefox on edge cases, and gives the same result with `optimize: true` and `false`.

- **Breaking:** Node.js 20+ is required; `strict` rejects more files (unresolvable lengths, empty path data, invalid transforms, unresolved CSS); a missing paint server without fallback is no longer painted; new code `unsupported-color-reference`; outputs that collide (even by case) fail before writing.
- **Added:** Jetpack Compose output (`toImageVector`, `--format compose`), text to paths with `fonts` / `--font`, `preserveIds`, more masks and API 21 evenodd rewrites, CSS `d` / `translate` / `rotate` / `scale` / root size and transform, `invalid-path-data` hint (off by default), redesigned playground.
- **Fixed:** about 80 rendering and warning fixes (large scales, tiny viewBoxes, clips, masks, CSS parsing and svgo minification, `<tspan>`, `--watch`, crashes on numeric references and prefixed roots).

## [0.4.0] - 2026-11-11

- **Breaking:** TypeScript ≥ 5.3 is required to read the type declarations; `strict` rejects more silently wrong files; a fully transparent `currentColor` / `colorMap` key throws; new code `mask-approximated`; `vectorDrawableToSvg` draws color references in gray instead of throwing.
- **Added:** `autoMirrored`, `width` / `height`, theme colors (`currentColor` / `colorMap` with `?attr/…` and `@color/…`), CSS Color 4, `<switch>`, `context-fill` / `context-stroke`, evenodd masks, CLI stdin and `--fallback-png`.
- **Fixed:** module resolution for old bundlers and CommonJS types, non-rendered content no longer warns, `clip-path` from `style`, gradient units, `pathLength`, `<switch>` with svgo.

## [0.3.0] - 2026-11-11

- **Fixed:** option validation (`floatPrecision`, `indent`, `currentColor`), zero `viewBox`, bounded `<use>` expansion, `vectorDrawableToSvg` attribute injection, very long `d` attributes, one-line CLI errors.
- **Changed:** minified browser builds (`browser-lite` 68 KB, 26 KB gzipped) and a shared CLI chunk.

## [0.2.0] - 2026-10-06

- **Added:** `rules` and `ConversionError`, warning codes and categories, `strict: 'lossy'`, nested `<svg>`, `<a>`, `minSdk`, `browser-lite`, `vectorDrawableToSvg`, evenodd clips, masks as clips, elliptical radials, dashed and gradient strokes, `--android-names`.
- **Changed:** faster large inputs, drawables that paint nothing are dropped, root `opacity` on `android:alpha`, strict attribute parsing, ESM-only CLI.
- **Fixed:** `viewBox` origin, group `clip-path`, `preserveAspectRatio`, percentages and units, gradients under transforms, `inherit`, `visibility`, `display="none"`, CLI output paths.

## [0.1.1]

- **Changed:** npm metadata and OIDC trusted publishing with provenance.

## [0.1.0]

- **Added:** SVG → Android VectorDrawable conversion (svgo-based), gradients, `objectBoundingBox`, `<use>`, baked skews, `clip-path`, inherited root attributes, CSS colors, warnings with `strict`, the `svgvd` CLI and a browser build.
