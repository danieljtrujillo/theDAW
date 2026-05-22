import os
import sys

# Ensure the parent directory (project root) is on sys.path so that
# `stable_audio_3` package can be imported by the server module.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8600,
        reload=False,
        app_dir=os.path.dirname(os.path.abspath(__file__)),
    )
