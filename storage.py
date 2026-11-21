"""
MediTrack storage layer.

Two interchangeable, owner-aware implementations:

  * JsonStorage      - the original JSON-file backend (default when Firebase is
                       not configured; used for local development). Single
                       tenant, so the ``owner`` argument is accepted but
                       ignored.
  * FirestoreStorage - Firebase Cloud Firestore backend. Every document is
                       scoped by ``owner_user_id`` and every read is filtered
                       by the verified owner.

The Flask routes call :func:`get_storage` and never touch a backend directly,
so the same API works against either store and the response shapes stay
identical to Steps 1-6.
"""
import json
import logging
import os
import uuid
from datetime import datetime

from models import DEFAULT_MEMBER_ID, RECORD_COLLECTIONS, log_document_id

logger = logging.getLogger(__name__)

# Fields exposed through the API for each collection, in a stable order. This
# keeps Firestore responses byte-compatible with the old JSON responses.
API_FIELDS = {
    "users": ("uid", "name", "email", "created_at", "updated_at", "account_status"),
    "medicines": ("id", "member_id", "name", "dosage", "frequency", "start_date",
                  "expiry_date", "notes"),
    "reminders": ("id", "member_id", "medicine_id", "medicine_name", "dosage",
                  "frequency", "times", "start_date", "end_date", "status", "created_at"),
    "reminder_logs": ("id", "reminder_id", "medicine_id", "medicine_name", "dosage",
                      "date", "time", "status", "recorded_at"),
    "family_members": ("id", "name", "relationship", "date_of_birth", "created_at"),
    "medical_histories": ("id", "member_id", "condition", "diagnosis_date", "allergies",
                          "existing_conditions", "treatment", "notes", "created_at"),
    "doctor_visits": ("id", "member_id", "doctor_name", "specialization", "hospital",
                      "visit_date", "diagnosis", "treatment", "prescription_notes",
                      "follow_up_date", "notes", "created_at"),
}

# Collections that store member-scoped records (used by the member-deletion
# safety check so a member cannot be removed while records still reference it).
MEMBER_SCOPED_COLLECTIONS = (
    "medicines", "reminders", "medical_histories", "doctor_visits",
)


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------
# Typed errors (mapped to HTTP status codes in app.py)
# ---------------------------------------------------------------
class StorageError(Exception):
    status_code = 500

    def __init__(self, message="Storage error"):
        super().__init__(message)
        self.message = message


class NotFound(StorageError):
    status_code = 404

    def __init__(self, message="Record not found"):
        super().__init__(message)


class Forbidden(StorageError):
    status_code = 403

    def __init__(self, message="You do not have access to this record"):
        super().__init__(message)


