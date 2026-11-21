"""
MediTrack - Firebase connection + Firestore read/write smoke test.

Safe by design: it only touches a temporary document in the ``connection_tests``
collection and never reads or writes medicines, reminders or any user data.

Steps (each result is printed separately):
  1. Initialise the Firebase Admin SDK
  2. Connect to Cloud Firestore
  3. Create a temporary test document in ``connection_tests``
  4. Write the test fields (test / status / server timestamp)
  5. Read the document back
  6. Verify all fields match
  7. Delete the temporary test document
  8. Confirm deletion succeeded

Run:
    python verify_firebase.py

Credentials (never printed, never hard-coded):
    FIREBASE_SERVICE_ACCOUNT_JSON   service account JSON (Render)
    GOOGLE_APPLICATION_CREDENTIALS  path to a local service account file
"""
import sys

import firebase_config

COLLECTION = "connection_tests"
DOC_ID = "meditrack-connection-test"
EXPECTED_TEST = "MediTrack Firebase connection"
EXPECTED_STATUS = "success"


def _report(step, ok, detail=""):
    flag = "PASS" if ok else "FAIL"
    line = "%s. RESULT: %s" % (step, flag)
    if detail:
        line += " - %s" % detail
    print(line)


def _blocked(steps, reason):
    for step in steps:
        _report(step, False, "NOT RUN - %s" % reason)


def main():
    print("MediTrack - Firestore connection test")
    print("Collection: %s   Document: %s\n" % (COLLECTION, DOC_ID))

    # ---- 1. Initialise the Admin SDK -------------------------------------
    firebase_config.init_firebase()
    status = firebase_config.get_status()
    if not status["ready"]:
        reason = status["error"] or "unknown"
        _report(1, False, reason)
        _blocked([2, 3, 4, 5, 6, 7, 8], "Admin SDK not initialised")
        print("\nOVERALL: FAIL - Firebase Admin SDK could not be initialised.")
        return 1
    _report(1, True, "project %s (source: %s)" % (status["project_id"], status["source"]))

    db = firebase_config.get_db()
    ref = db.collection(COLLECTION).document(DOC_ID)

    # ---- 2. Connect to Firestore ----------------------------------------
    try:
        ref.get()  # first real round-trip proves connectivity
        _report(2, True, "Firestore reachable")
    except Exception as exc:  # noqa: BLE001
        _report(2, False, type(exc).__name__)
        _blocked([3, 4, 5, 6, 7, 8], "no Firestore connection")
        print("\nOVERALL: FAIL - could not reach Cloud Firestore.")
        return 1

    # ---- 3 + 4. Create the document and write the fields ----------------
    written = False
    try:
        from firebase_admin import firestore  # SERVER_TIMESTAMP sentinel
    except ImportError as exc:  # noqa: BLE001
        _report(3, False, "firebase-admin firestore module unavailable: %s" % exc)
        _blocked([4, 5, 6, 7, 8], "server timestamp helper unavailable")
        print("\nOVERALL: FAIL")
        return 1

    try:
        ref.set({
            "test": EXPECTED_TEST,
            "status": EXPECTED_STATUS,
            "timestamp": firestore.SERVER_TIMESTAMP,  # resolved by the server
        })
        written = True
    except Exception as exc:  # noqa: BLE001
        _report(3, False, type(exc).__name__)

    if written:
        _report(3, True, "document created in '%s'" % COLLECTION)
        _report(4, True, "fields written: test, status, timestamp (server time)")
    else:
        _blocked([4, 5, 6, 7, 8], "write failed")
        print("\nOVERALL: FAIL - could not write the test document.")
        return 1

    # ---- 5. Read it back -------------------------------------------------
    data = None
    try:
        snapshot = ref.get()
        if not snapshot.exists:
            _report(5, False, "document not found after write")
        else:
            data = snapshot.to_dict() or {}
            _report(5, True, "document read back")
    except Exception as exc:  # noqa: BLE001
        _report(5, False, type(exc).__name__)

    if data is None:
        _blocked([6, 7, 8], "read failed")
        print("\nOVERALL: FAIL - could not read the test document back.")
        return 1

    # ---- 6. Verify the fields -------------------------------------------
    checks = {
        "test": data.get("test") == EXPECTED_TEST,
        "status": data.get("status") == EXPECTED_STATUS,
        "timestamp": data.get("timestamp") is not None,
    }
    all_match = all(checks.values())
    _report(6, all_match,
            "test=%s status=%s timestamp=%s" % (checks["test"], checks["status"], checks["timestamp"]))

    # ---- 7. Delete the document -----------------------------------------
    deleted = False
    try:
        ref.delete()
        deleted = True
        _report(7, True, "delete request sent")
    except Exception as exc:  # noqa: BLE001
        _report(7, False, type(exc).__name__)

    # ---- 8. Confirm deletion --------------------------------------------
    if deleted:
        try:
            _report(8, not ref.get().exists, "document no longer exists")
        except Exception as exc:  # noqa: BLE001
            _report(8, False, type(exc).__name__)
    else:
        _blocked([8], "delete failed")

    overall = all_match and deleted
    print("\nOVERALL: %s" % ("PASS - Firestore write/read/verify/delete succeeded" if overall
                             else "FAIL"))
    return 0 if overall else 1


if __name__ == "__main__":
    sys.exit(main())
