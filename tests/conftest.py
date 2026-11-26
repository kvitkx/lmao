"""
Global pytest fixtures for the Local Model Assessment Operator.
"""

import pytest

from api import create_app


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    """Runs every test in an empty working directory.

    The app and the pipeline read and write the relative ``data/`` folder.
    """
    monkeypatch.chdir(tmp_path)


@pytest.fixture
def app():
    """Yields a fresh Flask application, with its own services, for testing."""
    app = create_app()
    # Set Flask to testing mode to disable error catching during request handling
    # so that you get better error reports when performing test requests.
    app.config.update(
        {
            "TESTING": True,
        }
    )
    yield app


@pytest.fixture
def services(app):
    """The objects the app shares: registry, run store, clients, connection."""
    return app.extensions["lmao"]


@pytest.fixture
def registry(services):
    """The live state of the runs of the app."""
    return services.registry


@pytest.fixture
def client(app):
    """A test client for the app."""
    return app.test_client()


@pytest.fixture
def runner(app):
    """A test runner for the app's Click commands."""
    return app.test_cli_runner()
