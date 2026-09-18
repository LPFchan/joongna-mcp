import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

// joongna-mcp Worker: MCP server on Cloudflare Workers, port of the Python
// joongna-mcp (Joongna search-price scraper).
//
// A route-less backend behind the gateway Worker. It authenticates nobody:
// the gateway has already asked auth.lost.plus who the caller is, and hands
// the answer over in x-lost-plus-* headers. See identity.ts, and the routes
// comment in wrangler.toml for why this Worker holds no route of its own.
//
// Note: the Python server keeps in-memory caches (JOONGNA_CACHE_TTL_SECONDS)
// for search pages and product details. Those are dropped here because
// module-level state does not persist across Worker requests; every tool
// call fetches fresh data. The force_refresh parameter is accepted for
// parity but is a no-op.
import { z } from "zod";
import { identityFrom } from "./identity";

export interface Env {
  JOONGNA_BASE_URL: string;
  JOONGNA_TIMEOUT_SECONDS: string;
  JOONGNA_USER_AGENT: string;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const PRODUCT_API_BASE_URL = "https://product-api.joongna.com";
const KEYWORD_MAX_RETRIES = 3;
const KEYWORD_RETRY_DELAY_MS = 2000;

// --- normalize ---------------------------------------------------------------

// A whole-word match with the boundary the Python original had. Python's `\b`
// counts any Unicode letter as a word character, so `pro` in "맥북pro" is not
// a word of its own there; JavaScript's `\b` is ASCII-only and would split it.
// The lookarounds reproduce the Python boundary so "맥북pro" and "아이폰a"
// normalize the same way they did.
const WORD_START = "(?<![\\p{L}\\p{N}_])";
const WORD_END = "(?![\\p{L}\\p{N}_])";
function word(pattern: string): RegExp {
  return new RegExp(WORD_START + pattern + WORD_END, "gu");
}

const PHRASE_REPLACEMENTS: Array<[RegExp, string]> = [
  [word("apple watch"), "애플워치"],
  [word("airpods max"), "에어팟맥스"],
  [word("airpods pro"), "에어팟프로"],
  [word("airpods"), "에어팟"],
  [word("galaxy z fold"), "갤럭시z폴드"],
  [word("galaxy z flip"), "갤럭시z플립"],
  [word("galaxy"), "갤럭시"],
  [word("iphone"), "아이폰"],
  [word("ipad"), "아이패드"],
  [word("macbook"), "맥북"],
  [word("pro max"), "프로맥스"],
  [word("plus"), "플러스"],
  [word("ultra"), "울트라"],
  [word("mini"), "미니"],
  [word("pro"), "프로"],
  [word("max"), "맥스"],
];

const NOISE_PATTERNS: RegExp[] = [
  "how much does",
  "how much do",
  "how much is",
  "how much are",
  "how much",
  "what is the price of",
  "price of",
  "going for",
  "go for",
  "go these days",
  "these days",
  "worth",
  "selling for",
  "used",
  "second hand",
  "price",
  "current",
  "does",
  "do",
  "is",
  "are",
  "for",
  "the",
  "a",
  "an",
].map(word);

const STORAGE_UNIT_RE = word("(\\d+)\\s*(gb|g|tb)");

export function normalizeSearchWord(query: string): string {
  const text = query.trim();
  if (!text) throw new Error("query must not be blank");

  let normalized = text.toLowerCase();
  normalized = normalized.replace(/[?!.:,/()[\]{}]+/g, " ");
  normalized = normalized.replace(STORAGE_UNIT_RE, "$1");

  for (const [pattern, replacement] of PHRASE_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  for (const pattern of NOISE_PATTERNS) {
    normalized = normalized.replace(pattern, " ");
  }

  normalized = normalized.replace(/[^0-9a-zA-Z가-힣]+/g, " ");
  normalized = normalized.replace(/\s+/g, "");

  if (normalized) return normalized;

  const fallback = text.replace(/[^0-9a-zA-Z가-힣]+/g, "");
  if (!fallback) throw new Error("query did not contain a usable search term");
  return fallback;
}

// --- client ------------------------------------------------------------------

class JoongnaFetchError extends Error {}

interface ClientConfig {
  baseUrl: string;
  timeoutSeconds: number;
  userAgent: string;
}

function clientConfigFromEnv(env: Env): ClientConfig {
  return {
    baseUrl: (env.JOONGNA_BASE_URL || "https://web.joongna.com").replace(/\/+$/, ""),
    timeoutSeconds: Number.parseFloat(env.JOONGNA_TIMEOUT_SECONDS || "20"),
    userAgent: env.JOONGNA_USER_AGENT || DEFAULT_USER_AGENT,
  };
}

function pageHeaders(config: ClientConfig): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer: config.baseUrl + "/search-price",
    "user-agent": config.userAgent,
  };
}

