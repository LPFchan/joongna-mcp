import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { identityFrom } from "@lpfchan/gateway-identity";
import { z } from "zod";

export interface Env {
  JOONGNA_BASE_URL?: string;
  JOONGNA_SEARCH_API_BASE_URL?: string;
  JOONGNA_TIMEOUT_SECONDS?: string;
  JOONGNA_USER_AGENT?: string;
}

type Status = "on_sale" | "reserved" | "sold" | "removed" | "unknown";
type RequestedStatus = "on_sale" | "reserved" | "sold";
type Sort = "recent" | "price_low" | "price_high";
type JsonRecord = Record<string, unknown>;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const SEARCH_PAGE_SIZE = 50;
const DETAIL_CONCURRENCY = 8;
const SEARCH_API = "https://search-api.joongna.com";
const MAIN_API = "https://main-api.joongna.com";
const PRODUCT_API = "https://product-api.joongna.com";

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
const NOISE_PATTERNS = [
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
  let normalized = text
    .toLowerCase()
    .replace(/[?!.:,/()[\]{}]+/g, " ")
    .replace(STORAGE_UNIT_RE, "$1");
  for (const [pattern, replacement] of PHRASE_REPLACEMENTS)
    normalized = normalized.replace(pattern, replacement);
  for (const pattern of NOISE_PATTERNS)
    normalized = normalized.replace(pattern, " ");
  normalized = normalized.replace(/[^0-9a-zA-Z가-힣]+/g, "");
  if (normalized) return normalized;
  const fallback = text.replace(/[^0-9a-zA-Z가-힣]+/g, "");
  if (!fallback) throw new Error("query did not contain a usable search term");
  return fallback;
}
function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined || value === ""
    ? null
    : String(value);
}
function sourceId(value: unknown): string | null {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text : null;
  }
  return null;
}
function firstSourceId(...values: unknown[]): string | null {
  for (const value of values) {
    const id = sourceId(value);
    if (id !== null) return id;
  }
  return null;
}
function intOrNull(value: unknown): number | null {
  if (typeof value === "number")
    return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (!/^-?\d+$/.test(text) && !/^-?\d{1,3}(,\d{3})+$/.test(text)) return null;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}
function priceOrNull(value: unknown): number | null {
  const n = intOrNull(value);
  return n !== null && n >= 0 ? n : null;
}
function isoNow(): string {
  return new Date().toISOString();
}
export function saleStatusFromState(state: unknown): Status {
  const n = intOrNull(state);
  if (n === 0) return "on_sale";
  if (n === 1) return "reserved";
  if (n === 3) return "sold";
  return "unknown";
}

