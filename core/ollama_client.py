"""Ollama API Client module.

Provides a wrapper class to interact with a local Ollama service,
handling model discovery, generation requests and explicit VRAM unloading.
"""

import json
import os
import threading
import time
from collections.abc import Callable

import requests

from .provider import GENERATE_TIMEOUT_SEC, Provider, cancelled_result

NS_PER_SEC = 1e9
UNLOAD_TIMEOUT_SEC = 30


def _result(data: dict, text: str) -> dict:
    """Turns the last reply of /api/generate into the result of generate()."""
    total_duration_sec = data.get("total_duration", 0) / NS_PER_SEC
    load_duration_sec = data.get("load_duration", 0) / NS_PER_SEC
    eval_duration_sec = data.get("eval_duration", 0) / NS_PER_SEC
    eval_count = data.get("eval_count", 0)

    tokens_per_second = (eval_count / eval_duration_sec) if eval_duration_sec > 0 else 0

    return {
        "success": True,
        "response_text": text,
        "done_reason": data.get("done_reason", ""),
        "prompt_eval_count": data.get("prompt_eval_count", 0),
        "metrics": {
            "total_time_sec": round(total_duration_sec, 2),
            "load_time_sec": round(load_duration_sec, 2),
            "eval_time_sec": round(eval_duration_sec, 2),
            "tokens_generated": eval_count,
            "tokens_per_second": round(tokens_per_second, 2),
        },
    }