function buildSearchUrl(config: ClientConfig, searchWord: string): string {
  return config.baseUrl + "/search-price/" + encodeURIComponent(searchWord.trim());
}

function buildSearchKeywordUrl(config: ClientConfig, keyword: string): string {
  return config.baseUrl + "/search/" + encodeURIComponent(keyword.trim()) + "?excludeSoldOutProductYn=false";
}

function checkAntiBot(body: string, url: string): void {
  const lowered = body.toLowerCase();
  if (lowered.includes("captcha") || (lowered.includes("cloudflare") && !body.includes("__next_f.push"))) {
    throw new JoongnaFetchError("Joongna returned a suspected anti-bot page");
  }
}

async function fetchHtmlPage(config: ClientConfig, url: string, kind: string): Promise<[string, string]> {
  if (!url) throw new JoongnaFetchError(kind + " must not be blank");

  const resp = await fetch(url, {
    headers: pageHeaders(config),
    signal: AbortSignal.timeout(Math.round(config.timeoutSeconds * 1000)),
  });

  if (resp.status !== 200) {
    throw new JoongnaFetchError("Joongna returned HTTP " + resp.status + " for " + url);
  }

  const contentType = resp.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new JoongnaFetchError(
      "Joongna returned unexpected content type " + JSON.stringify(contentType) + " for " + url,
    );
  }

  const body = await resp.text();
  checkAntiBot(body, url);
  return [url, body];
}

async function fetchSearchPage(config: ClientConfig, searchWord: string): Promise<[string, string]> {
  if (!searchWord.trim()) throw new JoongnaFetchError("search_word must not be blank");
  return fetchHtmlPage(config, buildSearchUrl(config, searchWord), "search_word");
}

async function fetchSearchKeywordPage(config: ClientConfig, keyword: string): Promise<[string, string]> {
  if (!keyword.trim()) throw new JoongnaFetchError("keyword must not be blank");
  return fetchHtmlPage(config, buildSearchKeywordUrl(config, keyword), "keyword");
}

async function fetchProductDetail(
  config: ClientConfig,
  sequence: number,
): Promise<JsonObject> {
  const url =
    PRODUCT_API_BASE_URL + "/basic/" + sequence + "?increaseViewCount=false";
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { ...pageHeaders(config), accept: "application/json" },
      signal: AbortSignal.timeout(Math.round(config.timeoutSeconds * 1000)),
    });
  } catch {
    throw new JoongnaFetchError("Could not fetch Joongna product " + sequence);
  }

  if (resp.status !== 200) {
    throw new JoongnaFetchError("Joongna returned HTTP " + resp.status + " for " + url);
  }

  const contentType = resp.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new JoongnaFetchError(
      "Joongna returned unexpected content type " + JSON.stringify(contentType) + " for " + url,
    );
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    throw new JoongnaFetchError("Joongna returned invalid JSON for " + url);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new JoongnaFetchError("Joongna returned an invalid product response for " + url);
  }
  return payload as JsonObject;
}

