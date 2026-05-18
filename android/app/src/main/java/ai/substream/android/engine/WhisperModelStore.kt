package ai.substream.android.engine

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

class WhisperModelStore(private val context: Context) {
    private val client = OkHttpClient.Builder()
        .callTimeout(10, TimeUnit.MINUTES)
        .build()

    suspend fun ensureModel(model: String, onStatus: (String) -> Unit): File = withContext(Dispatchers.IO) {
        val safeModel = if (model == "base") "base" else "tiny"
        val modelDir = File(context.filesDir, "models").apply { mkdirs() }
        val target = File(modelDir, "ggml-$safeModel.bin")
        if (target.exists() && target.length() > 1_000_000) {
            return@withContext target
        }

        val url = MODEL_URLS.getValue(safeModel)
        onStatus("Downloading Whisper $safeModel model")
        val request = Request.Builder().url(url).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IllegalStateException("Model download failed: HTTP ${response.code}")
            }

            val body = response.body ?: throw IllegalStateException("Model download returned no body")
            val temp = File(modelDir, "ggml-$safeModel.bin.part")
            body.byteStream().use { input ->
                temp.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            if (temp.length() <= 1_000_000) {
                temp.delete()
                throw IllegalStateException("Downloaded model is too small")
            }
            if (target.exists()) target.delete()
            temp.renameTo(target)
        }
        target
    }

    companion object {
        private val MODEL_URLS = mapOf(
            "tiny" to "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
            "base" to "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        )
    }
}
