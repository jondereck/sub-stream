package ai.substream.android.net

import ai.substream.android.data.AppSettings
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
    private val onCaption: (String) -> Unit,
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
                    .put("transcriber", "openai-realtime")
                webSocket.send(config.toString())
                onStatus("Cloud connected")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (msg.optString("type")) {
                    "transcript" -> onCaption(msg.optString("text"))
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
}
