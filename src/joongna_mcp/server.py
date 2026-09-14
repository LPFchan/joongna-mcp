from __future__ import annotations

import contextlib
import fnmatch
import os
from typing import Annotated

from mcp.server import CacheHint, MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field
from starlette.responses import JSONResponse
import uvicorn

from joongna_mcp.client import DEFAULT_USER_AGENT, JoongnaClient
from joongna_mcp.service import JoongnaPriceService
from joongna_mcp.models import JoongnaSearchKeywordResult, JoongnaSearchPriceResult


_service: JoongnaPriceService | None = None



def _build_transport_security() -> TransportSecuritySettings:
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
    )


class _CORSMiddleware:
    def __init__(self, app):
        self.app = app
        raw = os.environ.get("ALLOWED_ORIGINS", os.environ.get("ALLOWED_ORIGIN", "https://chat.lost.plus"))
        self.allowed_origins = [o.strip() for o in raw.split(",") if o.strip()]
        self.cors_methods = b"GET, POST, DELETE, OPTIONS"
        self.cors_allow_headers = b"authorization, content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, mcp-param-*, last-event-id, x-api-key"
        self.cors_expose_headers = b"mcp-session-id, mcp-protocol-version, content-type"

    def _echo_origin(self, origin: str | None) -> str | None:
        if not origin:
            return None
        for pattern in self.allowed_origins:
            if fnmatch.fnmatch(origin, pattern):
                return origin
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        origin_raw = headers.get(b"origin")
        origin = origin_raw.decode() if origin_raw else None
        matched = self._echo_origin(origin)

        if scope["method"] == "OPTIONS":
            resp_headers = [
                (b"access-control-allow-methods", self.cors_methods),
                (b"access-control-allow-headers", self.cors_allow_headers),
                (b"access-control-max-age", b"86400"),
                (b"access-control-expose-headers", self.cors_expose_headers),
            ]
            if matched:
                resp_headers.insert(0, (b"access-control-allow-origin", matched.encode()))
            elif origin:
                resp_headers.insert(0, (b"access-control-allow-origin", origin.encode()))
            await send({"type": "http.response.start", "status": 204, "headers": resp_headers})
            await send({"type": "http.response.body", "body": b""})
            return

        async def send_with_cors(message):
            if message["type"] == "http.response.start":
                hlist = list(message.get("headers", []))
                if matched:
                    hlist.append((b"access-control-allow-origin", matched.encode()))
                elif origin:
                    hlist.append((b"access-control-allow-origin", origin.encode()))
                hlist.append((b"access-control-expose-headers", self.cors_expose_headers))
                hlist.append((b"vary", b"Origin"))
                message["headers"] = hlist
            await send(message)

        await self.app(scope, receive, send_with_cors)


@contextlib.asynccontextmanager
async def mcp_lifespan(_: MCPServer):
    global _service

    client = JoongnaClient(
        base_url=os.environ.get("JOONGNA_BASE_URL", "https://web.joongna.com"),
        product_api_base_url=os.environ.get(
            "JOONGNA_PRODUCT_API_BASE_URL",
            "https://product-api.joongna.com",
        ),
        timeout_seconds=float(os.environ.get("JOONGNA_TIMEOUT_SECONDS", "20")),
        user_agent=os.environ.get("JOONGNA_USER_AGENT", DEFAULT_USER_AGENT),
    )
    _service = JoongnaPriceService(
        client,
        cache_ttl_seconds=int(os.environ.get("JOONGNA_CACHE_TTL_SECONDS", "300")),
    )

    try:
        yield
    finally:
        if _service is not None:
            await _service.aclose()
        _service = None


mcp = MCPServer(
    "joongna-mcp",
    version="0.1.0",
    lifespan=mcp_lifespan,
    cache_hints={
        "server/discover": CacheHint(ttl_ms=300_000, scope="public"),
        "tools/list": CacheHint(ttl_ms=300_000, scope="private"),
    },
)


@mcp.tool()
async def joongna_search_price(
    query: Annotated[
        str,
        Field(description="Natural-language question or device name to search on Joongna"),
    ],
    search_word: Annotated[
        str | None,
        Field(
            default=None,
            description="Optional explicit Joongna search term override, ideally in Korean",
        ),
    ] = None,
    max_listings: Annotated[
        int,
        Field(default=10, ge=1, le=20, description="Maximum listings to return per dataset"),
    ] = 10,
    force_refresh: Annotated[
        bool,
        Field(default=False, description="Bypass the in-memory cache for this request"),
    ] = False,
) -> JoongnaSearchPriceResult:
    """Return Joongna price data and listings with descriptions and product images."""
    service = _require_service()
    return await service.search(
        query=query,
        search_word=search_word,
        max_listings=max_listings,
        force_refresh=force_refresh,
    )


@mcp.tool()
async def joongna_search_keyword(
    query: Annotated[
        str,
        Field(description="Product name to search for on Joongna"),
    ],
    search_word: Annotated[
        str | None,
        Field(
            default=None,
            description="Optional explicit Joongna search term override, ideally in Korean",
        ),
    ] = None,
    max_listings: Annotated[
        int,
        Field(default=20, ge=1, le=100, description="Maximum listings to return"),
    ] = 20,
    force_refresh: Annotated[
        bool,
        Field(default=False, description="Bypass the in-memory cache for this request"),
    ] = False,
) -> JoongnaSearchKeywordResult:
    """Return Joongna listings, including sold-out items, descriptions, and product images."""
    service = _require_service()
    return await service.search_keyword(
        query=query,
        search_word=search_word,
        max_listings=max_listings,
        force_refresh=force_refresh,
    )


def _require_service() -> JoongnaPriceService:
    if _service is None:
        raise RuntimeError("Joongna price service is not ready")
    return _service


async def index(_: object) -> JSONResponse:
    return JSONResponse(
        {
            "name": "joongna-mcp",
            "mcp_path": "/mcp",
            "healthz": "/healthz",
            "tools": ["joongna_search_price", "joongna_search_keyword"],
        }
    )


async def healthz(_: object) -> JSONResponse:
    return JSONResponse({"ok": True})


@mcp.custom_route("/", methods=["GET"], include_in_schema=False)
async def root_route(request):
    del request
    return await index(None)


@mcp.custom_route("/healthz", methods=["GET"], include_in_schema=False)
async def health_route(request):
    del request
    return await healthz(None)


_http_app = _CORSMiddleware(
    mcp.streamable_http_app(
        streamable_http_path="/mcp",
        json_response=True,
        stateless_http=True,
        host=os.environ.get("HOST", "0.0.0.0"),
        transport_security=_build_transport_security(),
    )
)


async def app(scope, receive, send):
    if scope["type"] == "http":
        path = scope.get("path", "")
        if scope["method"] == "POST":
            if path.rstrip("/") == "":
                scope["path"] = "/mcp"
            elif path != "/mcp" and path.rstrip("/") == "/mcp":
                scope["path"] = "/mcp"
    await _http_app(scope, receive, send)


def main() -> None:
    uvicorn.run(
        app,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        forwarded_allow_ips="*",
        proxy_headers=True,
    )


if __name__ == "__main__":
    main()
