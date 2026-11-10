"""
Unit tests for the OpenAI-compatible client. Every HTTP call is mocked.
"""

from unittest.mock import MagicMock, patch

import requests

from core.openai_client import ERROR_TEXT_LIMIT, OpenAIClient
from core.provider import GENERATE_TIMEOUT_SEC, Provider

MAX_TOKENS_REJECTED = (
    "Unsupported parameter: 'max_tokens' is not supported with this model. "
    "Use 'max_completion_tokens' instead."
)
SCHEMA_REJECTED = "Invalid schema for response_format 'response'"
SCHEMA = {"type": "object", "properties": {"score": {"type": "integer"}}}


def _response(payload=None, status=200, text=""):
    response = MagicMock()
    response.status_code = status
    response.ok = status < 400
    response.text = text
    response.json.return_value = payload
    return response


def _completion(text="ok", finish="stop", prompt_tokens=11, completion_tokens=5):
    return _response(
        {
            "choices": [{"message": {"content": text}, "finish_reason": finish}],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
            },
        }
    )


def _error(message, status=400):
    return _response({"error": {"message": message}}, status=status)


def _client():
    return OpenAIClient("https://api.example.com/v1/", "sk-secret-1234")


def _sent(mock_post, call=0):
    return mock_post.call_args_list[call].kwargs["json"]


# --- the client itself ------------------------------------------------------


def test_openai_client_is_a_provider_with_default_capabilities():
    client = _client()

    assert isinstance(client, Provider)
    assert client.unload("m") is True
    assert client.get_model_sizes() == {}
    assert client.get_loaded("m") is None


def test_base_url_loses_the_trailing_slash():
    assert _client().base_url == "https://api.example.com/v1"


def test_repr_hides_the_key():
    assert repr(_client()) == (
        "OpenAIClient(base_url='https://api.example.com/v1', api_key='***')"
    )


# --- get_models -------------------------------------------------------------


@patch("core.openai_client.requests.get")
def test_get_models_returns_ids_and_sends_the_key(mock_get):
    mock_get.return_value = _response({"data": [{"id": "a"}, {"id": "b"}]})

    assert _client().get_models() == ["a", "b"]
    assert mock_get.call_args.args[0] == "https://api.example.com/v1/models"
    assert mock_get.call_args.kwargs["headers"] == {
        "Authorization": "Bearer sk-secret-1234"
    }


@patch("core.openai_client.requests.get")
def test_get_models_handles_missing_data_key(mock_get):
    mock_get.return_value = _response({})

    assert _client().get_models() == []


@patch("core.openai_client.requests.get")
def test_get_models_returns_empty_list_on_http_error(mock_get):
    response = _response({})
    response.raise_for_status.side_effect = requests.HTTPError("401")
    mock_get.return_value = response

    assert _client().get_models() == []


@patch("core.openai_client.requests.get")
def test_get_models_returns_empty_list_on_connection_error(mock_get):
    mock_get.side_effect = requests.ConnectionError("down")

    assert _client().get_models() == []


# --- generate: request ------------------------------------------------------


@patch("core.openai_client.requests.post")
def test_generate_sends_a_chat_completion(mock_post):
    mock_post.return_value = _completion()

    _client().generate("m", "hi", system_prompt="be brief")

    assert mock_post.call_args.args[0] == "https://api.example.com/v1/chat/completions"
    assert mock_post.call_args.kwargs["headers"] == {
        "Authorization": "Bearer sk-secret-1234"
    }
    assert mock_post.call_args.kwargs["timeout"] == GENERATE_TIMEOUT_SEC
    assert _sent(mock_post) == {
        "model": "m",
        "messages": [
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "hi"},
        ],
    }


@patch("core.openai_client.requests.post")
def test_generate_without_a_system_prompt_sends_only_the_user_message(mock_post):
    mock_post.return_value = _completion()

    _client().generate("m", "hi", timeout=30)

    assert _sent(mock_post)["messages"] == [{"role": "user", "content": "hi"}]
    assert mock_post.call_args.kwargs["timeout"] == 30


@patch("core.openai_client.requests.post")
def test_generate_maps_options_and_drops_the_rest(mock_post):
    mock_post.return_value = _completion()
    options = {"temperature": 0, "seed": 7, "num_predict": 1000, "num_ctx": 8192}

    _client().generate("m", "hi", think=False, options=options, keep_alive="10m")

    payload = _sent(mock_post)
    assert (payload["temperature"], payload["seed"]) == (0, 7)
    assert payload["max_tokens"] == 1000
    for ignored in ("num_ctx", "num_predict", "think", "keep_alive", "options"):
        assert ignored not in payload


@patch("core.openai_client.requests.post")
def test_generate_requests_a_json_object_for_json_format(mock_post):
    mock_post.return_value = _completion()

    _client().generate("m", "hi", format="json")

    assert _sent(mock_post)["response_format"] == {"type": "json_object"}


@patch("core.openai_client.requests.post")
def test_generate_sends_a_schema_as_strict_json_schema(mock_post):
    mock_post.return_value = _completion()

    _client().generate("m", "hi", format=SCHEMA)

    assert _sent(mock_post)["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "response", "strict": True, "schema": SCHEMA},
    }


# --- generate: reply --------------------------------------------------------


