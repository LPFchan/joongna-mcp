from __future__ import annotations

import html as html_lib
import json
import re
from collections.abc import Iterable

from joongna_mcp.models import (
    DailyAveragePoint,
    HourlyScatterPoint,
    JoongnaSearchKeywordResult,
    JoongnaSearchPriceResult,
    Listing,
    ListingDetails,
    PriceHistoryDataset,
    PriceSummary,
    SearchMetadata,
)


class JoongnaParseError(ValueError):
    pass


_NEXT_FLIGHT_RE = re.compile(
    r"self\.__next_f\.push\(\[\d+,\"((?:\\.|[^\"\\])*)\"\]\)",
    re.DOTALL,
)
_SUMMARY_RE = re.compile(
    r">(평균 가격|가장 높은 가격|가장 낮은 가격)</span><span[^>]*>([^<]+)</span>"
)


def parse_search_price_page(
    html: str,
    *,
    query: str,
    search_word: str,
    source_url: str,
    fetched_at: str,
) -> JoongnaSearchPriceResult:
    summary = _parse_summary(html)
    datasets, metadata, has_empty_result_marker = _parse_hydrated_datasets(html)

    available_listings = _pick_available_listings(datasets)
    empty_result = has_empty_result_marker or (
        not datasets and not available_listings and _summary_is_empty(summary)
    )

    if empty_result and metadata is None:
        metadata = SearchMetadata(search_keyword=search_word)

    if not datasets and _summary_is_empty(summary) and not empty_result:
        raise JoongnaParseError("Joongna page did not expose summary or hydrated pricing datasets")

    return JoongnaSearchPriceResult(
        query=query,
        search_word=search_word,
        source_url=source_url,
        fetched_at=fetched_at,
        empty_result=empty_result,
        empty_result_reason="No pricing data found for this search word" if empty_result else None,
        summary=summary,
        metadata=metadata,
        registered_price_history=datasets.get("BID"),
        sold_price_history=datasets.get("EXECUTION"),
        available_listings=available_listings,
    )


def _parse_summary(html: str) -> PriceSummary:
    label_map = {
        "평균 가격": "average_price_krw",
        "가장 높은 가격": "highest_price_krw",
        "가장 낮은 가격": "lowest_price_krw",
    }
    summary_data: dict[str, int | None] = {
        "average_price_krw": None,
        "highest_price_krw": None,
        "lowest_price_krw": None,
    }

    for match in _SUMMARY_RE.finditer(html):
        label, raw_value = match.groups()
        summary_data[label_map[label]] = _parse_krw(raw_value)

    return PriceSummary(**summary_data)


def _parse_hydrated_datasets(
    html: str,
) -> tuple[dict[str, PriceHistoryDataset], SearchMetadata | None, bool]:
    datasets: dict[str, PriceHistoryDataset] = {}
    metadata: SearchMetadata | None = None
    has_empty_result_marker = False

    for query in _iter_hydrated_queries(html):
        query_key = query.get("queryKey")
        if not isinstance(query_key, list) or len(query_key) < 2:
            continue
        if query_key[0] != "postProductPriceScatterPlot":
            continue

        source_key = str(query_key[1]).upper()
        if source_key not in {"BID", "EXECUTION"}:
            continue

        data = (((query.get("state") or {}).get("data") or {}).get("data") or {})
        if metadata is None:
            metadata = _build_metadata(data)
        if data.get("emptyResult") is not None:
            has_empty_result_marker = True
        datasets[source_key] = _build_history_dataset(source_key, data)

    return datasets, metadata, has_empty_result_marker


def _iter_hydrated_queries(html: str) -> Iterable[dict]:
    for match in _NEXT_FLIGHT_RE.finditer(html):
        encoded = match.group(1)
        decoded = json.loads(f'"{encoded}"')
        if ":" not in decoded:
            continue

        _, payload = decoded.split(":", 1)
        try:
            root = json.loads(payload)
        except json.JSONDecodeError:
            continue

        stack: list[object] = [root]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                queries = node.get("queries")
                if isinstance(queries, list):
                    for query in queries:
                        if isinstance(query, dict):
                            yield query
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)


def _build_history_dataset(source_key: str, data: dict) -> PriceHistoryDataset:
    product_price = data.get("productPrice") or {}
    items = data.get("items") or []

    return PriceHistoryDataset(
        source_key=source_key,
        label_ko="등록가" if source_key == "BID" else "판매가",
        listing_count=len(items),
        daily_average_prices=[
            DailyAveragePoint(
                date=str(point.get("date")),
                average_price_krw=int(point.get("avgPrice", 0)),
            )
            for point in product_price.get("linePrices") or []
            if point.get("date") is not None and point.get("avgPrice") is not None
        ],
        hourly_scatter_points=_flatten_scatter_points(product_price.get("scatterPrices") or []),
        listings=[_build_listing(item) for item in items if item.get("seq") is not None],
    )


def _flatten_scatter_points(raw_scatter_prices: list[dict]) -> list[HourlyScatterPoint]:
    points: list[HourlyScatterPoint] = []

    for group in raw_scatter_prices:
        date_hour = group.get("dateHour")
        if not date_hour:
            continue
        for price_count in group.get("priceCounts") or []:
            price = price_count.get("price")
            count = price_count.get("count")
            if price is None or count is None:
                continue
            points.append(
                HourlyScatterPoint(
                    date_hour=str(date_hour),
                    price_krw=int(price),
                    count=int(count),
                )
            )

    return points


