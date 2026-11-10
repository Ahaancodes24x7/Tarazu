"""The app's in-process API (tarazu.lite) must answer exactly like FastAPI.

Runs the whole API test suite again in a fresh interpreter with the lite
dispatcher installed in place of FastAPI.
"""
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def test_api_suite_passes_on_the_lite_dispatcher():
    env = {**os.environ, "TARAZU_LITE": "1"}
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(HERE / "test_api.py")],
                       cwd=HERE.parent, env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout[-3000:] + r.stderr[-2000:]
    assert " passed" in r.stdout
