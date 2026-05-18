#include <jni.h>

#include <algorithm>
#include <string>
#include <thread>
#include <vector>

#include "whisper.h"

namespace {

std::string jstring_to_string(JNIEnv *env, jstring value) {
    if (value == nullptr) {
        return "";
    }
    const char *chars = env->GetStringUTFChars(value, nullptr);
    std::string out = chars == nullptr ? "" : chars;
    if (chars != nullptr) {
        env->ReleaseStringUTFChars(value, chars);
    }
    return out;
}

jstring string_to_jstring(JNIEnv *env, const std::string &value) {
    return env->NewStringUTF(value.c_str());
}

int worker_threads() {
    const auto hardware = static_cast<int>(std::thread::hardware_concurrency());
    return std::max(1, std::min(4, hardware <= 0 ? 2 : hardware));
}

} // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_ai_substream_android_engine_NativeWhisperBridge_initContext(
        JNIEnv *env,
        jclass,
        jstring model_path
) {
    const std::string path = jstring_to_string(env, model_path);
    if (path.empty()) {
        return 0;
    }

    whisper_context_params params = whisper_context_default_params();
    whisper_context *ctx = whisper_init_from_file_with_params(path.c_str(), params);
    return reinterpret_cast<jlong>(ctx);
}

extern "C" JNIEXPORT jstring JNICALL
Java_ai_substream_android_engine_NativeWhisperBridge_transcribe(
        JNIEnv *env,
        jclass,
        jlong context_ptr,
        jfloatArray pcm_array,
        jstring language_value,
        jboolean translate_to_english
) {
    auto *ctx = reinterpret_cast<whisper_context *>(context_ptr);
    if (ctx == nullptr || pcm_array == nullptr) {
        return string_to_jstring(env, "");
    }

    const jsize sample_count = env->GetArrayLength(pcm_array);
    if (sample_count <= 0) {
        return string_to_jstring(env, "");
    }

    std::vector<float> pcm(static_cast<size_t>(sample_count));
    env->GetFloatArrayRegion(pcm_array, 0, sample_count, pcm.data());

    std::string language = jstring_to_string(env, language_value);

    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.print_progress = false;
    params.print_realtime = false;
    params.print_timestamps = false;
    params.print_special = false;
    params.translate = translate_to_english == JNI_TRUE;
    params.no_context = true;
    params.single_segment = true;
    params.no_timestamps = true;
    params.suppress_blank = true;
    params.temperature = 0.0f;
    params.n_threads = worker_threads();
    params.language = language.empty() ? nullptr : language.c_str();

    const int result = whisper_full(ctx, params, pcm.data(), static_cast<int>(pcm.size()));
    if (result != 0) {
        return string_to_jstring(env, "");
    }

    const int segments = whisper_full_n_segments(ctx);
    std::string text;
    for (int i = 0; i < segments; ++i) {
        const char *segment = whisper_full_get_segment_text(ctx, i);
        if (segment != nullptr) {
            text += segment;
        }
    }
    return string_to_jstring(env, text);
}

extern "C" JNIEXPORT void JNICALL
Java_ai_substream_android_engine_NativeWhisperBridge_releaseContext(
        JNIEnv *,
        jclass,
        jlong context_ptr
) {
    auto *ctx = reinterpret_cast<whisper_context *>(context_ptr);
    if (ctx != nullptr) {
        whisper_free(ctx);
    }
}
