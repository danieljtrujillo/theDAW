"""Sound banks: the SF2, SF3 and DLS files the user adds, each stored under the
data root with its preset list and the bank offset the synths load it at."""

from backend.modules.modeldl import soundbanks as _downloads

from . import store as _store

# A bank the download manager installs is listed here at once, so it appears
# in GET /api/soundfonts and every picker without a restart.
_downloads.add_soundbank_hook(_store.on_bank_downloaded)