class OllamaClient(Provider):
    """Client for communicating with the Ollama REST API.

    Attributes:
        base_url (str): The base URL of the Ollama service.
    """

    truncates_prompts = True

    def __init__(self):
        """Initializes the OllamaClient using environment variables if present."""
        self.base_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

    def get_models(self) -> list:
        """Retrieves a list of available models installed in Ollama.

        Returns:
            list: A list of model name strings.
        """
        try:
            response = requests.get(f"{self.base_url}/api/tags", timeout=5)
            response.raise_for_status()
            models = [model["name"] for model in response.json().get("models", [])]
            return models
        except Exception as e:
            print(f"Error fetching models: {e}")
            return []

    def get_model_sizes(self) -> dict:
        """Retrieves the size on disk of every installed model.

        Returns:
            dict: Model name to size in bytes. Cloud models report 0.
        """
        try:
            response = requests.get(f"{self.base_url}/api/tags", timeout=5)
            response.raise_for_status()
            return {
                model["name"]: model.get("size", 0)
                for model in response.json().get("models", [])
            }
        except Exception as e:
            print(f"Error fetching model sizes: {e}")
            return {}

    def get_loaded(self, model: str) -> dict | None:
        """Reads the memory a loaded model takes.

        Args:
            model (str): The name of the model.

        Returns:
            dict | None: size (total) and size_vram in bytes, or None if the
                model is not loaded locally (cloud models never are).
        """
        try:
            response = requests.get(f"{self.base_url}/api/ps", timeout=5)
            response.raise_for_status()
            for item in response.json().get("models", []):
                if model in (item.get("name"), item.get("model")):
                    return {
                        "size": item.get("size", 0),
                        "size_vram": item.get("size_vram", 0),
                    }
        except requests.RequestException as e:
            print(f"Error reading loaded models: {e}")
        return None

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
        """Generates a text response from a specific model.

        By default `keep_alive` is 0, so Ollama unloads the model from VRAM right
        after the call. This prevents memory exhaustion when sequentially testing
        multiple large models. Pass a duration such as "10m" to keep the model
        loaded between calls and unload it explicitly with `unload()`.

        Args:
            model (str): The name of the model to use.
            prompt (str): The user input prompt.
            system_prompt (str, optional): Instructions for the model's behavior.
            format (str | dict, optional): "json" or a JSON schema for structured
                output. Defaults to free text.
            think (bool, optional): Enables or disables the model's thinking mode.
                None leaves the model default.
            options (dict, optional): Ollama model options, for example
                temperature, seed, num_ctx, num_predict.
            keep_alive (int | str, optional): How long the model stays loaded after
                the call. Defaults to 0 (unload immediately).
            timeout (int, optional): Seconds to wait for the full response.

        Returns:
            dict: A dictionary containing success status, response text, stop
                reason, prompt token count and performance metrics.
        """
        url, payload = self.build_request(
            model, prompt, system_prompt, format, think, options, keep_alive
        )

        try:
            response = requests.post(url, json=payload, timeout=timeout)
            response.raise_for_status()
            data = response.json()

            return _result(data, data.get("response", ""))
        except Exception as e:
            return {"success": False, "error": str(e)}

    def generate_stream(
        self,
        model: str,
        prompt: str,
        system_prompt: str = "",
        format: str | dict | None = None,
        think: bool | None = None,
        options: dict | None = None,
        keep_alive: int | str = 0,
        timeout: int = GENERATE_TIMEOUT_SEC,
        on_token: Callable[[str], None] | None = None,
        cancel: threading.Event | None = None,
    ) -> dict:
        """Generates a text response and reports it piece by piece.

        Ollama sends one JSON line per piece. `cancel` is checked before every
        line: when it is set the connection is closed, which stops the model.
        While the model is still loading nothing arrives, so a stop takes
        effect with the first piece.

        Args:
            on_token (Callable, optional): Called with each piece of text.
            cancel (threading.Event, optional): Stops the call when set.
            timeout (int, optional): Seconds for the whole answer.

        Returns:
            dict: The result of `generate`, or `cancelled_result()`.
        """
        url, payload = self.build_request(
            model,
            prompt,
            system_prompt,
            format,
            think,
            options,
            keep_alive,
            stream=True,
        )
        parts: list[str] = []
        final = None
        deadline = time.monotonic() + timeout

        try:
            with requests.post(
                url, json=payload, timeout=timeout, stream=True
            ) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if cancel is not None and cancel.is_set():
                        return cancelled_result()
                    if time.monotonic() > deadline:
                        raise TimeoutError(f"No complete answer within {timeout} s.")
                    if not line:
                        continue
                    chunk = json.loads(line)
                    if chunk.get("error"):
                        raise RuntimeError(chunk["error"])
                    text = chunk.get("response", "")
                    if text:
                        parts.append(text)
                        if on_token is not None:
                            on_token(text)
                    if chunk.get("done"):
                        final = chunk
                        break
        except Exception as e:
            return {"success": False, "error": str(e)}

        if final is None:
            return {
                "success": False,
                "error": "The stream ended before the model finished.",
            }
        return _result(final, "".join(parts))

    def build_request(
        self,
        model: str,
        prompt: str,
        system_prompt: str = "",
        format: str | dict | None = None,
        think: bool | None = None,
        options: dict | None = None,
        keep_alive: int | str = 0,
        stream: bool = False,
    ) -> tuple[str, dict]:
        """Builds the request `generate` sends: the URL and the JSON body."""
        payload = {
            "model": model,
            "prompt": prompt,
            "system": system_prompt,
            "stream": stream,
            "keep_alive": keep_alive,
        }
        if format is not None:
            payload["format"] = format
        if think is not None:
            payload["think"] = think
        if options:
            payload["options"] = options
        return f"{self.base_url}/api/generate", payload

    def unload(self, model: str) -> bool:
        """Unloads a model from VRAM right away.

        Args:
            model (str): The name of the model to unload.

        Returns:
            bool: True if Ollama accepted the request, False otherwise.
        """
        try:
            response = requests.post(
                f"{self.base_url}/api/generate",
                json={"model": model, "keep_alive": 0},
                timeout=UNLOAD_TIMEOUT_SEC,
            )
            response.raise_for_status()
            return True
        except requests.RequestException as e:
            print(f"Error unloading {model}: {e}")
            return False

    def get_version(self) -> str | None:
        """Reads the version of the Ollama server.

        Returns:
            str | None: The version, or None if Ollama does not answer.
        """
        try:
            response = requests.get(f"{self.base_url}/api/version", timeout=5)
            response.raise_for_status()
            version = response.json().get("version")
        except requests.RequestException as e:
            print(f"Error reading the Ollama version: {e}")
            return None
        return version if isinstance(version, str) else None
