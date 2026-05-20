package ai.substream.android.net

import ai.substream.android.data.AppSettings
import ai.substream.android.data.CaptionStage
import ai.substream.android.data.CaptionUpdate
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class CloudRealtimeClient(
    private val settings: AppSettings,
    private val onCaption: (CaptionUpdate) -> Unit,
    private val onStatus: (String) -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null

    fun connect(sampleRate: Int) {
        val request = Request.Builder().url(settings.backendUrl).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val config = JSONObject()
                    .put("type", "config")
                    .put("client", "android")
                    .put("token", settings.mobileToken)
                    .put("sampleRate", sampleRate)
                    .put("sourceLang", settings.sourceLang)
                    .put("targetLang", settings.targetLang)
                    .put("task", "translate")
                    .put("realtimeLatency", settings.subtitleMode.wireValue)
                    .put("partialEmitEnabled", settings.subtitleMode.partialTranslationEnabled)
                    .put("showSourceFirst", settings.showSourceFirst)
                    .put("translationDisplayMode", settings.translationDisplayMode.wireValue)
                    .put("translationGraceMs", settings.translationGraceMs)
                    .put("transcriber", "openai-realtime")
                webSocket.send(config.toString())
                onStatus("Cloud connected")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (msg.optString("type")) {
                    "transcript" -> onCaption(msg.toCaptionUpdate())
                    "error" -> onStatus(msg.optString("message", "Backend error"))
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onStatus("Cloud failed: ${t.message ?: "unknown error"}")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onStatus("Cloud closed")
            }
        })
    }

    fun sendPcm16(bytes: ByteArray) {
        socket?.send(ByteString.of(*bytes))
    }

    fun close() {
        socket?.close(1000, "capture stopped")
        socket = null
        client.dispatcher.executorService.shutdown()
    }

    private fun JSONObject.toCaptionUpdate(): CaptionUpdate {
        val phase = optString("phase")
        val stage = CaptionStage.fromWire(optString("stage"), phase)
        val chunkId = if (has("chunkId")) optString("chunkId") else ""
        val fallbackSegmentId = optString("captionId").ifBlank { chunkId }
        val update = CaptionUpdate(
            text = optString("text"),
            sourceText = optString("sourceText", optString("raw")),
            translatedText = optString("translatedText"),
            segmentId = optString("segmentId", fallbackSegmentId),
            chunkId = chunkId,
            stage = stage,
            phase = phase,
            transcriptEmittedAtMs = optDouble("transcriptEmittedAt", System.currentTimeMillis() / 1000.0)
                .times(1000)
                .toLong(),
            translationEmittedAtMs = if (has("translationEmittedAt")) {
                optDouble("translationEmittedAt").times(1000).toLong()
            } else {
                null
            },
            transcriptToTranslationDelayMs = if (has("transcriptToTranslationDelayMs")) {
                optLong("transcriptToTranslationDelayMs")
            } else {
                null
            },
        )
        if (stage == CaptionStage.Translation) {
            Log.d(
                TAG,
                "translation emitted segmentId=${update.segmentId} chunkId=${update.chunkId} delayMs=${update.transcriptToTranslationDelayMs}",
            )
        } else if (update.text.isNotBlank()) {
            Log.d(TAG, "transcript emitted segmentId=${update.segmentId} chunkId=${update.chunkId} phase=$phase")
        }
        return update
    }

    companion object {
        private const val TAG = "SubStreamCloud"
    }
}
