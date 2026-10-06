// Standalone Gradle build (own wrapper): a tiny JVM runner around Android Studio's SVG importer,
// com.android.ide.common.vectordrawable.Svg2Vector. See README.md.
plugins {
    // Provisions a JDK 21 toolchain when none is installed locally.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "svg2vector-runner"
