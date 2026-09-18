import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../index";

// The Worker's entry point, called directly. Plain vitest rather than
// @cloudflare/vitest-pool-workers: nothing under test needs a workerd runtime
// or a binding, and the one thing that reaches the network -- fetching
// Joongna -- is replaced with a fake below.
//
// Three groups: the refusal path (a request without gateway identity gets
// nothing), the MCP handshakes for the 2025-era and 2026-07-28 clients, and
// the tool calls themselves, which port the Python test_service.py.

const env: Env = {
  JOONGNA_BASE_URL: "https://web.joongna.com",
  JOONGNA_TIMEOUT_SECONDS: "20",
  JOONGNA_USER_AGENT: "test-agent",
};

const IDENTITY = {
  "x-lost-plus-sub": "42",
  "x-lost-plus-email": "me%40lost.plus",
  "x-lost-plus-name": "%EC%82%AC%EC%9A%A9%EC%9E%90",
  "x-lost-plus-role": "user",
  "x-lost-plus-encoding": "percent-utf8",
};

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://joongna.lost.plus${path}`, { headers });
}

// The 2026-07-28 revision carries the handshake in every request.
const META_2026 = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

type JsonRpc = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };

async function rpc(body: JsonRpc, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const response = await worker.fetch(
    new Request("https://joongna.lost.plus/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...IDENTITY,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    env,
  );
  const text = await response.text();
  // 2025-era responses come back as one SSE event; 2026 ones as plain JSON.
  const data = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data: "))!.slice(6) : text;
  return { status: response.status, json: JSON.parse(data) };
}

function initialize(protocolVersion: string): JsonRpc {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "0" } },
  };
}

function rpc2026(method: string, params: Record<string, unknown> = {}) {
  return rpc(
    { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META_2026 } },
    { "mcp-protocol-version": "2026-07-28", "mcp-method": method },
  );
}

function callTool(name: string, args: Record<string, unknown>) {
  return rpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { "mcp-protocol-version": "2025-06-18" },
  );
}

describe("without gateway identity headers", () => {
  for (const path of ["/", "/mcp", "/healthz", "/anything"]) {
    it(`refuses ${path}`, async () => {
      const response = await worker.fetch(request(path), env);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "no gateway identity" });
    });
  }

  it("refuses a POST to /mcp, which is how a real client calls it", async () => {
    const response = await worker.fetch(
      new Request("https://joongna.lost.plus/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    expect(response.status).toBe(500);
  });

  it("refuses a caller presenting a bearer token, which it must not validate", async () => {
    const response = await worker.fetch(request("/mcp", { authorization: "Bearer lp_something" }), env);
    expect(response.status).toBe(500);
  });

  it("refuses an identity sent without the encoding declaration", async () => {
    const { "x-lost-plus-encoding": _, ...unencoded } = IDENTITY;
    const response = await worker.fetch(request("/", unencoded), env);
    expect(response.status).toBe(500);
  });

  it("refuses a partial identity", async () => {
    const { "x-lost-plus-role": _, ...partial } = IDENTITY;
    const response = await worker.fetch(request("/", partial), env);
    expect(response.status).toBe(500);
  });
});

describe("with gateway identity headers", () => {
  it("serves the root document and names the caller it was given", async () => {
    const response = await worker.fetch(request("/", IDENTITY), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "joongna-mcp",
      mcp_path: "/mcp",
      caller: { sub: "42", email: "me@lost.plus", name: "사용자", role: "user" },
      tools: ["joongna_search_price", "joongna_search_keyword"],
    });
  });

  it("404s a path it does not serve", async () => {
    // Including /healthz and the metadata document, which are the gateway's
    // now and never reach this Worker in a correct deployment.
    for (const path of ["/healthz", "/.well-known/oauth-protected-resource/mcp", "/nope"]) {
      const response = await worker.fetch(request(path, IDENTITY), env);
      expect(response.status).toBe(404);
    }
  });
});

