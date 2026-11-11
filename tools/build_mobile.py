"""Build the offline mobile app's web bundle (mobile/www).

The phone runs the same Python engine and endpoints as the server, inside WebAssembly
(Pyodide). FastAPI is replaced by tarazu.lite, which the API test suite checks.

Steps: copy the frontend, mark pages as embedded, precompile the engine and its pure-Python
dependencies into one bytecode archive, and add a trimmed Pyodide.
Downloads are cached in mobile/.cache, so later builds need no network.

Run: python tools/build_mobile.py   then   cd mobile && npx cap sync android
"""
from __future__ import annotations

import compileall
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONT, ENGINE = ROOT / "frontend", ROOT / "backend" / "tarazu"
MOBILE = ROOT / "mobile"
WWW, CACHE = MOBILE / "www", MOBILE / ".cache"
PYODIDE_VERSION = "0.27.7"
CDN = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE_VERSION}/full/"
CORE = ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]
NEEDS = ["pydantic", "sqlite3"]  # what the engine imports; dependencies follow from the lock file
WHEELS: list[str] = []  # extra pure-Python wheels from PyPI (none: tarazu.lite replaces FastAPI in the app)
SKIP_FRONT = {"sw.js", "index.html", "manifest.webmanifest", "phone.html"}  # the app needs no service worker or web landing page
SKIP_ENGINE = {"trial.py"}  # research tooling stays on the laptop


def fetch(url: str, dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print("  download", url)
        with urllib.request.urlopen(url, timeout=120) as r:
            dest.write_bytes(r.read())
    return dest


def closure(lock: dict, names: list[str]) -> list[str]:
    pk = lock["packages"]
    seen, stack = [], list(names)
    while stack:
        n = stack.pop().lower().replace("_", "-")
        if n in seen:
            continue
        seen.append(n)
        stack += pk[n].get("depends", [])
    return seen


def main() -> None:
    if WWW.exists():
        shutil.rmtree(WWW)
    # 1. frontend, marked as embedded (api.js then talks to the on-device engine)
    shutil.copytree(FRONT, WWW, ignore=lambda d, names: [n for n in names if Path(d) == FRONT and n in SKIP_FRONT])
    # The pages may only talk to the phone itself: no request can leave the device.
    csp = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; "
           "font-src 'self'; connect-src 'self' blob: data:; worker-src 'self'; frame-src 'self'; "
           "media-src 'self' blob:; object-src 'none'; base-uri 'none'")
    meta = f'<meta name="tarazu-runtime" content="embedded">\n<meta http-equiv="Content-Security-Policy" content="{csp}">'
    for page in ("app.html", "demo.html"):
        p = WWW / page
        s = p.read_text(encoding="utf-8")
        s = s.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n' + meta, 1)
        s = re.sub(r'<meta name="viewport" content="([^"]*)">',
                   lambda m: f'<meta name="viewport" content="{m.group(1)}{"" if "viewport-fit" in m.group(1) else ", viewport-fit=cover"}">', s, 1)
        s = s.replace('<link rel="manifest" href="/manifest.webmanifest">\n', "")
        p.write_text(s, encoding="utf-8")
    shutil.copy(WWW / "app.html", WWW / "index.html")  # the app opens straight into the workspace

    # 2. Pyodide core; packages with compiled extensions are loaded by Pyodide itself
    pc = CACHE / f"pyodide-{PYODIDE_VERSION}"
    for f in CORE:
        fetch(CDN + f, pc / f)
    lock = json.loads((pc / "pyodide-lock.json").read_text(encoding="utf-8"))
    (WWW / "pyodide").mkdir()
    for f in CORE:
        shutil.copy(pc / f, WWW / "pyodide" / f)
    native, pure = [], []
    for n in closure(lock, NEEDS):
        fn = lock["packages"][n]["file_name"]
        fetch(CDN + fn, pc / fn)
        (pure if fn.endswith("-py3-none-any.whl") else native).append((n, pc / fn))
    for _n, f in native:
        shutil.copy(f, WWW / "pyodide" / f.name)

    # 3. every pure-Python package plus the engine, precompiled to bytecode in one archive.
    #    Python imports straight from the zip, so a phone never compiles source at start-up.
    wc = CACHE / "wheels"
    wc.mkdir(parents=True, exist_ok=True)
    wheels = [f for _n, f in pure]
    for spec in WHEELS:
        name, ver = spec.split("==")
        stem = f"{name.replace('-', '_').lower()}-{ver}"
        hit = [w for w in wc.glob("*.whl") if w.name.lower().startswith(stem)]
        if not hit:
            subprocess.run([sys.executable, "-m", "pip", "download", spec, "--no-deps", "--only-binary=:all:",
                            "-d", str(wc), "-q"], check=True)
            hit = [w for w in wc.glob("*.whl") if w.name.lower().startswith(stem)]
        wheels.append(hit[0])
    if sys.version_info[:2] != (3, 12):
        raise SystemExit("Build with Python 3.12: the bytecode must match Pyodide's Python 3.12")
    with tempfile.TemporaryDirectory() as tmp:
        site = Path(tmp) / "site"
        for w in wheels:
            with zipfile.ZipFile(w) as z:
                z.extractall(site)
        (site / "tarazu").mkdir()
        for f in ENGINE.glob("*.py"):
            if f.name not in SKIP_ENGINE:
                shutil.copy(f, site / "tarazu" / f.name)
        compileall.compile_dir(site, quiet=1, legacy=True, optimize=0, workers=0)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
            for f in sorted(site.rglob("*")):
                if f.is_file() and f.suffix != ".py" and "__pycache__" not in f.parts:
                    z.write(f, f.relative_to(site).as_posix())
    data = buf.getvalue()
    site_name = f"site-{hashlib.sha256(data).hexdigest()[:10]}.zip"
    (WWW / "py").mkdir()
    (WWW / "py" / site_name).write_bytes(data)
    pkgs = [n for n, _f in native]

    version = re.search(r'__version__\s*=\s*"([^"]+)"', (ENGINE / "__init__.py").read_text()).group(1)
    (WWW / "py" / "manifest.json").write_text(json.dumps(
        {"version": version, "site": site_name, "pyodide": pkgs}, indent=2), encoding="utf-8")
    size = sum(f.stat().st_size for f in WWW.rglob("*") if f.is_file())
    print(f"mobile/www ready: {size / 1e6:.1f} MB, packages {', '.join(pkgs)}")


if __name__ == "__main__":
    main()
