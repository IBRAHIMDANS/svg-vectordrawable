plugins {
    application
}

/** Latest stable `sdk-common` on Google Maven at the time of writing (= Android Gradle Plugin 9.4.1). */
val sdkCommonVersion = providers.gradleProperty("sdkCommonVersion").getOrElse("32.4.1")

dependencies {
    implementation("com.android.tools:sdk-common:$sdkCommonVersion")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

application {
    mainClass.set("Svg2VectorRunner")
    applicationDefaultJvmArgs = listOf("-Xmx1g", "-Djava.awt.headless=true")
}