// --- parser ------------------------------------------------------------------

class JoongnaParseError extends Error {}

// Mirrors _NEXT_FLIGHT_RE in python/src/joongna_mcp/parser.py.
// Extracts the string literal out of self.__next_f.push([N,"..."]) calls.
const NEXT_FLIGHT_RE = /self\.__next_f\.push\(\[\d+,\s*"((?:\\.|[^"\\])*)"\]\)/gs;

// Mirrors _SUMMARY_RE.
const SUMMARY_RE = />(평균 가격|가장 높은 가격|가장 낮은 가격)<\/span><span[^>]*>([^<]+)<\/span>/g;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface PriceSummaryData {
  average_price_krw: number | null;
  highest_price_krw: number | null;
  lowest_price_krw: number | null;
}

interface SearchMetadataData {
  search_keyword: string | null;
  selected_exposure_keyword: string | null;
  selected_model_name: string | null;
  selected_option_name: string | null;
}

interface ListingData {
  sequence: number;
  title: string;
  price_krw: number;
  listing_url: string;
  thumbnail_url: string | null;
  description: string | null;
  image_urls: string[];
  sorted_at: string | null;
  location_name: string | null;
  parcel_fee_krw: number | null;
  chat_count: number | null;
  wish_count: number | null;
  pickup_badge: boolean | null;
  certified_seller: boolean | null;
  sale_status: SaleStatus | null;
}

interface PriceHistoryDatasetData {
  source_key: "BID" | "EXECUTION";
  label_ko: "등록가" | "판매가";
  listing_count: number;
  daily_average_prices: Array<{ date: string; average_price_krw: number }>;
  hourly_scatter_points: Array<{ date_hour: string; price_krw: number; count: number }>;
  listings: ListingData[];
}

interface SearchPriceResult {
  query: string;
  search_word: string;
  source_url: string;
  fetched_at: string;
  from_cache: boolean;
  empty_result: boolean;
  empty_result_reason: string | null;
  summary: PriceSummaryData;
  metadata: SearchMetadataData | null;
  registered_price_history: PriceHistoryDatasetData | null;
  sold_price_history: PriceHistoryDatasetData | null;
  available_listings: ListingData[];
}

interface SearchKeywordResult {
  query: string;
  search_word: string;
  source_url: string;
  fetched_at: string;
  from_cache: boolean;
  total_count: number;
  listings: ListingData[];
}

// Minimal HTML entity unescape for the entities that actually appear in
// Next.js flight payloads (HTML-escaped titles).
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function unescapeHtml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return HTML_ENTITIES[entity] ?? match;
  });
}

function parseKrw(rawValue: string): number | null {
  const digits = rawValue.replace(/[^0-9]/g, "");
  if (!digits) return null;
  return Number.parseInt(digits, 10);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Decode the string literal captured from a __next_f.push call. The captured
// text is the raw contents of a JSON double-quoted string, so wrapping it in
// quotes and running JSON.parse reproduces Python's json.loads(f'"{encoded}"').
function decodeFlightLiteral(encoded: string): string | null {
  try {
    return JSON.parse('"' + encoded + '"') as string;
  } catch {
    return null;
  }
}

function* iterFlightPayloads(html: string): Generator<JsonValue> {
  NEXT_FLIGHT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NEXT_FLIGHT_RE.exec(html)) !== null) {
    const decoded = decodeFlightLiteral(match[1]);
    if (decoded === null || !decoded.includes(":")) continue;
    const payload = decoded.slice(decoded.indexOf(":") + 1);
    try {
      yield JSON.parse(payload) as JsonValue;
    } catch {
      continue;
    }
  }
}

function* iterHydratedQueries(html: string): Generator<JsonObject> {
  for (const root of iterFlightPayloads(html)) {
    const stack: JsonValue[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item);
      } else if (isObject(node)) {
        const queries = node["queries"];
        if (Array.isArray(queries)) {
          for (const query of queries) {
            if (isObject(query)) yield query;
          }
        }
        for (const value of Object.values(node)) stack.push(value);
      }
    }
  }
}

