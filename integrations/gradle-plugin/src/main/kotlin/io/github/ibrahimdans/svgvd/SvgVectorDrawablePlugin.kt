package io.github.ibrahimdans.svgvd

import org.gradle.api.Plugin
import org.gradle.api.Project

/**
 * Plugin `io.github.ibrahimdans.svg-vectordrawable`.
 *
 * Creates the `svgVectorDrawable` extension. With the Android Gradle plugin (application, library or
 * dynamic feature), registers `convert<Variant>SvgToVectorDrawable` for every variant and adds its output
 * as a generated resource folder, so it runs before `merge<Variant>Resources`. Without it, register a
 * [SvgToVectorDrawableTask] yourself.
 */
class SvgVectorDrawablePlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val extension = project.extensions.create("svgVectorDrawable", SvgVectorDrawableExtension::class.java)
        extension.sourceDir.convention(project.layout.projectDirectory.dir("src/main/svg"))
        extension.strict.convention(false)
        extension.androidNames.convention(true)
        extension.command.convention(defaultCommand())
        extension.workingDir.convention(project.rootProject.layout.projectDirectory)
        // Missing files are fine: they are fingerprinted as absent.
        extension.cliFiles.from(extension.workingDir.map { dir -> CLI_FILES.map { dir.file(it) } })

        project.tasks.withType(SvgToVectorDrawableTask::class.java).configureEach {
            group = "build"
            description = "Converts SVG files to Android VectorDrawable resources (svg-vectordrawable)."
            sourceDir.convention(extension.sourceDir)
            strict.convention(extension.strict)
            androidNames.convention(extension.androidNames)
            extraArgs.convention(extension.extraArgs)
            command.convention(extension.command)
            workingDir.convention(extension.workingDir)
            cliFiles.from(extension.cliFiles)
        }

        // AndroidVariants (and the AGP classes it uses) is only loaded once an Android plugin is applied.
        for (id in ANDROID_PLUGINS) project.pluginManager.withPlugin(id) { AndroidVariants.wire(project, id) }
    }

    private fun defaultCommand(): List<String> {
        val windows = System.getProperty("os.name").startsWith("Windows", ignoreCase = true)
        return listOf(if (windows) "npx.cmd" else "npx", "--no-install", "svgvd")
    }

    private companion object {
        val ANDROID_PLUGINS = listOf("com.android.application", "com.android.library", "com.android.dynamic-feature")
        val CLI_FILES = listOf("package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock")
    }
}
