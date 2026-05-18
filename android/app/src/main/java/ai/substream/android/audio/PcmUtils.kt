package ai.substream.android.audio

import kotlin.math.min
import kotlin.math.sqrt

object PcmUtils {
    const val SAMPLE_RATE = 16_000
    const val REALTIME_SAMPLE_RATE = 24_000
    private const val BYTES_PER_SAMPLE = 2

    fun rms(pcm16Le: ByteArray, size: Int = pcm16Le.size): Float {
        val sampleCount = size / BYTES_PER_SAMPLE
        if (sampleCount == 0) return 0f

        var sum = 0.0
        var index = 0
        repeat(sampleCount) {
            val lo = pcm16Le[index].toInt() and 0xff
            val hi = pcm16Le[index + 1].toInt()
            val sample = ((hi shl 8) or lo).toShort().toFloat() / Short.MAX_VALUE
            sum += sample * sample
            index += BYTES_PER_SAMPLE
        }
        return sqrt(sum / sampleCount).toFloat()
    }

    fun toFloatSamples(pcm16Le: ByteArray, size: Int = pcm16Le.size): FloatArray {
        val sampleCount = size / BYTES_PER_SAMPLE
        val out = FloatArray(sampleCount)
        var source = 0
        for (i in 0 until sampleCount) {
            val lo = pcm16Le[source].toInt() and 0xff
            val hi = pcm16Le[source + 1].toInt()
            out[i] = ((hi shl 8) or lo).toShort().toFloat() / Short.MAX_VALUE
            source += BYTES_PER_SAMPLE
        }
        return out
    }

    fun appendBytes(current: ByteArray, incoming: ByteArray, maxBytes: Int): ByteArray {
        if (incoming.isEmpty()) return current
        val merged = current + incoming
        if (merged.size <= maxBytes) return merged
        return merged.copyOfRange(merged.size - min(merged.size, maxBytes), merged.size)
    }
}
