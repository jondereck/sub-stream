package ai.substream.android.engine

import ai.substream.android.audio.PcmUtils
import ai.substream.android.data.AppSettings
import ai.substream.android.data.CaptionStage
import ai.substream.android.data.CaptionUpdate
import ai.substream.android.net.BackendTranslator
import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class LocalWhisperEngine(
    context: Context,
    private val settings: AppSettings,
    private val onCaption: (CaptionUpdate) -> Unit,
    private val onStatus: (String) -> Unit,
) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val chunks = Channel<FloatArray>(capacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val modelStore = WhisperModelStore(appContext)
    private val nativeLock = Any()
    private var pcmBuffer = ByteArray(0)
    private var contextPtr = 0L
    private var ready = false
    private var segmentSeq = 0

    fun start() {
        scope.launch {
            runCatching {
                NativeWhisperBridge.ensureLoaded()
                val modelFile = modelStore.ensureModel(settings.localModel, onStatus)
                onStatus("Loading local Whisper ${settings.localModel}")
                contextPtr = NativeWhisperBridge.initContext(modelFile.absolutePath)
                check(contextPtr != 0L) { "Whisper context failed to initialize" }
                ready = true
                onStatus("Local Whisper ready")
                consumeChunks()
            }.onFailure {
                onStatus("Local Whisper failed: ${it.message ?: "unknown error"}")
            }
        }
    }

    fun acceptPcm(pcm16Le: ByteArray) {
        if (pcm16Le.isEmpty()) return
        val chunkBytes = chunkMsForModel(settings.localModel) * PcmUtils.SAMPLE_RATE * 2 / 1000
        pcmBuffer = PcmUtils.appendBytes(pcmBuffer, pcm16Le, chunkBytes)
        if (pcmBuffer.size < chunkBytes) return

        if (PcmUtils.rms(pcmBuffer) < SILENCE_RMS) {
            pcmBuffer = ByteArray(0)
            return
        }

        val samples = PcmUtils.toFloatSamples(pcmBuffer)
        pcmBuffer = ByteArray(0)
        chunks.trySend(samples)
    }

    fun close() {
        ready = false
        chunks.close()
        if (contextPtr != 0L) {
            synchronized(nativeLock) {
                NativeWhisperBridge.releaseContext(contextPtr)
            }
            contextPtr = 0L
        }
        scope.cancel()
    }

    private suspend fun consumeChunks() {
        val translator = BackendTranslator(settings)
        for (samples in chunks) {
            if (!ready || contextPtr == 0L) continue
            runCatching {
                val translateToEnglish = settings.targetLang == "en"
                val language = if (settings.sourceLang == "auto") "" else settings.sourceLang
                val raw = withContext(Dispatchers.Default) {
                    synchronized(nativeLock) {
                        if (contextPtr == 0L) "" else NativeWhisperBridge
                            .transcribe(contextPtr, samples, language, translateToEnglish)
                            .trim()
                    }
                }
                if (raw.isBlank()) {
                    return@runCatching
                }

                val segmentId = "local:${++segmentSeq}"
                val sourceEmittedAt = System.currentTimeMillis()
                val caption = if (translateToEnglish) {
                    raw
                } else {
                    if (settings.showSourceFirst) {
                        Log.d(TAG, "transcript emitted segmentId=$segmentId chunkId=$segmentSeq phase=source-preview")
                        onCaption(
                            CaptionUpdate(
                                text = raw,
                                sourceText = raw,
                                segmentId = segmentId,
                                chunkId = segmentSeq.toString(),
                                stage = CaptionStage.Source,
                                phase = "source-preview",
                                transcriptEmittedAtMs = sourceEmittedAt,
                            ),
                        )
                    }
                    onStatus("Translating through backend")
                    translator.translate(raw)
                }
                val translatedAt = System.currentTimeMillis()
                val stage = if (translateToEnglish) CaptionStage.Source else CaptionStage.Translation
                val phase = if (translateToEnglish) "source-final" else "translated-final"
                if (stage == CaptionStage.Translation) {
                    Log.d(
                        TAG,
                        "translation emitted segmentId=$segmentId chunkId=$segmentSeq delayMs=${translatedAt - sourceEmittedAt}",
                    )
                }
                onCaption(
                    CaptionUpdate(
                        text = caption,
                        sourceText = raw,
                        translatedText = if (stage == CaptionStage.Translation) caption else "",
                        segmentId = segmentId,
                        chunkId = segmentSeq.toString(),
                        stage = stage,
                        phase = phase,
                        transcriptEmittedAtMs = sourceEmittedAt,
                        translationEmittedAtMs = if (stage == CaptionStage.Translation) translatedAt else null,
                        transcriptToTranslationDelayMs = if (stage == CaptionStage.Translation) translatedAt - sourceEmittedAt else null,
                    ),
                )
            }.onFailure {
                onStatus("Local caption failed: ${it.message ?: "unknown error"}")
            }
        }
    }

    private fun chunkMsForModel(model: String): Int {
        return when (model) {
            "base" -> 900
            else -> 800
        }
    }

    companion object {
        private const val TAG = "SubStreamLocal"
        private const val SILENCE_RMS = 0.005f
    }
}