function iterSearchItems(html: string): JsonObject[] {
  for (const root of iterFlightPayloads(html)) {
    const stack: JsonValue[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item);
      } else if (isObject(node)) {
        const items = node["items"];
        if (
          Array.isArray(items) &&
          items.length > 0 &&
          isObject(items[0]) &&
          "seq" in items[0]
        ) {
          return items as JsonObject[];
        }
        for (const value of Object.values(node)) stack.push(value);
      }
    }
  }
  return [];
}

function parseSummary(html: string): PriceSummaryData {
  const labelMap: Record<string, keyof PriceSummaryData> = {
    "평균 가격": "average_price_krw",
    "가장 높은 가격": "highest_price_krw",
    "가장 낮은 가격": "lowest_price_krw",
  };
  const summary: PriceSummaryData = {
    average_price_krw: null,
    highest_price_krw: null,
    lowest_price_krw: null,
  };
  SUMMARY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SUMMARY_RE.exec(html)) !== null) {
    const key = labelMap[match[1]];
    if (key) summary[key] = parseKrw(match[2]);
  }
  return summary;
}

function summaryIsEmpty(summary: PriceSummaryData): boolean {
  return (
    summary.average_price_krw === null &&
    summary.highest_price_krw === null &&
    summary.lowest_price_krw === null
  );
}

function strOrNull(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function intOrNull(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) return null;
  return Number.parseInt(String(value), 10);
}

function boolOrNull(value: JsonValue | undefined): boolean | null {
  if (value === undefined || value === null) return null;
  return Boolean(value);
}

function buildMetadata(data: JsonObject): SearchMetadataData | null {
  const searchKeyword = data["searchKeyword"];
  const selectedExposureKeyword = data["selectExposureKeyword"];
  const selectedModelName = data["selectModelName"];
  const selectedOptionName = data["selectOptionName"];

  const hasAny = [searchKeyword, selectedExposureKeyword, selectedModelName, selectedOptionName].some(
    (value) => value !== undefined && value !== null && value !== "",
  );
  if (!hasAny) return null;

  return {
    search_keyword: strOrNull(searchKeyword),
    selected_exposure_keyword: strOrNull(selectedExposureKeyword),
    selected_model_name: strOrNull(selectedModelName),
    selected_option_name: strOrNull(selectedOptionName),
  };
}

// Joongna's listing payloads carry sale state as a bare integer. Verified
// against product pages: 0 shows no badge, 1 shows 예약중, 3 shows 판매완료.
// Unrecognized codes keep their number so they stay debuggable.
type SaleStatus = "on_sale" | "reserved" | "sold" | `unknown_${number}`;

export function saleStatusFromState(state: number | null): SaleStatus | null {
  if (state === null) return null;
  if (state === 0) return "on_sale";
  if (state === 1) return "reserved";
  if (state === 3) return "sold";
  return `unknown_${state}`;
}

function buildListing(item: JsonObject): ListingData {
  const sequence = Number.parseInt(String(item["seq"]), 10);
  const articleUrl = item["articleUrl"];
  let listingUrl: string;
  if (typeof articleUrl === "string" && articleUrl) {
    listingUrl = articleUrl.startsWith("http")
      ? articleUrl
      : "https://web.joongna.com" + articleUrl;
  } else {
    listingUrl = "https://web.joongna.com/product/" + sequence;
  }

  const thumbnailUrl = (item["url"] as string | null | undefined) || null;

  return {
    sequence,
    title: unescapeHtml(String(item["title"] ?? "")),
    price_krw: Number.parseInt(String(item["price"] ?? 0), 10) || 0,
    listing_url: listingUrl,
    thumbnail_url: thumbnailUrl,
    description: null,
    image_urls: thumbnailUrl ? [thumbnailUrl] : [],
    // Empty strings are nulls here, as they were in the Python (`or None`).
    sorted_at: strOrNull(item["sortDate"] || null),
    location_name: strOrNull(item["mainLocationName"] || null),
    parcel_fee_krw: intOrNull(item["parcelFee"]),
    chat_count: intOrNull(item["chatCount"]),
    wish_count: intOrNull(item["wishCount"]),
    pickup_badge: boolOrNull(item["pickupBadgeFlag"]),
    certified_seller: boolOrNull(item["certifySellerFlag"]),
    sale_status: saleStatusFromState(intOrNull(item["state"])),
  };
}

