"""Type stubs for piano_transcription_inference 0.0.6, which ships no type
information.

The package re-exports one name from each of three modules; these stubs
mirror that layout. theDAW runs ``PianoTranscription`` on a file it loaded
with ``load_audio`` at ``sample_rate`` (``backend/modules/midi/engine.py``).
``tests/test_ml_import_stubs.py`` checks every name and parameter against the
installed package's source.
"""

from .config import sample_rate as sample_rate
from .inference import PianoTranscription as PianoTranscription
from .utilities import load_audio as load_audio
