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
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch

private val AppBackground = Color(0xFF020605)
private val PanelBackground = Color(0xFF08100F)
private val CardBackground = Color(0xFF0D1715)
private val CardBackgroundStrong = Color(0xFF101D19)
private val Stroke = Color(0xFF20332E)
private val StrokeStrong = Color(0xFF2C453D)
private val Accent = Color(0xFF35DF86)
private val Warning = Color(0xFFFFB31A)
private val Danger = Color(0xFFFF6B6B)
private val TextPrimary = Color(0xFFF3FFF8)
private val TextMuted = Color(0xFFA7B5AE)

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
    var advancedOpen by remember { mutableStateOf(false) }

    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Accent,
            secondary = Warning,
            background = AppBackground,
            surface = PanelBackground,
            onPrimary = AppBackground,
            onSecondary = AppBackground,
            onBackground = TextPrimary,
            onSurface = TextPrimary,
        ),
    ) {
        Scaffold(containerColor = AppBackground) { innerPadding ->
            BoxWithConstraints(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .background(AppBackground),
            ) {
                val compact = maxWidth < 860.dp
                val scrollState = rememberScrollState()

                if (compact) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(scrollState)
                            .padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        MainSettingsPanel(
                            settings = settings,
                            status = status,
                            isCapturing = isCapturing,
                            overlayAllowed = overlayAllowed,
                            recordAllowed = recordAllowed,
                            compact = true,
                            advancedOpen = advancedOpen,
                            onSettingsChange = onSettingsChange,
                            onStart = onStart,
                            onStop = onStop,
                            onOpenOverlaySettings = onOpenOverlaySettings,
                            onAdvancedClick = { advancedOpen = !advancedOpen },
                        )
                        if (advancedOpen) {
                            AdvancedSettingsPanel(
                                settings = settings,
                                compact = true,
                                onSettingsChange = onSettingsChange,
                                onCollapse = { advancedOpen = false },
                            )
                        }
                    }
                } else {
                    Row(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(scrollState)
                            .padding(18.dp),
                        horizontalArrangement = Arrangement.spacedBy(20.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        MainSettingsPanel(
                            settings = settings,
                            status = status,
                            isCapturing = isCapturing,
                            overlayAllowed = overlayAllowed,
                            recordAllowed = recordAllowed,
                            compact = false,
                            advancedOpen = advancedOpen,
                            onSettingsChange = onSettingsChange,
                            onStart = onStart,
                            onStop = onStop,
                            onOpenOverlaySettings = onOpenOverlaySettings,
                            onAdvancedClick = { advancedOpen = !advancedOpen },
                            modifier = Modifier.widthIn(max = 540.dp).weight(1f),
                        )
                        if (advancedOpen) {
                            AdvancedSettingsPanel(
                                settings = settings,
                                compact = false,
                                onSettingsChange = onSettingsChange,
                                onCollapse = { advancedOpen = false },
                                modifier = Modifier.width(520.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MainSettingsPanel(
    settings: AppSettings,
    status: String,
    isCapturing: Boolean,
    overlayAllowed: Boolean,
    recordAllowed: Boolean,
    compact: Boolean,
    advancedOpen: Boolean,
    onSettingsChange: (AppSettings) -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onOpenOverlaySettings: () -> Unit,
    onAdvancedClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    PanelSurface(modifier) {
        AppHeader(status = if (isCapturing) "Live" else "Ready")
        HeroCard(
            status = status,
            isCapturing = isCapturing,
            recordAllowed = recordAllowed,
            overlayAllowed = overlayAllowed,
            onStart = onStart,
            onStop = onStop,
            onOpenOverlaySettings = onOpenOverlaySettings,
        )
        LanguagesCard(settings, compact, onSettingsChange)
        CaptionDisplayCard(settings, compact, onSettingsChange)
        AdvancedSummary(open = advancedOpen, onClick = onAdvancedClick)
    }
}

@Composable
private fun AdvancedSettingsPanel(
    settings: AppSettings,
    compact: Boolean,
    onSettingsChange: (AppSettings) -> Unit,
    onCollapse: () -> Unit,
    modifier: Modifier = Modifier,
) {
    PanelSurface(modifier) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("*", color = Accent, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "Advanced Settings",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Black,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text("Fine tune performance and behavior.", color = TextMuted)
            }
            TextButton(onClick = onCollapse) {
                Text("Collapse")
            }
        }

        Spacer(Modifier.height(18.dp))
        BackendCard(settings, onSettingsChange)
        EngineCard(settings, compact, onSettingsChange)
        LocalWhisperCard(settings, onSettingsChange)
        SubtitleModeCard(settings, compact, onSettingsChange)
        TranslationBehaviorCard(settings, compact, onSettingsChange)
        OverlayCard(settings, compact, onSettingsChange)
    }
}

@Composable
private fun AppHeader(status: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Surface(
            modifier = Modifier.size(58.dp),
            shape = RoundedCornerShape(14.dp),
            color = Color(0xFF071410),
            border = BorderStroke(1.dp, Color(0xFF0D7F49)),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text("SS", color = Accent, fontWeight = FontWeight.Black, style = MaterialTheme.typography.titleLarge)
            }
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                "Sub Stream AI *",
                color = TextPrimary,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Black,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text("Live translated captions", color = TextMuted)
        }
        StatusPill(status)
    }
}

@Composable
private fun HeroCard(
    status: String,
    isCapturing: Boolean,
    recordAllowed: Boolean,
    overlayAllowed: Boolean,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onOpenOverlaySettings: () -> Unit,
) {
    PanelCard(borderColor = Color(0xFF19834C)) {
        Button(
            onClick = if (isCapturing) onStop else onStart,
            colors = ButtonDefaults.buttonColors(
                containerColor = if (isCapturing) Danger else Accent,
                contentColor = if (isCapturing) Color.White else AppBackground,
            ),
            shape = RoundedCornerShape(13.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(66.dp),
        ) {
            Text(if (isCapturing) "Stop Captions" else ">  Start Captions", fontWeight = FontWeight.Black)
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    if (recordAllowed && overlayAllowed) "Ready for live captions" else "Permission required",
                    color = if (recordAllowed && overlayAllowed) Accent else Warning,
                    fontWeight = FontWeight.Black,
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(status, color = TextMuted)
            }
            if (!overlayAllowed) {
                OutlinedButton(
                    onClick = onOpenOverlaySettings,
                    border = BorderStroke(1.dp, Warning),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Warning),
                ) {
                    Text("Overlay")
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PermissionChip("Record audio", recordAllowed)
            PermissionChip("Overlay", overlayAllowed)
        }
    }
}

@Composable
private fun LanguagesCard(
    settings: AppSettings,
    compact: Boolean,
    onSettingsChange: (AppSettings) -> Unit,
) {
    PanelCard {
        SectionTitle("o", "Languages")
        ResponsiveRow(compact) {
            OutlinedTextField(
                value = settings.sourceLang,
                onValueChange = { onSettingsChange(settings.copy(sourceLang = it.lowercase())) },
                label = { Text("From") },
                singleLine = true,
                modifier = Modifier.responsiveWeight(compact),
            )
            OutlinedTextField(
                value = settings.targetLang,
                onValueChange = { onSettingsChange(settings.copy(targetLang = it.lowercase())) },
                label = { Text("To") },
                singleLine = true,
                modifier = Modifier.responsiveWeight(compact),
            )
        }
        Text("Use auto, en, ja, ko, zh, es, fr, de, fil, and other backend-supported codes.", color = TextMuted)
    }
}

@Composable
private fun CaptionDisplayCard(
    settings: AppSettings,
    compact: Boolean,
    onSettingsChange: (AppSettings) -> Unit,
) {
    PanelCard {
        SectionTitle("CC", "Caption Display")
        ResponsiveRow(compact) {
            Column(modifier = Modifier.responsiveWeight(compact)) {
                Text("Font size: ${settings.fontSizeSp}sp", color = TextPrimary, fontWeight = FontWeight.SemiBold)
                Slider(
                    value = settings.fontSizeSp.toFloat(),
                    onValueChange = { onSettingsChange(settings.copy(fontSizeSp = it.toInt())) },
                    valueRange = 18f..42f,
                )
            }
            Column(modifier = Modifier.responsiveWeight(compact)) {
                Text("Position", color = TextPrimary, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ChoiceChip("Bottom", settings.overlayPosition == OverlayPosition.Bottom) {
                        onSettingsChange(settings.copy(overlayPosition = OverlayPosition.Bottom))
                    }
                    ChoiceChip("Top", settings.overlayPosition == OverlayPosition.Top) {
                        onSettingsChange(settings.copy(overlayPosition = OverlayPosition.Top))
                    }
                }
            }
        }
    }
}

@Composable
private fun BackendCard(settings: AppSettings, onSettingsChange: (AppSettings) -> Unit) {
    PanelCard {
        SectionTitle("=", "Backend")
        OutlinedTextField(
            value = settings.backendUrl,
            onValueChange = { onSettingsChange(settings.copy(backendUrl = it)) },
            label = { Text("Backend URL") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = settings.mobileToken,
            onValueChange = { onSettingsChange(settings.copy(mobileToken = it)) },
            label = { Text("Mobile token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Use ws://<PC-LAN-IP>:8765/ws. Keep OPENAI_API_KEY only on the backend.", color = TextMuted)
    }
}

@Composable
private fun EngineCard(
    settings: AppSettings,
    compact: Boolean,
    onSettingsChange: (AppSettings) -> Unit,
) {
    PanelCard {
        SectionTitle("*", "Engine")
        ResponsiveRow(compact) {
            ChoiceChip("Cloud Realtime", settings.engine == EngineMode.CloudRealtime) {
                onSettingsChange(settings.copy(engine = EngineMode.CloudRealtime))
            }
            ChoiceChip("Realtime Translate", settings.engine == EngineMode.RealtimeTranslate) {
                onSettingsChange(settings.copy(engine = EngineMode.RealtimeTranslate))
            }
            ChoiceChip("Local Whisper", settings.engine == EngineMode.LocalWhisper) {
                onSettingsChange(settings.copy(engine = EngineMode.LocalWhisper))
            }
        }
    }
}

@Composable
private fun LocalWhisperCard(settings: AppSettings, onSettingsChange: (AppSettings) -> Unit) {
    PanelCard {
        SectionTitle("LW", "Local Whisper")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ChoiceChip("tiny", settings.localModel == "tiny") {
                onSettingsChange(settings.copy(localModel = "tiny"))
            }
            ChoiceChip("base", settings.localModel == "base") {
                onSettingsChange(settings.copy(localModel = "base"))
            }
        }
        Text("Local mode downloads whisper.cpp ggml models on first use.", color = TextMuted)
    }
}

@Composable
private fun SubtitleModeCard(
    settings: AppSettings,
    compact: Boolean,
    onSettingsChange: (AppSettings) -> Unit,
) {
    PanelCard {
        SectionTitle("~", "Subtitle Mode")
        ResponsiveRow(compact) {
            ChoiceChip("Fast", settings.subtitleMode == SubtitleMode.Fast) {
                onSettingsChange(settings.copy(subtitleMode = SubtitleMode.Fast))
            }
            ChoiceChip("Balanced", settings.subtitleMode == SubtitleMode.Balanced) {
                onSettingsChange(settings.copy(subtitleMode = SubtitleMode.Balanced))
            }
            ChoiceChip("Accurate", settings.subtitleMode == SubtitleMode.Accurate) {
                onSettingsChange(settings.copy(subtitleMode = SubtitleMode.Accurate))
            }
        }
        Text("Fast updates sooner. Balanced adds a small subtitle delay. Accurate waits for cleaner context.", color = TextMuted)
    }
}

@Composable
private fun TranslationBehaviorCard(
    settings: AppSettings,
    compact: Boolean,
    onSettingsChange: (AppSettings) -> Unit,
) {
    PanelCard {
        SectionTitle("T", "Translation Behavior")
        ResponsiveRow(compact) {
            ChoiceChip("Auto", settings.translationMode == TranslationMode.Auto) {
                onSettingsChange(settings.copy(translationMode = TranslationMode.Auto))
            }
            ChoiceChip("Filipino-English", settings.translationMode == TranslationMode.FilipinoEnglish) {
                onSettingsChange(settings.copy(translationMode = TranslationMode.FilipinoEnglish))
            }
        }
        ResponsiveRow(compact) {
            ChoiceChip("Replace", settings.translationDisplayMode == TranslationDisplayMode.TranslationReplace) {
                onSettingsChange(settings.copy(translationDisplayMode = TranslationDisplayMode.TranslationReplace))
            }
            ChoiceChip("Dual", settings.translationDisplayMode == TranslationDisplayMode.TranslationDual) {
                onSettingsChange(settings.copy(translationDisplayMode = TranslationDisplayMode.TranslationDual))
            }
            ChoiceChip("Source first", settings.showSourceFirst) {
                onSettingsChange(settings.copy(showSourceFirst = !settings.showSourceFirst))
            }
        }
        Text("Translation grace: ${settings.translationGraceMs}ms", color = TextPrimary, fontWeight = FontWeight.SemiBold)
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
}

@Composable
private fun OverlayCard(
    settings: AppSettings,
    compact: Boolean,
    onSettingsChange: (AppSettings) -> Unit,
) {
    PanelCard {
        SectionTitle("[]", "Overlay")
        ResponsiveRow(compact) {
            ChoiceChip("Bottom", settings.overlayPosition == OverlayPosition.Bottom) {
                onSettingsChange(settings.copy(overlayPosition = OverlayPosition.Bottom))
            }
            ChoiceChip("Top", settings.overlayPosition == OverlayPosition.Top) {
                onSettingsChange(settings.copy(overlayPosition = OverlayPosition.Top))
            }
        }
        Text("Font size: ${settings.fontSizeSp}sp", color = TextPrimary, fontWeight = FontWeight.SemiBold)
        Slider(
            value = settings.fontSizeSp.toFloat(),
            onValueChange = { onSettingsChange(settings.copy(fontSizeSp = it.toInt())) },
            valueRange = 18f..42f,
        )
    }
}

@Composable
private fun AdvancedSummary(open: Boolean, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        colors = CardDefaults.cardColors(containerColor = CardBackground),
        border = BorderStroke(1.dp, if (open) Accent else Stroke),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(18.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("*", color = Accent, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
            Column(modifier = Modifier.weight(1f)) {
                Text("Advanced Settings", color = TextPrimary, fontWeight = FontWeight.Black, style = MaterialTheme.typography.titleMedium)
                Text("Latency, backend and behavior options", color = TextMuted)
            }
            Text(if (open) "^" else "v", color = TextPrimary, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun PanelSurface(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = PanelBackground),
        border = BorderStroke(1.dp, Color(0xFF23362F)),
        shape = RoundedCornerShape(18.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            content = content,
        )
    }
}

@Composable
private fun PanelCard(
    modifier: Modifier = Modifier,
    borderColor: Color = Stroke,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(containerColor = CardBackground),
        border = BorderStroke(1.dp, borderColor),
        shape = RoundedCornerShape(16.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}

@Composable
private fun SectionTitle(icon: String, title: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Surface(
            shape = RoundedCornerShape(7.dp),
            color = CardBackgroundStrong,
            border = BorderStroke(1.dp, Accent),
        ) {
            Text(
                icon,
                modifier = Modifier.padding(horizontal = 7.dp, vertical = 4.dp),
                color = Accent,
                fontWeight = FontWeight.Black,
            )
        }
        Text(title, color = TextPrimary, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun StatusPill(status: String) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = Color.Transparent,
        border = BorderStroke(1.dp, Stroke),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(9.dp)
                    .background(Accent, RoundedCornerShape(999.dp)),
            )
            Text(status, color = TextPrimary, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun PermissionChip(label: String, allowed: Boolean) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = if (allowed) Color(0xFF0F211A) else Color(0xFF241B0D),
        border = BorderStroke(1.dp, if (allowed) Accent else Warning),
    ) {
        Text(
            text = "$label: ${if (allowed) "allowed" else "needed"}",
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
            color = if (allowed) Accent else Warning,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun ChoiceChip(label: String, selected: Boolean, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label) },
    )
}

@Composable
private fun ResponsiveRow(compact: Boolean, content: @Composable ColumnScope.() -> Unit) {
    if (compact) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    } else {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                content = content,
            )
        }
    }
}

private fun Modifier.responsiveWeight(compact: Boolean): Modifier {
    return if (compact) this.fillMaxWidth() else this.fillMaxWidth()
}
