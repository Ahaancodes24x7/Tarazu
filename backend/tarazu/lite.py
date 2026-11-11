"""A minimal, in-process stand-in for the parts of FastAPI that api.py uses.

The phone has no network between the screen and the engine, so a web framework
only costs start-up time (importing FastAPI and Starlette takes about 3 seconds in
WebAssembly). `install()` registers this module under the `fastapi` names before
`tarazu.api` is imported; the endpoint functions, validation (pydantic) and every
response stay the same. tests/test_lite.py runs the full API test suite through
it, so both paths must give identical answers.

Supported: GET/POST/PUT/DELETE routes with {path} parameters, typed query
parameters, one pydantic body model, File/Form uploads, HTTPException, and the
JSON, plain-text and bytes responses api.py returns. It is an ASGI app, so the
same caller drives either implementation.
"""
from __future__ import annotations

import datetime as _dt
import enum
import inspect
import json
import re
import sys
import types
import typing
from decimal import Decimal
from urllib.parse import parse_qs

from pydantic import BaseModel, ValidationError


# ------------------------------------------------------------------ errors
class HTTPException(Exception):
    def __init__(self, status_code: int, detail=None, headers=None):
        super().__init__(detail)
        self.status_code, self.detail, self.headers = status_code, detail, headers


# ------------------------------------------------------------- parameters
class _Param:
    kind = "query"

    def __init__(self, default=..., **_kw):
        self.default = default


class Query(_Param):
    kind = "query"


class Form(_Param):
    kind = "form"


class File(_Param):
    kind = "file"


class UploadFile:
    def __init__(self, filename: str, content_type: str, data: bytes):
        self.filename, self.content_type, self._data = filename, content_type, data

    async def read(self) -> bytes:
        return self._data


# --------------------------------------------------------------- responses
class Response:
    media_type = None

    def __init__(self, content=b"", status_code: int = 200, headers=None, media_type=None):
        self.status_code = status_code
        self.media_type = media_type or self.media_type
        self.headers = dict(headers or {})
        self.body = self.render(content)

    def render(self, content) -> bytes:
        if content is None:
            return b""
        return content if isinstance(content, (bytes, bytearray)) else str(content).encode()


class JSONResponse(Response):
    media_type = "application/json"

    def render(self, content) -> bytes:
        return _dumps(content)


class PlainTextResponse(Response):
    media_type = "text/plain; charset=utf-8"


class HTMLResponse(Response):
    media_type = "text/html; charset=utf-8"


class RedirectResponse(Response):
    def __init__(self, url: str, status_code: int = 307, headers=None):
        super().__init__(b"", status_code, {**(headers or {}), "location": url})


class FileResponse(Response):
    def __init__(self, path, media_type=None, headers=None, **_kw):
        with open(path, "rb") as f:
            super().__init__(f.read(), 200, headers, media_type or "application/octet-stream")


class StaticFiles:  # the app serves its pages itself; nothing to mount
    def __init__(self, *a, **kw):
        pass


def _default(o):
    if isinstance(o, BaseModel):
        return o.model_dump(mode="json")
    if isinstance(o, Decimal):  # as FastAPI's jsonable_encoder: whole numbers as int, others as float
        return int(o) if o == o.to_integral_value() and o.as_tuple().exponent >= 0 else float(o)
    if isinstance(o, (set, frozenset)):
        return list(o)
    if isinstance(o, (_dt.datetime, _dt.date, _dt.time)):
        return o.isoformat()
    if isinstance(o, enum.Enum):
        return o.value
    if hasattr(o, "__dataclass_fields__"):
        import dataclasses
        return dataclasses.asdict(o)
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serialisable")


def _dumps(content) -> bytes:
    return json.dumps(content, ensure_ascii=False, allow_nan=False, separators=(",", ":"), default=_default).encode()


# ---------------------------------------------------------------- routing
def _unwrap(tp):
    """Optional[X] -> X; anything else unchanged."""
    if typing.get_origin(tp) in (typing.Union, getattr(types, "UnionType", None)):
        args = [a for a in typing.get_args(tp) if a is not type(None)]
        return args[0] if len(args) == 1 else str
    return tp


def _convert(value: str, tp):
    tp = _unwrap(tp)
    if tp is bool:
        if value.lower() in ("1", "true", "yes", "on"):
            return True
        if value.lower() in ("0", "false", "no", "off"):
            return False
        raise ValueError("Input should be a valid boolean")
    if tp in (int, float, Decimal):
        return tp(value)
    return value


