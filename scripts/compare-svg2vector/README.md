# Svg2Vector comparison

Benchmarks this library against Android Studio's own SVG importer,
`com.android.ide.common.vectordrawable.Svg2Vector` (`com.android.tools:sdk-common`, default **32.4.1**,
the latest stable on Google Maven, same line as AGP 9.4.1), on the same inputs and with the same
rendering metric as `test/visual/`.

## Run

```bash
pnpm run build                                 # dist/index.js
node scripts/corpus.mjs                        # once, fetches the icon corpus into $TMPDIR/svgvd-corpus
node scripts/compare-svg2vector/compare.mjs    # fixtures + probes + 500 icons per set (< 1 min)
node scripts/compare-svg2vector/compare.mjs --limit 0 --png --top 15   # full corpus (9,251 icons, ~1.5 min)
node scripts/compare-svg2vector/compare.mjs --set fixtures,probes --png
```

Options: `--set a,b` (`fixtures`, `probes`, `feather`, `bootstrap`, `heroicons-outline`, `heroicons-solid`,
`tabler-outline`, `tabler-filled`), `--limit N` per corpus set (evenly spaced sample, `0` = all),
`--top N` rows per discrepancy list, `--png` (source / lib / s2v renders of the listed discrepancies),
`--no-build` (reuse the built runner). `-PsdkCommonVersion=…` on `./gradlew installDist` picks another
`sdk-common`.

Requirements: Node ≥ 23.6 (imports the harness `.ts` files natively), a JDK 21 (Gradle toolchain:
found in `~/.gradle/jdks` or the usual locations, else provisioned by the foojay plugin); the Gradle
launcher itself runs on any Java ≥ 17, even a JRE.

Everything generated stays in this directory and is git-ignored: `build/`, `.gradle/` (Gradle) and
`out/` (`report.md`, `results.json`, converted XML in `out/lib/` and `out/svg2vector/`, `out/png/`).

## Why a Gradle build

`sdk-common` pulls ~20 transitive artifacts (`common`, `sdklib`, `layoutlib-api`, guava, kotlin-stdlib,
kxml2, …). Gradle resolves them from Google Maven / Maven Central into `~/.gradle`, nothing is installed
in the project, and the wrapper (copied from `android-render/`) pins Gradle 9.8.0. A hand-written jar
resolver would be more code and more fragile. The runner (`src/main/java/Svg2VectorRunner.java`) converts
every file in **one JVM** (`parseSvgToXml(Path, OutputStream)`), recording time, size, the returned
error/warning log and any exception per file as JSON lines.

## What is measured

For each SVG: the source is rendered with resvg, each converter's XML is turned back into SVG by
`test/visual/vdToSvg.ts` and rendered the same way, and `compareRasters` (`test/visual/compare.ts`) gives
the mismatch ratio (pixels differing by more than 64/255, over inked pixels). Under 1 % counts as
visually identical. A failed conversion or an output the harness cannot read counts as 100 % in the
medians / p95. The report also lists, per set, failures, Svg2Vector messages, files where one converter
is under the threshold and the other is not, output size (raw and whitespace-collapsed, since
Svg2Vector indents differently) and conversion time.

## Caveats

- **`currentColor`**: Svg2Vector copies it verbatim into `android:fillColor` / `strokeColor`. That is not
  an Android color (`#RGB`, `#ARGB`, `#RRGGBB`, `#AARRGGBB` or a resource reference), so such a file does
  not build as-is. vdToSvg would reject it; the script counts these files (`s2v currentColor` column, `*`
  per file) and substitutes `#FF000000` (the library's default `currentColor`) before rendering, so the
  mismatch measures geometry and paint, not validity.
- **`<clip-path android:fillType>`**: Svg2Vector emits it for `clip-rule="evenodd"`; neither the
  framework nor AndroidX reads that attribute on `<clip-path>` (only `name` and `pathData`), and vdToSvg
  clips with nonzero as the device does. If that assumption were wrong, Svg2Vector would be under-rated on
  `probes/evenodd.svg`; confirming it needs a device / layoutlib render (`android-render/`).
- The metric judges the harness's model of Android rendering (resvg + vdToSvg), not a device; see
  `android-render/` for layoutlib renders of the library's output.
- Times: the library runs in-process after one warm-up call, Svg2Vector in a single JVM (the first
  files pay JIT warm-up; JVM start-up is only in the wall time). Indicative only, sensitive to load.
- resvg-js keeps ≈ 0.5 MB of native memory per render even after GC, so rendering runs in child
  processes of 600 files each (`RENDER_CHUNK`); a single process over the full corpus exceeds 15 GB.