# ---------------------------------------------------------------
# JSON backend (faithful port of the Steps 1-6 file storage)
# ---------------------------------------------------------------
class JsonStorage:
    mode = "json"

    def __init__(self, data_dir="data"):
        self.data_dir = data_dir
        self.data_file = os.path.join(data_dir, "medicines.json")
        self.reminder_file = os.path.join(data_dir, "reminders.json")
        self.log_file = os.path.join(data_dir, "reminder_logs.json")
        self.user_file = os.path.join(data_dir, "users.json")
        # Family / medical-history / doctor-visit files (one per collection).
        self.record_files = {
            name: os.path.join(data_dir, filename)
            for name, filename in RECORD_COLLECTIONS.items()
        }
        os.makedirs(data_dir, exist_ok=True)
        every_file = [self.data_file, self.reminder_file, self.log_file, self.user_file]
        every_file += list(self.record_files.values())
        for path in every_file:
            if not os.path.exists(path):
                with open(path, "w") as handle:
                    json.dump([], handle)

    def _record_file(self, collection):
        path = self.record_files.get(collection)
        if path is None:
            raise StorageError("Unknown collection: {}".format(collection))
        return path

    # -- low level -------------------------------------------------
    def _load(self, path):
        try:
            with open(path, "r") as handle:
                content = handle.read().strip()
                if not content:
                    return []
                data = json.loads(content)
        except FileNotFoundError:
            return []
        except json.JSONDecodeError:
            backup = "{}.corrupt-{}".format(path, datetime.now().strftime("%Y%m%d%H%M%S"))
            try:
                os.replace(path, backup)
                logger.warning("Corrupted file backed up to %s", backup)
            except OSError:
                logger.warning("Could not back up corrupted file")
            return []
        if not isinstance(data, list):
            return []
        return [item for item in data if isinstance(item, dict)]

    def _save(self, path, items):
        temp_file = path + ".tmp"
        with open(temp_file, "w") as handle:
            json.dump(items, handle, indent=4)
        os.replace(temp_file, path)

    # -- medicines -------------------------------------------------
    def list_medicines(self, owner):
        # Legacy records have no member_id; present them as the account holder
        # ("self") without altering the stored JSON.
        return [dict(m, member_id=m.get("member_id") or DEFAULT_MEMBER_ID)
                for m in self._load(self.data_file)]

    def get_medicine(self, owner, medicine_id):
        for medicine in self._load(self.data_file):
            if medicine.get("id") == medicine_id:
                return medicine
        raise NotFound("Medicine not found")

    def create_medicine(self, owner, medicine):
        items = self._load(self.data_file)
        items.append(medicine)
        self._save(self.data_file, items)
        return medicine

    def update_medicine(self, owner, medicine_id, changes):
        items = self._load(self.data_file)
        for index, medicine in enumerate(items):
            if medicine.get("id") == medicine_id:
                medicine.update(changes)
                items[index] = medicine
                self._save(self.data_file, items)
                return medicine
        raise NotFound("Medicine not found")

    def delete_medicine(self, owner, medicine_id):
        items = self._load(self.data_file)
        for index, medicine in enumerate(items):
            if medicine.get("id") == medicine_id:
                removed = items.pop(index)
                self._save(self.data_file, items)
                return removed
        raise NotFound("Medicine not found")

    # -- reminders -------------------------------------------------
    def list_reminders(self, owner):
        return self._load(self.reminder_file)

    def get_reminder(self, owner, reminder_id):
        for reminder in self._load(self.reminder_file):
            if reminder.get("id") == reminder_id:
                return reminder
        raise NotFound("Reminder not found")

    def create_reminder(self, owner, reminder):
        items = self._load(self.reminder_file)
        items.append(reminder)
        self._save(self.reminder_file, items)
        return reminder

    def update_reminder(self, owner, reminder_id, changes):
        items = self._load(self.reminder_file)
        for index, reminder in enumerate(items):
            if reminder.get("id") == reminder_id:
                reminder.update(changes)
                items[index] = reminder
                self._save(self.reminder_file, items)
                return reminder
        raise NotFound("Reminder not found")

    def delete_reminder(self, owner, reminder_id):
        items = self._load(self.reminder_file)
        removed = None
        for index, reminder in enumerate(items):
            if reminder.get("id") == reminder_id:
                removed = items.pop(index)
                break
        if removed is None:
            raise NotFound("Reminder not found")
        self._save(self.reminder_file, items)

        logs = self._load(self.log_file)
        remaining = [log for log in logs if log.get("reminder_id") != reminder_id]
        if len(remaining) != len(logs):
            self._save(self.log_file, remaining)
        return removed

    # -- logs ------------------------------------------------------
    def list_logs(self, owner):
        return self._load(self.log_file)

    def get_log(self, owner, reminder_id, date, time):
        for log in self._load(self.log_file):
            if (log.get("reminder_id") == reminder_id
                    and log.get("date") == date and log.get("time") == time):
                return log
        return None

    def upsert_log(self, owner, reminder_id, date, time, status, snapshot):
        logs = self._load(self.log_file)
        for log in logs:
            if (log.get("reminder_id") == reminder_id
                    and log.get("date") == date and log.get("time") == time):
                log["status"] = status
                log["recorded_at"] = now_iso()
                self._save(self.log_file, logs)
                return log, False
        entry = {
            "id": str(uuid.uuid4()),
            "reminder_id": reminder_id,
            "medicine_id": snapshot.get("medicine_id", ""),
            "medicine_name": snapshot.get("medicine_name", ""),
            "dosage": snapshot.get("dosage", ""),
            "date": date,
            "time": time,
            "status": status,
            "recorded_at": now_iso(),
        }
        logs.append(entry)
        self._save(self.log_file, logs)
        return entry, True

    # -- users -----------------------------------------------------
    def get_user(self, owner):
        for user in self._load(self.user_file):
            if user.get("uid") == owner:
                return user
        return None

    def upsert_user(self, owner, profile):
        users = self._load(self.user_file)
        stamp = now_iso()
        for user in users:
            if user.get("uid") == owner:
                if profile.get("name"):
                    user["name"] = profile["name"]
                if profile.get("email"):
                    user["email"] = profile["email"]
                user["updated_at"] = stamp
                self._save(self.user_file, users)
                return user
        entry = {
            "uid": owner,
            "name": profile.get("name", ""),
            "email": profile.get("email", ""),
            "created_at": stamp,
            "updated_at": stamp,
            "account_status": "active",
        }
        users.append(entry)
        self._save(self.user_file, users)
        return entry

    # -- generic member-scoped records -----------------------------
    # Used by family_members / medical_histories / doctor_visits so the three
    # new modules share one implementation. Single-tenant, so ``owner`` is
    # accepted for API symmetry but not needed to separate rows.
    def list_records(self, owner, collection):
        return self._load(self._record_file(collection))

    def get_record(self, owner, collection, record_id):
        for record in self._load(self._record_file(collection)):
            if record.get("id") == record_id:
                return record
        raise NotFound()

    def create_record(self, owner, collection, record):
        items = self._load(self._record_file(collection))
        items.append(record)
        self._save(self._record_file(collection), items)
        return record

    def update_record(self, owner, collection, record_id, changes):
        items = self._load(self._record_file(collection))
        for index, record in enumerate(items):
            if record.get("id") == record_id:
                record.update(changes)
                items[index] = record
                self._save(self._record_file(collection), items)
                return record
        raise NotFound()

    def delete_record(self, owner, collection, record_id):
        items = self._load(self._record_file(collection))
        for index, record in enumerate(items):
            if record.get("id") == record_id:
                removed = items.pop(index)
                self._save(self._record_file(collection), items)
                return removed
        raise NotFound()

    def member_record_counts(self, owner, member_id):
        """Count records still referencing ``member_id`` (deletion safety)."""
        counts = {}
        if any(m.get("member_id") == member_id for m in self._load(self.data_file)):
            counts["medicines"] = sum(
                1 for m in self._load(self.data_file) if m.get("member_id") == member_id)
        for collection in ("reminders", "medical_histories", "doctor_visits"):
            if collection == "reminders":
                items = self._load(self.reminder_file)
            else:
                items = self._load(self._record_file(collection))
            n = sum(1 for r in items if r.get("member_id") == member_id)
            if n:
                counts[collection] = n
        return counts


