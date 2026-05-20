package ai.substream.android.data

enum class EngineMode(val wireValue: String) {
    CloudRealtime("cloud-realtime"),
    LocalWhisper("local-whisper");

    companion object {
        fun fromWire(value: String?) = entries.firstOrNull { it.wireValue == value } ?: CloudRealtime
    }
}

enum class OverlayPosition(val wireValue: String) {
    Top("top"),
    Bottom("bottom");

    companion object {
        fun fromWire(value: String?) = entries.firstOrNull { it.wireValue == value } ?: Bottom
    }
}

enum class SubtitleMode(val wireValue: String) {
    Fast("fast"),
    Balanced("balanced"),
    Accurate("accurate");

    val partialTranslationEnabled: Boolean
        get() = this != Accurate

    companion object {
        fun fromWire(value: String?) = when (value?.lowercase()) {
            "fast" -> Fast
            "stable", "accurate" -> Accurate
            else -> Balanced
        }
    }
}

enum class TranslationDisplayMode(val wireValue: String) {
    TranslationReplace("translation_replace"),
    TranslationDual("translation_dual");

    companion object {
        fun fromWire(value: String?) = when (value?.lowercase()) {
            "translation_dual" -> TranslationDual
            else -> TranslationReplace
        }
    }
}

enum class CaptionStage {
    Source,
    Translation;

    companion object {
        fun fromWire(stage: String?, phase: String?) = when {
            stage.equals("translation", ignoreCase = true) -> Translation
            phase.orEmpty().startsWith("translated", ignoreCase = true) -> Translation
            else -> Source
        }
    }
}

data class CaptionUpdate(
    val text: String,
    val sourceText: String = text,
    val translatedText: String = "",
    val segmentId: String = "",
    val chunkId: String = "",
    val stage: CaptionStage = CaptionStage.Source,
    val phase: String = "",
    val receivedAtMs: Long? = null,
    val segmentStartTsMs: Long? = null,
    val segmentEndTsMs: Long? = null,
    val transcriptEmittedAtMs: Long = System.currentTimeMillis(),
    val translationEmittedAtMs: Long? = null,
    val transcriptToTranslationDelayMs: Long? = null,
)

data class AppSettings(
    val engine: EngineMode = EngineMode.CloudRealtime,
    val backendUrl: String = "ws://192.168.1.10:8765/ws",
    val mobileToken: String = "",
    val localModel: String = "tiny",
    val sourceLang: String = "auto",
    val targetLang: String = "en",
    val overlayPosition: OverlayPosition = OverlayPosition.Bottom,
    val fontSizeSp: Int = 28,
    val subtitleMode: SubtitleMode = SubtitleMode.Balanced,
    val showSourceFirst: Boolean = true,
    val translationDisplayMode: TranslationDisplayMode = TranslationDisplayMode.TranslationReplace,
    val translationGraceMs: Long = 200L,
) {
    val translateUrl: String
        get() = backendUrl.replace(Regex("/ws$"), "/translate").replace("ws://", "http://").replace("wss://", "https://")
}
