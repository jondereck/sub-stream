package ai.substream.android.audio

import android.Manifest
import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import androidx.annotation.RequiresPermission
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.max

class PlaybackAudioCapture(
    private val mediaProjection: MediaProjection,
    private val sampleRate: Int = PcmUtils.SAMPLE_RATE,
) {
    private var audioRecord: AudioRecord? = null
    private var job: Job? = null

    @SuppressLint("MissingPermission")
    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    fun start(
        scope: CoroutineScope,
        onAudio: suspend (ByteArray, Long) -> Unit,
        onStatus: (String) -> Unit,
    ) {
        stop()

        val captureConfig = AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .build()

        val audioFormat = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(sampleRate)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()

        val minBuffer = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuffer <= 0) {
            onStatus("Audio capture is unavailable on this device.")
            return
        }

        val readBufferSize = max(minBuffer, sampleRate / 5 * 2)
        val record = AudioRecord.Builder()
            .setAudioPlaybackCaptureConfig(captureConfig)
            .setAudioFormat(audioFormat)
            .setBufferSizeInBytes(readBufferSize * 2)
            .build()

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            onStatus("Audio capture failed to initialize.")
            return
        }

        audioRecord = record
        record.startRecording()
        onStatus("Capturing app audio")

        job = scope.launch(Dispatchers.IO) {
            val buffer = ByteArray(readBufferSize)
            while (isActive) {
                val read = record.read(buffer, 0, buffer.size)
                if (read > 0) {
                    onAudio(buffer.copyOf(read), System.currentTimeMillis())
                } else if (read == AudioRecord.ERROR_INVALID_OPERATION) {
                    onStatus("Audio capture blocked by the current app.")
                    break
                }
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        audioRecord?.runCatching { stop() }
        audioRecord?.release()
        audioRecord = null
    }
}
