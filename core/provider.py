"""Provider interface for the models lmao talks to.

A provider lists models and generates text: a local Ollama, Ollama cloud or an
OpenAI-compatible API. The evaluation pipeline depends only on this interface.
What exists only for local runtimes (unloading, size on disk, memory) has a
safe default, so a remote provider implements just the two abstract methods.
"""

from abc import ABC, abstractmethod

GENERATE_TIMEOUT_SEC = 600


class Provider(ABC):
    """Base class of every model provider."""

    @abstractmethod
    def get_models(self) -> list:
        """Lists the models the provider can serve.

        Returns:
            list: Model name strings. Empty if the provider is unreachable.
        """

    @abstractmethod
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

        A failed call is reported in the result, never raised.

        Args:
            model (str): The name of the model to use.
            prompt (str): The user input prompt.
            system_prompt (str, optional): Instructions for the model's behavior.
            format (str | dict, optional): "json" or a JSON schema for structured
                output. Defaults to free text.
            think (bool, optional): Enables or disables the model's thinking mode.
                None leaves the model default.
            options (dict, optional): Model options, for example temperature,
                seed, num_ctx, num_predict.
            keep_alive (int | str, optional): How long a local model stays loaded
                after the call. Providers without loading ignore it.
            timeout (int, optional): Seconds to wait for the full response.

        Returns:
            dict: On success: success (True), response_text, done_reason ("length"
                when the token limit was hit), prompt_eval_count and metrics
                (total_time_sec, load_time_sec, eval_time_sec, tokens_generated,
                tokens_per_second). On failure: success (False) and error (str).
        """

    def unload(self, model: str) -> bool:
        """Frees the memory of a model. The default has nothing to free.

        Args:
            model (str): The name of the model to unload.

        Returns:
            bool: True if the model is not loaded any more.
        """
        return True

    def get_model_sizes(self) -> dict:
        """Returns the size on disk of every model, in bytes, by name.

        The default knows no sizes.
        """
        return {}

    def get_loaded(self, model: str) -> dict | None:
        """Reads the memory a loaded model takes.

        Returns:
            dict | None: size and size_vram in bytes, or None when the provider
                cannot tell (the default).
        """
        return None