describe("MCP handshake", () => {
  for (const version of ["2025-06-18", "2025-03-26"]) {
    it(`initializes a ${version} client`, async () => {
      const { status, json } = await rpc(initialize(version));
      expect(status).toBe(200);
      expect(json.result.protocolVersion).toBe(version);
      expect(json.result.serverInfo).toEqual({ name: "joongna-mcp", version: "0.1.0" });
      expect(json.result.capabilities.tools).toBeDefined();
    });
  }

  it("accepts POST /mcp/ with a trailing slash, as the gateway's /mcp/* route allows", async () => {
    const response = await worker.fetch(
      new Request("https://joongna.lost.plus/mcp/", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...IDENTITY },
        body: JSON.stringify(initialize("2025-06-18")),
      }),
      env,
    );
    expect(response.status).toBe(200);
  });

  it("lists both tools for a 2025 client", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" });
    expect(json.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "joongna_search_price",
      "joongna_search_keyword",
    ]);
    const price = json.result.tools[0].inputSchema.properties;
    expect(price.max_listings).toMatchObject({ minimum: 1, maximum: 20, default: 10 });
    const keyword = json.result.tools[1].inputSchema.properties;
    expect(keyword.max_listings).toMatchObject({ minimum: 1, maximum: 100, default: 20 });
  });

  it("answers server/discover for a 2026-07-28 client with a five-minute cache hint", async () => {
    const { status, json } = await rpc2026("server/discover");
    expect(status).toBe(200);
    expect(json.result.supportedVersions).toContain("2026-07-28");
    expect(json.result).toMatchObject({ ttlMs: 300_000, cacheScope: "private" });
  });

  it("tells a 2026-07-28 client to cache tools/list for five minutes, privately", async () => {
    const { status, json } = await rpc2026("tools/list");
    expect(status).toBe(200);
    expect(json.result.tools).toHaveLength(2);
    expect(json.result).toMatchObject({ ttlMs: 300_000, cacheScope: "private" });
  });
});

// --- tool calls, ported from the Python test_service.py ---------------------

const LISTING = {
  seq: 230894836,
  price: 260000,
  url: "https://img2.joongna.com/search-thumbnail.jpg",
  title: "아이폰13미니 128GB",
  state: 0,
};

const PRODUCT_DETAIL = {
  data: {
    productSeq: 230894836,
    productDescription: "판매자가 작성한 상품 설명",
    media: [
      { mediaType: 0, originUrl: "https://img2.joongna.com/full-1.jpg" },
      { mediaType: 0, originUrl: "https://img2.joongna.com/full-2.jpg" },
    ],
  },
};

