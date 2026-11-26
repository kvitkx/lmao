"""Where the judge of a run lives.

One class per judge provider replaces the `if kind == ...` branches that sat in
four endpoints (start, resume, budget and preview). A new provider is a new
class and an entry in JUDGE_KINDS; the endpoints do not change.
"""

from abc import ABC, abstractmethod
from typing import NamedTuple

from flask import Blueprint, jsonify

from core.budget import cost_of
from core.openai_client import OpenAIClient
from core.provider import JUDGE_OLLAMA, JUDGE_OLLAMA_CLOUD, JUDGE_OPENAI, Provider

from .errors import ApiError
from .services import Services, get_services

bp = Blueprint("providers", __name__)

NO_CONNECTION = "The OpenAI judge needs a saved connection."


def openai_client(connection: dict) -> OpenAIClient:
    """The client of a saved connection (the result of ConnectionStore.load)."""
    return OpenAIClient(connection["base_url"], connection["api_key"])


def _saved_connection(svc: Services) -> dict:
    connection = svc.connection_store.load()
    if connection is None:
        raise ApiError(NO_CONNECTION, 400)
    return connection


class PreviewTarget(NamedTuple):
    """What the request preview needs from a judge provider.

    Attributes:
        provider: Builds the request.
        headers: Added to Content-Type; the key is never in them.
        curl_auth: The authorization part of the curl line, or "".
    """

    provider: Provider
    headers: dict
    curl_auth: str


class JudgeKind(ABC):
    """One place a judge can live.

    Attributes:
        name (str): The value of `judge_provider` in a request.
        leaves_machine (bool): Prompts and answers are sent elsewhere.
    """

    name: str
    leaves_machine: bool

    @abstractmethod
    def provider(self, svc: Services) -> Provider | None:
        """The provider that serves the judge; None: the local Ollama."""

    def required_models(self, judge: str, candidates: list) -> list[str]:
        """The models that must be installed in the local Ollama."""
        return [judge, *candidates]

    def cost(self, svc: Services, tokens: dict) -> dict | None:
        """The cost range of the estimated tokens, or None if there is no price."""
        return None

    def preview(self, svc: Services) -> PreviewTarget:
        return PreviewTarget(svc.ollama, {}, "")


class OllamaJudge(JudgeKind):
    name = JUDGE_OLLAMA
    leaves_machine = False

    def provider(self, svc: Services) -> Provider | None:
        return None


class OllamaCloudJudge(OllamaJudge):
    """The same client as a local judge; the model runs in Ollama's cloud."""

    name = JUDGE_OLLAMA_CLOUD
    leaves_machine = True


class OpenAIJudge(JudgeKind):
    name = JUDGE_OPENAI
    leaves_machine = True

    def provider(self, svc: Services) -> Provider:
        return openai_client(_saved_connection(svc))

    def required_models(self, judge: str, candidates: list) -> list[str]:
        # The judge lives at the API: only the candidates must be installed.
        return list(candidates)

    def cost(self, svc: Services, tokens: dict) -> dict | None:
        connection = svc.connection_store.load()
        if connection is None:
            return None
        return cost_of(tokens, connection["price_in"], connection["price_out"])

    def preview(self, svc: Services) -> PreviewTarget:
        return PreviewTarget(
            self.provider(svc),
            {"Authorization": "Bearer ***"},
            ' \\\n  -H "Authorization: Bearer $API_KEY"',
        )


JUDGE_KINDS = {
    kind.name: kind for kind in (OllamaJudge(), OllamaCloudJudge(), OpenAIJudge())
}


def judge_kind(name: str) -> JudgeKind:
    """The kind of a `judge_provider` value.

    Raises:
        ApiError: If there is no such provider.
    """
    try:
        return JUDGE_KINDS[name]
    except KeyError:
        raise ApiError(f"Unknown judge provider: {name}.") from None


def resolve_judge(
    svc: Services, kind_name: str, judge: str, candidates: list
) -> Provider | None:
    """Finds the provider of the judge and checks the local models.

    Returns:
        Provider | None: The provider of the judge, or None for the local Ollama.

    Raises:
        ApiError: 400 if the provider needs a connection that is not saved, or a
            model that must be local is not installed.
    """
    kind = judge_kind(kind_name)
    provider = kind.provider(svc)

    installed = svc.ollama.get_models()
    required = dict.fromkeys(kind.required_models(judge, candidates))
    missing = [model for model in required if model not in installed]
    if missing:
        raise ApiError(f"Models are not installed: {', '.join(missing)}.")
    return provider


@bp.get("/api/models")
def get_models():
    """Retrieves a list of available models from the local Ollama instance.

    Returns:
        Response: A JSON response containing the list of model names.
    """
    return jsonify({"models": get_services().ollama.get_models()}), 200
