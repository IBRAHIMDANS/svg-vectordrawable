package io.github.ibrahimdans.svgvd

import org.gradle.testkit.runner.BuildResult
import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

/** TestKit functional tests: real Gradle builds running the real `svgvd` CLI (see build.gradle.kts). */
class SvgVectorDrawablePluginTest {
    @TempDir
    lateinit var dir: File

    private val cli = System.getProperty("svgvd.cli").also {
        check(File(it).isFile) { "svgvd CLI not found at $it: run `pnpm install` in example/ first" }
    }

    private val arrow = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>"""
    private val overlap = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g opacity=".5"><rect width="10" height="10"/><rect x="5" width="10" height="10"/></g></svg>"""

    private fun file(path: String) = File(dir, path)

    private fun write(path: String, content: String) = file(path).apply { parentFile.mkdirs() }.writeText(content)

    private val drawable get() = file("build/svgvd/res/drawable")

    @BeforeEach
    fun project() {
        write(
            "settings.gradle.kts",
            """
            rootProject.name = "fixture"
            buildCache { local { directory = File(rootDir, "build-cache") } }
            """.trimIndent(),
        )
        write(
            "build.gradle.kts",
            """
            plugins { id("io.github.ibrahimdans.svg-vectordrawable") }

            svgVectorDrawable {
                command.set(listOf("node", "${cli.replace("\\", "\\\\")}"))
            }

            tasks.register<io.github.ibrahimdans.svgvd.SvgToVectorDrawableTask>("convertSvg") {
                outputDir.set(layout.buildDirectory.dir("svgvd/res"))
            }
            """.trimIndent(),
        )
        write("src/main/svg/Arrow-Left.svg", arrow)
        write("src/main/svg/star.svg", arrow.replace("M20", "M19"))
    }

    private fun runner(vararg args: String) =
        GradleRunner.create().withProjectDir(dir).withPluginClasspath().withArguments(*args, "--stacktrace")

    private fun build(vararg args: String): BuildResult = runner(*args).build()

    private fun BuildResult.outcome(task: String = ":convertSvg") = task(task)?.outcome

    @Test
    fun `converts with Android resource names, then is UP-TO-DATE`() {
        assertEquals(TaskOutcome.SUCCESS, build("convertSvg").outcome())
        assertEquals(setOf("arrow_left.xml", "star.xml"), drawable.list()!!.toSet())
        assertTrue(File(drawable, "arrow_left.xml").readText().startsWith("<vector "))

        assertEquals(TaskOutcome.UP_TO_DATE, build("convertSvg").outcome())
    }

    @Test
    fun `reruns on a change and drops the output of a removed SVG`() {
        build("convertSvg")
        file("src/main/svg/star.svg").delete()
        write("src/main/svg/new-icon.svg", arrow)
        assertEquals(TaskOutcome.SUCCESS, build("convertSvg").outcome())
        assertEquals(setOf("arrow_left.xml", "new_icon.xml"), drawable.list()!!.toSet())
    }

    @Test
    fun `is restored FROM-CACHE after a clean`() {
        build("convertSvg", "--build-cache")
        file("build").deleteRecursively()
        assertEquals(TaskOutcome.FROM_CACHE, build("convertSvg", "--build-cache").outcome())
        assertTrue(File(drawable, "star.xml").isFile)
    }

    @Test
    fun `reuses the configuration cache`() {
        build("convertSvg", "--configuration-cache")
        val second = build("convertSvg", "--configuration-cache")
        assertTrue(second.output.contains("Configuration cache entry reused"), second.output)
        assertEquals(TaskOutcome.UP_TO_DATE, second.outcome())
    }

    @Test
    fun `warnings do not fail the build, strict errors do`() {
        write("src/main/svg/overlap.svg", overlap)
        val lenient = build("convertSvg")
        assertTrue(lenient.output.contains("overlap.svg: [opacity-approximated]"), lenient.output)

        file("build.gradle.kts").appendText("\nsvgVectorDrawable { strict.set(true) }\n")
        val failed = runner("convertSvg").buildAndFail()
        assertEquals(TaskOutcome.FAILED, failed.outcome())
        assertTrue(failed.output.contains("overlap.svg: [opacity-approximated]"), failed.output)
    }

    @Test
    fun `passes extraArgs and minSdk to the CLI`() {
        file("build.gradle.kts").appendText(
            """

            svgVectorDrawable { extraArgs.set(listOf("--tint", "#FF0000")) }
            tasks.named<io.github.ibrahimdans.svgvd.SvgToVectorDrawableTask>("convertSvg") { minSdk.set(21) }
            """.trimIndent(),
        )
        write("src/main/svg/gradient.svg", GRADIENT)
        val result = build("convertSvg")
        assertTrue(File(drawable, "star.xml").readText().contains("android:tint=\"#FF0000\""))
        // Gradients need API 24: reported because minSdk is 21.
        assertTrue(result.output.contains("gradient.svg: [min-sdk-exceeded]"), result.output)

        file("build.gradle.kts").appendText("\ntasks.named<io.github.ibrahimdans.svgvd.SvgToVectorDrawableTask>(\"convertSvg\") { minSdk.set(24) }\n")
        assertEquals(TaskOutcome.SUCCESS, build("convertSvg").outcome(), "an input change reruns the task")
    }

    @Test
    fun `is skipped without sources`() {
        file("src/main/svg").deleteRecursively()
        assertEquals(TaskOutcome.NO_SOURCE, build("convertSvg").outcome())
    }

    @Test
    fun `runs before mergeDebugResources of an Android app, then is UP-TO-DATE`() {
        assumeTrue(System.getenv("ANDROID_HOME") != null, "ANDROID_HOME is not set")
        write(
            "settings.gradle.kts",
            """
            dependencyResolutionManagement { repositories { google(); mavenCentral() } }
            rootProject.name = "android-fixture"
            """.trimIndent(),
        )
        write(
            "build.gradle.kts",
            """
            plugins {
                id("com.android.application")
                id("io.github.ibrahimdans.svg-vectordrawable")
            }
            android {
                namespace = "dev.svgvd.fixture"
                compileSdk = 36
                defaultConfig { minSdk = 24 }
            }
            svgVectorDrawable { command.set(listOf("node", "${cli.replace("\\", "\\\\")}")) }
            """.trimIndent(),
        )
        write("src/main/AndroidManifest.xml", """<manifest xmlns:android="http://schemas.android.com/apk/res/android"/>""")
        write(
            "src/main/res/values/refs.xml",
            """<resources><item name="icon" type="drawable">@drawable/arrow_left</item></resources>""",
        )

        val first = build(":processDebugResources")
        assertEquals(TaskOutcome.SUCCESS, first.outcome(":convertDebugSvgToVectorDrawable"))
        val tasks = first.tasks.map { it.path }
        assertTrue(
            tasks.indexOf(":convertDebugSvgToVectorDrawable") < tasks.indexOf(":mergeDebugResources"),
            tasks.joinToString(),
        )
        // refs.xml points at @drawable/arrow_left: processDebugResources links only if it was generated.
        assertTrue(file("build/generated/res/convertDebugSvgToVectorDrawable/drawable/arrow_left.xml").isFile)

        val second = build(":processDebugResources")
        assertEquals(TaskOutcome.UP_TO_DATE, second.outcome(":convertDebugSvgToVectorDrawable"))
        assertEquals(TaskOutcome.UP_TO_DATE, second.outcome(":mergeDebugResources"))
    }

    private companion object {
        val GRADIENT = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><path fill="url(#g)" d="M2 2h20v20H2z"/></svg>"""
    }
}
