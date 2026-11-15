"""
Unit tests for the Ollama client. Every HTTP call is mocked.
"""

from unittest.mock import MagicMock, patch

import requests

from core.ollama_client import GENERATE_TIMEOUT_SEC, UNLOAD_TIMEOUT_SEC, OllamaClient


def _response(payload):
    response = MagicMock()
    response.json.return_value = payload
    return response


def test_base_url_defaults_to_localhost(monkeypatch):
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)

    assert OllamaClient().base_url == "http://localhost:11434"


def test_base_url_is_read_from_environment(monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama:11434")

    assert OllamaClient().base_url == "http://ollama:11434"


@patch("core.ollama_client.requests.get")
def test_get_models_returns_model_names(mock_get):
    mock_get.return_value = _response({"models": [{"name": "a:1b"}, {"name": "b:2b"}]})

    assert OllamaClient().get_models() == ["a:1b", "b:2b"]
    assert mock_get.call_args.args[0].endswith("/api/tags")


@patch("core.ollama_client.requests.get")
def test_get_models_handles_missing_models_key(mock_get):
    mock_get.return_value = _response({})

    assert OllamaClient().get_models() == []


@patch("core.ollama_client.requests.get")
def test_get_models_returns_empty_list_on_error(mock_get):
    mock_get.side_effect = requests.ConnectionError("ollama is down")

    assert OllamaClient().get_models() == []


@patch("core.ollama_client.requests.post")
def test_ollama_client_handles_success(mock_post):
    """
    Test that our Ollama client correctly parses a successful response
    WITHOUT actually calling the running Ollama container.
    """
    mock_post.return_value = _response(
        {
            "response": "This is a mocked LLM response.",
            "done_reason": "stop",
            "prompt_eval_count": 42,
            "total_duration": 1000000000,  # 1 sec in ns
            "load_duration": 250000000,  # 0.25 sec in ns
            "eval_duration": 500000000,  # 0.5 sec in ns
            "eval_count": 100,
        }
    )

    result = OllamaClient().generate(model="mock-model", prompt="Hello!")

    assert result["success"] is True
    assert result["response_text"] == "This is a mocked LLM response."
    assert result["done_reason"] == "stop"
    assert result["prompt_eval_count"] == 42
    assert result["metrics"] == {
        "total_time_sec": 1.0,
        "load_time_sec": 0.25,
        "eval_time_sec": 0.5,
        "tokens_generated": 100,
        "tokens_per_second": 200.0,
    }
    mock_post.assert_called_once()


@patch("core.ollama_client.requests.post")
def test_generate_sends_prompt_and_forces_vram_unload(mock_post):
    mock_post.return_value = _response({})

    OllamaClient().generate(model="m", prompt="hi", system_prompt="be brief")

    assert mock_post.call_args.args[0].endswith("/api/generate")
    payload = mock_post.call_args.kwargs["json"]
    assert payload["model"] == "m"
    assert payload["prompt"] == "hi"
    assert payload["system"] == "be brief"
    assert payload["stream"] is False
    assert payload["keep_alive"] == 0
    assert "format" not in payload
    assert "think" not in payload
    assert "options" not in payload
    assert mock_post.call_args.kwargs["timeout"] == GENERATE_TIMEOUT_SEC


@patch("core.ollama_client.requests.post")
def test_generate_passes_format_think_options_and_keep_alive(mock_post):
    mock_post.return_value = _response({})
    schema = {"type": "object"}
    options = {"temperature": 0, "seed": 7, "num_predict": 1000}

    OllamaClient().generate(
        model="m",
        prompt="hi",
        format=schema,
        think=False,
        options=options,
        keep_alive="10m",
        timeout=30,
    )

    payload = mock_post.call_args.kwargs["json"]
    assert payload["format"] == schema
    assert payload["think"] is False
    assert payload["options"] == options
    assert payload["keep_alive"] == "10m"
    assert mock_post.call_args.kwargs["timeout"] == 30


@patch("core.ollama_client.requests.post")
def test_generate_requests_json_format_when_asked(mock_post):
    mock_post.return_value = _response({})

    OllamaClient().generate(model="m", prompt="hi", format="json")

    assert mock_post.call_args.kwargs["json"]["format"] == "json"


@patch("core.ollama_client.requests.post")
def test_generate_uses_defaults_for_missing_response_fields(mock_post):
    mock_post.return_value = _response({"response": "x"})

    result = OllamaClient().generate(model="m", prompt="hi")

    assert result["success"] is True
    assert result["done_reason"] == ""
    assert result["prompt_eval_count"] == 0
    assert result["metrics"]["load_time_sec"] == 0
    assert result["metrics"]["tokens_per_second"] == 0


@patch("core.ollama_client.requests.post")
def test_generate_returns_error_on_http_failure(mock_post):
    response = _response({})
    response.raise_for_status.side_effect = requests.HTTPError("500 Server Error")
    mock_post.return_value = response

    result = OllamaClient().generate(model="m", prompt="hi")

    assert result["success"] is False
    assert "500" in result["error"]


@patch("core.ollama_client.requests.post")
def test_generate_returns_error_on_connection_failure(mock_post):
    mock_post.side_effect = requests.ConnectionError("connection refused")

    result = OllamaClient().generate(model="m", prompt="hi")

    assert result == {"success": False, "error": "connection refused"}


@patch("core.ollama_client.requests.post")
def test_unload_sends_keep_alive_zero_without_prompt(mock_post):
    mock_post.return_value = _response({})

    assert OllamaClient().unload("m") is True

    assert mock_post.call_args.args[0].endswith("/api/generate")
    assert mock_post.call_args.kwargs["json"] == {"model": "m", "keep_alive": 0}
    assert mock_post.call_args.kwargs["timeout"] == UNLOAD_TIMEOUT_SEC


@patch("core.ollama_client.requests.post")
def test_unload_returns_false_on_error(mock_post):
    mock_post.side_effect = requests.ConnectionError("ollama is down")

    assert OllamaClient().unload("m") is False


@patch("core.ollama_client.requests.get")
def test_get_model_sizes_returns_bytes_by_name(mock_get):
    mock_get.return_value = _response(
        {"models": [{"name": "a:1b", "size": 100}, {"name": "b:cloud"}]}
    )

    assert OllamaClient().get_model_sizes() == {"a:1b": 100, "b:cloud": 0}
    assert mock_get.call_args.args[0].endswith("/api/tags")


@patch("core.ollama_client.requests.get")
def test_get_model_sizes_returns_empty_dict_on_error(mock_get):
    mock_get.side_effect = requests.ConnectionError("ollama is down")

    assert OllamaClient().get_model_sizes() == {}


@patch("core.ollama_client.requests.get")
def test_get_loaded_returns_the_memory_of_the_model(mock_get):
    mock_get.return_value = _response(
        {"models": [{"name": "m", "model": "m", "size": 300, "size_vram": 200}]}
    )

    assert OllamaClient().get_loaded("m") == {"size": 300, "size_vram": 200}
    assert mock_get.call_args.args[0].endswith("/api/ps")


@patch("core.ollama_client.requests.get")
def test_get_loaded_returns_none_for_a_model_that_is_not_loaded(mock_get):
    mock_get.return_value = _response({"models": []})

    assert OllamaClient().get_loaded("m") is None


@patch("core.ollama_client.requests.get")
def test_get_loaded_returns_none_on_error(mock_get):
    mock_get.side_effect = requests.ConnectionError("ollama is down")

    assert OllamaClient().get_loaded("m") is None


@patch("core.ollama_client.requests.get")
def test_get_version_returns_the_version(mock_get):
    mock_get.return_value = _response({"version": "0.21.0"})

    assert OllamaClient().get_version() == "0.21.0"
    assert mock_get.call_args.args[0].endswith("/api/version")


@patch("core.ollama_client.requests.get")
def test_get_version_returns_none_on_error(mock_get):
    mock_get.side_effect = requests.ConnectionError("ollama is down")

    assert OllamaClient().get_version() is None
