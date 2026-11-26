"""Entry point of the Local Model Assessment Operator.

The application is built by `api.create_app`; this module only exposes it for
`gunicorn app:app` and `flask --app app run`.
"""

import os

from api import create_app

app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("FLASK_PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "False").lower() in ("true", "1", "yes")
    app.run(host="0.0.0.0", port=port, debug=debug)