@patch("core.openai_client.requests.post")
def test_generate_parses_the_reply(mock_post):
    mock_post.return_value = _completion("hello", prompt_tokens=11)

    result = _client().generate("m", "hi")

    assert result["success"] is True
    assert result["response_text"] == "hello"
    assert result["done_reason"] == "stop"
    assert result["prompt_eval_count"] == 11


@patch("core.openai_client.requests.post")
@patch("core.openai_client.time")
def test_generate_measures_wall_time_and_speed(mock_time, mock_post):
    mock_time.monotonic.side_effect = [10.0, 12.0]
    mock_post.return_value = _completion(completion_tokens=5)

    result = _client().generate("m", "hi")

    assert result["metrics"] == {
        "total_time_sec": 2.0,
        "load_time_sec": 0,
        "eval_time_sec": 2.0,
        "tokens_generated": 5,
        "tokens_per_second": 2.5,
    }


@patch("core.openai_client.requests.post")
def test_generate_reports_the_token_limit(mock_post):
    mock_post.return_value = _completion("cut", finish="length")

    assert _client().generate("m", "hi")["done_reason"] == "length"


@patch("core.openai_client.requests.post")
def test_generate_uses_defaults_for_a_reply_without_content_or_usage(mock_post):
    mock_post.return_value = _response(
        {"choices": [{"message": {"content": None}, "finish_reason": None}]}
    )

    result = _client().generate("m", "hi")

    assert result["success"] is True
    assert result["response_text"] == ""
    assert result["done_reason"] == "stop"
    assert result["prompt_eval_count"] == 0
    assert result["metrics"]["tokens_generated"] == 0


@patch("core.openai_client.requests.post")
def test_generate_copes_with_a_reply_without_choices(mock_post):
    mock_post.return_value = _response({})

    result = _client().generate("m", "hi")

    assert (result["success"], result["response_text"]) == (True, "")


# --- generate: parameters a server rejects ----------------------------------


@patch("core.openai_client.requests.post")
def test_max_tokens_is_swapped_when_the_model_wants_max_completion_tokens(mock_post):
    mock_post.side_effect = [_error(MAX_TOKENS_REJECTED), _completion()]

    result = _client().generate("m", "hi", options={"num_predict": 1000})

    assert result["success"] is True
    assert mock_post.call_count == 2
    assert _sent(mock_post, 0)["max_tokens"] == 1000
    second = _sent(mock_post, 1)
    assert second["max_completion_tokens"] == 1000
    assert "max_tokens" not in second


@patch("core.openai_client.requests.post")
def test_a_rejected_schema_falls_back_to_a_json_object_and_is_remembered(mock_post):
    mock_post.side_effect = [
        _error(SCHEMA_REJECTED),
        _completion('{"score": 1}'),
        _completion('{"score": 2}'),
    ]
    client = _client()

    first = client.generate("m", "hi", format=SCHEMA)
    second = client.generate("m", "hi", format=SCHEMA)

    assert first["success"] is True
    assert second["success"] is True
    assert mock_post.call_count == 3
    assert _sent(mock_post, 0)["response_format"]["type"] == "json_schema"
    assert _sent(mock_post, 1)["response_format"] == {"type": "json_object"}
    assert _sent(mock_post, 2)["response_format"] == {"type": "json_object"}
    assert client.json_schema is False


@patch("core.openai_client.requests.post")
def test_an_unrelated_bad_request_is_not_retried(mock_post):
    mock_post.return_value = _error("Invalid request")

    result = _client().generate("m", "hi", format=SCHEMA)

    assert result == {"success": False, "error": "400: Invalid request"}
    assert mock_post.call_count == 1


# --- generate: failures -----------------------------------------------------


@patch("core.openai_client.requests.post")
def test_generate_reports_the_message_of_the_api(mock_post):
    mock_post.return_value = _error("Incorrect API key provided", status=401)

    result = _client().generate("m", "hi")

    assert result == {"success": False, "error": "401: Incorrect API key provided"}


@patch("core.openai_client.requests.post")
def test_generate_falls_back_to_the_body_when_the_error_is_not_json(mock_post):
    response = _response(status=502, text="Bad Gateway")
    response.json.side_effect = ValueError("no json")
    mock_post.return_value = response

    result = _client().generate("m", "hi")

    assert result == {"success": False, "error": "502: Bad Gateway"}


@patch("core.openai_client.requests.post")
def test_generate_cuts_a_long_error_message(mock_post):
    mock_post.return_value = _error("x" * 1000)

    error = _client().generate("m", "hi")["error"]

    assert len(error) == len("400: ") + ERROR_TEXT_LIMIT


@patch("core.openai_client.requests.post")
def test_generate_returns_error_on_connection_failure(mock_post):
    mock_post.side_effect = requests.ConnectionError("connection refused")

    result = _client().generate("m", "hi")

    assert result == {"success": False, "error": "connection refused"}


@patch("core.openai_client.requests.get")
def test_get_models_does_not_log_the_exception_text(mock_get, capsys):
    mock_get.side_effect = requests.ConnectionError("failed with sk-secret-1234")

    assert _client().get_models() == []

    output = capsys.readouterr().out
    assert "sk-secret" not in output
    assert "ConnectionError" in output


@patch("core.openai_client.requests.post")
def test_generate_hides_the_key_if_the_server_echoes_it(mock_post):
    mock_post.return_value = _error("Bad key sk-secret-1234 given", status=401)

    result = _client().generate("m", "hi")

    assert result == {"success": False, "error": "401: Bad key *** given"}
