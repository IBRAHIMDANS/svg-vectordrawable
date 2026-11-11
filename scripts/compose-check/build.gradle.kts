// Standalone Gradle build (no wrapper: run it with Gradle 9.8, as the compose-check workflow does).
// Compiles the Kotlin written by toImageVector against Compose Multiplatform (desktop JVM artifacts)
// and runs a Main that builds every ImageVector. See generate.mjs.
plugins {
    kotlin("jvm") version "2.4.21"
    application
}

val compose = "1.12.2"

dependencies {
    implementation("org.jetbrains.compose.ui:ui-graphics-desktop:$compose")
    implementation("org.jetbrains.compose.ui:ui-unit-desktop:$compose")
    implementation("org.jetbrains.compose.ui:ui-desktop:$compose")
}

kotlin {
    jvmToolchain(21)
    // Icons and Main.kt written by generate.mjs (git-ignored), next to the hand-written sources.
    sourceSets.main { kotlin.srcDir("build/generated/kotlin") }
}

application {
    mainClass.set("check.MainKt")
    applicationDefaultJvmArgs = listOf("-Xmx1g", "-Djava.awt.headless=true")
}
