from __future__ import annotations

import json

import pytest

from joongna_mcp.parser import _sale_status, parse_product_detail, parse_search_price_page


def test_parse_search_price_page_extracts_summary_history_and_listings() -> None:
    bid_query = {
        "state": {
            "data": {
                "data": {
                    "searchKeyword": "아이폰13미니",
                    "selectExposureKeyword": "아이폰",
                    "selectModelName": "아이폰13미니",
                    "selectOptionName": "",
                    "emptyResult": None,
                    "productPrice": {
                        "linePrices": [{"date": "2026-04-15", "avgPrice": 285000}],
                        "scatterPrices": [
                            {
                                "dateHour": "2026-04-15 01:00:00",
                                "priceCounts": [{"price": 280000, "count": 1}],
                            }
                        ],
                    },
                    "items": [
                        {
                            "seq": 228498566,
                            "price": 285000,
                            "url": "https://img2.joongna.com/media/original/iphone13mini.jpg",
                            "title": "아이폰13미니 128 그린 S급 풀박스",
                            "sortDate": "2026-05-14 13:01:03",
                            "mainLocationName": None,
                            "parcelFee": 0,
                            "chatCount": 0,
                            "wishCount": 0,
                            "pickupBadgeFlag": False,
                            "certifySellerFlag": False,
                            "articleUrl": None,
                        }
                    ],
                }
            }
        },
        "queryKey": ["postProductPriceScatterPlot", "BID", {"searchWord": "아이폰13미니", "priceType": 0}],
    }
    execution_query = {
        "state": {
            "data": {
                "data": {
                    "searchKeyword": "아이폰13미니",
                    "selectExposureKeyword": "아이폰",
                    "selectModelName": "아이폰13미니",
                    "selectOptionName": "",
                    "emptyResult": None,
                    "productPrice": {
                        "linePrices": [{"date": "2026-04-15", "avgPrice": 260000}],
                        "scatterPrices": [
                            {
                                "dateHour": "2026-04-15 01:00:00",
                                "priceCounts": [{"price": 255000, "count": 1}],
                            }
                        ],
                    },
                    "items": [
                        {
                            "seq": 228498566,
                            "price": 285000,
                            "url": "https://img2.joongna.com/media/original/iphone13mini.jpg",
                            "title": "아이폰13미니 128 그린 S급 풀박스",
                            "sortDate": "2026-05-14 13:01:03",
                            "mainLocationName": None,
                            "parcelFee": 0,
                            "chatCount": 0,
                            "wishCount": 0,
                            "pickupBadgeFlag": False,
                            "certifySellerFlag": False,
                            "articleUrl": None,
                        }
                    ],
                }
            }
        },
        "queryKey": [
            "postProductPriceScatterPlot",
            "EXECUTION",
            {"searchWord": "아이폰13미니", "priceType": 1},
        ],
    }

    html = "".join(
        [
            '<span>평균 가격</span><span>379,650원</span>',
            '<span>가장 높은 가격</span><span>650,000원</span>',
            '<span>가장 낮은 가격</span><span>5,000원</span>',
            _next_chunk({"state": {"queries": [bid_query]}}),
            _next_chunk({"state": {"queries": [execution_query]}}),
        ]
    )

    result = parse_search_price_page(
        html,
        query="how much does used iPhone 13 mini go these days?",
        search_word="아이폰13미니",
        source_url="https://web.joongna.com/search-price/%EC%95%84%EC%9D%B4%ED%8F%B013%EB%AF%B8%EB%8B%88",
        fetched_at="2026-05-14T12:00:00+00:00",
    )

    assert result.summary.average_price_krw == 379650
    assert result.summary.highest_price_krw == 650000
    assert result.summary.lowest_price_krw == 5000

    assert result.registered_price_history is not None
    assert result.registered_price_history.label_ko == "등록가"
    assert result.registered_price_history.daily_average_prices[0].average_price_krw == 285000

    assert result.sold_price_history is not None
    assert result.sold_price_history.label_ko == "판매가"
    assert result.sold_price_history.daily_average_prices[0].average_price_krw == 260000

    assert result.metadata is not None
    assert result.metadata.search_keyword == "아이폰13미니"
    assert result.metadata.selected_model_name == "아이폰13미니"

    assert result.available_listings[0].listing_url == "https://web.joongna.com/product/228498566"
    assert result.available_listings[0].thumbnail_url == "https://img2.joongna.com/media/original/iphone13mini.jpg"
    assert result.available_listings[0].image_urls == [
        "https://img2.joongna.com/media/original/iphone13mini.jpg"
    ]
    assert result.available_listings[0].title == "아이폰13미니 128 그린 S급 풀박스"


def test_parse_product_detail_extracts_description_and_ordered_images() -> None:
    result = parse_product_detail(
        {
            "data": {
                "productDescription": "판매자가 작성한 설명\n두 번째 줄",
                "media": [
                    {
                        "mediaType": 0,
                        "originUrl": "https://img2.joongna.com/first.jpg",
                        "mediaUrl": "https://img2.joongna.com/first-watermarked.jpg",
                    },
                    {
                        "mediaType": 1,
                        "originUrl": "https://img2.joongna.com/video.mp4",
                    },
                ],
                "descriptionMedia": [
                    {
                        "mediaType": 0,
                        "originUrl": "https://img2.joongna.com/second.jpg",
                    },
                    {
                        "mediaType": 0,
                        "originUrl": "https://img2.joongna.com/first.jpg",
                    },
                ],
            }
        }
    )

    assert result.description == "판매자가 작성한 설명\n두 번째 줄"
    assert result.image_urls == [
        "https://img2.joongna.com/first.jpg",
        "https://img2.joongna.com/second.jpg",
    ]


@pytest.mark.parametrize(
    ("state", "expected"),
    [
        (0, "on_sale"),
        (1, "reserved"),
        (3, "sold"),
        (2, "unknown_2"),
        (None, None),
    ],
)
def test_sale_status_maps_joongna_state_codes(state: int | None, expected: str | None) -> None:
    assert _sale_status(state) == expected

def _next_chunk(payload_obj: dict) -> str:
    encoded = json.dumps(f"22:{json.dumps(payload_obj, ensure_ascii=False, separators=(',', ':'))}")
    return f"<script>self.__next_f.push([1,{encoded}])</script>"
