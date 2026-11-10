"""Start Tarazu: python run.py  ->  http://127.0.0.1:8000"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "backend"))

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    print(f"Tarazu running at http://127.0.0.1:{port}  (workbench: /app)")
    uvicorn.run("tarazu.api:app", host=os.environ.get("HOST", "127.0.0.1"), port=port, reload=False)
