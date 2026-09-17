from joongna_mcp.normalize import normalize_search_word


def test_normalize_english_natural_language_query() -> None:
    assert normalize_search_word("how much does used iPhone 13 mini go these days?") == "아이폰13미니"


def test_normalize_korean_query() -> None:
    assert normalize_search_word("아이폰 13 미니") == "아이폰13미니"