const EvidenceErrorSchema = z.object({
  code: z.string(),
  retryable: z.boolean().optional(),
});
const SellerEvidenceSchema = z.object({
  marketplace: z.literal("joongna"),
  seller_id: z.string(),
  checked_at: z.string(),
  status: z.enum(["available", "unavailable", "failed"]),
  source_metrics: z.object({
    safeTradeCount: z.number().int().nullable(),
    reviewCount: z.number().int().nullable(),
  }),
  safe_trade_count: z.object({
    value: z.number().int().nullable(),
    status: z.enum(["available", "unavailable", "failed"]),
    source_field: z.literal("safeTradeCount"),
    role_scope: z.literal("unknown"),
    reason: z.string().optional(),
  }),
  source_payload: z.record(z.string(), z.unknown()),
  error: EvidenceErrorSchema.nullable(),
});
const ListingSchema = z.object({
  marketplace: z.literal("joongna"),
  listing_id: z.string(),
  listing_url: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  price_krw: z.number().int().nullable(),
  status: z.enum(["on_sale", "reserved", "sold", "removed", "unknown"]),
  raw_status: z.string().nullable(),
  seller_id: z.string().nullable(),
  category: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
  }),
  observed_at: z.string(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  sold_at: z.string().nullable(),
  detail_status: z.enum([
    "not_requested",
    "available",
    "unavailable",
    "failed",
  ]),
  detail_checked_at: z.string().nullable(),
  detail_error: EvidenceErrorSchema.nullable(),
  seller_evidence_status: z.enum([
    "not_requested",
    "available",
    "unavailable",
    "failed",
  ]),
  seller_checked_at: z.string().nullable(),
  seller_error: EvidenceErrorSchema.nullable(),
  seller_evidence: SellerEvidenceSchema.nullable(),
  thumbnail_url: z.string().nullable(),
  image_urls: z.array(z.string()),
  promoted_marketplace_product: z.boolean().nullable(),
  source_flags: z.object({
    jnPayBadgeFlag: z.boolean().nullable(),
    pickupBadgeFlag: z.boolean().nullable(),
    certifiedSellerFlag: z.boolean().nullable(),
  }),
  source_dates: z.object({
    sortDate: z.string().nullable(),
    updateDate: z.string().nullable(),
  }),
});
const ErrorSchema = z.object({
  code: z.enum([
    "authentication_required",
    "upstream_blocked",
    "rate_limited",
    "timeout",
    "parse_failed",
    "invalid_query",
    "unsupported_filter",
    "cursor_mismatch",
    "upstream_http",
  ]),
  retryable: z.boolean(),
  retry_after_seconds: z.number().int().nullable().optional(),
  message: z.string().optional(),
});
const PaginationSchema = z.object({
  native_page_size: z.number().int(),
  raw_count: z.number().int().nonnegative(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean().nullable(),
  total_count: z.object({
    value: z.number().int().nullable(),
    kind: z.enum(["exact", "estimated", "unavailable"]),
  }),
});
const SearchDataSchema = z.object({
  page_observed_at: z.string(),
  effective_request: z.record(z.string(), z.unknown()),
  applied_filters: z.object({
    price: z.object({
      upstream: z.enum(["range", "none", "unsupported"]),
      post_filter: z.boolean(),
    }),
    status: z.object({
      requested: z.array(z.enum(["on_sale", "reserved", "sold"])).nullable(),
      upstream: z.enum([
        "include_sold",
        "include_reserved",
        "exclude_sold",
        "none",
      ]),
      post_filter: z.array(z.enum(["on_sale", "reserved", "sold"])).nullable(),
    }),
  }),
  scanned_count: z.number().int().nonnegative(),
  returned_count: z.number().int().nonnegative(),
  excluded_counts: z.object({
    status: z.number().int(),
    external_ad: z.number().int(),
    unknown_status: z.number().int(),
  }),
  listings: z.array(ListingSchema),
  pagination: PaginationSchema,
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
const ErrorPaginationSchema = z.object({
  has_more: z.null(),
  next_cursor: z.null(),
});
const SearchOutputSchema = z
  .discriminatedUnion("outcome", [
    SearchDataSchema.extend({ outcome: z.literal("ok") }),
    SearchDataSchema.extend({ outcome: z.literal("partial") }),
    z.object({
      outcome: z.literal("error"),
      effective_request: z.record(z.string(), z.unknown()).optional(),
      error: ErrorSchema,
      request_cursor: z.string().nullable(),
      pagination: ErrorPaginationSchema,
    }),
  ])
  .meta({ type: "object" });
type Listing = z.infer<typeof ListingSchema>;
export type SearchListingsResponse = z.infer<typeof SearchOutputSchema>;
const ChartSchema = z.object({
  source: z.literal("joongna"),
  source_label: z.enum(["registered_price", "sales_price"]),
  requested_range: z.object({
    date_range: z.union([z.literal(30), z.literal(90), z.literal(180)]),
  }),
  observed_range: z.object({
    date_from: z.string().nullable(),
    date_to: z.string().nullable(),
    inclusive_day_count: z.number().int().nullable(),
  }),
  completeness: z.enum(["unknown", "partial", "complete"]),
  weighting_semantics: z.literal("unknown"),
  population_semantics: z.literal("unknown"),
  line_prices: z.array(z.record(z.string(), z.unknown())),
  scatter_prices: z.array(z.record(z.string(), z.unknown())),
  native_scatter_price_count_avg: z.unknown().nullable(),
  related_current_listings: z.array(ListingSchema),
  native_related_listing_count: z.number().int().nonnegative(),
});
const ChartDataSchema = z.object({
  page_observed_at: z.string(),
  search_word: z.string(),
  chart: ChartSchema,
  pagination: PaginationSchema,
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
const ChartOutputSchema = z
  .discriminatedUnion("outcome", [
    ChartDataSchema.extend({ outcome: z.literal("ok") }),
    ChartDataSchema.extend({ outcome: z.literal("partial") }),
    z.object({
      outcome: z.literal("error"),
      search_word: z.string().optional(),
      error: ErrorSchema,
      request_cursor: z.null(),
      pagination: ErrorPaginationSchema,
    }),
  ])
  .meta({ type: "object" });

export interface SearchInput {
  query?: string;
  search_word?: string;
  min_price_krw?: number;
  max_price_krw?: number;
  statuses?: RequestedStatus[];
  sort?: Sort;
  cursor?: string | null;
  include_details?: boolean;
  include_seller_evidence?: boolean;
}
const SearchInputSchema = z
  .object({
    query: z.string().optional(),
    search_word: z.string().optional(),
    min_price_krw: z.number().int().nonnegative().optional(),
    max_price_krw: z.number().int().nonnegative().optional(),
    statuses: z
      .array(z.enum(["on_sale", "reserved", "sold"]))
      .max(3)
      .optional(),
    sort: z.enum(["recent", "price_low", "price_high"]).default("recent"),
    cursor: z.string().nullable().optional(),
    include_details: z.boolean().default(true),
    include_seller_evidence: z.boolean().default(false),
  })
  .strict();
const SellerBatchSchema = z
  .object({ seller_ids: z.array(z.string().trim().min(1)).min(1).max(100) })
  .strict();
class DomainError extends Error {
  constructor(
    public readonly code: z.infer<typeof ErrorSchema>["code"],
    public readonly retryable: boolean,
    public readonly retryAfter?: number,
    message?: string,
  ) {
    super(message ?? code);
  }
}
function classifyFetchError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (
    (error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")) ||
    (error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  )
    return new DomainError(
      "timeout",
      true,
      undefined,
      "Joongna request timed out",
    );
  return new DomainError(
    "upstream_blocked",
    true,
    undefined,
    "Joongna request could not be completed",
  );
}
function configFrom(env: Env) {
  const seconds = Number.parseFloat(env.JOONGNA_TIMEOUT_SECONDS || "20");
  return {
    timeoutMs: Math.round((Number.isFinite(seconds) ? seconds : 20) * 1000),
    searchApi: (env.JOONGNA_SEARCH_API_BASE_URL || SEARCH_API).replace(
      /\/+$/,
      "",
    ),
    userAgent: env.JOONGNA_USER_AGENT || DEFAULT_USER_AGENT,
    listingBase: (env.JOONGNA_BASE_URL || "https://web.joongna.com").replace(
      /\/+$/,
      "",
    ),
  };
}
function validateNativeEnvelope(payload: unknown, context: string): void {
  const root = record(payload);
  const data = record(root.data);
  const meta = record(data.meta ?? root.meta);
  if (meta.code !== undefined && Number(meta.code) !== 0)
    throw new DomainError(
      "upstream_http",
      true,
      undefined,
      `${context} returned native error ${String(meta.message ?? meta.code)}`,
    );
}
async function fetchJson(
  config: ReturnType<typeof configFrom>,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "user-agent": config.userAgent,
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw classifyFetchError(error);
  }
  if (response.status === 401 || response.status === 403)
    throw new DomainError(
      response.status === 401 ? "authentication_required" : "upstream_blocked",
      response.status !== 401,
      undefined,
      `Joongna returned HTTP ${response.status}`,
    );
  if (response.status === 429)
    throw new DomainError(
      "rate_limited",
      true,
      retryAfterSeconds(response.headers.get("retry-after")),
      "Joongna rate limited the request",
    );
  if (response.status >= 500)
    throw new DomainError(
      "upstream_http",
      true,
      undefined,
      `Joongna returned HTTP ${response.status}`,
    );
  if (!response.ok)
    throw new DomainError(
      "upstream_http",
      false,
      undefined,
      `Joongna returned HTTP ${response.status}`,
    );
  try {
    return await response.json();
  } catch (error) {
    if (
      (error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")) ||
      (error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError"))
    )
      throw new DomainError(
        "timeout",
        true,
        undefined,
        "Joongna response decoding timed out",
      );
    throw new DomainError(
      "parse_failed",
      false,
      undefined,
      "Joongna returned invalid JSON",
    );
  }
}
function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !value.trim()) return undefined;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}
function effectiveSearchWord(input: {
  query?: string;
  search_word?: string;
}): string {
  if (input.search_word?.trim()) return input.search_word;
  if (input.query?.trim()) {
    try {
      return normalizeSearchWord(input.query);
    } catch (error) {
      throw new DomainError(
        "invalid_query",
        false,
        undefined,
        error instanceof Error ? error.message : "Query is unusable",
      );
    }
  }
  throw new DomainError(
    "invalid_query",
    false,
    undefined,
    "Provide query or a nonblank search_word",
  );
}
function searchIdentity(input: SearchInput, searchWord: string) {
  return {
    searchWord,
    minPrice: input.min_price_krw ?? null,
    maxPrice: input.max_price_krw ?? null,
    statuses: [...new Set(input.statuses ?? [])].sort(),
    sort: input.sort ?? "recent",
    pageSize: SEARCH_PAGE_SIZE,
  };
}
function encodeCursor(state: JsonRecord): string {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decodeCursor(cursor: string): JsonRecord {
  if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new DomainError(
      "cursor_mismatch",
      false,
      undefined,
      "Cursor is malformed",
    );
  try {
    const binary = atob(
      cursor.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (cursor.length % 4)) % 4),
    );
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new DomainError(
      "cursor_mismatch",
      false,
      undefined,
      "Cursor is malformed",
    );
  }
}
function cursorFor(
  input: SearchInput,
  searchWord: string,
): { page: number; key: ReturnType<typeof searchIdentity> } {
  const key = searchIdentity(input, searchWord);
  if (!input.cursor) return { page: 0, key };
  const state = decodeCursor(input.cursor);
  if (
    state.v !== 1 ||
    state.m !== "joongna" ||
    JSON.stringify(state.key) !== JSON.stringify(key) ||
    !Number.isInteger(state.page) ||
    Number(state.page) < 0 ||
    Number(state.page) > 10000
  )
    throw new DomainError(
      "cursor_mismatch",
      false,
      undefined,
      "Cursor does not match this search",
    );
  return { page: Number(state.page), key };
}
function nativePayload(
  input: SearchInput,
  searchWord: string,
  page: number,
): JsonRecord {
  const statuses = input.statuses ?? [];
  return {
    osType: 2,
    firstQuantity: SEARCH_PAGE_SIZE,
    quantity: SEARCH_PAGE_SIZE,
    jnPayYn: "ALL",
    categoryFilter: [{ categoryDepth: 0, categorySeq: 0 }],
    priceFilter: {
      minPrice: input.min_price_krw ?? 0,
      maxPrice: input.max_price_krw ?? 100000000,
    },
    sort:
      input.sort === "price_low"
        ? "PRICE_ASC_SORT"
        : input.sort === "price_high"
          ? "PRICE_DESC_SORT"
          : "RECENT_SORT",
    saleYn: statuses.includes("sold") ? "SALE_Y" : "SALE_N",
    parcelFeeYn: "ALL",
    page,
    searchWord,
    adjustSearchKeyword: true,
    keywordSource: "INPUT_KEYWORD",
    registPeriod: "ALL",
  };
}
function extractSearch(payload: unknown): {
  items: JsonRecord[];
  total: number | null;
} {
  const root = record(payload);
  const data = record(root.data);
  const meta = record(data.meta ?? root.meta);
  if (meta.code !== undefined && Number(meta.code) !== 0)
    throw new DomainError(
      "upstream_http",
      true,
      undefined,
      String(meta.message ?? "Joongna search failed"),
    );
  if (!Array.isArray(data.items))
    throw new DomainError(
      "parse_failed",
      false,
      undefined,
      "Joongna search response did not contain an items array",
    );
  if (
    data.items.some(
      (x) => typeof x !== "object" || x === null || Array.isArray(x),
    )
  )
    throw new DomainError(
      "parse_failed",
      false,
      undefined,
      "Joongna search response contained a malformed item",
    );
  return {
    items: data.items as JsonRecord[],
    total: intOrNull(data.totalSize),
  };
}
function isExternalAd(item: JsonRecord): boolean {
  const type = String(
    item.objectType ?? item.type ?? item.adType ?? "",
  ).toLowerCase();
  return (
    type.includes("external") ||
    type === "ext_ad" ||
    type === "shopping_ad" ||
    item.externalAd === true
  );
}
function listingFromItem(
  item: JsonRecord,
  config: ReturnType<typeof configFrom>,
  observedAt: string,
): Listing {
  const listingId = firstSourceId(item.seq, item.productSeq, item.id);
  if (listingId === null)
    throw new DomainError(
      "parse_failed",
      false,
      undefined,
      "Joongna listing did not contain an ID",
    );
  const thumbnail = typeof item.url === "string" && item.url ? item.url : null;
  const status = saleStatusFromState(item.state);
  const seller = firstSourceId(item.storeSeq, item.sellerId);
  return {
    marketplace: "joongna",
    listing_id: listingId,
    listing_url:
      typeof item.articleUrl === "string" && item.articleUrl
        ? item.articleUrl.startsWith("http")
          ? item.articleUrl
          : config.listingBase + item.articleUrl
        : `${config.listingBase}/product/${listingId}`,
    title: String(item.title ?? item.name ?? ""),
    description: null,
    price_krw: priceOrNull(item.price),
    status,
    raw_status: item.state === undefined ? null : String(item.state),
    seller_id: seller,
    category: {
      id: stringOrNull(item.categorySeq ?? item.categoryId),
      name: stringOrNull(item.categoryName),
    },
    observed_at: observedAt,
    created_at: stringOrNull(item.createdAt),
    updated_at: stringOrNull(item.updatedAt),
    sold_at: null,
    detail_status: "not_requested",
    detail_checked_at: null,
    detail_error: null,
    seller_evidence_status: "not_requested",
    seller_checked_at: null,
    seller_error: null,
    seller_evidence: null,
    thumbnail_url: thumbnail,
    image_urls: thumbnail ? [thumbnail] : [],
    promoted_marketplace_product:
      typeof item.promoted === "boolean" ? item.promoted : null,
    source_flags: {
      jnPayBadgeFlag:
        typeof item.jnPayBadgeFlag === "boolean" ? item.jnPayBadgeFlag : null,
      pickupBadgeFlag:
        typeof item.pickupBadgeFlag === "boolean" ? item.pickupBadgeFlag : null,
      certifiedSellerFlag:
        typeof item.certifySellerFlag === "boolean"
          ? item.certifySellerFlag
          : null,
    },
    source_dates: {
      sortDate: stringOrNull(item.sortDate),
      updateDate: stringOrNull(item.updateDate),
    },
  };
}
function filterItems(
  items: JsonRecord[],
  input: SearchInput,
  config: ReturnType<typeof configFrom>,
  observedAt: string,
) {
  const requested = input.statuses?.length
    ? [...new Set(input.statuses)]
    : null;
  const excluded = { status: 0, external_ad: 0, unknown_status: 0 };
  const listings: Listing[] = [];
  for (const item of items) {
    if (isExternalAd(item)) {
      excluded.external_ad++;
      continue;
    }
    const listing = listingFromItem(item, config, observedAt);
    if (requested) {
      if (listing.status === "unknown") {
        excluded.unknown_status++;
        continue;
      }
      if (!requested.includes(listing.status as RequestedStatus)) {
        excluded.status++;
        continue;
      }
    }
    listings.push(listing);
  }
  return { listings, excluded, requested };
}
function detailErrorCode(error: unknown): { code: string; retryable: boolean } {
  const e =
    error instanceof DomainError
      ? error
      : new DomainError("upstream_blocked", true);
  return { code: e.code, retryable: e.retryable };
}
function parseDetail(payload: unknown): {
  description: string | null;
  image_urls: string[];
} {
  validateNativeEnvelope(payload, "Joongna detail");
  const data = record(record(payload).data);
  if (
    Object.keys(data).length === 0 ||
    (data.productSeq === undefined &&
      data.productDescription === undefined &&
      !Array.isArray(data.media) &&
      !Array.isArray(data.descriptionMedia))
  )
    throw new DomainError(
      "parse_failed",
      false,
      undefined,
      "Joongna detail response did not contain data",
    );
  const images: string[] = [];
  const seen = new Set<string>();
  for (const key of ["media", "descriptionMedia"])
    for (const item of Array.isArray(data[key]) ? data[key] : []) {
      const media = record(item);
      if (media.mediaType !== undefined && media.mediaType !== 0) continue;
      const url = media.originUrl ?? media.mediaUrl;
      if (typeof url === "string" && url && !seen.has(url)) {
        seen.add(url);
        images.push(url);
      }
    }
  return {
    description:
      data.productDescription === undefined || data.productDescription === null
        ? null
        : String(data.productDescription),
    image_urls: images,
  };
}
async function enrichDetails(
  config: ReturnType<typeof configFrom>,
  listings: Listing[],
): Promise<boolean> {
  const ids = [...new Set(listings.map((x) => x.listing_id))];
  let next = 0;
  let failed = false;
  const details = new Map<
    string,
    {
      value?: ReturnType<typeof parseDetail>;
      error?: { code: string; retryable: boolean };
    }
  >();
  async function lane() {
    while (next < ids.length) {
      const id = ids[next++];
      const checked = isoNow();
      try {
        const value = parseDetail(
          await fetchJson(
            config,
            `${PRODUCT_API}/basic/${encodeURIComponent(id)}?increaseViewCount=false`,
            { headers: { accept: "application/json" } },
          ),
        );
        details.set(id, { value });
      } catch (error) {
        failed = true;
        details.set(id, { error: detailErrorCode(error) });
      }
      for (const listing of listings.filter((x) => x.listing_id === id)) {
        listing.detail_checked_at = checked;
        const detail = details.get(id);
        if (detail?.value) {
          listing.detail_status = "available";
          listing.description = detail.value.description;
          if (detail.value.image_urls.length)
            listing.image_urls = detail.value.image_urls;
        } else {
          listing.detail_status = "failed";
          listing.detail_error = detail?.error ?? {
            code: "upstream_blocked",
            retryable: true,
          };
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DETAIL_CONCURRENCY, ids.length) }, () =>
      lane(),
    ),
  );
  return failed;
}
async function fetchSeller(
  config: ReturnType<typeof configFrom>,
  sellerId: string,
) {
  const checkedAt = isoNow();
  try {
    const response = record(
      await fetchJson(
        config,
        `${MAIN_API}/v2/my-store/${encodeURIComponent(sellerId)}`,
        { headers: { accept: "application/json" } },
      ),
    );
    validateNativeEnvelope(response, "Joongna seller");
    const data = record(response.data);
    if (Object.keys(data).length === 0)
      throw new DomainError(
        "parse_failed",
        false,
        undefined,
        "Joongna seller response did not contain data",
      );
    const safe = intOrNull(data.safeTradeCount);
    const review = intOrNull(data.reviewCount);
    const sourcePayload = {
      safeTradeCount: data.safeTradeCount ?? null,
      reviewCount: data.reviewCount ?? null,
    };
    if (safe === null || safe < 0)
      return {
        marketplace: "joongna" as const,
        seller_id: sellerId,
        checked_at: checkedAt,
        status: "unavailable" as const,
        source_metrics: {
          safeTradeCount: null,
          reviewCount: review !== null && review >= 0 ? review : null,
        },
        safe_trade_count: {
          value: null,
          status: "unavailable" as const,
          source_field: "safeTradeCount" as const,
          role_scope: "unknown" as const,
          reason: "invalid_source_metric",
        },
        source_payload: sourcePayload,
        error: { code: "invalid_source_metric", retryable: false },
      };
    return {
      marketplace: "joongna" as const,
      seller_id: sellerId,
      checked_at: checkedAt,
      status: "available" as const,
      source_metrics: {
        safeTradeCount: safe,
        reviewCount: review !== null && review >= 0 ? review : null,
      },
      safe_trade_count: {
        value: safe,
        status: "available" as const,
        source_field: "safeTradeCount" as const,
        role_scope: "unknown" as const,
      },
      source_payload: sourcePayload,
      error: null,
    };
  } catch (error) {
    const e = detailErrorCode(error);
    return {
      marketplace: "joongna" as const,
      seller_id: sellerId,
      checked_at: checkedAt,
      status: "failed" as const,
      source_metrics: { safeTradeCount: null, reviewCount: null },
      safe_trade_count: {
        value: null,
        status: "failed" as const,
        source_field: "safeTradeCount" as const,
        role_scope: "unknown" as const,
        reason: e.code,
      },
      source_payload: {},
      error: e,
    };
  }
}
async function enrichSellers(
  config: ReturnType<typeof configFrom>,
  listings: Listing[],
): Promise<boolean> {
  const ids = [
    ...new Set(
      listings.map((x) => x.seller_id).filter((x): x is string => Boolean(x)),
    ),
  ];
  let next = 0;
  let partial = false;
  const byId = new Map<string, Awaited<ReturnType<typeof fetchSeller>>>();
  async function lane() {
    while (next < ids.length) {
      const id = ids[next++];
      byId.set(id, await fetchSeller(config, id));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DETAIL_CONCURRENCY, ids.length) }, () =>
      lane(),
    ),
  );
  for (const listing of listings) {
    listing.seller_checked_at = isoNow();
    if (!listing.seller_id) {
      listing.seller_evidence_status = "unavailable";
      listing.seller_error = { code: "missing_seller_id", retryable: false };
      partial = true;
      continue;
    }
    const evidence = byId.get(listing.seller_id);
    if (!evidence) {
      listing.seller_evidence_status = "failed";
      listing.seller_error = { code: "seller_fetch_failed", retryable: true };
      partial = true;
      continue;
    }
    listing.seller_evidence = evidence;
    listing.seller_evidence_status = evidence.status;
    if (evidence.status !== "available") {
      listing.seller_error = {
        code:
          evidence.error?.code ??
          evidence.safe_trade_count.reason ??
          "seller_fetch_failed",
        retryable: evidence.error?.retryable ?? false,
      };
      partial = true;
    }
  }
  return partial;
}
async function fetchSellerBatch(
  config: ReturnType<typeof configFrom>,
  ids: string[],
): Promise<Map<string, Awaited<ReturnType<typeof fetchSeller>>>> {
  const values = new Map<string, Awaited<ReturnType<typeof fetchSeller>>>();
  let next = 0;
  async function lane() {
    while (next < ids.length) {
      const id = ids[next++];
      values.set(id, await fetchSeller(config, id));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DETAIL_CONCURRENCY, ids.length) }, () =>
      lane(),
    ),
  );
  return values;
}
const SellerSuccessSchema = z.object({
  outcome: z.literal("ok"),
  sellers: z.array(SellerEvidenceSchema),
});
const SellerPartialSchema = z.object({
  outcome: z.literal("partial"),
  sellers: z.array(SellerEvidenceSchema),
});
const SellerOutputSchema = z
  .discriminatedUnion("outcome", [SellerSuccessSchema, SellerPartialSchema])
  .meta({ type: "object" });
