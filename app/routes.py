from flask import Blueprint, current_app, jsonify, render_template

bp = Blueprint("main", __name__)


@bp.route("/")
def index():
    return render_template("index.html", version=current_app.config["APP_VERSION"])


@bp.route("/health")
def health():
    return jsonify(status="ok", version=current_app.config["APP_VERSION"])
