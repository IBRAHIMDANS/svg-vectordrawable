package io.github.ibrahimdans.svgvd

import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property

/**
 * `svgVectorDrawable { … }`: defaults for every [SvgToVectorDrawableTask] of the project, including the
 * per-variant tasks registered on Android projects. See the task for what each property does.
 */
abstract class SvgVectorDrawableExtension {
    /** Default `src/main/svg`. */
    abstract val sourceDir: DirectoryProperty

    /** Default `false`. */
    abstract val strict: Property<Boolean>

    /** Default `true`: Android resource names must match `[a-z][a-z0-9_]*`. */
    abstract val androidNames: Property<Boolean>

    /** Default empty. */
    abstract val extraArgs: ListProperty<String>

    /** Default `npx --no-install svgvd`, e.g. `listOf("node", "node_modules/svg-vectordrawable/dist/cli.js")`. */
    abstract val command: ListProperty<String>

    /** Default: the root project folder. */
    abstract val workingDir: DirectoryProperty

    /** Default: `package.json` and the npm / pnpm / yarn / bun lockfiles of [workingDir]. */
    abstract val cliFiles: ConfigurableFileCollection
}
