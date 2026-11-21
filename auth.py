"""
MediTrack - server-side authorization.

The Firebase Admin SDK bypasses Firestore security rules, so authorization is
enforced here in Flask:

* ``require_auth`` verifies the Firebase Authentication ID token sent as
  ``Authorization: Bearer <idToken>`` and stores the VERIFIED uid on ``g``.
  The uid supplied by the frontend (``owner_user_id``) is never trusted.
* Every storage call is scoped by ``g.owner`` so one account cannot read or
  modify another account's medical records.

Enforcement mode (``MEDITRACK_AUTH_REQUIRED``):
    - unset  -> enforced automatically whenever Firebase is configured, so
                local JSON-only development keeps working with no auth.
    - "1"    -> always enforced (recommended in production).
    - "0"    -> never enforced (only for the JSON fallback / frontend
                transition). Requests are then attributed to
                ``MEDITRACK_LOCAL_OWNER``.

Response codes:
    - 401 -> the client must authenticate: no token, or a token that is
             genuinely invalid / expired / revoked / for another project.
    - 403 -> authenticated but not the owner of the requested record.
    - 503 -> the SERVER cannot verify tokens (Auth not configured, missing
             credentials, transient Google/network failure). Never 401, so the
             frontend does not sign a valid user out over a server-side fault.
"""
import logging
import os
from functools import wraps

from flask import current_app, g, jsonify, request

import firebase_config

AUTH_REQUIRED_ENV = "MEDITRACK_AUTH_REQUIRED"
LOCAL_OWNER = os.environ.get("MEDITRACK_LOCAL_OWNER", "local-dev")

logger = logging.getLogger("meditrack.auth")

# Firebase Admin raises typed errors for verification failures. Match on the
# class NAME so this module never depends on private SDK import paths.
#   * client token problems (expired / revoked / invalid / disabled) -> 401
#   * server-side problems (misconfiguration, missing credentials, transient
#     Google/network failures) -> 503
# Conflating the second group with 401 is what produced the false
# "Your session has expired" bug: a valid user was logged out because the
# SERVER could not verify the token.
_CLIENT_TOKEN_ERRORS = {
    "ExpiredIdTokenError": "Authentication token has expired",
    "RevokedIdTokenError": "Authentication token has been revoked",
    "InvalidIdTokenError": "Invalid authentication token",
    "UserDisabledError": "This account has been disabled",
}
_SERVER_VERIFY_ERRORS = {
    "CertificateFetchError",
    "InsufficientPermissionError",
}


def _log():
    """Prefer the Flask app logger (writes to Render logs); fall back safely."""
    try:
        return current_app.logger
    except RuntimeError:
        return logger


def _classify_verification_error(exc):
    """Map a token-verification exception to (http_status, public_message)."""
    name = type(exc).__name__
    if name in _CLIENT_TOKEN_ERRORS:
        return 401, _CLIENT_TOKEN_ERRORS[name]
    if name in _SERVER_VERIFY_ERRORS:
        return 503, "Authentication service temporarily unavailable"
    if isinstance(exc, ValueError):
        # e.g. 'incorrect "aud" claim' -> the token was not issued for the
        # project this server is configured for (usually a config mismatch).
        return 401, "Invalid authentication token"
    if isinstance(exc, RuntimeError):
        # firebase_config raises RuntimeError when Auth is not initialised.
        return 503, "Authentication service unavailable"
    return 503, "Authentication service temporarily unavailable"


def auth_is_enforced():
    raw = os.environ.get(AUTH_REQUIRED_ENV)
    if raw is not None and raw.strip() != "":
        return raw.strip() not in ("0", "false", "False", "no")
    return firebase_config.is_ready()


def _bearer_token():
    header = request.headers.get("Authorization", "")
    if header[:7].lower() == "bearer ":
        return header[7:].strip()
    return None


def require_auth(view):
    """Decorator: authenticate the request and set ``g.owner``."""

    @wraps(view)
    def wrapper(*args, **kwargs):
        if not auth_is_enforced():
            g.owner = LOCAL_OWNER
            g.uid = None
            g.email = None
            return view(*args, **kwargs)

        # Enforced, but the Admin SDK is not usable: this is a SERVER problem.
        # Returning 401 here would make the frontend sign the user out for a
        # fault that is not theirs, so we answer 503 instead.
        if not firebase_config.is_ready():
            status = firebase_config.get_status()
            _log().error(
                "AUTH CONFIG ERROR: auth is enforced but Firebase Admin is not ready "
                "(source=%s project=%s error=%s). Protected requests will fail with 503 "
                "until FIREBASE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS "
                "are configured correctly.",
                status.get("source"), status.get("project_id"), status.get("error"),
            )
            return jsonify({"error": "Authentication service is not configured on the server"}), 503

        token = _bearer_token()
        if not token:
            return jsonify({"error": "Authentication required"}), 401

        try:
            decoded = firebase_config.verify_id_token(token)
        except Exception as exc:  # noqa: BLE001 - classified just below
            code, message = _classify_verification_error(exc)
            # Log the failure class/reason only - never the token or credentials.
            _log().warning(
                "ID token verification failed: %s (%s) path=%s -> %s: %s",
                type(exc).__name__, message, request.path, code, str(exc)[:300],
            )
            return jsonify({"error": message}), code

        if not isinstance(decoded, dict):
            return jsonify({"error": "Invalid authentication token"}), 401
        uid = decoded.get("uid") or decoded.get("user_id")
        if not uid:
            return jsonify({"error": "Invalid authentication token"}), 401

        g.owner = uid
        g.uid = uid
        # Verified email claim from the token - never trust a frontend-supplied
        # email, exactly like owner_user_id.
        g.email = decoded.get("email")
        return view(*args, **kwargs)

    return wrapper
