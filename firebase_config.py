"""
MediTrack - Firebase Admin SDK bootstrap.

Initialises the Firebase Admin SDK exactly once and exposes a small, safe API
to the rest of the application:

    init_firebase()        -> bool   initialise (idempotent, thread-safe)
    is_ready()             -> bool   True when Firestore + Auth are usable
    get_db()               -> Firestore client or None
    get_status()           -> dict   non-sensitive status summary
    verify_id_token(tok)   -> dict   decoded token (raises on invalid token)

Credentials are NEVER hard-coded. Two supported sources, checked in order:

  1. FIREBASE_SERVICE_ACCOUNT_JSON
     The service-account JSON itself. Used on Render (paste the JSON into an
     environment variable).
  2. GOOGLE_APPLICATION_CREDENTIALS
     Path to a protected local service-account file (local development). The
     file must be git-ignored.

If neither is present (or the SDK is missing) the application simply runs in
local JSON mode - nothing crashes.
"""
import json
import os
import re
import threading

DEFAULT_PROJECT_ID = "meditrack-3a681"

_lock = threading.Lock()
_app = None
_state = {
    "attempted": False,
    "ready": False,
    "db": None,
    "auth": None,
    "project_id": None,
    "source": None,
    "error": None,
}


def parse_service_account_json(raw):
    """Parse a service-account JSON blob from an environment variable.

    Render (and similar hosts) often mangle the private key: the value is
    wrapped in extra quotes, or the ``\\n`` escapes inside ``private_key``
    are turned into real newlines, which makes ``json.loads`` fail. This
    repairs those cases without logging any key material.
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
    candidates = [text]
    # Double-encoded JSON (a JSON string whose contents are JSON).
    if text.startswith('"') and text.endswith('"'):
        try:
            inner = json.loads(text)
        except json.JSONDecodeError:
            inner = None
        if isinstance(inner, str):
            candidates.append(inner)
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            return parsed
        repaired = re.sub(
            r'("private_key"\s*:\s*")(.+?)("\s*,)',
            lambda match: (
                match.group(1)
                + match.group(2).replace("\r\n", "\\n").replace("\n", "\\n").replace("\r", "\\n")
                + match.group(3)
            ),
            candidate,
            count=1,
            flags=re.DOTALL,
        )
        try:
            parsed = json.loads(repaired)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _resolve_credential():
    """Return (credential, project_id, source) or (None, None, reason)."""
    try:
        from firebase_admin import credentials as fb_credentials
    except ImportError:
        return None, None, "firebase-admin is not installed"

    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if raw and raw.strip():
        info = parse_service_account_json(raw)
        if not isinstance(info, dict):
            return None, None, "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON"
        try:
            cred = fb_credentials.Certificate(info)
        except Exception:  # noqa: BLE001 - malformed service account
            return None, None, "FIREBASE_SERVICE_ACCOUNT_JSON is not a valid service account"
        project_id = (
            info.get("project_id")
            or os.environ.get("FIREBASE_PROJECT_ID")
            or DEFAULT_PROJECT_ID
        )
        return cred, project_id, "env:FIREBASE_SERVICE_ACCOUNT_JSON"

    path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if path and path.strip():
        if not os.path.exists(path):
            return None, None, "GOOGLE_APPLICATION_CREDENTIALS file not found"
        try:
            cred = fb_credentials.Certificate(path)
        except Exception:  # noqa: BLE001 - unreadable service account file
            return None, None, "GOOGLE_APPLICATION_CREDENTIALS is not a valid service account"
        project_id = (
            getattr(cred, "project_id", None)
            or os.environ.get("FIREBASE_PROJECT_ID")
            or DEFAULT_PROJECT_ID
        )
        return cred, project_id, "env:GOOGLE_APPLICATION_CREDENTIALS"

    return None, None, "no Firebase service account configured"


def init_firebase(force=False):
    """Initialise Firebase Admin once. Never raises; returns True on success."""
    global _app
    with _lock:
        if _state["attempted"] and not force:
            return _state["ready"]
        _state["attempted"] = True

        credential, project_id, source = _resolve_credential()
        if credential is None:
            _state.update(ready=False, db=None, auth=None, source=None, error=source)
            return False

        try:
            import firebase_admin
            from firebase_admin import firestore, auth

            # Initialise the default app exactly once.
            if _app is None:
                _app = firebase_admin.initialize_app(credential, {"projectId": project_id})

            _state["db"] = firestore.client()
            _state["auth"] = auth
            _state.update(ready=True, project_id=project_id, source=source, error=None)
            return True
        except Exception as exc:  # noqa: BLE001 - surfaced safely, never re-raised
            _state.update(
                ready=False, db=None, auth=None, source=source, error=str(exc)
            )
            return False


def is_ready():
    return bool(_state["ready"])


def get_db():
    return _state["db"]


def get_project_id():
    return _state["project_id"]


def get_status():
    """Non-sensitive status (never includes key material)."""
    return {
        "ready": _state["ready"],
        "project_id": _state["project_id"],
        "source": _state["source"],
        "error": _state["error"],
    }


# Firebase rejects tokens when the server clock and Google's clock disagree by
# even a second ("token used too early" / false revocation). 60 seconds is the
# maximum the Admin SDK allows and matches Google's own recommendation.
CLOCK_SKEW_SECONDS = 60


def verify_id_token(token, check_revoked=True):
    """Verify a Firebase ID token. Raises when Auth is unavailable/invalid."""
    auth = _state["auth"]
    if not _state["ready"] or auth is None:
        raise RuntimeError("Firebase Auth is not available")
    kwargs = {"check_revoked": check_revoked}
    try:
        import inspect
        if "clock_skew_seconds" in inspect.signature(auth.verify_id_token).parameters:
            kwargs["clock_skew_seconds"] = CLOCK_SKEW_SECONDS
    except (TypeError, ValueError):
        pass
    return auth.verify_id_token(token, **kwargs)
