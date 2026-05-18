cmake_minimum_required(VERSION 3.22.1)

project(substream_whisper)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)

include(FetchContent)
FetchContent_Declare(
    whispercpp
    GIT_REPOSITORY https://github.com/ggml-org/whisper.cpp.git
    GIT_TAG v1.7.6
)
FetchContent_MakeAvailable(whispercpp)

add_library(substream_whisper SHARED substream_whisper.cpp)

find_library(log-lib log)

target_include_directories(
    substream_whisper
    PRIVATE
        ${whispercpp_SOURCE_DIR}/include
        ${whispercpp_SOURCE_DIR}/ggml/include
)

target_link_libraries(
    substream_whisper
    PRIVATE
        whisper
        ${log-lib}
)
