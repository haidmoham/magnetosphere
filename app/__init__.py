import os
from flask import Flask
from flask_compress import Compress

from .routes import bp


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY", "dev-secret-change-me")
    app.config["APP_VERSION"] = os.environ.get("APP_VERSION", "0.1.0")

    Compress(app)
    app.register_blueprint(bp)
    return app
