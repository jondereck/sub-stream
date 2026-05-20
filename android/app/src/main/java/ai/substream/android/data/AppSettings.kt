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
) {
    val translateUrl: String
        get() = backendUrl.replace(Regex("/ws$"), "/translate").replace("ws://", "http://").replace("wss://", "https://")
}
