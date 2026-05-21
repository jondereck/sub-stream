package ai.substream.android.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.settingsDataStore by preferencesDataStore("substream_settings")

class SettingsStore(private val context: Context) {
    private object Keys {
        val Engine = stringPreferencesKey("engine")
        val BackendUrl = stringPreferencesKey("backend_url")
        val MobileToken = stringPreferencesKey("mobile_token")
        val LocalModel = stringPreferencesKey("local_model")
        val SourceLang = stringPreferencesKey("source_lang")
        val TargetLang = stringPreferencesKey("target_lang")
        val OverlayPosition = stringPreferencesKey("overlay_position")
        val FontSize = intPreferencesKey("font_size")
        val SubtitleMode = stringPreferencesKey("subtitle_mode")
        val ShowSourceFirst = booleanPreferencesKey("show_source_first")
        val TranslationDisplayMode = stringPreferencesKey("translation_display_mode")
        val TranslationGraceMs = longPreferencesKey("translation_grace_ms")
        val TranslationMode = stringPreferencesKey("translation_mode")
    }

    val settings: Flow<AppSettings> = context.settingsDataStore.data.map { prefs ->
        AppSettings(
            engine = EngineMode.fromWire(prefs[Keys.Engine]),
            backendUrl = prefs[Keys.BackendUrl] ?: AppSettings().backendUrl,
            mobileToken = prefs[Keys.MobileToken] ?: "",
            localModel = prefs[Keys.LocalModel] ?: "tiny",
            sourceLang = prefs[Keys.SourceLang] ?: "auto",
            targetLang = prefs[Keys.TargetLang] ?: "en",
            overlayPosition = OverlayPosition.fromWire(prefs[Keys.OverlayPosition]),
            fontSizeSp = prefs[Keys.FontSize] ?: 28,
            subtitleMode = SubtitleMode.fromWire(prefs[Keys.SubtitleMode]),
            showSourceFirst = prefs[Keys.ShowSourceFirst] ?: true,
            translationDisplayMode = TranslationDisplayMode.fromWire(prefs[Keys.TranslationDisplayMode]),
            translationGraceMs = prefs[Keys.TranslationGraceMs] ?: 200L,
            translationMode = TranslationMode.fromWire(prefs[Keys.TranslationMode]),
        )
    }

    suspend fun save(settings: AppSettings) {
        context.settingsDataStore.edit { prefs ->
            prefs[Keys.Engine] = settings.engine.wireValue
            prefs[Keys.BackendUrl] = settings.backendUrl.trim()
            prefs[Keys.MobileToken] = settings.mobileToken.trim()
            prefs[Keys.LocalModel] = settings.localModel
            prefs[Keys.SourceLang] = settings.sourceLang
            prefs[Keys.TargetLang] = settings.targetLang
            prefs[Keys.OverlayPosition] = settings.overlayPosition.wireValue
            prefs[Keys.FontSize] = settings.fontSizeSp
            prefs[Keys.SubtitleMode] = settings.subtitleMode.wireValue
            prefs[Keys.ShowSourceFirst] = settings.showSourceFirst
            prefs[Keys.TranslationDisplayMode] = settings.translationDisplayMode.wireValue
            prefs[Keys.TranslationGraceMs] = settings.translationGraceMs
            prefs[Keys.TranslationMode] = settings.translationMode.wireValue
        }
    }
}
