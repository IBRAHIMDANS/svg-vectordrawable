package dev.svgvd.render

import android.graphics.Bitmap
import android.graphics.Canvas
import app.cash.paparazzi.Paparazzi
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Renders every generated VectorDrawable (res/drawable, written by prepare.mjs) with Android's own
 * graphics stack — layoutlib's native Skia/hwui, the code that runs on devices — into a transparent
 * ARGB_8888 bitmap of the size listed in the manifest, and writes it as a PNG for compare.mjs.
 *
 * No golden is recorded or verified here: Paparazzi is only used to boot layoutlib and get a Context.
 */
class RenderTest {
    @get:Rule
    val paparazzi = Paparazzi()

    @Test
    fun renderGeneratedDrawables() {
        val manifest = File(requireNotNull(System.getProperty("render.manifest")) { "render.manifest not set" })
        check(manifest.isFile) { "$manifest is missing: run `node android-render/prepare.mjs` first" }
        val out = File(requireNotNull(System.getProperty("render.out")) { "render.out not set" })
        out.deleteRecursively()
        out.mkdirs()

        val entries = manifest.readLines().filter { it.isNotBlank() }.map { it.split('\t') }
        assertTrue("empty manifest $manifest", entries.isNotEmpty())
        for ((name, width, height) in entries) {
            val id = R.drawable::class.java.getField(name).getInt(null)
            val drawable = requireNotNull(paparazzi.context.getDrawable(id)) { "no drawable $name" }
            val w = width.toInt()
            val h = height.toInt()
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            drawable.setBounds(0, 0, w, h)
            drawable.draw(Canvas(bitmap))

            // getPixels returns unpremultiplied ARGB, which is what a TYPE_INT_ARGB PNG stores.
            val pixels = IntArray(w * h)
            bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
            val image = BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB)
            image.setRGB(0, 0, w, h, pixels, 0, w)
            ImageIO.write(image, "png", File(out, "$name.png"))
            println("rendered $name (${drawable.javaClass.simpleName}, ${w}x$h)")
        }
    }
}
