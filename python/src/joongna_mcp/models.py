from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PriceSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    average_price_krw: int | None = Field(default=None)
    highest_price_krw: int | None = Field(default=None)
    lowest_price_krw: int | None = Field(default=None)


class DailyAveragePoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: str
    average_price_krw: int


class HourlyScatterPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date_hour: str
    price_krw: int
    count: int


class Listing(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sequence: int
    title: str
    price_krw: int
    listing_url: str
    thumbnail_url: str | None = None
    description: str | None = Field(
        default=None,
        description="Seller-provided listing description",
    )
    image_urls: list[str] = Field(
        default_factory=list,
        description="Full-size product image URLs in display order",
    )
    sorted_at: str | None = None
    location_name: str | None = None
    parcel_fee_krw: int | None = None
    chat_count: int | None = None
    wish_count: int | None = None
    pickup_badge: bool | None = None
    certified_seller: bool | None = None
    state: int | None = None


class ListingDetails(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str | None = None
    image_urls: list[str] = Field(default_factory=list)


class SearchMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    search_keyword: str | None = None
    selected_exposure_keyword: str | None = None
    selected_model_name: str | None = None
    selected_option_name: str | None = None


class PriceHistoryDataset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_key: Literal["BID", "EXECUTION"]
    label_ko: Literal["등록가", "판매가"]
    listing_count: int
    daily_average_prices: list[DailyAveragePoint] = Field(default_factory=list)
    hourly_scatter_points: list[HourlyScatterPoint] = Field(default_factory=list)
    listings: list[Listing] = Field(default_factory=list)


class JoongnaSearchKeywordResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str
    search_word: str
    source_url: str
    fetched_at: str
    from_cache: bool = False
    total_count: int = 0
    listings: list[Listing] = Field(default_factory=list)


class JoongnaSearchPriceResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str
    search_word: str
    source_url: str
    fetched_at: str
    from_cache: bool = False
    empty_result: bool = False
    empty_result_reason: str | None = None
    summary: PriceSummary = Field(default_factory=PriceSummary)
    metadata: SearchMetadata | None = None
    registered_price_history: PriceHistoryDataset | None = None
    sold_price_history: PriceHistoryDataset | None = None
    available_listings: list[Listing] = Field(default_factory=list)