function flattenScatterPoints(
  rawScatterPrices: JsonValue,
): Array<{ date_hour: string; price_krw: number; count: number }> {
  const points: Array<{ date_hour: string; price_krw: number; count: number }> = [];
  if (!Array.isArray(rawScatterPrices)) return points;

  for (const group of rawScatterPrices) {
    if (!isObject(group)) continue;
    const dateHour = group["dateHour"];
    if (!dateHour) continue;
    const priceCounts = group["priceCounts"];
    if (!Array.isArray(priceCounts)) continue;
    for (const priceCount of priceCounts) {
      if (!isObject(priceCount)) continue;
      const price = priceCount["price"];
      const count = priceCount["count"];
      if (price === null || price === undefined || count === null || count === undefined) continue;
      points.push({
        date_hour: String(dateHour),
        price_krw: Number.parseInt(String(price), 10),
        count: Number.parseInt(String(count), 10),
      });
    }
  }
  return points;
}

function buildHistoryDataset(sourceKey: "BID" | "EXECUTION", data: JsonObject): PriceHistoryDatasetData {
  const productPrice = isObject(data["productPrice"]) ? (data["productPrice"] as JsonObject) : {};
  const items = Array.isArray(data["items"]) ? data["items"] : [];

  const dailyAveragePrices: Array<{ date: string; average_price_krw: number }> = [];
  const linePrices = productPrice["linePrices"];
  if (Array.isArray(linePrices)) {
    for (const point of linePrices) {
      if (!isObject(point)) continue;
      if (point["date"] === null || point["date"] === undefined) continue;
      if (point["avgPrice"] === null || point["avgPrice"] === undefined) continue;
      dailyAveragePrices.push({
        date: String(point["date"]),
        average_price_krw: Number.parseInt(String(point["avgPrice"]), 10),
      });
    }
  }

  return {
    source_key: sourceKey,
    label_ko: sourceKey === "BID" ? "등록가" : "판매가",
    listing_count: items.length,
    daily_average_prices: dailyAveragePrices,
    hourly_scatter_points: flattenScatterPoints(productPrice["scatterPrices"] ?? []),
    listings: items.filter(
      (item): item is JsonObject => isObject(item) && item["seq"] !== null && item["seq"] !== undefined,
    ).map(buildListing),
  };
}

function parseHydratedDatasets(html: string): {
  datasets: Partial<Record<"BID" | "EXECUTION", PriceHistoryDatasetData>>;
  metadata: SearchMetadataData | null;
  hasEmptyResultMarker: boolean;
} {
  const datasets: Partial<Record<"BID" | "EXECUTION", PriceHistoryDatasetData>> = {};
  let metadata: SearchMetadataData | null = null;
  let hasEmptyResultMarker = false;

  for (const query of iterHydratedQueries(html)) {
    const queryKey = query["queryKey"];
    if (!Array.isArray(queryKey) || queryKey.length < 2) continue;
    if (queryKey[0] !== "postProductPriceScatterPlot") continue;

    const sourceKey = String(queryKey[1]).toUpperCase();
    if (sourceKey !== "BID" && sourceKey !== "EXECUTION") continue;

    const state = isObject(query["state"]) ? (query["state"] as JsonObject) : {};
    const dataOuter = isObject(state["data"]) ? (state["data"] as JsonObject) : {};
    const data = isObject(dataOuter["data"]) ? (dataOuter["data"] as JsonObject) : {};

    if (metadata === null) metadata = buildMetadata(data);
    if (data["emptyResult"] !== null && data["emptyResult"] !== undefined) {
      hasEmptyResultMarker = true;
    }
    datasets[sourceKey] = buildHistoryDataset(sourceKey, data);
  }

  return { datasets, metadata, hasEmptyResultMarker };
}

