# svg-vectordrawable Gradle plugin

Converts a folder of SVGs into Android VectorDrawable resources before the resource merge of every
Android variant, by running the `svgvd` CLI of
[`svg-vectordrawable`](https://github.com/IBRAHIMDANS/svg-vectordrawable). The task is cacheable: with
nothing changed it is `UP-TO-DATE`, and restored `FROM-CACHE` with the build cache.

## Requirements

- **Node.js 18+** on the `PATH` (or a custom `command`, see below), and `svg-vectordrawable` installed in
  the folder the CLI runs in (the root project folder by default):

    ```sh
    npm install --save-dev svg-vectordrawable
    ```

- Gradle 9 and the Android Gradle plugin 9 (tested with Gradle 9.8 and AGP 9.4). The Android wiring uses
  the public variant API (`androidComponents.onVariants`, `sources.res.addGeneratedSourceDirectory`).

## Usage

```kotlin
// app/build.gradle.kts
plugins {
    id("com.android.application")
    id("io.github.ibrahimdans.svg-vectordrawable") version "0.1.0"
}

svgVectorDrawable {
    sourceDir.set(rootProject.layout.projectDirectory.dir("design/icons")) // default: src/main/svg
    strict.set(true) // fail the build on any lossy construct
    extraArgs.set(listOf("--rule", "opacity-approximated=warn"))
}
```

For every variant, the plugin registers `convert<Variant>SvgToVectorDrawable`, which writes
`build/generated/res/convert<Variant>SvgToVectorDrawable/drawable/*.xml` and is wired by AGP before
`merge<Variant>Resources`. The variant's `minSdk` is passed as `--min-sdk`. Generated drawables are not
committed; reference them as usual (`@drawable/arrow_left`, `R.drawable.arrow_left`).

Apply the plugin in the same `plugins {}` block as the Android plugin (or declare both with `apply false`
at the root): it needs to see the Android plugin's classes.

| Property       | Default                                         | Effect                                                                                           |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `sourceDir`    | `src/main/svg`                                  | Folder holding the `*.svg` files (non-recursive); missing or empty: skipped                      |
| `strict`       | `false`                                         | `--strict`: fail on the first lossy or approximated construct                                    |
| `androidNames` | `true`                                          | `--android-names`: `Arrow-Left.svg` → `arrow_left.xml`                                           |
| `extraArgs`    | `[]`                                            | Any other CLI option (`--rule`, `--strict=lossy`, `--tint`, `--precision`…)                      |
| `command`      | `npx --no-install svgvd` (`npx.cmd` on Windows) | How to start the CLI, e.g. `listOf("node", "tools/node_modules/svg-vectordrawable/dist/cli.js")` |
| `workingDir`   | root project folder                             | Where `command` runs                                                                             |
| `cliFiles`     | `package.json` and lockfiles of `workingDir`    | Changing them (a new CLI version) reruns the task                                                |

Warnings are printed in the build output and do not fail the build; the task fails when the CLI exits
with an error (with `strict`, or an invalid SVG).

Without the Android plugin, register the task yourself:

```kotlin
tasks.register<io.github.ibrahimdans.svgvd.SvgToVectorDrawableTask>("convertSvg") {
    outputDir.set(layout.buildDirectory.dir("svgvd/res")) // writes res/drawable/*.xml
}
```

## Development

```sh
(cd example && pnpm install)            # the CLI used by the tests and the example (own pnpm workspace)
./gradlew build                         # TestKit functional tests (incl. an Android app) + validatePlugins
./gradlew -p example :app:assembleDebug # example app (needs ANDROID_HOME)
```
