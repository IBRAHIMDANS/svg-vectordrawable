# Integrations

How to call `svg-vectordrawable` from common build setups. Everything uses the public API:

```ts
convert(svg: string, options?: ConvertOptions): { xml: string; warnings: Warning[] } // throws ConversionError
convertFile(inputPath: string, outputPath?: string, options?: ConvertOptions, naming?: { androidNames?: boolean }): ConvertResult
convertDir(inputDir: string, outputDir: string, options?: ConvertOptions, naming?: { androidNames?: boolean }): { input: string; output: string; warnings: Warning[] }[]
androidResourceName(name: string): string
```

All functions are synchronous. The package ships ESM and CommonJS for Node (`import` or `require`),
an ESM browser build under `svg-vectordrawable/browser` (`convert` only, no file helpers) and the
`svgvd` CLI.

> Sections marked **Example — not published** are sketches to copy into your project. They are not
> packages you can install.

> `rules`, `ConversionError`, `--rule` and `--android-names` are listed under `[Unreleased]` in the
> changelog: they need the release after 0.1.1.

## Node build script

Convert a folder of SVGs into `res/drawable`, fail the build on anything that would render
differently, and keep a readable report:

```js
// scripts/build-drawables.mjs
import { convertDir, ConversionError } from 'svg-vectordrawable';

try {
    const results = convertDir(
        'design/icons',
        'app/src/main/res/drawable',
        { strict: true, rules: { 'opacity-approximated': 'warn' } },
        { androidNames: true }, // Arrow-Left.svg → arrow_left.xml
    );
    for (const { input, output, warnings } of results) {
        console.log(`${input} → ${output}`);
        for (const w of warnings) console.warn(`  [${w.code}] ${w.message}`);
    }
} catch (err) {
    if (err instanceof ConversionError) {
        console.error(`Cannot convert: [${err.warning.code}] ${err.warning.message}`);
        process.exit(1);
    }
    throw err; // I/O error, or two files mapping to the same resource name with androidNames
}
```

`convertDir` stops at the first file that throws; files converted before it are already written. To
convert everything and report every failure, loop over the files with `convertFile` and catch per file,
or use the CLI, which does exactly that.

## React Native app icon pipeline (vector with PNG fallback)