export function parseSearchPricePage(
  html: string,
  opts: { query: string; searchWord: string; sourceUrl: string; fetchedAt: string },
): SearchPriceResult {
  const summary = parseSummary(html);
  const parsed = parseHydratedDatasets(html);
  const datasets = parsed.datasets;
  const hasEmptyResultMarker = parsed.hasEmptyResultMarker;
  let metadata = parsed.metadata;

  const availableListings =
    (datasets.BID && datasets.BID.listings.length > 0 && datasets.BID.listings) ||
    (datasets.EXECUTION && datasets.EXECUTION.listings.length > 0 && datasets.EXECUTION.listings) ||
    [];

  const hasDatasets = datasets.BID !== undefined || datasets.EXECUTION !== undefined;
  const emptyResult =
    hasEmptyResultMarker || (!hasDatasets && availableListings.length === 0 && summaryIsEmpty(summary));

  if (emptyResult && metadata === null) {
    metadata = {
      search_keyword: opts.searchWord,
      selected_exposure_keyword: null,
      selected_model_name: null,
      selected_option_name: null,
    };
  }

  return {
    query: opts.query,
    search_word: opts.searchWord,
    source_url: opts.sourceUrl,
    fetched_at: opts.fetchedAt,
    from_cache: false,
    empty_result: emptyResult,
    empty_result_reason: emptyResult ? "No pricing data found for this search word" : null,
    summary,
    metadata,
    registered_price_history: datasets.BID ?? null,
    sold_price_history: datasets.EXECUTION ?? null,
    available_listings: availableListings,
  };
}

export function parseSearchKeywordPage(
  html: string,
  opts: { query: string; searchWord: string; sourceUrl: string; fetchedAt: string },
): SearchKeywordResult {
  const items = iterSearchItems(html);
  const listings = items
    .filter((item) => item["seq"] !== null && item["seq"] !== undefined)
    .map(buildListing);

  return {
    query: opts.query,
    search_word: opts.searchWord,
    source_url: opts.sourceUrl,
    fetched_at: opts.fetchedAt,
    from_cache: false,
    total_count: listings.length,
    listings,
  };
}

export function parseProductDetail(payload: JsonObject): { description: string | null; image_urls: string[] } {
  const data = payload["data"];
  if (!isObject(data)) {
    throw new JoongnaParseError("Joongna product response did not contain product data");
  }

  const rawDescription = data["productDescription"];
  const description = rawDescription === null || rawDescription === undefined ? null : String(rawDescription);

  const imageUrls: string[] = [];
  const seen = new Set<string>();
  for (const collectionName of ["media", "descriptionMedia"]) {
    const mediaItems = data[collectionName];
    if (!Array.isArray(mediaItems)) continue;
    for (const media of mediaItems) {
      if (!isObject(media)) continue;
      const mediaType = media["mediaType"];
      if (mediaType !== null && mediaType !== undefined && mediaType !== 0) continue;
      const imageUrl = media["originUrl"] ?? media["mediaUrl"];
      if (typeof imageUrl === "string" && imageUrl && !seen.has(imageUrl)) {
        seen.add(imageUrl);
        imageUrls.push(imageUrl);
      }
    }
  }

  return { description, image_urls: imageUrls };
}

