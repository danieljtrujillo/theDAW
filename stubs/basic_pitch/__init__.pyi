"""Type stubs for basic-pitch 0.4, which ships no type information.

theDAW imports the bundled model's path from here and the model and
``predict_and_save`` from ``basic_pitch.inference``
(``backend/modules/midi/engine.py``). ``tests/test_ml_import_stubs.py``
checks every name and parameter against the installed package's source.
"""

import enum
import pathlib

class FilenameSuffix(enum.Enum):
    tf = "nmp"
    coreml = "nmp.mlpackage"
    tflite = "nmp.tflite"
    onnx = "nmp.onnx"

def build_icassp_2022_model_path(suffix: FilenameSuffix) -> pathlib.Path: ...

ICASSP_2022_MODEL_PATH: pathlib.Path
