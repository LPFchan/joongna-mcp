import { describe, expect, it, vi } from "vitest";
import {
  normalizeSearchWord,
  saleStatusFromState,
  searchListings,
  type Env,
} from "../index";

const env: Env = {
  JOONGNA_BASE_URL: "https://web.joongna.com",
  JOONGNA_TIMEOUT_SECONDS: "20",
  JOONGNA_USER_AGENT: "test-agent",
};

describe("normalizeSearchWord", () => {
  it("normalizes natural language while preserving explicit terms elsewhere", () => {
    expect(
      normalizeSearchWord("how much does used iPhone 13 mini go these days?"),
    ).toBe("아이폰13미니");
    expect(normalizeSearchWord("갤럭시 s24 ultra 256gb")).toBe(
      "갤럭시s24울트라256",
    );
  });

  it("keeps Hangul and Latin word boundaries intact", () => {
    expect(normalizeSearchWord("맥북pro")).toBe("맥북pro");
    expect(normalizeSearchWord("아이폰a")).toBe("아이폰a");
    expect(normalizeSearchWord("에어팟pro 2")).toBe("에어팟pro2");
    expect(normalizeSearchWord("iPhone 15 Pro Max 256GB")).toBe(
      "아이폰15프로맥스256",
    );
  });

  it("rejects blank and unusable queries", () => {
    expect(() => normalizeSearchWord("  ")).toThrow("must not be blank");
    expect(() => normalizeSearchWord("?!")).toThrow("usable search term");
  });
});

describe("saleStatusFromState", () => {
  it.each([
    [0, "on_sale"],
    [1, "reserved"],
    [3, "sold"],
    [9, "unknown"],
    [null, "unknown"],
  ])(
    "maps native state %s without treating productStatus=9 as search state",
    (state, expected) => expect(saleStatusFromState(state)).toBe(expected),
  );
});

describe("searchListings", () => {
  it("requires query or search_word and preserves explicit search_word bytes", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        return Response.json({
          data: { meta: { code: 0 }, items: [], totalSize: 0 },
        });
      },
    );
    const result = await searchListings(env, {
      search_word: "  아이폰 17  ",
      include_details: false,
    });
    expect(result.outcome).toBe("ok");
    expect(JSON.parse(await calls[0].clone().text()).searchWord).toBe(
      "  아이폰 17  ",
    );
    const invalid = await searchListings(env, {});
    expect(invalid.outcome).toBe("error");
    if (invalid.outcome === "error")
      expect(invalid.error.code).toBe("invalid_query");
    vi.unstubAllGlobals();
  });

  it("keeps malformed comma prices nullable", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: {
          meta: { code: 0 },
          items: [{ seq: 7, state: 3, price: "1,2,3", title: "x" }],
        },
      }),
    );
    const result = await searchListings(env, {
      search_word: "아이폰",
      statuses: ["sold"],
      include_details: false,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "error")
      expect(result.listings[0].price_krw).toBeNull();
    vi.unstubAllGlobals();
  });

  it("rejects malformed listing IDs instead of stringifying them", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: {
          meta: { code: 0 },
          items: [{ seq: {}, state: 0, title: "malformed" }],
        },
      }),
    );
    const result = await searchListings(env, {
      search_word: "아이폰",
      include_details: false,
    });
    expect(result).toMatchObject({
      outcome: "error",
      error: { code: "parse_failed", retryable: false },
    });
    vi.unstubAllGlobals();
  });
});
