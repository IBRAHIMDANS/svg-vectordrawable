// Example Android app using the plugin from the parent folder. In a real project, drop `includeBuild`
// and declare the published plugin version in the `plugins {}` block of app/build.gradle.kts.
pluginManagement {
    includeBuild("..")
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

rootProject.name = "svg-vectordrawable-example"
include(":app")