function errorResult(
  error: unknown,
  requestCursor: string | null,
  base?: Partial<SearchListingsResponse>,
): SearchListingsResponse {
  const e =
    error instanceof DomainError
      ? error
      : new DomainError("upstream_blocked", true);
  return {
    outcome: "error",
    ...base,
    error: {
      code: e.code,
      retryable: e.retryable,
      ...(e.retryAfter === undefined
        ? {}
        : { retry_after_seconds: e.retryAfter }),
      message: e.message,
    },
    request_cursor: requestCursor,
    pagination: { next_cursor: null, has_more: null },
  } as SearchListingsResponse;
}
export async function searchListings(
  env: Env,
  input: SearchInput,
): Promise<SearchListingsResponse> {
  const config = configFrom(env);
  let searchWord = "";
  let effectiveRequest: JsonRecord | undefined;
  const requestCursor = input.cursor ?? null;
  try {
    if (
      input.min_price_krw !== undefined &&
      input.max_price_krw !== undefined &&
      input.min_price_krw > input.max_price_krw
    )
      throw new DomainError(
        "invalid_query",
        false,
        undefined,
        "min_price_krw must not exceed max_price_krw",
      );
    searchWord = effectiveSearchWord(input);
    const cursor = cursorFor(input, searchWord);
    effectiveRequest = nativePayload(input, searchWord, cursor.page);
    const payload = await fetchJson(
      config,
      `${config.searchApi}/v3/search/all`,
      {
        method: "POST",
        body: JSON.stringify(effectiveRequest),
      },
    );
    const extracted = extractSearch(payload);
    const observedAt = isoNow();
    const filtered = filterItems(extracted.items, input, config, observedAt);
    let partial = false;
    if (input.include_details !== false && filtered.listings.length) {
      const detailPartial = await enrichDetails(config, filtered.listings);
      partial = partial || detailPartial;
    }
    if (input.include_seller_evidence && filtered.listings.length) {
      const sellerPartial = await enrichSellers(config, filtered.listings);
      partial = partial || sellerPartial;
    }
    for (const listing of filtered.listings) {
      if (input.include_details === false)
        listing.detail_status = "not_requested";
      if (!input.include_seller_evidence)
        listing.seller_evidence_status = "not_requested";
    }
    const hasMore = extracted.items.length === 0 ? false : null;
    const nextCursor =
      extracted.items.length === 0
        ? null
        : encodeCursor({
            v: 1,
            m: "joongna",
            key: cursor.key,
            page: cursor.page + 1,
          });
    return {
      outcome: partial ? "partial" : "ok",
      page_observed_at: observedAt,
      effective_request: effectiveRequest,
      applied_filters: {
        price: { upstream: "range", post_filter: false },
        status: {
          requested: filtered.requested,
          upstream: (input.statuses ?? []).includes("sold")
            ? "include_sold"
            : "exclude_sold",
          post_filter: filtered.requested,
        },
      },
      scanned_count: extracted.items.length,
      returned_count: filtered.listings.length,
      excluded_counts: filtered.excluded,
      listings: filtered.listings,
      pagination: {
        native_page_size: SEARCH_PAGE_SIZE,
        raw_count: extracted.items.length,
        next_cursor: nextCursor,
        has_more: hasMore,
        total_count: { value: null, kind: "unavailable" },
      },
      warnings: [
        {
          code: "classification_boundary",
          message:
            "Marketplace status and price filters do not classify product model or transaction eligibility.",
        },
      ],
    };
  } catch (error) {
    return errorResult(
      error,
      requestCursor,
      effectiveRequest ? { effective_request: effectiveRequest } : undefined,
    );
  }
}

