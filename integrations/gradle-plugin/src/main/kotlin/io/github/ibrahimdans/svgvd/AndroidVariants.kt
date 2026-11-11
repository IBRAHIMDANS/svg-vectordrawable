package io.github.ibrahimdans.svgvd

import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import com.android.build.api.variant.DynamicFeatureAndroidComponentsExtension
import com.android.build.api.variant.LibraryAndroidComponentsExtension
import com.android.build.api.variant.Variant
import org.gradle.api.Project

/** Android wiring, kept apart so that non-Android builds never load the Android Gradle plugin API. */
internal object AndroidVariants {
    fun wire(project: Project, pluginId: String) {
        val extensions = project.extensions
        when (pluginId) {
            "com.android.application" ->
                extensions.getByType(ApplicationAndroidComponentsExtension::class.java)
                    .onVariants { register(project, it) }
            "com.android.library" ->
                extensions.getByType(LibraryAndroidComponentsExtension::class.java)
                    .onVariants { register(project, it) }
            "com.android.dynamic-feature" ->
                extensions.getByType(DynamicFeatureAndroidComponentsExtension::class.java)
                    .onVariants { register(project, it) }
        }
    }

    private fun register(project: Project, variant: Variant) {
        val name = "convert${variant.name.replaceFirstChar(Char::titlecase)}SvgToVectorDrawable"
        val task = project.tasks.register(name, SvgToVectorDrawableTask::class.java) {
            minSdk.convention(variant.minSdk.apiLevel)
        }
        // AGP picks the output folder and runs the task before merge<Variant>Resources.
        variant.sources.res?.addGeneratedSourceDirectory(task, SvgToVectorDrawableTask::outputDir)
    }
}
