# Comparison

A factual comparison of `svg-vectordrawable` with the two converters people usually reach for:

- [`svg2vectordrawable`](https://github.com/Ashung/svg2vectordrawable) — the popular npm package
  (version **2.9.1**, last published 2022-06-27, depends on `svgo@^2.8.0`).
- **Svg2Vector** — Android Studio's own importer (Vector Asset Studio),
  `com.android.ide.common.vectordrawable.Svg2Vector` in `com.android.tools:sdk-common` (version
  **32.4.1** in this repository's benchmark).

Only facts verified in this repository are listed. Each section says where they come from. Dates refer
to 2026-10-05.

## At a glance

|                               | `svg-vectordrawable`                                                             | `svg2vectordrawable` 2.9.1                                                                 | Svg2Vector (`sdk-common` 32.4.1)                                        |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Runtime                       | Node ≥ 18, browser build                                                         | Node ≥ 8 (`engines`), browser entry                                                        | JVM (Android Studio, or `sdk-common` as a library)                      |
| SVG normalization             | svgo 4 (on by default)                                                           | svgo 2 in the default export only; not in the file helper nor the CLI                      | Own parser                                                              |
| API style                     | Synchronous, returns `{ xml, warnings }`                                         | `Promise<string>`                                                                          | Java (`parseSvgToXml(Path, OutputStream)` returns an error/warning log) |
| Reporting of lossy constructs | Typed warnings with stable codes; `strict` + per-code `rules`; `ConversionError` | `strict` rejects unknown element / attribute names after conversion; no warnings otherwise | Error/warning log string                                                |
| CLI                           | `svgvd` (strict, rules, Android resource names)                                  | `s2v` (no strict mode)                                                                     | Used through Android Studio's Vector Asset Studio                       |

Sources: `package.json` of each npm package, `src/` of `svg2vectordrawable` 2.9.1,
`scripts/compare-svg2vector/README.md` for Svg2Vector.

## `svg-vectordrawable` vs `svg2vectordrawable`

Observed by running both libraries on the same probe SVGs on 2026-10-05 (`svg2vectordrawable` 2.9.1
from npm, default export with svgo; `svg-vectordrawable` from the current sources, default options).
The probes are minimal SVGs exercising one feature each; this is a feature check, not a corpus
benchmark.

| Feature                                            | `svg2vectordrawable` 2.9.1                                                         | `svg-vectordrawable`                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `gradientTransform`                                | Ignored: a radial with `translate(12 12) scale(10)` is emitted at (0, 0), radius 1 | Applied: center (12, 12), radius 10                                                                                                     |
| Non-zero `viewBox` origin (`-12 -12 24 24`)        | Ignored: content shifted out of the viewport                                       | `<group translateX/Y>` puts it back                                                                                                     |
| Presentation attributes on `<svg>` (Feather style) | Dropped: stroked icon has no paint, renders empty                                  | Inherited                                                                                                                               |
| `clip-path` on a `<g>`                             | Dropped                                                                            | `<clip-path>` in a `<group>`                                                                                                            |
| `stroke-dasharray` (own or inherited from `<g>`)   | Dropped: solid stroke                                                              | Dashes baked into the geometry                                                                                                          |
| Gradient stroke                                    | Gradient emitted, `stroke-width` lost                                              | Gradient and width emitted                                                                                                              |
| `hsl()` fill                                       | Black                                                                              | Converted                                                                                                                               |
| `<mask>`                                           | First child of the mask used as a clip, no error even in `strict`                  | Not applied, `unsupported-attribute` warning, unless it is equivalent to a clip                                                         |
| `<text>`, `<image>`                                | Dropped (rejected in `strict`)                                                     | Dropped with `unsupported-element` (thrown in `strict`)                                                                                 |
| `strict` on an SVG with a gradient in `<defs>`     | Rejected: `Unsupported element defs`                                               | Converts                                                                                                                                |
| `strict` on the dashed logo of issue #1            | Rejected: `Unsupported element defs`                                               | Rejected with `opacity-approximated` (group opacity over overlapping orbits); converts with `rules: { 'opacity-approximated': 'warn' }` |

The `svg2vectordrawable` CLI (`s2v`) and its file helper skip svgo entirely: on 2.9.1, `s2v -s` drops
a `<circle>` and turns `fill="red"` into black (`#FF000000`).

## `svg-vectordrawable` vs Svg2Vector

The repository contains a benchmark harness, `scripts/compare-svg2vector/` (TASK-024), that converts
the same inputs with both tools and renders source SVG, library output and Svg2Vector output with the
same metric as `test/visual/` (resvg, mismatch over inked pixels, < 1 % counts as visually identical).
Inputs: the test fixtures, Android-specific probes and the pinned icon corpus (9,251 icons from
Feather, Bootstrap Icons, Heroicons and Tabler).

Run of 2026-10-05, `com.android.tools:sdk-common` 32.4.1, library output with `optimize: true`:

| Input               | `svg-vectordrawable` < 1 % | Svg2Vector < 1 % | Notes                                                                                                               |
| ------------------- | -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Fixtures (10)       | 10                         | 9                | Svg2Vector ignores `stroke-dasharray` (issue #1 logo: 24.05 %)                                                      |
| Android probes (6)  | 5                          | 4                | Svg2Vector loses the elliptical radial (39.92 %); both lose `clip-rule="evenodd"` (29.09 %), only the library warns |
| Icon corpus (9,251) | 9,251                      | 9,251            | median and p95 mismatch 0 % for both                                                                                |

| Corpus metric                      | `svg-vectordrawable` | Svg2Vector                                           |
| ---------------------------------- | -------------------- | ---------------------------------------------------- |
| Output compiles with `aapt2` as is | yes                  | no on 9,251 / 9,251 (`currentColor` copied verbatim) |
| Total output size (unindented)     | 5,558 KiB (−33 %)    | 8,338 KiB                                            |
| Time per file (median / p95)       | 0.67 / 2.2 ms        | 0.34 / 0.84 ms                                       |

Svg2Vector's `currentColor` output was substituted with black before rendering so that geometry and
paint could still be compared. Source: `scripts/compare-svg2vector/compare.mjs` (see its README).

Reproduce with:

```sh
pnpm run build
node scripts/corpus.mjs
node scripts/compare-svg2vector/compare.mjs --limit 0 --png --top 15
```

Facts already established by the harness (from `scripts/compare-svg2vector/README.md`):

- Svg2Vector copies `currentColor` verbatim into `android:fillColor` / `android:strokeColor`. That is
  not a valid Android color, so such a file does not build as-is. `svg-vectordrawable` substitutes the
  `currentColor` option (default `#000000`).
- Svg2Vector emits `android:fillType` on `<clip-path>` for `clip-rule="evenodd"`. The harness assumes
  Android ignores that attribute on `<clip-path>`; this is not yet confirmed on a device or layoutlib.
  `svg-vectordrawable` reports `clip-rule="evenodd"` as `unsupported-clip-path` instead.

## How `svg-vectordrawable` itself is checked

From the README (Robustness) and the changelog:

| Check              | What                                                                                                     | Where                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Icon corpus        | 9,251 icons (Feather, Bootstrap Icons, Heroicons, Tabler; pinned versions), with and without svgo, in CI | `scripts/corpus.mjs`                           |
| Android toolchain  | Fixtures compiled and linked with `aapt2` against `android.jar`                                          | `scripts/aapt2-validate.mjs`                   |
| Visual regression  | Each fixture rendered with resvg next to its VectorDrawable; must match within 1 % of inked pixels       | `test/visual/`, `pnpm test:visual`             |
| Android's renderer | Output rendered by layoutlib (Skia/hwui via Paparazzi); fixtures and Android probes match within 0.11 %  | `android-render/`, `pnpm run validate:android` |
| Issue #1 logo      | Renders within 0.22 % of its source (dashes baked into geometry)                                         | `test/visual.test.ts`, changelog               |
| Large input        | 10,000 paths: 24.6 s → under 2 s after skipping svgo's `mergePaths` above 500 drawable elements          | changelog                                      |

Limitations that apply to every converter, because VectorDrawable cannot express them, are listed in
the README under _Known limitations_ (`<mask>`, `<filter>`, `<pattern>`, `<text>`, `<image>`, group
opacity over overlapping children, radial focal points).
