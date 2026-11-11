"""
Unit tests for the saved connection. Every test runs in a temporary directory.
"""

import json
import os
import stat

import pytest

from core.connection import (
    ERROR_TEXTS,
    ConnectionStore,
    InvalidConnection,
    normalize_url,
    public_view,
)

URL = "https://api.example.com/v1"
KEY = "sk-secret-1234"


@pytest.fixture
def store(tmp_path):
    return ConnectionStore(str(tmp_path / "data" / "connection.json"))


# --- normalize_url ----------------------------------------------------------


@pytest.mark.parametrize(
    "value, expected",
    [
        ("https://api.example.com/v1", URL),
        (" https://api.example.com/v1/ ", URL),
        ("http://localhost:1234/v1", "http://localhost:1234/v1"),
    ],
)
def test_normalize_url_accepts_http_urls(value, expected):
    assert normalize_url(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        None,
        5,
        "",
        "   ",
        "/",
        "https://",
        "api.example.com",
        "ftp://api.example.com",
        "https://user:pw@api.example.com/v1",
        "https://api.example.com/v1?key=1",
        "https://api.example.com/v1#frag",
        "https://api.example.com:notaport/v1",
        "https://[::1/v1",
        "https://" + "a" * 300,
    ],
)
def test_normalize_url_rejects_everything_else(value):
    with pytest.raises(InvalidConnection):
        normalize_url(value)


def test_an_error_carries_a_code_and_its_text():
    with pytest.raises(InvalidConnection) as error:
        normalize_url("ftp://api.example.com")

    assert error.value.code == "url_scheme"
    assert str(error.value) == ERROR_TEXTS["url_scheme"]


# --- save and load ----------------------------------------------------------


def test_load_returns_none_without_a_file(store):
    assert store.load() is None


def test_save_writes_the_file_for_the_owner_only(store):
    saved = store.save(URL, KEY, "gpt-4.1-mini")

    assert saved == {
        "base_url": URL,
        "api_key": KEY,
        "model": "gpt-4.1-mini",
        "price_in": None,
        "price_out": None,
    }
    assert store.load() == saved
    assert stat.S_IMODE(os.stat(store.path).st_mode) == 0o600


def test_save_tightens_the_permissions_of_an_old_file(store):
    os.makedirs(os.path.dirname(store.path))
    with open(store.path, "w", encoding="utf-8") as f:
        f.write("{}")
    os.chmod(store.path, 0o644)

    store.save(URL, KEY)

    assert stat.S_IMODE(os.stat(store.path).st_mode) == 0o600


def test_save_leaves_no_temporary_file(store):
    store.save(URL, KEY)

    assert os.listdir(os.path.dirname(store.path)) == ["connection.json"]


def test_save_normalizes_the_url_and_defaults_the_model(store):
    saved = store.save(" https://api.example.com/v1/ ", KEY)

    assert saved["base_url"] == URL
    assert saved["model"] == ""


@pytest.mark.parametrize("empty_key", [None, "", "   "])
def test_an_empty_key_keeps_the_saved_key_for_the_same_url(store, empty_key):
    store.save(URL, KEY, "a")

    saved = store.save(URL, empty_key, "b")

    assert (saved["api_key"], saved["model"]) == (KEY, "b")
    assert store.load() == saved


def test_changing_the_url_needs_the_key_again(store):
    store.save(URL, KEY)

    with pytest.raises(InvalidConnection, match="again"):
        store.save("https://evil.example.com/v1")

    assert store.load()["base_url"] == URL


def test_a_new_url_with_a_new_key_is_saved(store):
    store.save(URL, KEY)

    saved = store.save("https://other.example.com/v1", "sk-other-5678")

    assert saved["base_url"] == "https://other.example.com/v1"
    assert saved["api_key"] == "sk-other-5678"


def test_the_first_save_needs_a_key(store):
    with pytest.raises(InvalidConnection, match="required"):
        store.save(URL)

    assert store.load() is None


@pytest.mark.parametrize(
    "key", [5, ["k"], "sk with space", "sk\nline", "sk-é", "x" * 501]
)
def test_save_rejects_an_unusable_key(store, key):
    with pytest.raises(InvalidConnection):
        store.save(URL, key)

    assert store.load() is None