async function fetchChart(
  config: ReturnType<typeof configFrom>,
  searchWord: string,
  dateRange: 30 | 90 | 180,
  sourceLabel: "registered_price" | "sales_price",
): Promise<JsonRecord> {
  const root = record(
    await fetchJson(
      config,
      `${config.searchApi}/v4/analysis/product-price/scatter-plot`,
      {
        method: "POST",
        body: JSON.stringify({
          searchWord,
          priceType: sourceLabel === "registered_price" ? 0 : 1,
          productPriceSize: 1,
          dateRange,
        }),
      },
    ),
  );
  validateNativeEnvelope(root, "Joongna chart");
  const data = record(root.data);
  return Object.keys(data).length ? data : root;
}
function chartFromPayload(
  data: JsonRecord,
  config: ReturnType<typeof configFrom>,
  observedAt: string,
  requestedRange: 30 | 90 | 180,
  maxRelated: number,
  sourceLabel: "registered_price" | "sales_price",
): z.infer<typeof ChartSchema> {
  if (
    !data.productPrice ||
    typeof data.productPrice !== "object" ||
    Array.isArray(data.productPrice)
  )
    throw new DomainError(
      "parse_failed",
      false,
      undefined,
      "Joongna chart response did not contain productPrice",
    );
  const productPrice = record(data.productPrice);
  if (
    !Array.isArray(productPrice.linePrices) ||
    !Array.isArray(productPrice.scatterPrices)
  )
    throw new DomainError(
      "parse_failed",
      false,
      undefined,
      "Joongna chart response did not contain price series",
    );
  if (
    productPrice.linePrices.some(
      (x) => typeof x !== "object" || x === null || Array.isArray(x),
    ) ||
    productPrice.scatterPrices.some(
      (x) => typeof x !== "object" || x === null || Array.isArray(x),
    )
  )
    throw new DomainError(
      "parse_failed",
      false,
      undefined,
      "Joongna chart response contained malformed series data",
    );
  const line = productPrice.linePrices as JsonRecord[];
  const scatter = productPrice.scatterPrices as JsonRecord[];
  const dates = [
    ...line.map((x) => stringOrNull(x.date)),
    ...scatter.map((x) => stringOrNull(x.dateHour)?.slice(0, 10)),
  ]
    .filter(
      (x): x is string =>
        typeof x === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(x) &&
        Number.isFinite(Date.parse(`${x}T00:00:00Z`)),
    )
    .sort();
  if (
    data.items !== undefined &&
    (!Array.isArray(data.items) ||
      data.items.some(
        (x) => typeof x !== "object" || x === null || Array.isArray(x),
      ))
  )
    throw new DomainError(
      "parse_failed",
      false,
      undefined,
      "Joongna chart response contained malformed related listings",
    );
  const items = (data.items ?? []) as JsonRecord[];
  return {
    source: "joongna",
    source_label: sourceLabel,
    requested_range: {
      date_range: requestedRange,
    },
    observed_range: {
      date_from: dates[0] ?? null,
      date_to: dates.at(-1) ?? null,
      inclusive_day_count: dates.length
        ? Math.round(
            (Date.parse(`${dates.at(-1)}T00:00:00Z`) -
              Date.parse(`${dates[0]}T00:00:00Z`)) /
              86400000,
          ) + 1
        : null,
    },
    completeness: "unknown",
    weighting_semantics: "unknown",
    population_semantics: "unknown",
    line_prices: line,
    scatter_prices: scatter,
    native_scatter_price_count_avg: productPrice.scatterPriceCountAvg ?? null,
    related_current_listings: items
      .slice(0, maxRelated)
      .map((item) => listingFromItem(item, config, observedAt)),
    native_related_listing_count: items.length,
  };
}
const ChartInputSchema = z
  .object({
    query: z.string().optional(),
    search_word: z.string().optional(),
    date_range: z
      .union([z.literal(30), z.literal(90), z.literal(180)])
      .default(30),
    source_label: z
      .enum(["registered_price", "sales_price"])
      .default("sales_price"),
    max_related_listings: z.number().int().min(1).max(50).default(20),
    include_details: z.boolean().default(true),
  })
  .strict();
