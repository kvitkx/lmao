"""OpenAI-compatible API client module.

Implements the provider interface for servers that speak the OpenAI chat
completions API: OpenAI, OpenRouter, vLLM, LM Studio and others. A remote API
has nothing to load or unload and reports no sizes, so only the two required
methods are implemented.
"""

import time

import requests

from .provider import GENERATE_TIMEOUT_SEC, Provider

MODELS_TIMEOUT_SEC = 10
# A parameter the server rejects is fixed and the request is sent again, at
# most this many times.
MAX_ADJUSTMENTS = 2
ERROR_TEXT_LIMIT = 300

# Ollama option -> chat completions parameter. Other options (num_ctx, ...) have
# no counterpart and are dropped.
_OPTION_PARAMS = {
    "temperature": "temperature",
    "seed": "seed",
    "num_predict": "max_tokens",
}


def _error_message(response) -> str:
    """The message of an error reply: the API's own text, or the raw body."""
    try:
        message = response.json()["error"]["message"]
    except ValueError, KeyError, TypeError:
        message = response.text
    return str(message)[:ERROR_TEXT_LIMIT]


def _result(data: dict, elapsed: float) -> dict:
    """Turns a chat completions reply into the result of Provider.generate()."""
    choice = (data.get("choices") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or ""
    usage = data.get("usage") or {}
    tokens = usage.get("completion_tokens", 0)

    return {
        "success": True,
        "response_text": text,
        "done_reason": choice.get("finish_reason") or "stop",
        "prompt_eval_count": usage.get("prompt_tokens", 0),
        "metrics": {
            "total_time_sec": round(elapsed, 2),
            "load_time_sec": 0,
            # The API does not split prompt and generation time: the whole
            # call counts, network and queueing included.
            "eval_time_sec": round(elapsed, 2),
            "tokens_generated": tokens,
            "tokens_per_second": round(tokens / elapsed, 2) if elapsed > 0 else 0,
        },
    }


class OpenAIClient(Provider):
    """Client for an OpenAI-compatible chat completions API.

    Attributes:
        base_url (str): API root without a trailing slash, for example
            https://api.openai.com/v1.
        api_key (str): Sent as a Bearer token. Never printed or logged.
        json_schema (bool): False once the server rejected a JSON schema, so
            later calls ask for a plain JSON object right away.
    """

    def __init__(self, base_url: str, api_key: str):
        """Initializes the client.

        Args:
            base_url (str): API root, for example https://api.openai.com/v1.
            api_key (str): The API key.
        """
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.json_schema = True

    def __repr__(self) -> str:
        return f"OpenAIClient(base_url={self.base_url!r}, api_key='***')"

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"}

    def _redact(self, text: str) -> str:
        """Hides the API key in text that is shown to the user or stored."""
        return text.replace(self.api_key, "***") if self.api_key else text

    def get_models(self) -> list:
        """Retrieves the ids of the models the API serves.

        Returns:
            list: A list of model id strings. Empty on any error.
        """
        try:
            response = requests.get(
                f"{self.base_url}/models",
                headers=self._headers(),
                timeout=MODELS_TIMEOUT_SEC,
            )
            response.raise_for_status()
            return [model["id"] for model in response.json().get("data", [])]
        except Exception as e:
            # Only the type: the text of an exception is not ours to trust.
            print(f"Error fetching models: {type(e).__name__}")
            return []

    def generate(
        self,
        model: str,
        prompt: str,
        system_prompt: str = "",
        format: str | dict | None = None,
        think: bool | None = None,
        options: dict | None = None,
        keep_alive: int | str = 0,
        timeout: int = GENERATE_TIMEOUT_SEC,
    ) -> dict:
        """Generates a text response with a chat completion.

        `temperature`, `seed` and `num_predict` (sent as `max_tokens`) are
        passed on. `think`, `keep_alive` and the other options have no
        counterpart and are ignored. A JSON schema becomes a strict
        `json_schema` response format; if the server rejects it, the client
        falls back to a plain JSON object. The speed in the metrics includes
        network time, so it is not comparable with a local model's speed.

        Returns:
            dict: See `Provider.generate`.
        """
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        payload = {"model": model, "messages": messages}

        response_format = self._response_format(format)
        if response_format:
            payload["response_format"] = response_format

        for option, param in _OPTION_PARAMS.items():
            if option in (options or {}):
                payload[param] = options[option]

        try:
            started = time.monotonic()
            data = self._post_chat(payload, timeout)
            return _result(data, time.monotonic() - started)
        except Exception as e:
            return {"success": False, "error": self._redact(str(e))}

    def _response_format(self, format: str | dict | None) -> dict | None:
        if format is None:
            return None
        if isinstance(format, dict) and self.json_schema:
            return {
                "type": "json_schema",
                "json_schema": {"name": "response", "strict": True, "schema": format},
            }
        return {"type": "json_object"}

    def _post_chat(self, payload: dict, timeout: int) -> dict:
        """Posts the request, fixing parameters the server rejects."""
        for attempt in range(MAX_ADJUSTMENTS + 1):
            response = requests.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=payload,
                timeout=timeout,
            )
            if response.status_code == 400 and attempt < MAX_ADJUSTMENTS:
                fixed = self._adjust(payload, _error_message(response))
                if fixed is not None:
                    payload = fixed
                    continue
            break

        if not response.ok:
            raise requests.HTTPError(
                f"{response.status_code}: {_error_message(response)}",
                response=response,
            )
        return response.json()

    def _adjust(self, payload: dict, message: str) -> dict | None:
        """Fixes a request the server rejected, or returns None if it cannot.

        Two known differences between servers: newer OpenAI models want
        `max_completion_tokens` instead of `max_tokens`, and not every model or
        server accepts a JSON schema.
        """
        text = message.lower()

        if "max_completion_tokens" in text and "max_tokens" in payload:
            fixed = {k: v for k, v in payload.items() if k != "max_tokens"}
            fixed["max_completion_tokens"] = payload["max_tokens"]
            return fixed

        is_schema = payload.get("response_format", {}).get("type") == "json_schema"
        if is_schema and ("response_format" in text or "json_schema" in text):
            self.json_schema = False
            return {**payload, "response_format": {"type": "json_object"}}

        return None
