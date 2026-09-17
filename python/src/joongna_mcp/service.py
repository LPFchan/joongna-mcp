from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import asyncio
import time

from joongna_mcp.client import JoongnaClient, JoongnaFetchError
from joongna_mcp.models import (
    JoongnaSearchKeywordResult,
    JoongnaSearchPriceResult,
    Listing,
    ListingDetails,
)
from joongna_mcp.normalize import normalize_search_word
from joongna_mcp.parser import (
    JoongnaParseError,
    parse_product_detail,
    parse_search_keyword_page,
    parse_search_price_page,
)


@dataclass(slots=True)
class _CacheEntry:
    expires_at: float
    result: JoongnaSearchPriceResult


@dataclass(slots=True)
class _KeywordCacheEntry:
    expires_at: float
    result: JoongnaSearchKeywordResult


@dataclass(slots=True)
class _DetailCacheEntry:
    expires_at: float
    details: ListingDetails


_MAX_KEYWORD_RETRIES = 3
_KEYWORD_RETRY_DELAY = 2.0


class JoongnaPriceService:
    def __init__(self, client: JoongnaClient, *, cache_ttl_seconds: int = 300) -> None:
        self._client = client
        self._cache_ttl_seconds = cache_ttl_seconds
        self._cache: dict[str, _CacheEntry] = {}
        self._keyword_cache: dict[str, _KeywordCacheEntry] = {}
        self._detail_cache: dict[int, _DetailCacheEntry] = {}
        self._detail_semaphore = asyncio.Semaphore(8)
        self._lock = asyncio.Lock()

    async def search(
        self,
        *,
        query: str,
        search_word: str | None = None,
        max_listings: int = 10,
        force_refresh: bool = False,
    ) -> JoongnaSearchPriceResult:
        if max_listings < 1:
            raise ValueError("max_listings must be at least 1")

        effective_search_word = search_word.strip() if search_word else normalize_search_word(query)
        now = time.monotonic()
        cached_result: JoongnaSearchPriceResult | None = None

        async with self._lock:
            entry = self._cache.get(effective_search_word)
            if not force_refresh and entry and entry.expires_at > now:
                cached_result = self._limit_result(
                    entry.result,
                    max_listings=max_listings,
                    from_cache=True,
                )
            if entry and entry.expires_at <= now:
                self._cache.pop(effective_search_word, None)

        if cached_result is not None:
            return await self._enrich_price_result(cached_result, force_refresh=False)

        source_url, html = await self._client.fetch_search_page(effective_search_word)
        fetched_at = datetime.now(timezone.utc).isoformat()
        result = parse_search_price_page(
            html,
            query=query,
            search_word=effective_search_word,
            source_url=source_url,
            fetched_at=fetched_at,
        )

        async with self._lock:
            self._cache[effective_search_word] = _CacheEntry(
                expires_at=time.monotonic() + self._cache_ttl_seconds,
                result=result.model_copy(deep=True),
            )

        limited = self._limit_result(result, max_listings=max_listings, from_cache=False)
        return await self._enrich_price_result(limited, force_refresh=force_refresh)

    async def search_keyword(
        self,
        *,
        query: str,
        search_word: str | None = None,
        max_listings: int = 20,
        force_refresh: bool = False,
    ) -> JoongnaSearchKeywordResult:
        if max_listings < 1:
            raise ValueError("max_listings must be at least 1")

        effective_search_word = search_word.strip() if search_word else normalize_search_word(query)
        now = time.monotonic()
        cached_result: JoongnaSearchKeywordResult | None = None

        async with self._lock:
            entry = self._keyword_cache.get(effective_search_word)
            if not force_refresh and entry and entry.expires_at > now:
                cached_result = self._limit_keyword_result(
                    entry.result,
                    max_listings=max_listings,
                    from_cache=True,
                )
            if entry and entry.expires_at <= now:
                self._keyword_cache.pop(effective_search_word, None)

        if cached_result is not None:
            return await self._enrich_keyword_result(cached_result, force_refresh=False)

        for attempt in range(_MAX_KEYWORD_RETRIES):
            source_url, html = await self._client.fetch_search_keyword_page(effective_search_word)
            fetched_at = datetime.now(timezone.utc).isoformat()
            result = parse_search_keyword_page(
                html,
                query=query,
                search_word=effective_search_word,
                source_url=source_url,
                fetched_at=fetched_at,
            )

            if result.listings:
                break

            if attempt < _MAX_KEYWORD_RETRIES - 1:
                await asyncio.sleep(_KEYWORD_RETRY_DELAY)

        async with self._lock:
            self._keyword_cache[effective_search_word] = _KeywordCacheEntry(
                expires_at=time.monotonic() + self._cache_ttl_seconds,
                result=result.model_copy(deep=True),
            )

        limited = self._limit_keyword_result(result, max_listings=max_listings, from_cache=False)
        return await self._enrich_keyword_result(limited, force_refresh=force_refresh)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _enrich_keyword_result(
        self,
        result: JoongnaSearchKeywordResult,
        *,
        force_refresh: bool,
    ) -> JoongnaSearchKeywordResult:
        await self._enrich_listings(result.listings, force_refresh=force_refresh)
        return result

    async def _enrich_price_result(
        self,
        result: JoongnaSearchPriceResult,
        *,
        force_refresh: bool,
    ) -> JoongnaSearchPriceResult:
        listing_groups = [result.available_listings]
        if result.registered_price_history is not None:
            listing_groups.append(result.registered_price_history.listings)
        if result.sold_price_history is not None:
            listing_groups.append(result.sold_price_history.listings)

        await self._enrich_listings(
            [listing for group in listing_groups for listing in group],
            force_refresh=force_refresh,
        )
        return result

    async def _enrich_listings(
        self,
        listings: list[Listing],
        *,
        force_refresh: bool,
    ) -> None:
        sequences = list(dict.fromkeys(listing.sequence for listing in listings))
        if not sequences:
            return

        fetched_details = await asyncio.gather(
            *(
                self._get_listing_details(sequence, force_refresh=force_refresh)
                for sequence in sequences
            )
        )
        details_by_sequence = dict(zip(sequences, fetched_details, strict=True))

        for listing in listings:
            details = details_by_sequence[listing.sequence]
            listing.description = details.description
            if details.image_urls:
                listing.image_urls = details.image_urls.copy()

    async def _get_listing_details(
        self,
        sequence: int,
        *,
        force_refresh: bool,
    ) -> ListingDetails:
        now = time.monotonic()
        async with self._lock:
            entry = self._detail_cache.get(sequence)
            if not force_refresh and entry and entry.expires_at > now:
                return entry.details.model_copy(deep=True)
            if entry and entry.expires_at <= now:
                self._detail_cache.pop(sequence, None)

        try:
            async with self._detail_semaphore:
                payload = await self._client.fetch_product_detail(sequence)
            details = parse_product_detail(payload)
        except (JoongnaFetchError, JoongnaParseError):
            details = ListingDetails()

        async with self._lock:
            self._detail_cache[sequence] = _DetailCacheEntry(
                expires_at=time.monotonic() + self._cache_ttl_seconds,
                details=details.model_copy(deep=True),
            )
        return details

    def _limit_keyword_result(
        self,
        result: JoongnaSearchKeywordResult,
        *,
        max_listings: int,
        from_cache: bool,
    ) -> JoongnaSearchKeywordResult:
        limited = result.model_copy(deep=True, update={"from_cache": from_cache})
        limited.listings = limited.listings[:max_listings]
        limited.total_count = len(limited.listings)
        return limited

    def _limit_result(
        self,
        result: JoongnaSearchPriceResult,
        *,
        max_listings: int,
        from_cache: bool,
    ) -> JoongnaSearchPriceResult:
        limited = result.model_copy(deep=True, update={"from_cache": from_cache})
        limited.available_listings = limited.available_listings[:max_listings]

        if limited.registered_price_history is not None:
            limited.registered_price_history.listings = limited.registered_price_history.listings[
                :max_listings
            ]

        if limited.sold_price_history is not None:
            limited.sold_price_history.listings = limited.sold_price_history.listings[:max_listings]

        return limited
