package ai.substream.android

import ai.substream.android.data.AppSettings
import ai.substream.android.data.EngineMode
import ai.substream.android.data.OverlayPosition
import ai.substream.android.data.SettingsStore
import ai.substream.android.data.SubtitleMode
import ai.substream.android.data.TranslationDisplayMode
import ai.substream.android.data.TranslationMode
import ai.substream.android.service.CaptureService
import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = SettingsStore(applicationContext)

        setContent {
            val activity = this@MainActivity
            val scope = rememberCoroutineScope()
            val settings by store.settings.collectAsState(initial = AppSettings())
            var status by remember { mutableStateOf("Ready") }
            var isCapturing by remember { mutableStateOf(false) }

            val mediaProjectionLauncher = rememberLauncherForActivityResult(
                ActivityResultContracts.StartActivityForResult(),
            ) { result ->
                val data = result.data
                if (result.resultCode == Activity.RESULT_OK && data != null) {
                    CaptureService.start(activity, settings, result.resultCode, data)
                    isCapturing = true
                    status = "Capture started"
                } else {
                    status = "Screen audio permission was cancelled."
                }
            }

            val recordPermissionLauncher = rememberLauncherForActivityResult(
                ActivityResultContracts.RequestPermission(),
            ) { granted ->
                status = if (granted) "Microphone permission granted. Start again." else "RECORD_AUDIO is required."
            }

            val notificationPermissionLauncher = rememberLauncherForActivityResult(
                ActivityResultContracts.RequestPermission(),
            ) { granted ->
                status = if (granted) "Notification permission granted. Start again." else "Notification permission denied."
            }

            fun save(next: AppSettings) {
                scope.launch { store.save(next) }
            }

            fun start() {
                if (!activity.hasPermission(Manifest.permission.RECORD_AUDIO)) {
                    recordPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    return
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                    !activity.hasPermission(Manifest.permission.POST_NOTIFICATIONS)
                ) {
                    notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    return
                }

                if (!Settings.canDrawOverlays(activity)) {
                    status = "Allow display over other apps, then start again."
                    activity.startActivity(
                        Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:${activity.packageName}"),
                        ),
                    )
                    return
                }

                val projectionManager = activity.getSystemService(MediaProjectionManager::class.java)
                mediaProjectionLauncher.launch(projectionManager.createScreenCaptureIntent())
            }

            SubStreamScreen(
                settings = settings,
                status = status,
                isCapturing = isCapturing,
                overlayAllowed = Settings.canDrawOverlays(activity),
                recordAllowed = activity.hasPermission(Manifest.permission.RECORD_AUDIO),
                onSettingsChange = ::save,
                onStart = ::start,
                onStop = {
                    CaptureService.stop(activity)
                    isCapturing = false
                    status = "Capture stopped"
                },
                onOpenOverlaySettings = {
                    activity.startActivity(
                        Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:${activity.packageName}"),
                        ),
                    )
                },
            )
        }
    }

    private fun hasPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
    }
}