An adaptive icon layer (API 26+) can be a VectorDrawable or a set of PNGs. The pattern used by
[`react-native-svg-app-icon`](https://github.com/aeirola/react-native-svg-app-icon) is: try the
vector, and fall back to PNG when the SVG cannot be represented. With `svg2vectordrawable` this relied
on its `strict` option rejecting the promise; with this library `strict` throws a `ConversionError`
synchronously.

```ts
import { convert, ConversionError, type ConvertOptions } from 'svg-vectordrawable';

const VECTOR_OPTIONS: ConvertOptions = {
    // Any construct VectorDrawable cannot draw exactly becomes an error...
    strict: true,
    // ...except the approximations you decide to accept (optional, see below).
    rules: { 'opacity-approximated': 'warn' },
    // fillBlackForUnfilled defaults to true: unfilled shapes are black, as in SVG
    // (the equivalent of svg2vectordrawable's `fillBlack: true`).
};

type Layer = { kind: 'vector'; xml: string } | { kind: 'png'; reason: string };

export function iconLayer(svg: string): Layer {
    try {
        const { xml, warnings } = convert(svg, VECTOR_OPTIONS);
        for (const w of warnings) console.warn(`[svg-vectordrawable] ${w.code}: ${w.message}`);
        return { kind: 'vector', xml };
    } catch (err) {
        // Only "not representable" falls back to PNG; anything else is a real bug.
        if (err instanceof ConversionError) return { kind: 'png', reason: err.warning.code };
        throw err;
    }
}
```

The same change applied to `react-native-svg-app-icon` 0.7.0
(`lib/android/adaptive/vector-drawable.js`, shown here as TypeScript source), keeping its existing
`try { vector } catch { PNG }` in `adaptive-icons`:

```ts
import { convert } from 'svg-vectordrawable';

export async function* generateVectorDrawable(imageInput, fileName, context) {
    yield* output.generateFile(
        getIconPath(context.config, 'drawable', { density: 'anydpi', minApiLevel: 26 }, `${fileName}.xml`),
        async () => {
            const imageData = await imageInput.read();
            // Throws a ConversionError on unsupported constructs, so the caller falls back to PNG.
            return convert(imageData.data.toString('utf-8'), { strict: true }).xml;
        },
        context,
    );
}
```

Choosing the rules: `strict: true` alone rejects every approximation. Codes worth reviewing for app
icons:

| Code                    | Effect if downgraded to `'warn'`                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `opacity-approximated`  | Group `opacity` over overlapping children: the overlaps render darker than in the SVG                                                                                          |
| `gradient-approximated` | Radial focal point (`fx`/`fy`) ignored, or elliptical radial on a path that is also stroked                                                                                    |
| `group-skew`            | The skew is baked into the path geometry; stroke widths get one uniform scale factor (√\|det\|), so strokes under a strong skew keep a constant width instead of being sheared |
| `empty-path`            | None visible: a shape without geometry is skipped                                                                                                                              |

Keep `unsupported-element`, `unsupported-attribute`, `unsupported-paint`, `unsupported-clip-path` and
`unsupported-style` as errors: they mean something is missing from the drawable.

Gradients in VectorDrawable require API 24+, which adaptive icons (API 26+) always satisfy.

## Gradle (Android project)

Call the CLI from an `Exec` task that runs before the build. `--android-names` makes the output file
names valid resource names (`[a-z][a-z0-9_]*`, not a Java keyword) and fails before writing anything
if two SVGs map to the same name.

**Example — not published.** Kotlin DSL (`app/build.gradle.kts`), with `svg-vectordrawable` installed
in the repository's `package.json`:

```kotlin
val svgDir = rootProject.layout.projectDirectory.dir("design/icons")
val generatedRes = layout.buildDirectory.dir("generated/svgvd/res")

val convertSvgIcons by tasks.registering(Exec::class) {
    inputs.dir(svgDir)
    outputs.dir(generatedRes)
    workingDir = rootProject.projectDir
    // On Windows use "npx.cmd".
    commandLine(
        "npx", "--no-install", "svgvd", svgDir.asFile.path,
        "-o", generatedRes.get().dir("drawable").asFile.path,
        "--android-names", "--strict",
    )
}

android {
    sourceSets["main"].res.srcDir(generatedRes.get().asFile)
}

tasks.named("preBuild") { dependsOn(convertSvgIcons) }
```

- `svgvd` exits with code 1 if any file fails, so `--strict` fails the Gradle build; warnings are
  printed on stderr and do not.
- Output goes to `build/`, so generated drawables are not committed. To commit them instead, point
  `-o` at `src/main/res/drawable` and drop the `srcDir` line.
- Check the `sourceSets` / `preBuild` wiring against your Android Gradle Plugin version; newer AGP
  versions also offer `androidComponents { onVariants { … } }` for generated resources.

## Vite

**Example — not published.** A plugin that turns `import xml from './icon.svg?vd'` into the
VectorDrawable XML string (for instance in a web tool that previews or exports Android drawables):

```ts
// vite-plugin-vectordrawable.ts
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';
import { convert, ConversionError, type ConvertOptions } from 'svg-vectordrawable';

export function vectorDrawable(options: ConvertOptions = { strict: true }): Plugin {
    return {
        name: 'vectordrawable',
        enforce: 'pre', // run before Vite's own asset handling of .svg
        async load(id) {
            const [file, query] = id.split('?', 2);
            if (query !== 'vd' || !file.endsWith('.svg')) return null;
            this.addWatchFile(file);
            try {
                const { xml, warnings } = convert(await readFile(file, 'utf8'), options);
                for (const w of warnings) this.warn(`${file}: [${w.code}] ${w.message}`);
                return `export default ${JSON.stringify(xml)};`;
            } catch (err) {
                if (err instanceof ConversionError) this.error(`${file}: ${err.message}`);
                throw err;
            }
        },
    };
}
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { vectorDrawable } from './vite-plugin-vectordrawable';

export default defineConfig({ plugins: [vectorDrawable()] });
```

For TypeScript, declare the module: `declare module '*.svg?vd' { const xml: string; export default xml; }`.

## webpack

**Example — not published.** The same idea as a loader:

```js
// svg-vectordrawable-loader.cjs
const { convert } = require('svg-vectordrawable');

module.exports = function svgVectorDrawableLoader(source) {
    const { xml, warnings } = convert(source, this.getOptions());
    for (const w of warnings) this.emitWarning(new Error(`[${w.code}] ${w.message}`));
    return `module.exports = ${JSON.stringify(xml)};`;
};
```

```js
// webpack.config.js (excerpt)
module.exports = {
    module: {
        rules: [
            {
                test: /\.svg$/,
                resourceQuery: /vd/,
                type: 'javascript/auto',
                use: [{ loader: require.resolve('./svg-vectordrawable-loader.cjs'), options: { strict: true } }],
            },
        ],
    },
};
```

A `ConversionError` thrown by the loader fails the module build with its `[code] message`. Make sure
no other rule (asset modules, `@svgr/webpack`, …) also matches `*.svg?vd`.

## CI

Use the CLI as a gate. It converts every file, prints `✗ file: [code] message` for each failure and
exits with 1 if any failed.

```sh
# Fail on anything lossy, tolerate approximated group opacity.
npx svgvd design/icons -o build/drawable --strict --rule opacity-approximated=warn

# Not strict: only fail on missing content, keep the rest as warnings.
npx svgvd design/icons -o build/drawable --rule unsupported-element=error --rule unsupported-paint=error
```

`--rule` is repeatable, takes `<code>=<off|warn|error>` and rejects unknown codes (exit code 1, with
the list of known codes). The codes are listed in the README and exported as `WARNING_CODES`.

GitHub Actions step:

```yaml
- run: npx svgvd design/icons -o build/drawable --strict --android-names
```

To also check that the generated XML compiles, run `aapt2 compile` / `aapt2 link` on the output, as
this repository does in `scripts/aapt2-validate.mjs`, or simply build the Android app.
