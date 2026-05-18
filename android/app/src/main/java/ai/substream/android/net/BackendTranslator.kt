package ai.substream.android.net

import ai.substream.android.data.AppSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class BackendTranslator(private val settings: AppSettings) {
    private val client = OkHttpClient.Builder()
        .callTimeout(15, TimeUnit.SECONDS)
        .build()

    suspend fun translate(text: String): String = withContext(Dispatchers.IO) {
        if (text.isBlank()) return@withContext text

        val payload = JSONObject()
            .put("text", text.take(MAX_TEXT_CHARS))
            .put("sourceLang", settings.sourceLang)
            .put("targetLang", settings.targetLang)
            .put("token", settings.mobileToken)
            .toString()

        val request = Request.Builder()
            .url(settings.translateUrl)
            .post(payload.toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IllegalStateException("Translate failed: HTTP ${response.code}")
            }
            val body = response.body?.string().orEmpty()
            JSONObject(body).optString("text", text)
        }
    }

    companion object {
        private const val MAX_TEXT_CHARS = 2_000
    }
}
