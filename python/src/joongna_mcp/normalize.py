from __future__ import annotations

import re


_PHRASE_REPLACEMENTS: tuple[tuple[str, str], ...] = (
    (r"\bapple watch\b", "애플워치"),
    (r"\bairpods max\b", "에어팟맥스"),
    (r"\bairpods pro\b", "에어팟프로"),
    (r"\bairpods\b", "에어팟"),
    (r"\bgalaxy z fold\b", "갤럭시z폴드"),
    (r"\bgalaxy z flip\b", "갤럭시z플립"),
    (r"\bgalaxy\b", "갤럭시"),
    (r"\biphone\b", "아이폰"),
    (r"\bipad\b", "아이패드"),
    (r"\bmacbook\b", "맥북"),
    (r"\bpro max\b", "프로맥스"),
    (r"\bplus\b", "플러스"),
    (r"\bultra\b", "울트라"),
    (r"\bmini\b", "미니"),
    (r"\bpro\b", "프로"),
    (r"\bmax\b", "맥스"),
)

_NOISE_PATTERNS: tuple[str, ...] = (
    r"\bhow much does\b",
    r"\bhow much do\b",
    r"\bhow much is\b",
    r"\bhow much are\b",
    r"\bhow much\b",
    r"\bwhat is the price of\b",
    r"\bprice of\b",
    r"\bgoing for\b",
    r"\bgo for\b",
    r"\bgo these days\b",
    r"\bthese days\b",
    r"\bworth\b",
    r"\bselling for\b",
    r"\bused\b",
    r"\bsecond hand\b",
    r"\bprice\b",
    r"\bcurrent\b",
    r"\bdoes\b",
    r"\bdo\b",
    r"\bis\b",
    r"\bare\b",
    r"\bfor\b",
    r"\bthe\b",
    r"\ba\b",
    r"\ban\b",
)


def normalize_search_word(query: str) -> str:
    text = query.strip()
    if not text:
        raise ValueError("query must not be blank")

    normalized = text.lower()
    normalized = re.sub(r"[?!.:,/()\[\]{}]+", " ", normalized)
    normalized = re.sub(r"\b(\d+)\s*(gb|g|tb)\b", r"\1", normalized)

    for pattern, replacement in _PHRASE_REPLACEMENTS:
        normalized = re.sub(pattern, replacement, normalized)

    for pattern in _NOISE_PATTERNS:
        normalized = re.sub(pattern, " ", normalized)

    normalized = re.sub(r"[^0-9a-zA-Z가-힣]+", " ", normalized)
    normalized = re.sub(r"\s+", "", normalized)

    if normalized:
        return normalized

    fallback = re.sub(r"[^0-9a-zA-Z가-힣]+", "", text)
    if not fallback:
        raise ValueError("query did not contain a usable search term")
    return fallback
