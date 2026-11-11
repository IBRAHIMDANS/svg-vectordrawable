import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    `kotlin-dsl`
    id("com.gradle.plugin-publish") version "2.2.1"
}

group = "io.github.ibrahimdans"
version = "0.1.0"

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

val agpVersion = "9.4.1"

// The Android Gradle plugin injected next to this plugin in TestKit builds: plugins injected with
// withPluginClasspath() cannot see classes of plugins resolved by the test build itself.
val testKitAndroidPlugin = configurations.create("testKitAndroidPlugin")

dependencies {
    // Only the public variant API; the Android Gradle plugin itself comes from the consuming build.
    compileOnly("com.android.tools.build:gradle-api:$agpVersion")
    testKitAndroidPlugin("com.android.tools.build:gradle:$agpVersion")

    testImplementation(platform("org.junit:junit-bom:5.13.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

gradlePlugin {
    website = "https://github.com/IBRAHIMDANS/svg-vectordrawable/tree/main/integrations/gradle-plugin"
    vcsUrl = "https://github.com/IBRAHIMDANS/svg-vectordrawable.git"
    plugins {
        create("svgVectorDrawable") {
            id = "io.github.ibrahimdans.svg-vectordrawable"
            implementationClass = "io.github.ibrahimdans.svgvd.SvgVectorDrawablePlugin"
            displayName = "SVG to Android VectorDrawable"
            description =
                "Converts a folder of SVGs into Android VectorDrawable resources with the svg-vectordrawable CLI " +
                "(Node.js), before the resource merge of every Android variant. Cacheable and incremental."
            tags = listOf("android", "svg", "vectordrawable", "drawable", "resources")
        }
    }
}

tasks.validatePlugins { enableStricterValidation = true }

tasks.pluginUnderTestMetadata { pluginClasspath.from(testKitAndroidPlugin) }

// TestKit functional tests (src/test) drive the real `svgvd` CLI installed in example/node_modules.
val svgvdCli = layout.projectDirectory.file("example/node_modules/svg-vectordrawable/dist/cli.js")

tasks.test {
    useJUnitPlatform()
    systemProperty("svgvd.cli", svgvdCli.asFile.absolutePath)
    inputs.file(svgvdCli).withPathSensitivity(PathSensitivity.NONE).withPropertyName("svgvdCli")
    testLogging { events("passed", "failed", "skipped"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
