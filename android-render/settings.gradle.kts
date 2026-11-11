// Standalone Gradle build: renders the VectorDrawables generated from test/fixtures with Android's own
// graphics stack (layoutlib, via Paparazzi) on the JVM. See prepare.mjs for the full pipeline.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    // Provisions the JDK 21 toolchain (render/build.gradle.kts) when none is installed locally,
    // e.g. when the default java is a JRE without javac.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "android-render"
include(":render")