@pytest.mark.parametrize("model", [5, ["m"], "m" * 201])
def test_save_rejects_an_unusable_model(store, model):
    with pytest.raises(InvalidConnection):
        store.save(URL, KEY, model)


@pytest.mark.parametrize(
    "content",
    [
        "{not json",
        "[]",
        json.dumps({"base_url": URL}),
        json.dumps({"api_key": KEY}),
        json.dumps({"base_url": URL, "api_key": ""}),
        json.dumps({"base_url": 5, "api_key": KEY}),
    ],
)
def test_load_ignores_a_damaged_file(store, content):
    os.makedirs(os.path.dirname(store.path))
    with open(store.path, "w", encoding="utf-8") as f:
        f.write(content)

    assert store.load() is None


def test_load_defaults_a_missing_model(store):
    os.makedirs(os.path.dirname(store.path))
    with open(store.path, "w", encoding="utf-8") as f:
        json.dump({"base_url": URL, "api_key": KEY}, f)

    assert store.load() == {
        "base_url": URL,
        "api_key": KEY,
        "model": "",
        "price_in": None,
        "price_out": None,
    }


# --- delete -----------------------------------------------------------------


def test_delete_removes_the_connection_and_is_safe_twice(store):
    store.save(URL, KEY)

    store.delete()
    store.delete()

    assert store.load() is None


# --- public_view ------------------------------------------------------------


def test_public_view_never_contains_the_key():
    view = public_view({"base_url": URL, "api_key": KEY, "model": "m"})

    assert view == {
        "base_url": URL,
        "model": "m",
        "price_in": None,
        "price_out": None,
        "key_last4": "1234",
    }
    assert "sk-secret" not in json.dumps(view)


def test_public_view_hides_a_short_key_completely():
    view = public_view({"base_url": URL, "api_key": "abc", "model": ""})

    assert view["key_last4"] == ""


def test_public_view_of_no_connection_is_none():
    assert public_view(None) is None


# --- prices -----------------------------------------------------------------


def test_prices_are_saved_and_loaded(store):
    saved = store.save(URL, KEY, "m", price_in=0.4, price_out=1.6)

    assert (saved["price_in"], saved["price_out"]) == (0.4, 1.6)
    assert store.load() == saved


def test_integer_and_zero_prices_become_floats(store):
    saved = store.save(URL, KEY, price_in=0, price_out=2)

    assert (saved["price_in"], saved["price_out"]) == (0.0, 2.0)
    assert isinstance(saved["price_in"], float)
    assert isinstance(saved["price_out"], float)


def test_saving_without_prices_clears_them_but_keeps_the_key(store):
    store.save(URL, KEY, price_in=1, price_out=2)

    saved = store.save(URL, None)

    assert (saved["price_in"], saved["price_out"]) == (None, None)
    assert saved["api_key"] == KEY


@pytest.mark.parametrize(
    "bad", [-1, "5", True, [1], float("nan"), float("inf"), 10_001]
)
def test_save_rejects_an_unusable_price(store, bad):
    with pytest.raises(InvalidConnection) as error:
        store.save(URL, KEY, price_in=bad, price_out=1)

    assert error.value.code == "price_invalid"
    assert store.load() is None


@pytest.mark.parametrize("pair", [(1, None), (None, 1)])
def test_the_prices_come_as_a_pair(store, pair):
    with pytest.raises(InvalidConnection, match="both"):
        store.save(URL, KEY, price_in=pair[0], price_out=pair[1])

    assert store.load() is None


def test_load_ignores_damaged_prices(store):
    os.makedirs(os.path.dirname(store.path))
    with open(store.path, "w", encoding="utf-8") as f:
        json.dump({"base_url": URL, "api_key": KEY, "price_in": "x", "price_out": 2}, f)

    assert store.load() == {
        "base_url": URL,
        "api_key": KEY,
        "model": "",
        "price_in": None,
        "price_out": None,
    }


def test_public_view_contains_the_prices_but_not_the_key():
    view = public_view(
        {
            "base_url": URL,
            "api_key": KEY,
            "model": "m",
            "price_in": 1.0,
            "price_out": 2.0,
        }
    )

    assert view == {
        "base_url": URL,
        "model": "m",
        "price_in": 1.0,
        "price_out": 2.0,
        "key_last4": "1234",
    }
