"""A TestClient-shaped wrapper that drives an ASGI app in-process (used with tarazu.lite)."""
import asyncio
import json as _json
import uuid
from urllib.parse import urlsplit

CRLF = b"\r\n"


class _Res:
    def __init__(self, status, headers, body):
        self.status_code, self.headers, self.content = status, headers, body

    @property
    def text(self):
        return self.content.decode("utf-8", "replace")

    def json(self):
        return _json.loads(self.content)


class LiteClient:
    def __init__(self, app):
        self.app = app

    def request(self, method, url, json=None, files=None, data=None):
        u = urlsplit(url)
        headers, body = [], b""
        if json is not None:
            body = _json.dumps(json).encode()
            headers.append((b"content-type", b"application/json"))
        elif files or data:
            b = uuid.uuid4().hex.encode()
            parts = []
            for k, v in (data or {}).items():
                parts.append(b"--" + b + CRLF + f'Content-Disposition: form-data; name="{k}"'.encode() + CRLF + CRLF
                             + str(v).encode() + CRLF)
            for k, (fn, content, ct) in (files or {}).items():
                parts.append(b"--" + b + CRLF + f'Content-Disposition: form-data; name="{k}"; filename="{fn}"'.encode()
                             + CRLF + f"Content-Type: {ct}".encode() + CRLF + CRLF + content + CRLF)
            body = b"".join(parts) + b"--" + b + b"--" + CRLF
            headers.append((b"content-type", b"multipart/form-data; boundary=" + b))
        scope = {"type": "http", "method": method, "path": u.path, "query_string": u.query.encode(), "headers": headers}
        out = {}

        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}

        async def send(m):
            if m["type"] == "http.response.start":
                out["status"] = m["status"]
                out["headers"] = {k.decode(): v.decode() for k, v in m["headers"]}
            else:
                out["body"] = out.get("body", b"") + m.get("body", b"")

        asyncio.run(self.app(scope, receive, send))
        return _Res(out["status"], out["headers"], out.get("body", b""))

    def get(self, url, **kw):
        return self.request("GET", url, **kw)

    def post(self, url, **kw):
        return self.request("POST", url, **kw)

    def delete(self, url, **kw):
        return self.request("DELETE", url, **kw)
