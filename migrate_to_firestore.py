"""
MediTrack - one-way, non-destructive JSON -> Firestore migration.

Safety guarantees
-----------------
* NEVER deletes or modifies the source JSON files (they stay as backups).
* NEVER invents a user identity. Ownership is only assigned from an explicit
  value (``--owner`` or ``MIGRATION_OWNER_UID``). Without one the script runs
  in report-only mode and writes nothing.
* NEVER overwrites an existing Firestore document unless ``--overwrite`` is
  passed explicitly.
* Duplicate migration is impossible by construction: every document uses the
  record's existing (or migration-stable) id as its Firestore document id, so a
  second run simply finds the document and skips it.
* Verifies migrated counts at the end.

Usage
-----
    # Inspect what would happen (no credentials required):
    python migrate_to_firestore.py

    # Real migration, attributing legacy records to your Firebase uid:
    python migrate_to_firestore.py --owner <FIREBASE_UID> --yes

Environment
-----------
    FIREBASE_SERVICE_ACCOUNT_JSON  service account JSON (Render)
    GOOGLE_APPLICATION_CREDENTIALS path to local service account file
    MIGRATION_OWNER_UID            alternative to --owner
    MEDITRACK_DATA_DIR             JSON folder (default: "data")
"""
import argparse
import json
import os
import sys
import uuid
from datetime import datetime

import firebase_config
from models import DEFAULT_MEMBER_ID, log_document_id


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def load_json_list(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def build_medicine(record, owner):
    return {
        "id": record["id"],
        "owner_user_id": owner,
        "member_id": record.get("member_id") or DEFAULT_MEMBER_ID,
        "name": record.get("name", ""),
        "dosage": record.get("dosage", ""),
        "frequency": record.get("frequency", ""),
        "start_date": record.get("start_date", ""),
        "expiry_date": record.get("expiry_date", ""),
        "notes": record.get("notes", ""),
        "created_at": record.get("created_at") or now_iso(),
        "_migrated_from": "medicines.json",
        "_migrated_at": now_iso(),
    }


def build_reminder(record, owner):
    return {
        "id": record["id"],
        "owner_user_id": owner,
        "member_id": record.get("member_id") or DEFAULT_MEMBER_ID,
        "medicine_id": record.get("medicine_id", ""),
        "medicine_name": record.get("medicine_name", ""),
        "dosage": record.get("dosage", ""),
        "frequency": record.get("frequency", ""),
        "times": record.get("times", []),
        "start_date": record.get("start_date", ""),
        "end_date": record.get("end_date", ""),
        "status": record.get("status", "active"),
        "created_at": record.get("created_at") or now_iso(),
        "_migrated_from": "reminders.json",
        "_migrated_at": now_iso(),
    }


def build_log(record, owner):
    reminder_id = record.get("reminder_id", "")
    date = record.get("date", "")
    time = record.get("time", "")
    return log_document_id(reminder_id, date, time), {
        "id": record.get("id") or str(uuid.uuid4()),
        "owner_user_id": owner,
        "member_id": record.get("member_id") or DEFAULT_MEMBER_ID,
        "reminder_id": reminder_id,
        "medicine_id": record.get("medicine_id", ""),
        "medicine_name": record.get("medicine_name", ""),
        "dosage": record.get("dosage", ""),
        "date": date,
        "time": time,
        "status": record.get("status", ""),
        "recorded_at": record.get("recorded_at") or now_iso(),
        "_migrated_from": "reminder_logs.json",
        "_migrated_at": now_iso(),
    }


def plan(records, builder):
    """Return a list of (collection_ignored, doc_id, payload) placeholders."""
    items = []
    for record in records:
        if not isinstance(record, dict):
            continue
        if not record.get("id") and "reminder_id" not in record:
            continue
        built = builder(record)
        if isinstance(built, tuple):
            items.append(built)
        else:
            items.append((record["id"], built))
    return items


def run(db, collection, items, overwrite, dry_run):
    stats = {"written": 0, "skipped": 0, "overwritten": 0, "would_write": 0}
    for doc_id, payload in items:
        ref = db.collection(collection).document(doc_id)
        exists = ref.get().exists
        if dry_run:
            stats["would_write" if not exists else "skipped"] += 1
            continue
        if exists and not overwrite:
            stats["skipped"] += 1
            continue
        ref.set(payload, merge=True)
        stats["overwritten" if exists else "written"] += 1
    return stats


def main():
    parser = argparse.ArgumentParser(description="Migrate MediTrack JSON data to Firestore.")
    parser.add_argument("--owner", help="Firebase UID to attribute legacy records to")
    parser.add_argument("--data-dir", default=os.environ.get("MEDITRACK_DATA_DIR", "data"))
    parser.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    parser.add_argument("--overwrite", action="store_true", help="update existing documents")
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = parser.parse_args()

    owner = args.owner or os.environ.get("MIGRATION_OWNER_UID")

    medicines = load_json_list(os.path.join(args.data_dir, "medicines.json"))
    reminders = load_json_list(os.path.join(args.data_dir, "reminders.json"))
    logs = load_json_list(os.path.join(args.data_dir, "reminder_logs.json"))

    print("Source records found (JSON backups are read-only and never modified):")
    print("  medicines.json     : %d" % len(medicines))
    print("  reminders.json     : %d" % len(reminders))
    print("  reminder_logs.json : %d" % len(logs))

    if not owner:
        print("\nNo owner supplied -> REPORT-ONLY mode (nothing written).")
        print("Existing records have no user id, and this tool will not invent one.")
        print("To migrate, supply the Firebase UID that should own these records:")
        print("  python migrate_to_firestore.py --owner <YOUR_FIREBASE_UID> --yes")
        return 0

    # ---- connect ----
    if not firebase_config.init_firebase():
        print("\nCannot connect to Firebase: %s" % firebase_config.get_status().get("error"))
        print("Configure FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.")
        return 1
    db = firebase_config.get_db()
    print("\nConnected to project: %s" % firebase_config.get_project_id())
    print("Attributing legacy records to owner: %s" % owner)

    if args.dry_run:
        print("DRY RUN - no documents will be written.\n")
    elif not args.yes:
        answer = input("Proceed with migration? [y/N] ").strip().lower()
        if answer != "y":
            print("Aborted.")
            return 1

    med_items = plan(medicines, lambda r: build_medicine(r, owner))
    rem_items = plan(reminders, lambda r: build_reminder(r, owner))
    log_items = plan(logs, lambda r: build_log(r, owner))

    results = {
        "medicines": run(db, "medicines", med_items, args.overwrite, args.dry_run),
        "reminders": run(db, "reminders", rem_items, args.overwrite, args.dry_run),
        "reminder_logs": run(db, "reminder_logs", log_items, args.overwrite, args.dry_run),
    }

    print("\nMigration result:")
    for name, stats in results.items():
        print("  %-14s %s" % (name, stats))

    if args.dry_run:
        print("\nDry run complete. Re-run without --dry-run to write.")
        return 0

    # ---- verify counts ----
    print("\nVerifying migrated counts...")
    ok = True
    for collection in ("medicines", "reminders", "reminder_logs"):
        query = db.collection(collection).where("owner_user_id", "==", owner)
        count = sum(1 for _ in query.stream())
        expected = len(results[collection]) and (
            results[collection]["written"] + results[collection]["overwritten"] + results[collection]["skipped"]
        )
        marker = "OK" if count == expected else "MISMATCH"
        if count != expected:
            ok = False
        print("  %-14s stored=%d expected=%d [%s]" % (collection, count, expected, marker))

    print("\nDone. Original JSON files were not modified.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
