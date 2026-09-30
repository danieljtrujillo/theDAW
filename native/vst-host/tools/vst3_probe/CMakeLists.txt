# vst3_probe — a standalone driver for the VST3 hosting layer.
#
# It links `thedaw_vst3` and supplies the two message-thread hooks IPluginInstance.h leaves to
# the host, so the layer can be proved against real plugins without the engine or the socket
# server existing.
cmake_minimum_required(VERSION 3.20)

if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    project(thedaw_vst3_probe LANGUAGES CXX)
    get_filename_component(THEDAW_VST_HOST_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
    add_subdirectory("${THEDAW_VST_HOST_ROOT}/src/vst3" "${CMAKE_CURRENT_BINARY_DIR}/thedaw_vst3")
endif()

if(NOT TARGET thedaw_vst3)
    message(FATAL_ERROR "vst3_probe needs the thedaw_vst3 target; add src/vst3 first.")
endif()

add_executable(vst3_probe
    main.cpp
    message_loop.cpp
)
target_link_libraries(vst3_probe PRIVATE thedaw_vst3)
target_compile_features(vst3_probe PRIVATE cxx_std_17)
if(MSVC)
    target_compile_options(vst3_probe PRIVATE /W4 /EHsc /permissive-)
endif()
set_target_properties(vst3_probe PROPERTIES OUTPUT_NAME "vst3_probe")
