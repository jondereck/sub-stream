package ai.substream.android.engine

class NativeWhisperBridge private constructor() {
    companion object {
        private val loadError = runCatching {
            System.loadLibrary("substream_whisper")
        }.exceptionOrNull()

        fun ensureLoaded() {
            loadError?.let {
                throw IllegalStateException("Local Whisper native library failed to load: ${it.message}", it)
            }
        }

        @JvmStatic
        external fun initContext(modelPath: String): Long

        @JvmStatic
        external fun transcribe(
            contextPtr: Long,
            pcm: FloatArray,
            language: String,
            translateToEnglish: Boolean,
        ): String

        @JvmStatic
        external fun releaseContext(contextPtr: Long)
    }
}
