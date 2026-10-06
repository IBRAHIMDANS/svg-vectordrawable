// Standalone Gradle build: renders the VectorDrawables generated from test/fixtures with Android's own
// graphics stack (layoutlib, via Paparazzi) on the JVM. See prepare.mjs for the full pipeline.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
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