async function searchPrice(
  env: Env,
  input: z.infer<typeof ChartInputSchema>,
): Promise<z.infer<typeof ChartOutputSchema>> {
  const config = configFrom(env);
  let searchWord = "";
  try {
    searchWord = effectiveSearchWord(input);
    const observed = isoNow();
    const chart = chartFromPayload(
      await fetchChart(
        config,
        searchWord,
        input.date_range,
        input.source_label,
      ),
      config,
      observed,
      input.date_range,
      input.max_related_listings,
      input.source_label,
    );
    let partial = false;
    if (input.include_details && chart.related_current_listings.length)
      partial = await enrichDetails(config, chart.related_current_listings);
    return {
      outcome: partial ? "partial" : "ok",
      page_observed_at: observed,
      search_word: searchWord,
      chart,
      pagination: {
        native_page_size: chart.native_related_listing_count,
        raw_count: chart.native_related_listing_count,
        next_cursor: null,
        has_more: false,
        total_count: { value: null, kind: "unavailable" },
      },
      warnings: [
        {
          code: "source_chart_limits",
          message:
            "This is a Joongna source chart with unknown population and weighting; it is not an exact transaction average.",
        },
      ],
    };
  } catch (error) {
    const e =
      error instanceof DomainError
        ? error
        : new DomainError("parse_failed", false);
    return {
      outcome: "error",
      search_word: searchWord || undefined,
      error: { code: e.code, retryable: e.retryable, message: e.message },
      request_cursor: null,
      pagination: { next_cursor: null, has_more: null },
    } as z.infer<typeof ChartOutputSchema>;
  }
}
function toolResult(value: object, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}
function buildServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "joongna-mcp", version: "0.2.0" },
    {
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "private" },
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
      },
    },
  );
  server.registerTool(
    "joongna_search_keyword",
    {
      description:
        "Search one native Joongna page. Defaults to 50 native results, details enabled, and no seller evidence. The cursor is opaque; no automatic page fill or offset pagination is performed.",
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
    },
    async (args) => {
      const result = await searchListings(env, args);
      return toolResult(result, result.outcome === "error");
    },
  );
  server.registerTool(
    "joongna_search_price",
    {
      description:
        "Return the Joongna sales-price source chart for 30, 90, or 180 days, with related current listings. Chart population, weighting, and exact transaction semantics are unknown.",
      inputSchema: ChartInputSchema,
      outputSchema: ChartOutputSchema,
    },
    async (args) => {
      const result = await searchPrice(env, args);
      return toolResult(result, result.outcome === "error");
    },
  );
  server.registerTool(
    "joongna_get_seller_evidence",
    {
      description:
        "Fetch Joongna safeTradeCount and reviewCount evidence for each requested seller ID.",
      inputSchema: SellerBatchSchema,
      outputSchema: SellerOutputSchema,
    },
    async ({ seller_ids }) => {
      const config = configFrom(env);
      const unique = [...new Set(seller_ids)];
      const values = await fetchSellerBatch(config, unique);
      const sellers = seller_ids.map((id) => values.get(id)!);
      return toolResult({
        outcome: sellers.some((seller) => seller.status !== "available")
          ? "partial"
          : "ok",
        sellers,
      });
    },
  );
  return server;
}
function refused(): Response {
  return Response.json(
    {
      error: "no gateway identity",
      detail: "this service is only reachable through the gateway",
    },
    { status: 500 },
  );
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (identityFrom(request.headers) === null) return refused();
    const path = new URL(request.url).pathname;
    if (path !== "/mcp" && !path.startsWith("/mcp/"))
      return new Response("not found", { status: 404 });
    return createMcpHandler(() => buildServer(env)).fetch(request);
  },
};
