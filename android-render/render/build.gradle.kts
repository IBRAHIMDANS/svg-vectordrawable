plugins {
    id("com.android.library")
    id("app.cash.paparazzi")
}

android {
    namespace = "dev.svgvd.render"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
    }
}

// Inputs / outputs shared with the Node scripts (prepare.mjs writes the manifest, compare.mjs reads the PNGs).
val renderDir = rootProject.layout.buildDirectory.dir("render")

tasks.withType<Test>().configureEach {
    systemProperty("render.manifest", renderDir.get().file("fixtures.tsv").asFile.absolutePath)
    systemProperty("render.out", renderDir.get().dir("android").asFile.absolutePath)
    inputs.file(renderDir.map { it.file("fixtures.tsv") })
    outputs.dir(renderDir.map { it.dir("android") })
    testLogging { events("passed", "failed"); showStandardStreams = true }
}
