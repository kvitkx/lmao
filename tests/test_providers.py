"""
Unit tests for the places a judge can live.
"""

from unittest.mock import patch

import pytest

from api.errors import ApiError
from api.providers import JUDGE_KINDS, judge_kind, openai_client, resolve_judge
from core.openai_client import OpenAIClient
from core.provider import JUDGE_PROVIDERS

TOKENS = {
    "input": {"low": 1_000_000, "high": 2_000_000},
    "output": {"low": 500_000, "high": 1_000_000},
}


def _save_connection(services, **overrides):
    fields = {"base_url": "https://api.example.com/v1", "api_key": "sk-secret-1234"}
    fields.update(overrides)
    return services.connection_store.save(**fields)


def test_every_judge_provider_has_a_kind():
    assert set(JUDGE_KINDS) == set(JUDGE_PROVIDERS)


def test_only_a_local_ollama_judge_stays_on_this_machine():
    assert {name: kind.leaves_machine for name, kind in JUDGE_KINDS.items()} == {
        "ollama": False,
        "ollama_cloud": True,
        "openai": True,
    }


def test_an_unknown_judge_provider_is_a_client_error():
    with pytest.raises(ApiError) as error:
        judge_kind("nope")

    assert error.value.status == 400
    assert "nope" in error.value.message


def test_a_local_judge_has_no_provider_of_its_own(services):
    assert judge_kind("ollama").provider(services) is None
    assert judge_kind("ollama_cloud").provider(services) is None


def test_a_local_judge_must_be_installed_like_the_candidates(services):
    with patch.object(services.ollama, "get_models", return_value=["m"]):
        with pytest.raises(ApiError) as error:
            resolve_judge(services, "ollama", "j", ["m"])

    assert error.value.message == "Models are not installed: j."
    assert error.value.status == 400


def test_an_openai_judge_need_not_be_installed(services):
    _save_connection(services)

    with patch.object(services.ollama, "get_models", return_value=["m"]):
        provider = resolve_judge(services, "openai", "gpt", ["m"])

    assert isinstance(provider, OpenAIClient)


def test_an_openai_judge_needs_a_saved_connection(services):
    with pytest.raises(ApiError) as error:
        resolve_judge(services, "openai", "gpt", ["m"])

    assert error.value.message == "The OpenAI judge needs a saved connection."


def test_only_an_openai_judge_with_prices_has_a_cost(services):
    openai = judge_kind("openai")

    assert openai.cost(services, TOKENS) is None  # no connection
    _save_connection(services)
    assert openai.cost(services, TOKENS) is None  # no prices
    _save_connection(services, price_in=2.0, price_out=8.0)
    assert openai.cost(services, TOKENS) == {"low": 6.0, "high": 12.0}
    assert judge_kind("ollama").cost(services, TOKENS) is None
    assert judge_kind("ollama_cloud").cost(services, TOKENS) is None


def test_the_preview_of_a_local_judge_has_no_key(services):
    target = judge_kind("ollama").preview(services)

    assert target.provider is services.ollama
    assert target.headers == {}
    assert target.curl_auth == ""


def test_the_preview_of_an_openai_judge_hides_the_key(services):
    _save_connection(services)

    target = judge_kind("openai").preview(services)

    assert target.headers == {"Authorization": "Bearer ***"}
    assert "$API_KEY" in target.curl_auth
    assert "sk-secret" not in target.curl_auth


def test_openai_client_takes_the_url_and_the_key_of_a_connection():
    client = openai_client({"base_url": "https://x/v1", "api_key": "k"})

    assert (client.base_url, client.api_key) == ("https://x/v1", "k")
