package io.github.ibrahimdans.svgvd

import org.gradle.api.DefaultTask
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.FileSystemOperations
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.IgnoreEmptyDirectories
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.SkipWhenEmpty
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations
import javax.inject.Inject

/**
 * Converts the `*.svg` files of [sourceDir] (non-recursive) into XML files in the `drawable` subfolder of
 * [outputDir], an Android `res` folder, by running the `svgvd` CLI of the npm package `svg-vectordrawable`.
 *
 * Cacheable: the inputs are the source folder, the CLI arguments and the files that pin the CLI version
 * ([cliFiles]); with nothing changed the task is UP-TO-DATE, and FROM-CACHE with the build cache.
 */
@CacheableTask
abstract class SvgToVectorDrawableTask @Inject constructor(
    private val exec: ExecOperations,
    private val fileSystem: FileSystemOperations,
) : DefaultTask() {

    /** Folder holding the source `*.svg` files. The task is skipped (NO-SOURCE) when it is missing or empty. */
    @get:InputDirectory
    @get:SkipWhenEmpty
    @get:IgnoreEmptyDirectories
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceDir: DirectoryProperty

    /** An Android `res` folder: the drawables are written to its `drawable/` subfolder, which is emptied first. */
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    /** `--strict`: fail on any lossy or approximated construct. */
    @get:Input
    abstract val strict: Property<Boolean>

    /** `--android-names`: `Arrow-Left.svg` becomes `arrow_left.xml`. */
    @get:Input
    abstract val androidNames: Property<Boolean>

    /** `--min-sdk`: warn when the output needs a higher API level. Set from the variant's minSdk on Android. */
    @get:Input
    @get:Optional
    abstract val minSdk: Property<Int>

    /** Any other CLI option, e.g. `listOf("--rule", "opacity-approximated=warn", "--tint", "#FF000000")`. */
    @get:Input
    abstract val extraArgs: ListProperty<String>

    /** How to start the CLI. Default `npx --no-install svgvd` (`npx.cmd` on Windows). */
    @get:Input
    abstract val command: ListProperty<String>

    /** Where [command] runs: the folder whose `node_modules` holds `svg-vectordrawable`. */
    @get:Internal
    abstract val workingDir: DirectoryProperty

    /** Files that pin the CLI version (`package.json`, lockfiles): changing them reruns the task. */
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val cliFiles: ConfigurableFileCollection

    @TaskAction
    fun convert() {
        val drawableDir = outputDir.get().dir("drawable").asFile
        // Start from an empty folder, so the output of a removed SVG does not linger.
        fileSystem.delete { delete(outputDir) }
        drawableDir.mkdirs()

        val args = buildList {
            addAll(command.get())
            add(sourceDir.get().asFile.absolutePath)
            add("-o")
            add(drawableDir.absolutePath)
            if (androidNames.get()) add("--android-names")
            if (strict.get()) add("--strict")
            minSdk.orNull?.let { addAll(listOf("--min-sdk", it.toString())) }
            addAll(extraArgs.get())
        }
        // svgvd prints warnings on stderr and exits with 1 if any file failed, which fails the task.
        exec.exec {
            workingDir(this@SvgToVectorDrawableTask.workingDir.get().asFile)
            commandLine(args)
        }
    }
}
