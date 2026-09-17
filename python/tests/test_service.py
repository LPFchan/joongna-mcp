from __future__ import annotations

import asyncio
import json

from joongna_mcp.service import JoongnaPriceService


LISTING = {
    "seq": 230894836,
    "price": 260000,
    "url": "https://img2.joongna.com/search-thumbnail.jpg",
    "title": "아이폰13미니 128GB",
}

PRODUCT_DETAIL = {
    "data": {
        "productSeq": 230894836,
        "productDescription": "판매자가 작성한 상품 설명",
        "media": [
            {"mediaType": 0, "originUrl": "https://img2.joongna.com/full-1.jpg"},
            {"mediaType": 0, "originUrl": "https://img2.joongna.com/full-2.jpg"},
        ],
    }
}


class FakeClient:
    def __init__(self) -> None:
        self.detail_calls: list[int] = []

    async def fetch_search_page(self, search_word: str) -> tuple[str, str]:
        query = {
            "state": {
                "data": {
                    "data": {
                        "searchKeyword": search_word,
                        "productPrice": {"linePrices": [], "scatterPrices": []},
                        "items": [LISTING],
                    }
                }
            },
            "queryKey": ["postProductPriceScatterPlot", "BID"],
        }
        return "https://web.joongna.com/search-price/test", _next_chunk(
            {"state": {"queries": [query]}}
        )

    async def fetch_search_keyword_page(self, search_word: str) -> tuple[str, str]:
        return "https://web.joongna.com/search/test", _next_chunk({"items": [LISTING]})

    async def fetch_product_detail(self, sequence: int) -> dict:
        self.detail_calls.append(sequence)
        return PRODUCT_DETAIL

    async def aclose(self) -> None:
        return None


def test_both_search_tools_include_description_and_images_by_default() -> None:
    async def run() -> None:
        client = FakeClient()
        service = JoongnaPriceService(client)  # type: ignore[arg-type]

        keyword_result = await service.search_keyword(query="아이폰13미니")
        price_result = await service.search(query="아이폰13미니")

        expected_images = [
            "https://img2.joongna.com/full-1.jpg",
            "https://img2.joongna.com/full-2.jpg",
        ]
        assert keyword_result.listings[0].description == "판매자가 작성한 상품 설명"
        assert keyword_result.listings[0].image_urls == expected_images
        assert price_result.available_listings[0].description == "판매자가 작성한 상품 설명"
        assert price_result.available_listings[0].image_urls == expected_images
        assert price_result.registered_price_history is not None
        assert price_result.registered_price_history.listings[0].description == (
            "판매자가 작성한 상품 설명"
        )
        assert client.detail_calls == [230894836]

    asyncio.run(run())


def _next_chunk(payload_obj: dict) -> str:
    encoded = json.dumps(f"22:{json.dumps(payload_obj, ensure_ascii=False, separators=(',', ':'))}")
    return f"<script>self.__next_f.push([1,{encoded}])</script>"