# ---------------------------------------------------------------
# Firestore backend
# ---------------------------------------------------------------
class FirestoreStorage:
    mode = "firestore"

    def __init__(self, db, default_member_id=DEFAULT_MEMBER_ID):
        if db is None:
            raise StorageError("Firestore client is not available")
        self.db = db
        self.default_member_id = default_member_id

    # -- helpers ---------------------------------------------------
    def _collection(self, name):
        return self.db.collection(name)

    def _project(self, name, data):
        """Return only the API-facing fields, filling safe defaults."""
        result = {}
        for field in API_FIELDS[name]:
            value = data.get(field)
            if value is None:
                if field == "times":
                    value = []
                elif field == "member_id":
                    value = self.default_member_id
                else:
                    value = ""
            result[field] = value
        return result

    def _owned(self, name, owner, doc_id):
        """Fetch a document, enforcing existence + ownership."""
        snapshot = self._collection(name).document(doc_id).get()
        if not snapshot.exists:
            raise NotFound()
        data = snapshot.to_dict() or {}
        if data.get("owner_user_id") != owner:
            raise Forbidden()
        return data

    # -- users -----------------------------------------------------
    def get_user(self, owner):
        snapshot = self._collection("users").document(owner).get()
        if not snapshot.exists:
            return None
        return self._project("users", snapshot.to_dict() or {})

    def upsert_user(self, owner, profile):
        ref = self._collection("users").document(owner)
        existing = ref.get()
        stamp = now_iso()
        if existing.exists:
            current = existing.to_dict() or {}
            ref.set({
                "name": profile.get("name") or current.get("name", ""),
                "email": profile.get("email") or current.get("email", ""),
                "updated_at": stamp,
            }, merge=True)
        else:
            ref.set({
                "uid": owner,
                "name": profile.get("name", ""),
                "email": profile.get("email", ""),
                "created_at": stamp,
                "updated_at": stamp,
                "account_status": "active",
            })
        return self._project("users", ref.get().to_dict() or {})

    # -- medicines -------------------------------------------------
    def list_medicines(self, owner):
        query = self._collection("medicines").where("owner_user_id", "==", owner)
        return [self._project("medicines", snap.to_dict() or {}) for snap in query.stream()]

    def get_medicine(self, owner, medicine_id):
        return self._project("medicines", self._owned("medicines", owner, medicine_id))

    def create_medicine(self, owner, medicine):
        document = dict(medicine)
        document["owner_user_id"] = owner
        document.setdefault("member_id", self.default_member_id)
        document.setdefault("created_at", now_iso())
        self._collection("medicines").document(medicine["id"]).set(document)
        return self._project("medicines", document)

    def update_medicine(self, owner, medicine_id, changes):
        self._owned("medicines", owner, medicine_id)
        self._collection("medicines").document(medicine_id).set(changes, merge=True)
        return self._project("medicines", self._owned("medicines", owner, medicine_id))

    def delete_medicine(self, owner, medicine_id):
        data = self._owned("medicines", owner, medicine_id)
        self._collection("medicines").document(medicine_id).delete()
        return self._project("medicines", data)

    # -- reminders -------------------------------------------------
    def list_reminders(self, owner):
        query = self._collection("reminders").where("owner_user_id", "==", owner)
        return [self._project("reminders", snap.to_dict() or {}) for snap in query.stream()]

    def get_reminder(self, owner, reminder_id):
        return self._project("reminders", self._owned("reminders", owner, reminder_id))

    def create_reminder(self, owner, reminder):
        document = dict(reminder)
        document["owner_user_id"] = owner
        document.setdefault("member_id", self.default_member_id)
        document.setdefault("created_at", now_iso())
        self._collection("reminders").document(reminder["id"]).set(document)
        return self._project("reminders", document)

    def update_reminder(self, owner, reminder_id, changes):
        self._owned("reminders", owner, reminder_id)
        self._collection("reminders").document(reminder_id).set(changes, merge=True)
        return self._project("reminders", self._owned("reminders", owner, reminder_id))

    def delete_reminder(self, owner, reminder_id):
        data = self._owned("reminders", owner, reminder_id)
        self._collection("reminders").document(reminder_id).delete()
        # Cascade: drop the completion logs that belonged to this reminder.
        logs = (self._collection("reminder_logs")
                .where("owner_user_id", "==", owner)
                .where("reminder_id", "==", reminder_id))
        for snap in logs.stream():
            self._collection("reminder_logs").document(snap.id).delete()
        return self._project("reminders", data)

    # -- logs ------------------------------------------------------
    def list_logs(self, owner):
        query = self._collection("reminder_logs").where("owner_user_id", "==", owner)
        return [self._project("reminder_logs", snap.to_dict() or {}) for snap in query.stream()]

    def get_log(self, owner, reminder_id, date, time):
        doc_id = log_document_id(reminder_id, date, time)
        snapshot = self._collection("reminder_logs").document(doc_id).get()
        if not snapshot.exists:
            return None
        data = snapshot.to_dict() or {}
        if data.get("owner_user_id") != owner:
            return None
        return self._project("reminder_logs", data)

    def upsert_log(self, owner, reminder_id, date, time, status, snapshot):
        doc_id = log_document_id(reminder_id, date, time)
        ref = self._collection("reminder_logs").document(doc_id)
        existing = ref.get()
        created = not existing.exists

        if created:
            document = {
                "id": str(uuid.uuid4()),
                "reminder_id": reminder_id,
                "medicine_id": snapshot.get("medicine_id", ""),
                "medicine_name": snapshot.get("medicine_name", ""),
                "dosage": snapshot.get("dosage", ""),
                "date": date,
                "time": time,
                "status": status,
                "owner_user_id": owner,
                "member_id": snapshot.get("member_id", self.default_member_id),
                "recorded_at": now_iso(),
            }
        else:
            current = existing.to_dict() or {}
            if current.get("owner_user_id") != owner:
                raise Forbidden()
            document = {"status": status, "recorded_at": now_iso()}

        ref.set(document, merge=True)
        final = ref.get().to_dict() or {}
        return self._project("reminder_logs", final), created

    # -- generic member-scoped records -----------------------------
    # Every read is filtered by the verified owner; every write stamps
    # ``owner_user_id`` so one account can never reach another's records.
    def list_records(self, owner, collection):
        query = self._collection(collection).where("owner_user_id", "==", owner)
        return [self._project(collection, snap.to_dict() or {}) for snap in query.stream()]

    def get_record(self, owner, collection, record_id):
        return self._project(collection, self._owned(collection, owner, record_id))

    def create_record(self, owner, collection, record):
        document = dict(record)
        document["owner_user_id"] = owner
        document.setdefault("member_id", self.default_member_id)
        document.setdefault("created_at", now_iso())
        self._collection(collection).document(record["id"]).set(document)
        return self._project(collection, document)

    def update_record(self, owner, collection, record_id, changes):
        self._owned(collection, owner, record_id)
        self._collection(collection).document(record_id).set(changes, merge=True)
        return self._project(collection, self._owned(collection, owner, record_id))

    def delete_record(self, owner, collection, record_id):
        data = self._owned(collection, owner, record_id)
        self._collection(collection).document(record_id).delete()
        return self._project(collection, data)

    def member_record_counts(self, owner, member_id):
        """Count records still referencing ``member_id`` (deletion safety)."""
        counts = {}
        for collection in MEMBER_SCOPED_COLLECTIONS:
            query = (self._collection(collection)
                     .where("owner_user_id", "==", owner)
                     .where("member_id", "==", member_id))
            n = sum(1 for _ in query.stream())
            if n:
                counts[collection] = n
        return counts


# ---------------------------------------------------------------
# Storage singleton
# ---------------------------------------------------------------
_STORAGE = None


def set_storage(storage):
    global _STORAGE
    _STORAGE = storage


def get_storage():
    global _STORAGE
    if _STORAGE is None:
        _STORAGE = JsonStorage(os.environ.get("MEDITRACK_DATA_DIR", "data"))
    return _STORAGE
