# theDAW's VST3 hosting layer.
#
# Two ways to build this:
#   * add_subdirectory(src/vst3) from native/vst-host/CMakeLists.txt — you get the
#     `thedaw_vst3` static library and nothing else;
#   * configure THIS directory as the top-level project — you get the library plus the
#     vst3_probe CLI, which is how the layer is exercised against real plugins without the
#     rest of the host existing.
#
#   cmake -S native/vst-host/src/vst3 -B build/vst-host-vst3-probe -G "Visual Studio 17 2022" -A x64
#   cmake --build build/vst-host-vst3-probe --config Release
#
# Name the Visual Studio generator you have installed: -A is accepted only by the
# Visual Studio generators, and a CMake whose default is Ninja rejects it.

cmake_minimum_required(VERSION 3.20)

if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    project(thedaw_vst3_standalone LANGUAGES CXX)
    set(THEDAW_VST3_STANDALONE TRUE)
else()
    set(THEDAW_VST3_STANDALONE FALSE)
endif()

if(NOT WIN32)
    message(FATAL_ERROR "thedaw_vst3 hosts VST3 plugins through the Win32 API; it is Windows-only.")
endif()

# native/vst-host
get_filename_component(THEDAW_VST_HOST_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
set(THEDAW_VST3_ABI_DIR "${THEDAW_VST_HOST_ROOT}/third_party/vst3_pluginterfaces")

if(NOT EXISTS "${THEDAW_VST3_ABI_DIR}/pluginterfaces/base/funknown.h")
    message(FATAL_ERROR
        "The VST3 ABI headers are missing from ${THEDAW_VST3_ABI_DIR}. "
        "See native/vst-host/third_party/README.md for where they come from.")
endif()

# The four SDK translation units that DEFINE the interface ids and the UTF-16 helpers. They are
# ABI, not framework: without them queryInterface has nothing to compare against.
add_library(thedaw_vst3_abi STATIC
    "${THEDAW_VST3_ABI_DIR}/pluginterfaces/base/funknown.cpp"
    "${THEDAW_VST3_ABI_DIR}/pluginterfaces/base/coreiids.cpp"
    "${THEDAW_VST3_ABI_DIR}/pluginterfaces/base/conststringtable.cpp"
    "${THEDAW_VST3_ABI_DIR}/pluginterfaces/base/ustring.cpp"
)
target_include_directories(thedaw_vst3_abi PUBLIC "${THEDAW_VST3_ABI_DIR}")
target_compile_features(thedaw_vst3_abi PUBLIC cxx_std_17)
target_compile_definitions(thedaw_vst3_abi PUBLIC UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
if(MSVC)
    # Vendored third-party code: compiled as-is, warnings and all, so the ABI stays byte-identical
    # to the SDK's and our own warning level stays strict.
    target_compile_options(thedaw_vst3_abi PRIVATE /W0 /EHsc)
endif()

add_library(thedaw_vst3 STATIC
    vst3_common.cpp
    vst3_editor.cpp
    vst3_entry.cpp
    vst3_guard.cpp
    vst3_host_context.cpp
    vst3_iid_log.cpp
    vst3_iids.cpp
    vst3_instance.cpp
    vst3_module.cpp
    vst3_param_changes.cpp
    vst3_state_container.cpp
    vst3_stream.cpp
)
target_include_directories(thedaw_vst3
    PUBLIC
        "${THEDAW_VST_HOST_ROOT}/src"   # so <plugin/IPluginInstance.h> resolves for consumers
    PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}"
)
target_link_libraries(thedaw_vst3 PUBLIC thedaw_vst3_abi)
target_compile_features(thedaw_vst3 PUBLIC cxx_std_17)
target_link_libraries(thedaw_vst3 PUBLIC user32 gdi32 ole32 shell32)
if(MSVC)
    target_compile_options(thedaw_vst3 PRIVATE /W4 /EHsc /permissive-)
    # The CRT's secure template overloads: a strcpy into a fixed-size array, which the vendored
    # ivstrepresentation.h does, becomes the bounded strcpy_s. Without this the call is the
    # deprecated unbounded one, and C4996 under /WX stops the build.
    target_compile_definitions(thedaw_vst3 PRIVATE _CRT_SECURE_CPP_OVERLOAD_STANDARD_NAMES=1)
    # The parent sets THEDAW_WERROR; standalone builds of this directory default to the same
    # strictness so a warning cannot reach the host through the library.
    if(NOT DEFINED THEDAW_WERROR OR THEDAW_WERROR)
        target_compile_options(thedaw_vst3 PRIVATE /WX)
    endif()
endif()

if(THEDAW_VST3_STANDALONE)
    # Built here rather than under tools/ so that `cmake -S src/vst3` gives a working probe with
    # no other part of the host present.
    add_subdirectory("${THEDAW_VST_HOST_ROOT}/tools/vst3_probe" "${CMAKE_CURRENT_BINARY_DIR}/vst3_probe")
endif()