class _Route:
    __slots__ = ("method", "regex", "func", "params", "is_async")

    def __init__(self, method: str, path: str, func):
        self.method = method
        self.regex = re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", path) + "$")
        self.func = func
        hints = typing.get_type_hints(func)
        self.params = []
        for name, p in inspect.signature(func).parameters.items():
            tp = hints.get(name, str)
            default = p.default
            if isinstance(default, _Param):
                kind, default = default.kind, default.default
            elif inspect.isclass(_unwrap(tp)) and issubclass(_unwrap(tp), BaseModel):
                kind = "body"
            elif "{" + name + "}" in path:
                kind = "path"
            else:
                kind = "query"
            if default is inspect.Parameter.empty:
                default = ...
            self.params.append((name, kind, tp, default))
        self.is_async = inspect.iscoroutinefunction(func)


def _err(loc, msg, typ="missing", inp=None):
    return {"type": typ, "loc": loc, "msg": msg, "input": inp}


def _multipart(content_type: str, body: bytes) -> tuple[dict, dict]:
    import email.parser  # only uploads need these; importing them costs start-up time on a phone
    import email.policy

    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + content_type.encode("latin-1") + b"\r\n\r\n" + body)
    fields, files = {}, {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        data = part.get_payload(decode=True) or b""
        fn = part.get_filename()
        if fn is not None:
            files[name] = UploadFile(fn, part.get_content_type(), data)
        else:
            fields[name] = data.decode(part.get_content_charset() or "utf-8")
    return fields, files


class FastAPI:
    def __init__(self, **_kw):
        self.routes: list[_Route] = []

    def _add(self, method):
        def deco_factory(path, **_kw):
            def deco(func):
                self.routes.append(_Route(method, path, func))
                return func
            return deco
        return deco_factory

    def __getattr__(self, name):
        if name in ("get", "post", "put", "delete", "patch"):
            return self._add(name.upper())
        raise AttributeError(name)

    def mount(self, *a, **kw):
        pass

    async def dispatch(self, method: str, path: str, query: str, headers: dict, body: bytes) -> Response:
        allowed = False
        for r in self.routes:
            m = r.regex.match(path)
            if not m:
                continue
            if r.method != method:
                allowed = True
                continue
            return await self._call(r, m.groupdict(), query, headers, body)
        return JSONResponse({"detail": "Method Not Allowed" if allowed else "Not Found"}, 405 if allowed else 404)

    async def _call(self, r: _Route, path_args: dict, query: str, headers: dict, body: bytes) -> Response:
        q = {k: v[-1] for k, v in parse_qs(query, keep_blank_values=True).items()}
        form = files = None
        kwargs, errors = {}, []
        for name, kind, tp, default in r.params:
            try:
                if kind == "path":
                    kwargs[name] = _convert(path_args[name], tp)
                elif kind == "body":
                    if not body:
                        errors.append(_err(["body"], "Field required"))
                        continue
                    kwargs[name] = _unwrap(tp).model_validate_json(body)
                elif kind in ("form", "file"):
                    if form is None:
                        form, files = _multipart(headers.get("content-type", ""), body)
                    src = files if kind == "file" else form
                    if name in src:
                        kwargs[name] = src[name]
                    elif default is ...:
                        errors.append(_err(["body", name], "Field required"))
                    else:
                        kwargs[name] = default
                else:
                    if name in q:
                        kwargs[name] = _convert(q[name], tp)
                    elif default is ...:
                        errors.append(_err(["query", name], "Field required"))
                    else:
                        kwargs[name] = default
            except ValidationError as e:
                errors += [{"type": x["type"], "loc": ["body", *x["loc"]], "msg": x["msg"], "input": x.get("input")}
                           for x in e.errors(include_url=False)]
            except ValueError as e:
                errors.append(_err([kind, name], str(e), "parsing", q.get(name, path_args.get(name))))
        if errors:
            return JSONResponse({"detail": errors}, 422)
        try:
            out = await r.func(**kwargs) if r.is_async else r.func(**kwargs)
        except HTTPException as e:
            return JSONResponse({"detail": e.detail}, e.status_code, e.headers)
        return out if isinstance(out, Response) else JSONResponse(out)

    async def __call__(self, scope, receive, send):
        body = b""
        while True:
            msg = await receive()
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                break
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        res = await self.dispatch(scope["method"], scope["path"], scope.get("query_string", b"").decode(), headers, body)
        hdrs = {"content-length": str(len(res.body)), **{k.lower(): v for k, v in res.headers.items()}}
        if res.media_type:
            hdrs["content-type"] = res.media_type
        await send({"type": "http.response.start", "status": res.status_code,
                    "headers": [(k.encode("latin-1"), str(v).encode("latin-1")) for k, v in hdrs.items()]})
        await send({"type": "http.response.body", "body": res.body})


def install() -> None:
    """Make `import fastapi` (and its submodules used by api.py) resolve to this module."""
    me = sys.modules[__name__]
    for name in ("fastapi", "fastapi.responses", "fastapi.staticfiles"):
        sys.modules[name] = me