// --- service -----------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getListingDetails(
  config: ClientConfig,
  sequence: number,
): Promise<{ description: string | null; image_urls: string[] }> {
  try {
    const payload = await fetchProductDetail(config, sequence);
    return parseProductDetail(payload);
  } catch (err) {
    if (err instanceof JoongnaFetchError || err instanceof JoongnaParseError) {
      return { description: null, image_urls: [] };
    }
    throw err;
  }
}

async function enrichListings(config: ClientConfig, listings: ListingData[]): Promise<void> {
  const sequences = [...new Set(listings.map((listing) => listing.sequence))];
  if (sequences.length === 0) return;

  const detailsList = await Promise.all(
    sequences.map((sequence) => getListingDetails(config, sequence)),
  );
  const detailsBySequence = new Map(sequences.map((sequence, i) => [sequence, detailsList[i]]));

  for (const listing of listings) {
    const details = detailsBySequence.get(listing.sequence);
    if (!details) continue;
    listing.description = details.description;
    if (details.image_urls.length > 0) {
      listing.image_urls = [...details.image_urls];
    }
  }
}

function limitPriceResult(result: SearchPriceResult, maxListings: number): SearchPriceResult {
  result.available_listings = result.available_listings.slice(0, maxListings);
  if (result.registered_price_history) {
    result.registered_price_history.listings = result.registered_price_history.listings.slice(0, maxListings);
  }
  if (result.sold_price_history) {
    result.sold_price_history.listings = result.sold_price_history.listings.slice(0, maxListings);
  }
  return result;
}

function limitKeywordResult(result: SearchKeywordResult, maxListings: number): SearchKeywordResult {
  result.listings = result.listings.slice(0, maxListings);
  result.total_count = result.listings.length;
  return result;
}

async function searchPrice(
  config: ClientConfig,
  args: { query: string; searchWord?: string; maxListings: number },
): Promise<SearchPriceResult> {
  if (args.maxListings < 1) throw new Error("max_listings must be at least 1");

  const effectiveSearchWord = args.searchWord?.trim() || normalizeSearchWord(args.query);
  const [sourceUrl, html] = await fetchSearchPage(config, effectiveSearchWord);
  const fetchedAt = new Date().toISOString();
  const result = parseSearchPricePage(html, {
    query: args.query,
    searchWord: effectiveSearchWord,
    sourceUrl,
    fetchedAt,
  });

  const limited = limitPriceResult(result, args.maxListings);
  const groups: ListingData[] = [...limited.available_listings];
  if (limited.registered_price_history) groups.push(...limited.registered_price_history.listings);
  if (limited.sold_price_history) groups.push(...limited.sold_price_history.listings);
  await enrichListings(config, groups);
  return limited;
}

async function searchKeyword(
  config: ClientConfig,
  args: { query: string; searchWord?: string; maxListings: number },
): Promise<SearchKeywordResult> {
  if (args.maxListings < 1) throw new Error("max_listings must be at least 1");

  const effectiveSearchWord = args.searchWord?.trim() || normalizeSearchWord(args.query);
  let result: SearchKeywordResult | null = null;

  for (let attempt = 0; attempt < KEYWORD_MAX_RETRIES; attempt++) {
    const [sourceUrl, html] = await fetchSearchKeywordPage(config, effectiveSearchWord);
    const fetchedAt = new Date().toISOString();
    result = parseSearchKeywordPage(html, {
      query: args.query,
      searchWord: effectiveSearchWord,
      sourceUrl,
      fetchedAt,
    });
    if (result.listings.length > 0) break;
    if (attempt < KEYWORD_MAX_RETRIES - 1) await sleep(KEYWORD_RETRY_DELAY_MS);
  }

  const limited = limitKeywordResult(result as SearchKeywordResult, args.maxListings);
  await enrichListings(config, limited.listings);
  return limited;
}

// --- MCP server --------------------------------------------------------------

