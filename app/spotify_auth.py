# Spotify OAuth + token refresh blueprint.
#
# Flow:
#   1. GET  /auth/spotify/login    → redirect to Spotify authorize URL
#   2. GET  /auth/spotify/callback → exchange code for tokens, store in session,
#                                    redirect to / with ?spotify=connected
#   3. GET  /auth/spotify/token    → frontend fetches current access token;
#                                    auto-refreshes if <60s from expiry
#   4. GET  /auth/spotify/status   → cheap auth check for UI state
#   5. POST /auth/spotify/logout   → clear session tokens
#
# Tokens live in Flask's signed-cookie session — fine for a personal app.
# Don't put real client secrets in a public deploy: Railway env vars only.

import secrets
import time
import urllib.parse

import requests
from flask import Blueprint, current_app, jsonify, redirect, request, session

spotify_bp = Blueprint("spotify", __name__, url_prefix="/auth/spotify")

SPOTIFY_AUTH_URL  = "https://accounts.spotify.com/authorize"
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"

# Listening-along flow: we don't play audio in the browser. We just watch what's
# playing on the user's account (any device) and fetch the per-track audio
# analysis to drive the visualizer. Single scope is enough.
#
#   user-read-playback-state  — read currently playing track + position +
#                               play/pause state on whichever device the user
#                               is actually listening on
#
# Notably absent: `streaming` (Premium-only, was for the Web Playback SDK).
# This flow now works for free Spotify accounts.
SCOPES = "user-read-playback-state"


def _client_creds():
    return (
        current_app.config.get("SPOTIFY_CLIENT_ID", ""),
        current_app.config.get("SPOTIFY_CLIENT_SECRET", ""),
    )


def _redirect_uri():
    return current_app.config.get("SPOTIFY_REDIRECT_URI", "")


@spotify_bp.route("/login")
def login():
    client_id, _ = _client_creds()
    if not client_id:
        return "SPOTIFY_CLIENT_ID not configured on the server.", 500
    state = secrets.token_urlsafe(16)
    session["spotify_oauth_state"] = state
    params = {
        "response_type": "code",
        "client_id":     client_id,
        "scope":         SCOPES,
        "redirect_uri":  _redirect_uri(),
        "state":         state,
    }
    return redirect(f"{SPOTIFY_AUTH_URL}?{urllib.parse.urlencode(params)}")


@spotify_bp.route("/callback")
def callback():
    code  = request.args.get("code")
    state = request.args.get("state")
    error = request.args.get("error")

    if error:
        return redirect(f"/?spotify_error={urllib.parse.quote(error)}")

    expected_state = session.pop("spotify_oauth_state", None)
    if not state or state != expected_state:
        return "Spotify OAuth state mismatch.", 400
    if not code:
        return "Spotify callback missing code.", 400

    client_id, client_secret = _client_creds()
    r = requests.post(
        SPOTIFY_TOKEN_URL,
        data={
            "grant_type":   "authorization_code",
            "code":         code,
            "redirect_uri": _redirect_uri(),
        },
        auth=(client_id, client_secret),
        timeout=10,
    )
    if not r.ok:
        return f"Token exchange failed: {r.text}", 500

    tokens = r.json()
    session["spotify_access_token"]     = tokens["access_token"]
    session["spotify_refresh_token"]    = tokens.get("refresh_token", "")
    session["spotify_token_expires_at"] = time.time() + tokens["expires_in"]
    session.permanent = True
    return redirect("/?spotify=connected")


def _refresh_if_needed() -> bool:
    """Refresh the access token if it's within 60s of expiring. Returns True
    if a usable token now sits in the session, False if the user must re-auth."""
    if "spotify_access_token" not in session:
        return False
    if time.time() < session.get("spotify_token_expires_at", 0) - 60:
        return True

    refresh = session.get("spotify_refresh_token")
    if not refresh:
        return False
    client_id, client_secret = _client_creds()
    r = requests.post(
        SPOTIFY_TOKEN_URL,
        data={"grant_type": "refresh_token", "refresh_token": refresh},
        auth=(client_id, client_secret),
        timeout=10,
    )
    if not r.ok:
        return False
    tokens = r.json()
    session["spotify_access_token"]     = tokens["access_token"]
    session["spotify_token_expires_at"] = time.time() + tokens["expires_in"]
    # Spotify sometimes rotates the refresh token; only update if returned.
    if "refresh_token" in tokens:
        session["spotify_refresh_token"] = tokens["refresh_token"]
    return True


@spotify_bp.route("/token")
def token():
    """Frontend pulls the access token from here. Refreshes transparently."""
    if not _refresh_if_needed():
        return jsonify({"error": "not_authenticated"}), 401
    return jsonify({
        "access_token": session["spotify_access_token"],
        "expires_at":   session["spotify_token_expires_at"],
    })


@spotify_bp.route("/status")
def status():
    """Cheap auth + server-config check. Frontend uses this to decide whether
    the spotify source button should show 'connect' or activate immediately."""
    client_id, _ = _client_creds()
    return jsonify({
        "authenticated": "spotify_access_token" in session,
        "configured":    bool(client_id),
    })


@spotify_bp.route("/logout", methods=["POST"])
def logout():
    for k in ("spotify_access_token", "spotify_refresh_token", "spotify_token_expires_at"):
        session.pop(k, None)
    return jsonify({"ok": True})
