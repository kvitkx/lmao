"""
Unit tests for the provider interface.
"""

import threading

import pytest

from core.ollama_client import OllamaClient
from core.provider import Provider


class _Minimal(Provider):
    """A provider that implements only the two required methods."""

    def get_models(self):
        return ["m"]

    def generate(self, model, prompt, **kwargs):
        return {"success": True, "response_text": "x"}


def test_provider_cannot_be_instantiated():
    with pytest.raises(TypeError):
        Provider()


def test_a_provider_needs_both_abstract_methods():
    class OnlyModels(Provider):
        def get_models(self):
            return []

    with pytest.raises(TypeError):
        OnlyModels()


def test_optional_capabilities_have_safe_defaults():
    provider = _Minimal()

    assert provider.get_models() == ["m"]
    assert provider.unload("m") is True
    assert provider.get_model_sizes() == {}
    assert provider.get_loaded("m") is None
    assert provider.get_version() is None


def test_ollama_client_is_a_provider():
    assert issubclass(OllamaClient, Provider)


def test_only_a_local_ollama_truncates_prompts():
    assert _Minimal().truncates_prompts is False
    assert OllamaClient().truncates_prompts is True


def test_default_streaming_makes_one_call_and_sends_the_whole_text_as_a_token():
    tokens = []

    result = _Minimal().generate_stream("m", "hi", on_token=tokens.append)

    assert result == {"success": True, "response_text": "x"}
    assert tokens == ["x"]


def test_default_streaming_does_not_call_the_model_once_cancelled():
    cancel = threading.Event()
    cancel.set()

    result = _Minimal().generate_stream("m", "hi", cancel=cancel)

    assert result == {"success": False, "cancelled": True, "error": "Cancelled."}