function nextChunk(payloadObj: unknown): string {
  const encoded = JSON.stringify("22:" + JSON.stringify(payloadObj));
  return "<script>self.__next_f.push([1," + encoded + "])</" + "script>";
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** A fake Joongna: one search-price page, one keyword page, one product. */
function fakeJoongna() {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (url.startsWith("https://web.joongna.com/search-price/")) {
      const query = {
        queryKey: ["postProductPriceScatterPlot", "BID"],
        state: {
          data: {
            data: {
              searchKeyword: "아이폰13미니",
              productPrice: { linePrices: [], scatterPrices: [] },
              items: [LISTING],
            },
          },
        },
      };
      return html(nextChunk({ state: { queries: [query] } }));
    }
    if (url.startsWith("https://web.joongna.com/search/")) {
      return html(nextChunk({ items: [LISTING] }));
    }
    if (url.startsWith("https://product-api.joongna.com/basic/")) {
      return Response.json(PRODUCT_DETAIL);
    }
    throw new Error("unexpected fetch " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, detailCalls: () => calls.filter((c) => c.url.includes("product-api")).map((c) => c.url) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tool calls", () => {
  it("both search tools include description and images by default", async () => {
    const joongna = fakeJoongna();
    const expectedImages = ["https://img2.joongna.com/full-1.jpg", "https://img2.joongna.com/full-2.jpg"];

    const keyword = await callTool("joongna_search_keyword", { query: "아이폰13미니" });
    expect(keyword.json.result.isError).toBeUndefined();
    const keywordResult = JSON.parse(keyword.json.result.content[0].text);
    expect(keywordResult.search_word).toBe("아이폰13미니");
    expect(keywordResult.listings[0].description).toBe("판매자가 작성한 상품 설명");
    expect(keywordResult.listings[0].image_urls).toEqual(expectedImages);
    expect(keywordResult.listings[0].sale_status).toBe("on_sale");

    const price = await callTool("joongna_search_price", { query: "아이폰13미니" });
    const priceResult = JSON.parse(price.json.result.content[0].text);
    expect(priceResult.available_listings[0].description).toBe("판매자가 작성한 상품 설명");
    expect(priceResult.available_listings[0].image_urls).toEqual(expectedImages);
    expect(priceResult.registered_price_history.listings[0].description).toBe("판매자가 작성한 상품 설명");

    // One detail fetch per unique listing per call, even though the price
    // result carries the same listing in two places.
    expect(joongna.detailCalls()).toEqual([
      "https://product-api.joongna.com/basic/230894836?increaseViewCount=false",
      "https://product-api.joongna.com/basic/230894836?increaseViewCount=false",
    ]);
  });

  it("sends the browser-shaped headers Joongna expects, with the configured user agent", async () => {
    const joongna = fakeJoongna();
    await callTool("joongna_search_keyword", { query: "아이폰13미니" });
    const page = joongna.calls[0];
    expect(page.url).toBe(
      "https://web.joongna.com/search/%EC%95%84%EC%9D%B4%ED%8F%B013%EB%AF%B8%EB%8B%88?excludeSoldOutProductYn=false",
    );
    expect(page.headers.get("user-agent")).toBe("test-agent");
    expect(page.headers.get("accept-language")).toContain("ko-KR");
    expect(page.headers.get("referer")).toBe("https://web.joongna.com/search-price");
    const detail = joongna.calls[1];
    expect(detail.headers.get("accept")).toBe("application/json");
  });

  it("uses an explicit search_word instead of normalizing the query", async () => {
    const joongna = fakeJoongna();
    await callTool("joongna_search_price", { query: "whatever", search_word: "갤럭시S24" });
    expect(joongna.calls[0].url).toBe("https://web.joongna.com/search-price/%EA%B0%A4%EB%9F%AD%EC%8B%9CS24");
  });

  it("rejects max_listings outside the schema before fetching anything", async () => {
    const joongna = fakeJoongna();
    const { json } = await callTool("joongna_search_price", { query: "아이폰", max_listings: 21 });
    expect(json.result?.isError ?? json.error !== undefined).toBe(true);
    expect(joongna.calls).toHaveLength(0);
  });

  it("reports an anti-bot page as a tool error rather than a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html("<html>please solve this captcha</html>")));
    const { status, json } = await callTool("joongna_search_price", { query: "아이폰" });
    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toBe("Joongna returned a suspected anti-bot page");
  });

  it("reports a non-200 from Joongna as a tool error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const { json } = await callTool("joongna_search_price", { query: "아이폰" });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/^Joongna returned HTTP 503 for /);
  });

  it("degrades to no description when the product API fails, instead of failing the search", async () => {
    const joongna = fakeJoongna();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("product-api")) return new Response("err", { status: 500 });
      return real(input, init);
    });
    const { json } = await callTool("joongna_search_keyword", { query: "아이폰13미니" });
    expect(json.result.isError).toBeUndefined();
    const result = JSON.parse(json.result.content[0].text);
    expect(result.listings[0].description).toBeNull();
    expect(result.listings[0].image_urls).toEqual(["https://img2.joongna.com/search-thumbnail.jpg"]);
    expect(joongna.calls).toHaveLength(1); // the page; the detail call never reached the fake
  });
});
