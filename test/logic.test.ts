import { describe, expect, it } from "vitest";
import {
  normalizeSearchWord,
  parseProductDetail,
  parseSearchPricePage,
} from "../index";

// Fixtures ported 1:1 from python/tests/test_parser.py and test_normalize.py
// so the Worker port asserts the same behavior as the Python server.

function nextChunk(payloadObj: unknown): string {
  const encoded = JSON.stringify("22:" + JSON.stringify(payloadObj));
  return "<script>self.__next_f.push([1," + encoded + "])</" + "script>";
}

describe("normalizeSearchWord", () => {
  it("normalizes an English natural-language query", () => {
    expect(normalizeSearchWord("how much does used iPhone 13 mini go these days?")).toBe(
      "아이폰13미니",
    );
  });

  it("normalizes a Korean query", () => {
    expect(normalizeSearchWord("아이폰 13 미니")).toBe("아이폰13미니");
  });
});

describe("parseSearchPricePage", () => {
  it("extracts summary, history, and listings", () => {
    const bidQuery = {
      queryKey: ["postProductPriceScatterPlot", "BID", { searchWord: "아이폰13미니", priceType: 0 }],
      state: {
        data: {
          data: {
            searchKeyword: "아이폰13미니",
            selectExposureKeyword: "아이폰",
            selectModelName: "아이폰13미니",
            selectOptionName: "",
            emptyResult: null,
            productPrice: {
              linePrices: [{ date: "2026-04-15", avgPrice: 285000 }],
              scatterPrices: [
                { dateHour: "2026-04-15 01:00:00", priceCounts: [{ price: 280000, count: 1 }] },
              ],
            },
            items: [
              {
                seq: 228498566,
                price: 285000,
                url: "https://img2.joongna.com/media/original/iphone13mini.jpg",
                title: "아이폰13미니 128 그린 S급 풀박스",
                sortDate: "2026-05-14 13:01:03",
                mainLocationName: null,
                parcelFee: 0,
                chatCount: 0,
                wishCount: 0,
                pickupBadgeFlag: false,
                certifySellerFlag: false,
                articleUrl: null,
              },
            ],
          },
        },
      },
    };
    const executionQuery = {
      queryKey: ["postProductPriceScatterPlot", "EXECUTION", { searchWord: "아이폰13미니", priceType: 1 }],
      state: {
        data: {
          data: {
            searchKeyword: "아이폰13미니",
            selectExposureKeyword: "아이폰",
            selectModelName: "아이폰13미니",
            selectOptionName: "",
            emptyResult: null,
            productPrice: {
              linePrices: [{ date: "2026-04-15", avgPrice: 260000 }],
              scatterPrices: [
                { dateHour: "2026-04-15 01:00:00", priceCounts: [{ price: 255000, count: 1 }] },
              ],
            },
            items: [
              {
                seq: 228498566,
                price: 285000,
                url: "https://img2.joongna.com/media/original/iphone13mini.jpg",
                title: "아이폰13미니 128 그린 S급 풀박스",
                sortDate: "2026-05-14 13:01:03",
                mainLocationName: null,
                parcelFee: 0,
                chatCount: 0,
                wishCount: 0,
                pickupBadgeFlag: false,
                certifySellerFlag: false,
                articleUrl: null,
              },
            ],
          },
        },
      },
    };

    const html = [
      "<span>평균 가격</span><span>379,650원</span>",
      "<span>가장 높은 가격</span><span>650,000원</span>",
      "<span>가장 낮은 가격</span><span>5,000원</span>",
      nextChunk({ state: { queries: [bidQuery] } }),
      nextChunk({ state: { queries: [executionQuery] } }),
    ].join("");

    const result = parseSearchPricePage(html, {
      query: "how much does used iPhone 13 mini go these days?",
      searchWord: "아이폰13미니",
      sourceUrl: "https://web.joongna.com/search-price/x",
      fetchedAt: "2026-05-14T12:00:00+00:00",
    });

    expect(result.summary.average_price_krw).toBe(379650);
    expect(result.summary.highest_price_krw).toBe(650000);
    expect(result.summary.lowest_price_krw).toBe(5000);

    expect(result.registered_price_history?.label_ko).toBe("등록가");
    expect(result.registered_price_history?.daily_average_prices[0].average_price_krw).toBe(285000);

    expect(result.sold_price_history?.label_ko).toBe("판매가");
    expect(result.sold_price_history?.daily_average_prices[0].average_price_krw).toBe(260000);

    expect(result.metadata?.search_keyword).toBe("아이폰13미니");
    expect(result.metadata?.selected_model_name).toBe("아이폰13미니");

    expect(result.available_listings[0].listing_url).toBe("https://web.joongna.com/product/228498566");
    expect(result.available_listings[0].thumbnail_url).toBe(
      "https://img2.joongna.com/media/original/iphone13mini.jpg",
    );
    expect(result.available_listings[0].image_urls).toEqual([
      "https://img2.joongna.com/media/original/iphone13mini.jpg",
    ]);
    expect(result.available_listings[0].title).toBe("아이폰13미니 128 그린 S급 풀박스");
  });
});

describe("parseProductDetail", () => {
  it("extracts description and ordered images", () => {
    const result = parseProductDetail({
      data: {
        productDescription: "판매자가 작성한 설명\n두 번째 줄",
        media: [
          {
            mediaType: 0,
            originUrl: "https://img2.joongna.com/first.jpg",
            mediaUrl: "https://img2.joongna.com/first-watermarked.jpg",
          },
          { mediaType: 1, originUrl: "https://img2.joongna.com/video.mp4" },
        ],
        descriptionMedia: [
          { mediaType: 0, originUrl: "https://img2.joongna.com/second.jpg" },
          { mediaType: 0, originUrl: "https://img2.joongna.com/first.jpg" },
        ],
      },
    });

    expect(result.description).toBe("판매자가 작성한 설명\n두 번째 줄");
    expect(result.image_urls).toEqual([
      "https://img2.joongna.com/first.jpg",
      "https://img2.joongna.com/second.jpg",
    ]);
  });
});