def _sale_status(state: object) -> str | None:
    """Map Joongna's bare sale-state integer to a readable label.

    Verified against product pages: 0 shows no badge, 1 shows 예약중, 3 shows
    판매완료. Unrecognized codes keep their number so they stay debuggable.
    """
    if state is None:
        return None
    code = int(state)
    return {0: "on_sale", 1: "reserved", 3: "sold"}.get(code, f"unknown_{code}")


def _build_listing(item: dict) -> Listing:
    sequence = int(item["seq"])
    article_url = item.get("articleUrl")
    if isinstance(article_url, str) and article_url:
        if article_url.startswith("http"):
            listing_url = article_url
        else:
            listing_url = f"https://web.joongna.com{article_url}"
    else:
        listing_url = f"https://web.joongna.com/product/{sequence}"

    thumbnail_url = item.get("url") or None

    return Listing(
        sequence=sequence,
        title=html_lib.unescape(str(item.get("title") or "")),
        price_krw=int(item.get("price") or 0),
        listing_url=listing_url,
        thumbnail_url=thumbnail_url,
        image_urls=[thumbnail_url] if thumbnail_url else [],
        sorted_at=item.get("sortDate") or None,
        location_name=item.get("mainLocationName") or None,
        parcel_fee_krw=int(item["parcelFee"]) if item.get("parcelFee") is not None else None,
        chat_count=int(item["chatCount"]) if item.get("chatCount") is not None else None,
        wish_count=int(item["wishCount"]) if item.get("wishCount") is not None else None,
        pickup_badge=bool(item["pickupBadgeFlag"]) if item.get("pickupBadgeFlag") is not None else None,
        certified_seller=bool(item["certifySellerFlag"]) if item.get("certifySellerFlag") is not None else None,
        sale_status=_sale_status(item.get("state")),
    )


def parse_product_detail(payload: dict) -> ListingDetails:
    data = payload.get("data")
    if not isinstance(data, dict):
        raise JoongnaParseError("Joongna product response did not contain product data")

    raw_description = data.get("productDescription")
    description = str(raw_description) if raw_description is not None else None

    image_urls: list[str] = []
    seen_urls: set[str] = set()
    for collection_name in ("media", "descriptionMedia"):
        media_items = data.get(collection_name) or []
        if not isinstance(media_items, list):
            continue
        for media in media_items:
            if not isinstance(media, dict):
                continue
            if media.get("mediaType") not in (None, 0):
                continue
            image_url = media.get("originUrl") or media.get("mediaUrl")
            if isinstance(image_url, str) and image_url and image_url not in seen_urls:
                seen_urls.add(image_url)
                image_urls.append(image_url)

    return ListingDetails(description=description, image_urls=image_urls)


def _build_metadata(data: dict) -> SearchMetadata | None:
    if not isinstance(data, dict):
        return None

    search_keyword = data.get("searchKeyword")
    selected_exposure_keyword = data.get("selectExposureKeyword")
    selected_model_name = data.get("selectModelName")
    selected_option_name = data.get("selectOptionName")

    if not any(
        value is not None and value != ""
        for value in (
            search_keyword,
            selected_exposure_keyword,
            selected_model_name,
            selected_option_name,
        )
    ):
        return None

    return SearchMetadata(
        search_keyword=str(search_keyword) if search_keyword is not None else None,
        selected_exposure_keyword=(
            str(selected_exposure_keyword) if selected_exposure_keyword is not None else None
        ),
        selected_model_name=str(selected_model_name) if selected_model_name is not None else None,
        selected_option_name=(
            str(selected_option_name) if selected_option_name is not None else None
        ),
    )


def _pick_available_listings(datasets: dict[str, PriceHistoryDataset]) -> list[Listing]:
    for source_key in ("BID", "EXECUTION"):
        dataset = datasets.get(source_key)
        if dataset and dataset.listings:
            return dataset.listings
    return []


def _summary_is_empty(summary: PriceSummary) -> bool:
    return (
        summary.average_price_krw is None
        and summary.highest_price_krw is None
        and summary.lowest_price_krw is None
    )


def _iter_search_items(html: str) -> list[dict]:
    for match in _NEXT_FLIGHT_RE.finditer(html):
        encoded = match.group(1)
        decoded = json.loads(f'"{encoded}"')
        if ":" not in decoded:
            continue

        _, payload = decoded.split(":", 1)
        try:
            root = json.loads(payload)
        except json.JSONDecodeError:
            continue

        stack: list[object] = [root]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                items = node.get("items")
                if isinstance(items, list) and items and isinstance(items[0], dict) and "seq" in items[0]:
                    return items
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
    return []


def parse_search_keyword_page(
    html: str,
    *,
    query: str,
    search_word: str,
    source_url: str,
    fetched_at: str,
) -> JoongnaSearchKeywordResult:
    items = _iter_search_items(html)
    listings = [_build_listing(item) for item in items if item.get("seq") is not None]

    return JoongnaSearchKeywordResult(
        query=query,
        search_word=search_word,
        source_url=source_url,
        fetched_at=fetched_at,
        total_count=len(listings),
        listings=listings,
    )


def _parse_krw(raw_value: str) -> int | None:
    digits = re.sub(r"[^0-9]", "", raw_value)
    if not digits:
        return None
    return int(digits)
