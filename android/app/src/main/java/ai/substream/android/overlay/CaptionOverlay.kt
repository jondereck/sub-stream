package ai.substream.android.overlay

import ai.substream.android.data.AppSettings
import ai.substream.android.data.OverlayPosition
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import androidx.core.view.setPadding

class CaptionOverlay(private val context: Context) {
    private val windowManager = context.getSystemService(WindowManager::class.java)
    private var textView: TextView? = null
    private var params: WindowManager.LayoutParams? = null

    fun show(settings: AppSettings) {
        if (textView != null) {
            updateStyle(settings)
            return
        }

        val background = GradientDrawable().apply {
            setColor(Color.argb(215, 0, 0, 0))
            cornerRadius = 24f
        }

        val view = TextView(context).apply {
            text = "Sub Stream AI is listening..."
            textSize = settings.fontSizeSp.toFloat()
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(18)
            this.background = background
        }

        val overlayType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        val layoutParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            android.graphics.PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = gravityFor(settings.overlayPosition)
            x = 0
            y = 48
        }

        textView = view
        params = layoutParams
        windowManager.addView(view, layoutParams)
    }

    fun updateStyle(settings: AppSettings) {
        val view = textView ?: return
        view.textSize = settings.fontSizeSp.toFloat()
        params?.let {
            it.gravity = gravityFor(settings.overlayPosition)
            windowManager.updateViewLayout(view, it)
        }
    }

    fun updateCaption(text: String) {
        textView?.text = text.ifBlank { "..." }
    }

    fun updateStatus(status: String) {
        textView?.text = status
    }

    fun hide() {
        textView?.let { view -> runCatching { windowManager.removeView(view) } }
        textView = null
        params = null
    }

    private fun gravityFor(position: OverlayPosition): Int {
        return when (position) {
            OverlayPosition.Top -> Gravity.TOP or Gravity.CENTER_HORIZONTAL
            OverlayPosition.Bottom -> Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
        }
    }
}
