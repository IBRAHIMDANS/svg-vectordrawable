# Comparison

A factual comparison of `svg-vectordrawable` with the two converters people usually reach for:

- [`svg2vectordrawable`](https://github.com/Ashung/svg2vectordrawable) — the popular npm package
  (version **2.9.1**, the latest, published 2022-06-02, depends on `svgo@^2.8.0`).
- **Svg2Vector** — Android Studio's own importer (Vector Asset Studio),
  `com.android.ide.common.vectordrawable.Svg2Vector` in `com.android.tools:sdk-common` (version
  **32.4.1** in this repository's benchmark).

Only facts verified in this repository are listed. Each section says where they come from and the
command that reproduces it. Unless stated otherwise, the figures were measured on 2026-11-11 against
the **published `svg-vectordrawable` 0.4.0** (npm), not against `main` or `develop`. Changes merged on
`develop` but not released yet (changelog, _Unreleased_) are marked **unreleased**.

## At a glance

|                               | `svg-vectordrawable`                                                             | `svg2vectordrawable` 2.9.1                                                                 | Svg2Vector (`sdk-common` 32.4.1)                                        |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Runtime                       | Node ≥ 20, browser build                                                         | Node ≥ 8 (`engines`), browser entry                                                        | JVM (Android Studio, or `sdk-common` as a library)                      |
| SVG normalization             | svgo 4 (on by default)                                                           | svgo 2 in the default export only; not in the file helper nor the CLI                      | Own parser                                                              |
| API style                     | Synchronous, returns `{ xml, warnings, minSdk }`                                 | `Promise<string>`                                                                          | Java (`parseSvgToXml(Path, OutputStream)` returns an error/warning log) |
| Reporting of lossy constructs | Typed warnings with stable codes; `strict` + per-code `rules`; `ConversionError` | `strict` rejects unknown element / attribute names after conversion; no warnings otherwise | Error/warning log string                                                |
| CLI                           | `svgvd` (strict, rules, Android resource names, `--json`, `--fallback-png`)      | `s2v` (no strict mode)                                                                     | Used through Android Studio's Vector Asset Studio                       |

Sources: `package.json` of each npm package, `src/` of `svg2vectordrawable` 2.9.1,
`scripts/compare-svg2vector/README.md` for Svg2Vector.

## `svg-vectordrawable` vs `svg2vectordrawable`

Observed by running both libraries on the same probe SVGs on 2026-11-11 (`svg2vectordrawable` 2.9.1
from npm, default export with svgo; `svg-vectordrawable` 0.4.0 from npm, default options). The probes
are minimal SVGs exercising one feature each, written inline for this check and not stored in the
repository; this is a feature check, not a corpus benchmark. To replay a row, save its probe as
`probe.svg` and run both converters on it:

```sh
npm i svg2vectordrawable@2.9.1 svg-vectordrawable@0.4.0
node --input-type=module -e "
import s2v from 'svg2vectordrawable';
import { convert } from 'svg-vectordrawable';
import { readFileSync } from 'node:fs';
const svg = readFileSync('probe.svg', 'utf8');
console.log(await s2v(svg));
console.log(convert(svg));"
```

The `gradientTransform` probe, for instance:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><radialGradient id="r" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(12 12) scale(10)"><stop stop-color="#fff"/><stop offset="1"/></radialGradient><path d="M0 0h24v24H0z" fill="url(#r)"/></svg>
```

`strict` rows pass `{ strict: true }` to each converter.

| Feature                                            | `svg2vectordrawable` 2.9.1                                                                       | `svg-vectordrawable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gradientTransform`                                | Ignored: a radial with `translate(12 12) scale(10)` is emitted at (0, 0), radius 1               | Applied: center (12, 12), radius 10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Non-zero `viewBox` origin (`-12 -12 24 24`)        | Ignored: content shifted out of the viewport                                                     | `<group translateX/Y>` puts it back                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Presentation attributes on `<svg>` (Feather style) | Dropped: stroked icon has no paint, renders empty                                                | Inherited                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `clip-path` on a `<g>`                             | Dropped                                                                                          | `<clip-path>` in a `<group>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `stroke-dasharray` (own or inherited from `<g>`)   | Dropped: solid stroke; `strict` rejects it: `Unsupported attribute stroke-dasharray`             | Dashes baked into the geometry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Gradient stroke                                    | Gradient emitted, `stroke-width` lost; `strict` rejects it: `Unsupported attribute stroke-width` | Gradient and width emitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `hsl()` fill                                       | Black                                                                                            | Converted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `<mask>`                                           | First child of the mask used as a clip, no error even in `strict`                                | Converted to a `<clip-path>` when the mask is a clip: opaque white content (opaque with `mask-type: alpha`), also with `fill-rule="evenodd"` (exact, #46). Stroked content is clipped without its strokes, with `mask-approximated` (thrown by `strict: true`, accepted by `strict: 'lossy'`, #62). Other masks (gradient, gray or translucent content, black shapes inside) are not applied, `unsupported-attribute` (thrown in `strict`). **Unreleased:** uniform gray or translucent content becomes an opacity, black shapes inside a white rectangle are cut out of the clip |
| `<text>`, `<image>`                                | Dropped (rejected in `strict`)                                                                   | Dropped with `unsupported-element` (thrown in `strict`). **Unreleased:** a simple single-line `<text>` becomes paths with the `fonts` option                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `strict` on an SVG with a gradient in `<defs>`     | Rejected: `Unsupported element defs`                                                             | Converts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `strict` on the dashed logo of issue #1            | Rejected: `Unsupported element defs`                                                             | Rejected with `opacity-approximated` (group opacity over overlapping orbits); converts with `rules: { 'opacity-approximated': 'warn' }`                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The `svg2vectordrawable` CLI (`s2v`) and its file helper skip svgo entirely: on 2.9.1, `s2v -s` drops
a `<circle>` and turns `fill="red"` into black (`#FF000000`).

## `svg-vectordrawable` vs Svg2Vector

The repository contains a benchmark harness, `scripts/compare-svg2vector/` (TASK-024), that converts
the same inputs with both tools and renders source SVG, library output and Svg2Vector output with the
same metric as `test/visual/` (resvg, mismatch over inked pixels, < 1 % counts as visually identical).
Inputs: the test fixtures, Android-specific probes and the pinned icon corpus (9,251 icons from
Feather, Bootstrap Icons, Heroicons and Tabler).

Run of 2026-11-11, `svg-vectordrawable` **0.4.0** (npm tarball's `dist/`, harness of `develop` at
`6755bee`), `com.android.tools:sdk-common` 32.4.1, library output with `optimize: true`:

| Input               | `svg-vectordrawable` < 1 % | Svg2Vector < 1 % | Notes                                                                                                                                                                                                            |
| ------------------- | -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixtures (10)       | 10                         | 9                | Svg2Vector ignores `stroke-dasharray` (issue #1 logo: 24.05 %)                                                                                                                                                   |
| Android probes (8)  | 8                          | 5                | Svg2Vector loses the elliptical radial (39.92 %), `clip-rule="evenodd"` (29.09 %) and the masks of `mask-as-clip.svg` (5.35 %, with an error in its log); the library is at 0.00 % on all three, with no warning |
| Icon corpus (9,251) | 9,251                      | 9,251            | median and p95 mismatch 0 % for both                                                                                                                                                                             |

| Corpus metric                      | `svg-vectordrawable`                | Svg2Vector                                                                                         |
| ---------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| Output compiles with `aapt2` as is | yes: all 9,251 pass a single `link` | no: 51 / 51 sampled outputs rejected at `link` (`currentColor` copied verbatim into 9,251 / 9,251) |
| Total output size (unindented)     | 5,313 KiB (−36 %)                   | 8,338 KiB                                                                                          |

Where to read each figure in `scripts/compare-svg2vector/out/report.md`: the counts are in _Summary
per set_ (columns `lib < 1 %`, `s2v < 1 %`, `s2v currentColor`), the per-file percentages in _Per
file: fixtures_ and _Per file: probes_, the sizes in the `corpus total` row, column
`bytes lib / s2v (compact)`. The `aapt2` figures come from the commands below.

Svg2Vector's `currentColor` output was substituted with black before rendering so that geometry and
paint could still be compared. Source: `scripts/compare-svg2vector/compare.mjs` (see its README).

Conversion time is not compared. The report prints it (column `time lib / s2v`), but it does not
reproduce: three full runs of 0.3.0 on 2026-11-11 on the same laptop (Intel Core i7-1265U, 12 threads,
31 GiB, Linux, Node 24.22.1, OpenJDK 21) gave a corpus total of 5.4, 10.7 and 23.1 s for the library
and 5.3, 7.3 and 7.9 s for Svg2Vector, and the 0.4.0 run 24.6 s and 16.5 s, depending on what else the
machine was running (load average 28 at the start of one run, 16 during the 0.4.0 run). Both stay
under 3 ms per icon on average in every run.

Reproduce on 0.4.0 (`pnpm run build` instead of the `npm pack` line measures the current sources):

```sh
pnpm install
npm pack svg-vectordrawable@0.4.0 && tar -xzf svg-vectordrawable-0.4.0.tgz \
  && rm -rf dist && mv package/dist dist && rm -rf package svg-vectordrawable-0.4.0.tgz
node scripts/corpus.mjs
node scripts/compare-svg2vector/compare.mjs --limit 0
```

### `aapt2` check of the corpus outputs

Run in bash from the repository root after the full comparison above (Android SDK with build-tools
36.1.0 and platform 36). A single `aapt2 link` over all 9,251 Svg2Vector outputs also fails (exit
code 1), but it stops reporting after 20 errors; hence the file-by-file check on a sample:

```bash
cd scripts/compare-svg2vector/out
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
AAPT2=$SDK/build-tools/36.1.0/aapt2
JAR=$SDK/platforms/android-36/android.jar
SETS="feather bootstrap heroicons-outline heroicons-solid tabler-outline tabler-filled"
T=$(mktemp -d)
echo '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="t.t"/>' > "$T/AndroidManifest.xml"

# Svg2Vector: one corpus output in 185 (51 files), each compiled and linked on its own
for s in $SETS; do ls svg2vector/$s/*.xml; done | awk 'NR % 185 == 1' | while read -r f; do
  rm -rf "$T/res" && mkdir -p "$T/res/drawable" && cp "$f" "$T/res/drawable/icon.xml"
  if ! "$AAPT2" compile --dir "$T/res" -o "$T/c.zip" 2>/dev/null; then echo compile-rejected
  elif ! "$AAPT2" link -I "$JAR" --manifest "$T/AndroidManifest.xml" -o "$T/a.apk" "$T/c.zip" 2>/dev/null; then echo link-rejected
  else echo linked; fi
done | sort | uniq -c

# Library: all 9,251 corpus outputs in a single compile + link (file names made valid resource names)
rm -rf "$T/res" && mkdir -p "$T/res/drawable"
for s in $SETS; do for f in lib/$s/*.xml; do
  cp "$f" "$T/res/drawable/$(echo "${s}_$(basename "$f")" | tr -- '-' '_')"
done; done
"$AAPT2" compile --dir "$T/res" -o "$T/c.zip" &&
  "$AAPT2" link -I "$JAR" --manifest "$T/AndroidManifest.xml" -o "$T/a.apk" "$T/c.zip" && echo "lib: linked"
```

Output on 2026-11-11: `51 link-rejected` (all 51 pass `compile`; `link` fails with
`'currentColor' is incompatible with attribute fillColor (attr) color.`, or `strokeColor` for stroked
icons), then `lib: linked`.

Facts already established by the harness (from `scripts/compare-svg2vector/README.md`; replayed on
2026-11-11 by calling `Svg2Vector.parseSvgToXml` of `sdk-common` 32.4.1 directly and running 0.4.0
on the same probes):

- Svg2Vector copies `currentColor` verbatim into `android:fillColor` / `android:strokeColor`. That is
  not a valid Android color, so such a file does not build as-is (see the `aapt2` check above).
  `svg-vectordrawable` substitutes the `currentColor` option (default `#000000`).
- Svg2Vector emits `android:fillType` on `<clip-path>` for `clip-rule="evenodd"`. The harness assumes
  Android ignores that attribute on `<clip-path>`; this is not yet confirmed on a device or layoutlib.
  `svg-vectordrawable` (since 0.2.0) rewrites an evenodd clip whose contours are nested or disjoint
  into the same region under nonzero, which is why it scores 0.00 % on `probes/evenodd.svg`; clips
  with crossing contours keep the `unsupported-clip-path` warning.

## How `svg-vectordrawable` itself is checked

From the README (Robustness) and the changelog; every figure was remeasured on 0.4.0 on 2026-11-11
(the Android renderer with `pnpm run validate:android`, on the 0.4.0 `dist/`):

| Check              | What                                                                                                                                                  | Where                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Icon corpus        | 9,251 icons (Feather, Bootstrap Icons, Heroicons, Tabler; pinned versions), with and without svgo, in CI: 0 warning                                   | `scripts/corpus.mjs`                           |
| Android toolchain  | Fixtures compiled and linked with `aapt2` against `android.jar`                                                                                       | `scripts/aapt2-validate.mjs`                   |
| Visual regression  | Each fixture rendered with resvg next to its VectorDrawable; must match within 1 % of inked pixels                                                    | `test/visual/`, `pnpm test:visual`             |
| Android's renderer | Output rendered by layoutlib (Skia/hwui via Paparazzi); fixtures and Android probes match within 0.11 %                                               | `android-render/`, `pnpm run validate:android` |
| Issue #1 logo      | Renders within 0.17 % of its source, with and without svgo (dashes baked into geometry)                                                               | `test/visual.test.ts`                          |
| Large input        | 10,000 paths: 24.6 s → under 2 s (10,000 filled squares, default config: 1.4 to 1.7 s on 0.4.0) after skipping svgo's `mergePaths` above 500 elements | changelog                                      |

### Strict mode on web-platform-tests

`scripts/wpt-corpus.mjs` checks the `strict` promise on the SVG files of
[web-platform-tests](https://github.com/web-platform-tests/wpt) (`svg/`, pinned commit): every file
converted with `strict: true` must either be rejected with a `ConversionError`, or render (resvg)
like its source within the visual-test threshold. A file that converts but renders differently is a
silent wrong render, unless resvg itself is known to render the source differently from the wpt
reference (`KNOWN_ARTEFACTS` in the script, each entry checked against the reference).

Run of 2026-11-11, `develop` at `71985ef` (**unreleased**, after 0.4.0), wpt at
`76f5455a0a266f098dd8bd888a8a84b0cad0350d`, Node 24.22.1:

| Figure                                                              | Value         |
| ------------------------------------------------------------------- | ------------- |
| Files kept (1,376 `.svg` minus text, script, references, SMIL, ...) | 226 × 2 modes |
| Conversions                                                         | 452           |
| Converted, render differs, not a known resvg artefact               | **0**         |
| Converted, render differs, known resvg artefact                     | 73            |
| Rejected (`optimize: true` / `false`)                               | 128 / 164     |
| Converted and matching (`optimize: true` / `false`)                 | 48 / 39       |

Reproduce (the script reads the built `dist/` and fetches wpt `svg/` once into a cache outside the
repository, `$TMPDIR/svgvd-wpt` or `SVGVD_WPT_DIR`):

```sh
pnpm install && pnpm run build
pnpm run validate:wpt   # = node scripts/wpt-corpus.mjs
```

The two figures to read are the `converted+mismatch, not in KNOWN_ARTEFACTS (converter bugs)` and
`known harness artefacts` lines of its output. To be remeasured on the 1.0.0 `dist/` at release.

Limitations that apply to every converter, because VectorDrawable cannot express them, are listed in
the README under _Known limitations_ (non-uniform `<mask>` such as a gradient mask, `<filter>`,
`<pattern>`, `<text>` (**unreleased:** except simple single-line text with the `fonts` option),
`<image>`, group opacity over overlapping children, radial focal points).
