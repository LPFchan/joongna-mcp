import { describe, expect, it } from "vitest";
import {
  normalizeSearchWord,
  parseProductDetail,
  parseSearchKeywordPage,
  parseSearchPricePage,
  saleStatusFromState,
} from "../index";

// Fixtures ported 1:1 from the Python server's test_parser.py and
// test_normalize.py (deleted with the container tree), plus cases where the
// two runtimes diverged during the port so the divergence stays fixed.

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

  it("uses the Python word boundary, where Hangul is a word character", () => {
    // JavaScript's \b would split "맥북pro" into 맥북 + pro and translate the
    // pro, and would strip the trailing a from "아이폰a" as a noise word. The
    // Python re module does neither, and neither does this.
    expect(normalizeSearchWord("맥북pro")).toBe("맥북pro");
    expect(normalizeSearchWord("아이폰a")).toBe("아이폰a");
    expect(normalizeSearchWord("에어팟pro 2")).toBe("에어팟pro2");
    // Space-separated words still translate and still lose their storage unit.
    expect(normalizeSearchWord("갤럭시 s24 ultra 256gb")).toBe("갤럭시s24울트라256");
    expect(normalizeSearchWord("iPhone 15 Pro Max 256GB")).toBe("아이폰15프로맥스256");
  });

  it("rejects a blank query and one with nothing searchable", () => {
    expect(() => normalizeSearchWord("   ")).toThrow("must not be blank");
    expect(() => normalizeSearchWord("???")).toThrow("usable search term");
  });
});

describe("saleStatusFromState", () => {
  it.each([
    [0, "on_sale"],
    [1, "reserved"],
    [3, "sold"],
    [2, "unknown_2"],
    [null, null],
  ])("maps Joongna state %s to %s", (state, expected) => {
    expect(saleStatusFromState(state)).toBe(expected);
  });
});

describe("parseSearchKeywordPage", () => {
  it("reads the first items array with a seq, labels sale state, and nulls empty strings", () => {
    const html = nextChunk({
      items: [
        {
          seq: 230894836,
          price: 260000,
          url: "https://img2.joongna.com/search-thumbnail.jpg",
          title: "아이폰13미니 128GB &amp; 케이스",
          state: 3,
          sortDate: "",
          mainLocationName: "",
          articleUrl: "/product/230894836",
        },
        { seq: 1, price: null, url: null, title: null },
      ],
    });
    const result = parseSearchKeywordPage(html, {
      query: "아이폰13미니",
      searchWord: "아이폰13미니",
      sourceUrl: "https://web.joongna.com/search/x",
      fetchedAt: "2026-05-14T12:00:00Z",
    });

    expect(result.total_count).toBe(2);
    const [first, second] = result.listings;
    expect(first.title).toBe("아이폰13미니 128GB & 케이스");
    expect(first.sale_status).toBe("sold");
    expect(first.listing_url).toBe("https://web.joongna.com/product/230894836");
    // The Python built these with `or None`, so an empty string is a null.
    expect(first.sorted_at).toBeNull();
    expect(first.location_name).toBeNull();
    expect(second).toMatchObject({ title: "", price_krw: 0, thumbnail_url: null, image_urls: [], sale_status: null });
  });

  it("returns no listings when the page carries no items", () => {
    const result = parseSearchKeywordPage("<html></html>", {
      query: "q",
      searchWord: "q",
      sourceUrl: "u",
      fetchedAt: "t",
    });
    expect(result).toMatchObject({ total_count: 0, listings: [], from_cache: false });
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
    expect(result.empty_result).toBe(false);
  });

  it("reports an empty result when Joongna says so, and fills in metadata", () => {
    const emptyQuery = {
      queryKey: ["postProductPriceScatterPlot", "BID"],
      state: { data: { data: { emptyResult: true, productPrice: {}, items: [] } } },
    };
    const result = parseSearchPricePage(nextChunk({ state: { queries: [emptyQuery] } }), {
      query: "q",
      searchWord: "없는검색어",
      sourceUrl: "u",
      fetchedAt: "t",
    });
    expect(result.empty_result).toBe(true);
    expect(result.empty_result_reason).toBe("No pricing data found for this search word");
    expect(result.metadata?.search_keyword).toBe("없는검색어");
    expect(result.available_listings).toEqual([]);
  });

  it("treats a page with neither summary nor hydrated datasets as an empty result", () => {
    // As the Python did: no marker, no datasets, no summary is "nothing
    // found", not a parse failure.
    const result = parseSearchPricePage("<html>nothing here</html>", {
      query: "q",
      searchWord: "q",
      sourceUrl: "u",
      fetchedAt: "t",
    });
    expect(result.empty_result).toBe(true);
    expect(result.summary).toEqual({ average_price_krw: null, highest_price_krw: null, lowest_price_krw: null });
    expect(result.registered_price_history).toBeNull();
    expect(result.sold_price_history).toBeNull();
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
