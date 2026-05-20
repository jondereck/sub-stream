package ai.substream.android.service

import ai.substream.android.audio.PcmUtils
import ai.substream.android.audio.PlaybackAudioCapture
import ai.substream.android.data.AppSettings
import ai.substream.android.data.EngineMode
import ai.substream.android.data.OverlayPosition
import ai.substream.android.data.SubtitleMode
import ai.substream.android.engine.LocalWhisperEngine
import ai.substream.android.net.CloudRealtimeClient
import ai.substream.android.overlay.CaptionOverlay
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class CaptureService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var projection: MediaProjection? = null
    private var capture: PlaybackAudioCapture? = null
    private var overlay: CaptionOverlay? = null
    private var cloudClient: CloudRealtimeClient? = null
    private var localEngine: LocalWhisperEngine? = null
    private var activeSettings: AppSettings? = null
    private var pendingCaptionUpdate: Runnable? = null
    private var lastSilentStatusAt = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopCapture()
                stopSelf()
            }
            ACTION_START -> startCapture(intent)
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopCapture()
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun startCapture(intent: Intent) {
        stopCapture()
        ensureNotificationChannel(this)
        startForeground(NOTIFICATION_ID, buildNotification("Starting capture"))

        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        val resultData = intent.getParcelableExtraCompat<Intent>(EXTRA_RESULT_DATA)
        if (resultCode == 0 || resultData == null) {
            updateStatus("MediaProjection permission was not granted.")
            stopSelf()
            return
        }

        val settings = intent.toSettings()
        activeSettings = settings
        overlay = runCatching {
            CaptionOverlay(this).also { it.show(settings) }
        }.getOrElse {
            updateStatus("Overlay permission is required for captions.")
            stopSelf()
            return
        }
        updateStatus("Starting ${settings.engine.wireValue}")

        val projectionManager = getSystemService(MediaProjectionManager::class.java)
        projection = projectionManager.getMediaProjection(resultCode, resultData)?.also { mediaProjection ->
            mediaProjection.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    updateStatus("Screen audio capture stopped.")
                    projection = null
                    stopCapture(stopProjection = false)
                    stopSelf()
                }
            }, mainHandler)
        }

        val activeProjection = projection
        if (activeProjection == null) {
            updateStatus("MediaProjection could not start.")
            stopSelf()
            return
        }

        val captureSampleRate = if (settings.engine == EngineMode.CloudRealtime) {
            PcmUtils.REALTIME_SAMPLE_RATE
        } else {
            PcmUtils.SAMPLE_RATE
        }

        when (settings.engine) {
            EngineMode.CloudRealtime -> {
                cloudClient = CloudRealtimeClient(
                    settings = settings,
                    onCaption = ::updateCaption,
                    onStatus = ::updateStatus,
                ).also { it.connect(captureSampleRate) }
            }
            EngineMode.LocalWhisper -> {
                localEngine = LocalWhisperEngine(
                    context = this,
                    settings = settings,
                    onCaption = ::updateCaption,
                    onStatus = ::updateStatus,
                ).also { it.start() }
            }
        }

        capture = PlaybackAudioCapture(activeProjection, captureSampleRate).also { audioCapture ->
            audioCapture.start(
                scope = serviceScope,
                onAudio = audio@ { bytes, _ ->
                    if (PcmUtils.rms(bytes) < SILENCE_RMS) {
                        maybeShowSilentStatus()
                        updateCaption("")
                        return@audio
                    }
                    when (settings.engine) {
                        EngineMode.CloudRealtime -> cloudClient?.sendPcm16(bytes)
                        EngineMode.LocalWhisper -> localEngine?.acceptPcm(bytes)
                    }
                },
                onStatus = ::updateStatus,
            )
        }
    }

    private fun stopCapture(stopProjection: Boolean = true) {
        capture?.stop()
        capture = null
        cloudClient?.close()
        cloudClient = null
        localEngine?.close()
        localEngine = null
        pendingCaptionUpdate?.let { mainHandler.removeCallbacks(it) }
        pendingCaptionUpdate = null
        activeSettings = null
        if (stopProjection) {
            projection?.runCatching { stop() }
        }
        projection = null
        overlay?.hide()
        overlay = null
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    private fun maybeShowSilentStatus() {
        val now = System.currentTimeMillis()
        if (now - lastSilentStatusAt > 2_500) {
            lastSilentStatusAt = now
            updateStatus("No capturable audio. The video may be paused, silent, or blocked.")
        }
    }

    private fun updateCaption(text: String) {
        val delayMs = activeSettings?.subtitleMode?.captionDelayMs() ?: 0L
        pendingCaptionUpdate?.let { mainHandler.removeCallbacks(it) }
        val update = Runnable {
            overlay?.updateCaption(text)
        }
        pendingCaptionUpdate = update
        mainHandler.postDelayed(update, delayMs)
    }

    private fun updateStatus(status: String) {
        mainHandler.post {
            overlay?.updateStatus(status)
            val manager = getSystemService(NotificationManager::class.java)
            manager.notify(NOTIFICATION_ID, buildNotification(status))
        }
    }

    private fun buildNotification(status: String) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(ai.substream.android.R.drawable.ic_notification)
        .setContentTitle("Sub Stream AI")
        .setContentText(status)
        .setOngoing(true)
        .addAction(
            0,
            "Stop",
            PendingIntent.getService(
                this,
                1,
                Intent(this, CaptureService::class.java).setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .build()

    private fun Intent.toSettings(): AppSettings {
        return AppSettings(
            engine = EngineMode.fromWire(getStringExtra(EXTRA_ENGINE)),
            backendUrl = getStringExtra(EXTRA_BACKEND_URL) ?: AppSettings().backendUrl,
            mobileToken = getStringExtra(EXTRA_MOBILE_TOKEN) ?: "",
            localModel = getStringExtra(EXTRA_LOCAL_MODEL) ?: "tiny",
            sourceLang = getStringExtra(EXTRA_SOURCE_LANG) ?: "auto",
            targetLang = getStringExtra(EXTRA_TARGET_LANG) ?: "en",
            overlayPosition = OverlayPosition.fromWire(getStringExtra(EXTRA_OVERLAY_POSITION)),
            fontSizeSp = getIntExtra(EXTRA_FONT_SIZE, 28),
            subtitleMode = SubtitleMode.fromWire(getStringExtra(EXTRA_SUBTITLE_MODE)),
        )
    }

    private inline fun <reified T> Intent.getParcelableExtraCompat(name: String): T? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getParcelableExtra(name, T::class.java)
        } else {
            @Suppress("DEPRECATION")
            getParcelableExtra(name) as? T
        }
    }

    companion object {
        const val ACTION_START = "ai.substream.android.START_CAPTURE"
        const val ACTION_STOP = "ai.substream.android.STOP_CAPTURE"

        private const val CHANNEL_ID = "substream_capture"
        private const val NOTIFICATION_ID = 7104
        private const val SILENCE_RMS = 0.005f

        private const val EXTRA_RESULT_CODE = "result_code"
        private const val EXTRA_RESULT_DATA = "result_data"
        private const val EXTRA_ENGINE = "engine"
        private const val EXTRA_BACKEND_URL = "backend_url"
        private const val EXTRA_MOBILE_TOKEN = "mobile_token"
        private const val EXTRA_LOCAL_MODEL = "local_model"
        private const val EXTRA_SOURCE_LANG = "source_lang"
        private const val EXTRA_TARGET_LANG = "target_lang"
        private const val EXTRA_OVERLAY_POSITION = "overlay_position"
        private const val EXTRA_FONT_SIZE = "font_size"
        private const val EXTRA_SUBTITLE_MODE = "subtitle_mode"

        fun ensureNotificationChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Sub Stream AI capture",
                NotificationManager.IMPORTANCE_LOW,
            )
            manager.createNotificationChannel(channel)
        }

        fun start(
            context: Context,
            settings: AppSettings,
            resultCode: Int,
            resultData: Intent,
        ) {
            ensureNotificationChannel(context)
            val intent = Intent(context, CaptureService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, resultData)
                .putExtra(EXTRA_ENGINE, settings.engine.wireValue)
                .putExtra(EXTRA_BACKEND_URL, settings.backendUrl)
                .putExtra(EXTRA_MOBILE_TOKEN, settings.mobileToken)
                .putExtra(EXTRA_LOCAL_MODEL, settings.localModel)
                .putExtra(EXTRA_SOURCE_LANG, settings.sourceLang)
                .putExtra(EXTRA_TARGET_LANG, settings.targetLang)
                .putExtra(EXTRA_OVERLAY_POSITION, settings.overlayPosition.wireValue)
                .putExtra(EXTRA_FONT_SIZE, settings.fontSizeSp)
                .putExtra(EXTRA_SUBTITLE_MODE, settings.subtitleMode.wireValue)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, CaptureService::class.java).setAction(ACTION_STOP))
        }
    }
}

private fun SubtitleMode.captionDelayMs(): Long {
    return when (this) {
        SubtitleMode.Fast -> 0L
        SubtitleMode.Balanced -> 500L
        SubtitleMode.Accurate -> 900L
    }
}