function text(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "joongna-mcp", version: "0.1.0" });
  const config = clientConfigFromEnv(env);

  server.registerTool("joongna_search_price", { description: "Return Joongna price data and listings with descriptions and product images.", inputSchema: z.object({
              query: z.string().describe("Natural-language question or device name to search on Joongna"),
              search_word: z
                .string()
                .optional()
                .describe("Optional explicit Joongna search term override, ideally in Korean"),
              max_listings: z
                .number()
                .int()
                .min(1)
                .max(20)
                .default(10)
                .describe("Maximum listings to return per dataset"),
              force_refresh: z
                .boolean()
                .default(false)
                .describe("Bypass the in-memory cache for this request"),
            }) }, async ({ query, search_word, max_listings }) => {
              const result = await searchPrice(config, { query, searchWord: search_word, maxListings: max_listings });
              return text(result);
            });

  server.registerTool("joongna_search_keyword", { description: "Return Joongna listings, including sold-out items, descriptions, and product images.", inputSchema: z.object({
              query: z.string().describe("Product name to search for on Joongna"),
              search_word: z
                .string()
                .optional()
                .describe("Optional explicit Joongna search term override, ideally in Korean"),
              max_listings: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(20)
                .describe("Maximum listings to return"),
              force_refresh: z
                .boolean()
                .default(false)
                .describe("Bypass the in-memory cache for this request"),
            }) }, async ({ query, search_word, max_listings }) => {
              const result = await searchKeyword(config, { query, searchWord: search_word, maxListings: max_listings });
              return text(result);
            });

  return server;
}

// --- entry -------------------------------------------------------------------

/**
 * No identity headers, so no service.
 *
 * The only way to reach this Worker is through a service binding declared by
 * another Worker in the account, and the only Worker that declares one is the
 * gateway, which never forwards a request it has not authorized. So arriving
 * here without an identity means the deployment is wrong -- the gateway's
 * route for this host lost its `mcp` policy, or something else in the account
 * bound to this Worker directly.
 *
 * 500 rather than 401, because it is true. A 401 would tell the caller to
 * authenticate, and the caller may well have done so correctly; the fault is
 * on this side of the binding. Serving the tools anyway is the specific
 * failure the whole gateway arrangement exists to prevent, so this refuses.
 */
function refused(): Response {
  return Response.json(
    { error: "no gateway identity", detail: "this service is only reachable through the gateway" },
    { status: 500 },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Before routing, not after. There is no path here that serves without an
    // identity, so there is no reason for one to be reachable before the check.
    const identity = identityFrom(request.headers);
    if (identity === null) return refused();

    const url = new URL(request.url);

    // /healthz and /.well-known/oauth-protected-resource are gone from here.
    // The gateway answers both now, which is why healthz changed shape: `ok`
    // as text/plain rather than `{"ok":true}` as JSON. Anything checking the
    // body rather than the status needs updating.
    if (url.pathname === "/" || url.pathname === "") {
      return Response.json({
        name: "joongna-mcp",
        runtime: "cloudflare-workers",
        mcp_path: "/mcp",
        caller: { sub: identity.sub, email: identity.email, name: identity.name, role: identity.role },
        tools: ["joongna_search_price", "joongna_search_keyword"],
      });
    }

    // `/mcp/*` as well as `/mcp`, which this service accepted before the
    // cutover and keeps accepting. The gateway's route for this host has no
    // path_prefix, so both arrive here.
    if (url.pathname !== "/mcp" && !url.pathname.startsWith("/mcp/")) {
      return new Response("not found", { status: 404 });
    }

    // Dual-era MCP: createMcpHandler serves 2026-07-28 (stateless, per-request)
    // and legacy 2025-era clients through the stateless handshake fallback.
    // A fresh handler per request closes over env; each McpServer instance the
    // factory builds is itself per-request.
    //
    // CORS is the gateway's now: under the `mcp` policy it strips
    // access-control-allow-origin and -expose-headers from whatever the
    // backend returns and sets its own (gateway src/responseRewrite.ts).
    return createMcpHandler(() => buildServer(env)).fetch(request);
  },
};
