plugins {
    id("com.android.application")
    id("io.github.ibrahimdans.svg-vectordrawable")
}

android {
    namespace = "io.github.ibrahimdans.svgvd.example"
    compileSdk = 36
    defaultConfig {
        applicationId = "io.github.ibrahimdans.svgvd.example"
        minSdk = 24
    }
}

svgVectorDrawable {
    // SVGs shared with the design team, at the repository root. `npx svgvd` runs in the root project
    // folder, where package.json installs svg-vectordrawable.
    sourceDir.set(rootProject.layout.projectDirectory.dir("design/icons"))
    strict.set(true)
}
