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
"""
import os
from functools import wraps

from flask import g, jsonify, request

import firebase_config

AUTH_REQUIRED_ENV = "MEDITRACK_AUTH_REQUIRED"
LOCAL_OWNER = os.environ.get("MEDITRACK_LOCAL_OWNER", "local-dev")


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
            return view(*args, **kwargs)

        token = _bearer_token()
        if not token:
            return jsonify({"error": "Authentication required"}), 401

        try:
            decoded = firebase_config.verify_id_token(token)
        except Exception:  # noqa: BLE001 - invalid/expired/unverifiable token
            return jsonify({"error": "Invalid or expired authentication token"}), 401

        uid = decoded.get("uid") or decoded.get("user_id") if isinstance(decoded, dict) else None
        if not uid:
            return jsonify({"error": "Invalid authentication token"}), 401

        g.owner = uid
        g.uid = uid
        # Verified email claim from the token — never trust a frontend-supplied
        # email, exactly like owner_user_id.
        g.email = decoded.get("email") if isinstance(decoded, dict) else None
        return view(*args, **kwargs)

    return wrapper
