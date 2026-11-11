package check

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

// Shape written by gradient() in src/compose.ts for android:type="sweep", which no SVG produces.
val Sweep: ImageVector by lazy {
    ImageVector.Builder(
        name = "Sweep",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(
            fill = Brush.sweepGradient(
                0f to Color(0xFFFF0000),
                1f to Color(0x800000FF),
                center = Offset(12f, 12f),
            ),
        ) {
            moveTo(0f, 0f)
            lineTo(24f, 24f)
            close()
        }
    }.build()
}
