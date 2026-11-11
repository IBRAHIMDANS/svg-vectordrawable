// Gradle plugin that runs the `svgvd` CLI before the Android resource merge. The example Android app
// in example/ consumes it through `includeBuild("..")`.
rootProject.name = "svg-vectordrawable-gradle-plugin"

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