@Composable
private fun SubStreamScreen(
    settings: AppSettings,
    status: String,
    isCapturing: Boolean,
    overlayAllowed: Boolean,
    recordAllowed: Boolean,
    onSettingsChange: (AppSettings) -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onOpenOverlaySettings: () -> Unit,
) {
    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.copy(
            primary = Color(0xFF0F766E),
            secondary = Color(0xFFF97316),
            background = Color(0xFFF7F4EE),
            surface = Color(0xFFFFFBF4),
        ),
    ) {
        Scaffold { innerPadding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text("Sub Stream AI", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text(
                    "Android capture for app audio subtitles. Cloud is closest to live; Local Whisper works offline with tiny/base models.",
                    style = MaterialTheme.typography.bodyMedium,
                )

                StatusCard(status, isCapturing, recordAllowed, overlayAllowed, onStart, onStop, onOpenOverlaySettings)

                SettingsCard("Engine") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        EngineChip("Realtime Translate", settings.engine == EngineMode.RealtimeTranslate) {
                            onSettingsChange(settings.copy(engine = EngineMode.RealtimeTranslate))
                        }
                        EngineChip("Cloud Realtime", settings.engine == EngineMode.CloudRealtime) {
                            onSettingsChange(settings.copy(engine = EngineMode.CloudRealtime))
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        EngineChip("Local Whisper", settings.engine == EngineMode.LocalWhisper) {
                            onSettingsChange(settings.copy(engine = EngineMode.LocalWhisper))
                        }
                    }
                }

                SettingsCard("Backend") {
                    OutlinedTextField(
                        value = settings.backendUrl,
                        onValueChange = { onSettingsChange(settings.copy(backendUrl = it)) },
                        label = { Text("WebSocket URL") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = settings.mobileToken,
                        onValueChange = { onSettingsChange(settings.copy(mobileToken = it)) },
                        label = { Text("Mobile token") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        "Use ws://<PC-LAN-IP>:8765/ws. Keep OPENAI_API_KEY only on the backend.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                SettingsCard("Languages") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = settings.sourceLang,
                            onValueChange = { onSettingsChange(settings.copy(sourceLang = it.lowercase())) },
                            label = { Text("Source") },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        OutlinedTextField(
                            value = settings.targetLang,
                            onValueChange = { onSettingsChange(settings.copy(targetLang = it.lowercase())) },
                            label = { Text("Target") },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    Text("Use auto, en, ja, ko, zh, es, fr, de, fil, and other backend-supported codes.")
                }

                SettingsCard("Local Whisper") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        EngineChip("tiny", settings.localModel == "tiny") {
                            onSettingsChange(settings.copy(localModel = "tiny"))
                        }
                        EngineChip("base", settings.localModel == "base") {
                            onSettingsChange(settings.copy(localModel = "base"))
                        }
                    }
                    Text(
                        "Local mode downloads whisper.cpp ggml models on first use. Non-English target translation needs the backend.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                SettingsCard("Subtitle Mode") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        EngineChip("Fast", settings.subtitleMode == SubtitleMode.Fast) {
                            onSettingsChange(settings.copy(subtitleMode = SubtitleMode.Fast))
                        }
                        EngineChip("Balanced", settings.subtitleMode == SubtitleMode.Balanced) {
                            onSettingsChange(settings.copy(subtitleMode = SubtitleMode.Balanced))
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        EngineChip("Accurate", settings.subtitleMode == SubtitleMode.Accurate) {
                            onSettingsChange(settings.copy(subtitleMode = SubtitleMode.Accurate))
                        }
                    }
                    Text(
                        "Fast updates sooner. Balanced adds a small subtitle delay. Accurate waits for cleaner context.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                SettingsCard("Translation Display") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        EngineChip("Auto", settings.translationMode == TranslationMode.Auto) {
                            onSettingsChange(settings.copy(translationMode = TranslationMode.Auto))
                        }
                        EngineChip("Filipino-English", settings.translationMode == TranslationMode.FilipinoEnglish) {
                            onSettingsChange(settings.copy(translationMode = TranslationMode.FilipinoEnglish))
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        EngineChip("Replace", settings.translationDisplayMode == TranslationDisplayMode.TranslationReplace) {
                            onSettingsChange(settings.copy(translationDisplayMode = TranslationDisplayMode.TranslationReplace))
                        }
                        EngineChip("Dual", settings.translationDisplayMode == TranslationDisplayMode.TranslationDual) {
                            onSettingsChange(settings.copy(translationDisplayMode = TranslationDisplayMode.TranslationDual))
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        EngineChip("Source first", settings.showSourceFirst) {
                            onSettingsChange(settings.copy(showSourceFirst = !settings.showSourceFirst))
                        }
                    }
                    Text("Grace: ${settings.translationGraceMs}ms")
                    Slider(
                        value = settings.translationGraceMs.toFloat(),
                        onValueChange = {
                            val rounded = (it / 50f).toInt() * 50L
                            onSettingsChange(settings.copy(translationGraceMs = rounded.coerceIn(0L, 2_000L)))
                        },
                        valueRange = 0f..2_000f,
                        steps = 39,
                    )
                }

                SettingsCard("Overlay") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        EngineChip("Bottom", settings.overlayPosition == OverlayPosition.Bottom) {
                            onSettingsChange(settings.copy(overlayPosition = OverlayPosition.Bottom))
                        }
                        EngineChip("Top", settings.overlayPosition == OverlayPosition.Top) {
                            onSettingsChange(settings.copy(overlayPosition = OverlayPosition.Top))
                        }
                    }
                    Text("Font size: ${settings.fontSizeSp}sp")
                    Slider(
                        value = settings.fontSizeSp.toFloat(),
                        onValueChange = { onSettingsChange(settings.copy(fontSizeSp = it.toInt())) },
                        valueRange = 18f..42f,
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusCard(
    status: String,
    isCapturing: Boolean,
    recordAllowed: Boolean,
    overlayAllowed: Boolean,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onOpenOverlaySettings: () -> Unit,
) {
    SettingsCard("Live Status") {
        Text(status, fontWeight = FontWeight.SemiBold)
        Text("Record audio: ${if (recordAllowed) "allowed" else "needed"}")
        Text("Overlay: ${if (overlayAllowed) "allowed" else "needed"}")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = if (isCapturing) onStop else onStart) {
                Text(if (isCapturing) "Stop Capture" else "Start Capture")
            }
            TextButton(onClick = onOpenOverlaySettings) {
                Text("Overlay Permission")
            }
        }
    }
}

@Composable
private fun SettingsCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            content()
        }
    }
}

@Composable
private fun EngineChip(label: String, selected: Boolean, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label) },
    )
}
