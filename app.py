
from flask import Flask, request, jsonify, render_template, g
import os
import uuid
from datetime import datetime

import firebase_config
from auth import require_auth, auth_is_enforced
from models import DEFAULT_MEMBER_ID
from storage import (
    get_storage, set_storage, JsonStorage, FirestoreStorage,
    StorageError, NotFound, Forbidden,
)

app = Flask(__name__)

# Safe development configuration
# Keep the original field order in JSON responses (Flask 2.3+ API)
app.json.sort_keys = False
# Return generic JSON error responses instead of exposing stack traces
app.config["PROPAGATE_EXCEPTIONS"] = False

# Session signing key. In production (Render) set SECRET_KEY to a strong random
# value. Local development falls back to an ephemeral key so no secret is ever
# hard-coded in source control.
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or os.urandom(24)

# Storage locations (kept so the original JSON files remain the local fallback)
DATA_DIR = os.environ.get("MEDITRACK_DATA_DIR", "data")

# Fields that must be present and non-empty
REQUIRED_FIELDS = ["name", "dosage", "frequency"]

# Optional fields that are validated when provided
OPTIONAL_FIELDS = ["start_date", "expiry_date", "notes"]


# ---------------------------------------------------------------
# Backend selection: Firebase Firestore when configured, JSON otherwise.
# The JSON files are never deleted or rewritten by this switch.
# ---------------------------------------------------------------
firebase_config.init_firebase()
if firebase_config.is_ready():
    set_storage(FirestoreStorage(firebase_config.get_db()))
    app.logger.info("Storage backend: Firestore (project %s)", firebase_config.get_project_id())
else:
    os.makedirs(DATA_DIR, exist_ok=True)
    set_storage(JsonStorage(DATA_DIR))
    app.logger.info("Storage backend: JSON files (%s)", firebase_config.get_status().get("error"))


# Validate a date string in YYYY-MM-DD format
def is_valid_date(value):
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return True
    except (ValueError, TypeError):
        return False


# Resolve and validate the family member a record belongs to.
# "" / missing -> the account holder ("self"). Any other value must reference a
# family member owned by the signed-in user, otherwise the request is rejected.
def resolve_member_id(owner, value):
    if value is None:
        return DEFAULT_MEMBER_ID, None
    if not isinstance(value, str):
        return None, "'member_id' must be text"
    value = value.strip()
    if not value:
        return DEFAULT_MEMBER_ID, None
    if value == DEFAULT_MEMBER_ID:
        return value, None
    try:
        get_storage().get_record(owner, "family_members", value)
    except NotFound:
        return None, "Unknown family member"
    return value, None


# Validate an incoming medicine payload
def validate_medicine(data):
    if not isinstance(data, dict):
        return None, {"error": "Request body must be a JSON object"}

    errors = {}
    cleaned = {}

    # Required text fields
    for field in REQUIRED_FIELDS:
        value = data.get(field)
        if not isinstance(value, str) or not value.strip():
            errors[field] = "'{}' is required and cannot be empty".format(field)
        else:
            cleaned[field] = value.strip()

    # Optional fields
    for field in OPTIONAL_FIELDS:
        if field not in data:
            continue
        value = data.get(field)
        if value is None:
            cleaned[field] = ""
            continue
        if not isinstance(value, str):
            errors[field] = "'{}' must be text".format(field)
            continue
        value = value.strip()
        if field in ("start_date", "expiry_date") and value and not is_valid_date(value):
            errors[field] = "'{}' must be a valid date (YYYY-MM-DD)".format(field)
        else:
            cleaned[field] = value

    # Cross-field rule: expiry date cannot be earlier than the start date
    start_date = cleaned.get("start_date")
    expiry_date = cleaned.get("expiry_date")
    if start_date and expiry_date:
        if datetime.strptime(expiry_date, "%Y-%m-%d") < datetime.strptime(start_date, "%Y-%m-%d"):
            errors["expiry_date"] = "'expiry_date' cannot be earlier than 'start_date'"

    if errors:
        return None, {"error": "Validation failed", "details": errors}

    return cleaned, None


# Home route -> serves the MediTrack dashboard
@app.route("/")
def home():
    return render_template("index.html")


# Lightweight health/status probe (public, exposes no secrets)
@app.route("/api/health", methods=["GET"])
def health():
    store = get_storage()
    return jsonify({
        "status": "ok",
        "storage": store.mode,
        "firebase_ready": firebase_config.is_ready(),
        "auth_enforced": auth_is_enforced(),
        # Public value (same id the Web SDK uses); helps spot a project / token
        # "audience" mismatch that would otherwise surface as a fake 401.
        "project_id": firebase_config.get_project_id(),
    })


# ---------------------------------------------------------------
# Step 8 Phase C - user account profile  (Firestore collection: users)
# The document id and owner are the VERIFIED Firebase uid (``g.owner``).
# ``email`` comes from the verified token claim, never from the request body.
# ---------------------------------------------------------------
@app.route("/api/users/me", methods=["GET"])
@require_auth
def get_my_profile():
    profile = get_storage().get_user(g.owner)
    if profile is None:
        return jsonify({"error": "Profile not found"}), 404
    return jsonify(profile)


@app.route("/api/users/me", methods=["PUT"])
@require_auth
def upsert_my_profile():
    data = request.get_json(silent=True)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400

    name = data.get("name")
    if name is not None and not isinstance(name, str):
        return jsonify({"error": "Validation failed",
                        "details": {"name": "'name' must be text"}}), 400

    profile = get_storage().upsert_user(g.owner, {
        "name": (name or "").strip(),
        "email": getattr(g, "email", "") or "",
    })
    return jsonify({"message": "Profile saved", "user": profile})


# ---------------------------------------------------------------
# Step 2/6 - Medicines
# ---------------------------------------------------------------
@app.route("/api/medicines", methods=["GET"])
@require_auth
def get_medicines():
    return jsonify(get_storage().list_medicines(g.owner))


@app.route("/api/medicines", methods=["POST"])
@require_auth
def add_medicine():
    data = request.get_json(silent=True)

    cleaned, error = validate_medicine(data)
    if error:
        return jsonify(error), 400

    member_id, member_error = resolve_member_id(g.owner, data.get("member_id"))
    if member_error:
        return jsonify({"error": "Validation failed", "details": {"member_id": member_error}}), 400

    new_medicine = {
        "id": str(uuid.uuid4()),
        "member_id": member_id,
        "name": cleaned["name"],
        "dosage": cleaned["dosage"],
        "frequency": cleaned["frequency"],
        "start_date": cleaned.get("start_date", ""),
        "expiry_date": cleaned.get("expiry_date", ""),
        "notes": cleaned.get("notes", ""),
    }

    created = get_storage().create_medicine(g.owner, new_medicine)

    return jsonify({
        "message": "Medicine added successfully",
        "medicine": created,
    }), 201


@app.route("/api/medicines/<medicine_id>", methods=["GET"])
@require_auth
def get_medicine(medicine_id):
    return jsonify(get_storage().get_medicine(g.owner, medicine_id))


@app.route("/api/medicines/<medicine_id>", methods=["PUT"])
@require_auth
def update_medicine(medicine_id):
    data = request.get_json(silent=True)

    cleaned, error = validate_medicine(data)
    if error:
        return jsonify(error), 400

    changes = {
        "name": cleaned["name"],
        "dosage": cleaned["dosage"],
        "frequency": cleaned["frequency"],
    }
    for field in OPTIONAL_FIELDS:
        if field in cleaned:
            changes[field] = cleaned[field]

    # Only re-scope the medicine when the client explicitly sends member_id, so
    # an edit that omits it never silently resets the family association.
    if "member_id" in data:
        member_id, member_error = resolve_member_id(g.owner, data.get("member_id"))
        if member_error:
            return jsonify({"error": "Validation failed",
                            "details": {"member_id": member_error}}), 400
        changes["member_id"] = member_id

    medicine = get_storage().update_medicine(g.owner, medicine_id, changes)

    return jsonify({
        "message": "Medicine updated successfully",
        "medicine": medicine,
    })


@app.route("/api/medicines/<medicine_id>", methods=["DELETE"])
@require_auth
def delete_medicine(medicine_id):
    removed = get_storage().delete_medicine(g.owner, medicine_id)
    return jsonify({
        "message": "Medicine deleted successfully",
        "medicine": removed,
    })


# ---------------------------------------------------------------
# Step 5 - Medicine reminders
# ---------------------------------------------------------------
# Supported schedule frequencies -> required number of reminder times
FREQUENCY_TIME_COUNT = {
    "Once daily": 1,
    "Twice daily": 2,
    "Three times daily": 3,
    "Four times daily": 4,
}
REMINDER_FREQUENCIES = list(FREQUENCY_TIME_COUNT.keys()) + ["Custom"]
REMINDER_STATUSES = ["active", "inactive"]
LOG_STATUSES = ["taken", "missed"]


# Validate a HH:MM time string
def is_valid_time(value):
    try:
        datetime.strptime(value, "%H:%M")
        return True
    except (ValueError, TypeError):
        return False


# Validate an incoming reminder payload
def validate_reminder(data):
    if not isinstance(data, dict):
        return None, {"error": "Request body must be a JSON object"}

    errors = {}
    cleaned = {}

    # Required text fields
    for field in ("medicine_id", "medicine_name", "dosage"):
        value = data.get(field)
        if not isinstance(value, str) or not value.strip():
            errors[field] = "'{}' is required and cannot be empty".format(field)
        else:
            cleaned[field] = value.strip()

    # Frequency must be one of the supported options
    frequency = data.get("frequency")
    if not isinstance(frequency, str) or frequency not in REMINDER_FREQUENCIES:
        errors["frequency"] = "'frequency' must be one of: {}".format(", ".join(REMINDER_FREQUENCIES))
    else:
        cleaned["frequency"] = frequency

    # Reminder times: a non-empty list of unique HH:MM values
    times = data.get("times")
    if not isinstance(times, list) or not times:
        errors["times"] = "'times' must be a non-empty list of HH:MM values"
    else:
        norm_times = []
        bad_time = False
        for item in times:
            if not isinstance(item, str) or not is_valid_time(item.strip()):
                bad_time = True
                break
            norm_times.append(item.strip())
        if bad_time:
            errors["times"] = "each time must be in HH:MM format"
        elif len(set(norm_times)) != len(norm_times):
            errors["times"] = "reminder times must be unique"
        else:
            norm_times.sort()
            cleaned["times"] = norm_times
            expected = FREQUENCY_TIME_COUNT.get(frequency)
            if expected is not None and len(norm_times) != expected:
                errors["times"] = "'{}' requires exactly {} reminder time(s)".format(frequency, expected)

    # Dates (both optional)
    for field in ("start_date", "end_date"):
        value = data.get(field)
        if value in (None, ""):
            cleaned[field] = ""
            continue
        if not isinstance(value, str) or not is_valid_date(value.strip()):
            errors[field] = "'{}' must be a valid date (YYYY-MM-DD)".format(field)
        else:
            cleaned[field] = value.strip()

    # End date cannot be earlier than the start date
    start_date = cleaned.get("start_date")
    end_date = cleaned.get("end_date")
    if start_date and end_date and end_date < start_date:
        errors["end_date"] = "'end_date' cannot be earlier than 'start_date'"

    # Schedule status
    status = data.get("status", "active")
    if status not in REMINDER_STATUSES:
        errors["status"] = "'status' must be 'active' or 'inactive'"
    else:
        cleaned["status"] = status

    if errors:
        return None, {"error": "Validation failed", "details": errors}

    return cleaned, None


@app.route("/api/reminders", methods=["GET"])
@require_auth
def get_reminders():
    return jsonify(get_storage().list_reminders(g.owner))


@app.route("/api/reminders", methods=["POST"])
@require_auth
def add_reminder():
    data = request.get_json(silent=True)

    cleaned, error = validate_reminder(data)
    if error:
        return jsonify(error), 400

    new_reminder = {
        "id": str(uuid.uuid4()),
        "medicine_id": cleaned["medicine_id"],
        "medicine_name": cleaned["medicine_name"],
        "dosage": cleaned["dosage"],
        "frequency": cleaned["frequency"],
        "times": cleaned["times"],
        "start_date": cleaned.get("start_date", ""),
        "end_date": cleaned.get("end_date", ""),
        "status": cleaned["status"],
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }

    created = get_storage().create_reminder(g.owner, new_reminder)

    return jsonify({
        "message": "Reminder added successfully",
        "reminder": created,
    }), 201


@app.route("/api/reminders/<reminder_id>", methods=["GET"])
@require_auth
def get_reminder(reminder_id):
    return jsonify(get_storage().get_reminder(g.owner, reminder_id))


@app.route("/api/reminders/<reminder_id>", methods=["PUT"])
@require_auth
def update_reminder(reminder_id):
    data = request.get_json(silent=True)

    cleaned, error = validate_reminder(data)
    if error:
        return jsonify(error), 400

    changes = {
        "medicine_id": cleaned["medicine_id"],
        "medicine_name": cleaned["medicine_name"],
        "dosage": cleaned["dosage"],
        "frequency": cleaned["frequency"],
        "times": cleaned["times"],
        "start_date": cleaned.get("start_date", ""),
        "end_date": cleaned.get("end_date", ""),
        "status": cleaned["status"],
    }

    reminder = get_storage().update_reminder(g.owner, reminder_id, changes)

    return jsonify({
        "message": "Reminder updated successfully",
        "reminder": reminder,
    })


@app.route("/api/reminders/<reminder_id>", methods=["DELETE"])
@require_auth
def delete_reminder(reminder_id):
    removed = get_storage().delete_reminder(g.owner, reminder_id)
    return jsonify({
        "message": "Reminder deleted successfully",
        "reminder": removed,
    })


@app.route("/api/reminder-logs", methods=["GET"])
@require_auth
def get_reminder_logs():
    return jsonify(get_storage().list_logs(g.owner))


# Record a completion (or missed) event for one scheduled occurrence.
# One record per (reminder, date, time) - duplicates are updated, never added.
@app.route("/api/reminders/<reminder_id>/log", methods=["POST"])
@require_auth
def log_reminder(reminder_id):
    # Existence + ownership check first (404 / 403)
    reminder = get_storage().get_reminder(g.owner, reminder_id)

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400

    errors = {}
    date_value = data.get("date")
    time_value = data.get("time")
    status = data.get("status")

    if not isinstance(date_value, str) or not is_valid_date(date_value.strip()):
        errors["date"] = "'date' must be a valid date (YYYY-MM-DD)"
    if not isinstance(time_value, str) or not is_valid_time(time_value.strip()):
        errors["time"] = "'time' must be in HH:MM format"
    if status not in LOG_STATUSES:
        errors["status"] = "'status' must be 'taken' or 'missed'"

    if errors:
        return jsonify({"error": "Validation failed", "details": errors}), 400

    date_value = date_value.strip()
    time_value = time_value.strip()

    snapshot = {
        "medicine_id": reminder.get("medicine_id", ""),
        "medicine_name": reminder.get("medicine_name", ""),
        "dosage": reminder.get("dosage", ""),
    }

    entry, created = get_storage().upsert_log(
        g.owner, reminder_id, date_value, time_value, status, snapshot
    )

    return jsonify({
        "message": "Reminder marked as {}.".format(status),
        "log": entry,
    }), (201 if created else 200)


# ---------------------------------------------------------------
# Step 6 - Medicine expiry tracking
# Expiry status / days remaining are calculated on demand from the
# existing medicine records. Nothing new is stored, so the original
# medicine data is never modified or lost.
# ---------------------------------------------------------------
EXPIRING_SOON_DAYS = 30
EXPIRING_7_DAYS = 7


# Return (days_remaining, status) for a medicine.
# days_remaining is an int (negative when already expired) or None when
# the expiry date is missing or invalid. status is one of
# 'expired' | 'expiring' | 'active' | 'unknown'.
def expiry_info(medicine, today):
    value = medicine.get("expiry_date")
    if not isinstance(value, str) or not value.strip():
        return None, "unknown"

    try:
        expiry = datetime.strptime(value.strip(), "%Y-%m-%d").date()
    except ValueError:
        return None, "unknown"

    days = (expiry - today).days
    if days < 0:
        status = "expired"
    elif days <= EXPIRING_SOON_DAYS:
        status = "expiring"
    else:
        status = "active"
    return days, status


# Expiry overview: per-medicine days remaining + status, plus summary counts.
# Missing / invalid expiry dates are reported safely (days None, status 'unknown')
# and never break the response.
@app.route("/api/expiry", methods=["GET"])
@require_auth
def get_expiry():
    medicines = get_storage().list_medicines(g.owner)
    today = datetime.now().date()

    items = []
    summary = {
        "total": len(medicines),
        "expired": 0,
        "expiring_7": 0,
        "expiring_30": 0,
        "active": 0,
        "no_expiry": 0,
    }

    for medicine in medicines:
        days, status = expiry_info(medicine, today)

        items.append({
            "id": medicine.get("id", ""),
            "member_id": medicine.get("member_id", DEFAULT_MEMBER_ID),
            "name": medicine.get("name", ""),
            "dosage": medicine.get("dosage", ""),
            "expiry_date": medicine.get("expiry_date", ""),
            "days_remaining": days,
            "status": status,
        })

        if days is None:
            summary["no_expiry"] += 1
        elif days < 0:
            summary["expired"] += 1
        else:
            if days <= EXPIRING_7_DAYS:
                summary["expiring_7"] += 1
            if days <= EXPIRING_SOON_DAYS:
                summary["expiring_30"] += 1
            else:
                summary["active"] += 1

    return jsonify({"summary": summary, "medicines": items})


# ---------------------------------------------------------------
# Family management
# Every member is owned by the signed-in user (owner_user_id) and only
# that user can read or change it. Medicines, reminders, medical
# histories and doctor visits reference a member by ``member_id``.
# ---------------------------------------------------------------
def validate_family_member(data):
    if not isinstance(data, dict):
        return None, {"error": "Request body must be a JSON object"}

    errors = {}
    cleaned = {}

    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        errors["name"] = "'name' is required and cannot be empty"
    else:
        cleaned["name"] = name.strip()

    relationship = data.get("relationship")
    if relationship in (None, ""):
        cleaned["relationship"] = ""
    elif not isinstance(relationship, str):
        errors["relationship"] = "'relationship' must be text"
    else:
        cleaned["relationship"] = relationship.strip()

    dob = data.get("date_of_birth")
    if dob in (None, ""):
        cleaned["date_of_birth"] = ""
    elif not isinstance(dob, str) or not is_valid_date(dob.strip()):
        errors["date_of_birth"] = "'date_of_birth' must be a valid date (YYYY-MM-DD)"
    elif datetime.strptime(dob.strip(), "%Y-%m-%d").date() > datetime.now().date():
        errors["date_of_birth"] = "'date_of_birth' cannot be in the future"
    else:
        cleaned["date_of_birth"] = dob.strip()

    if errors:
        return None, {"error": "Validation failed", "details": errors}
    return cleaned, None


@app.route("/api/family-members", methods=["GET"])
@require_auth
def get_family_members():
    return jsonify(get_storage().list_records(g.owner, "family_members"))


@app.route("/api/family-members", methods=["POST"])
@require_auth
def add_family_member():
    data = request.get_json(silent=True)
    cleaned, error = validate_family_member(data)
    if error:
        return jsonify(error), 400

    member = {
        "id": str(uuid.uuid4()),
        "name": cleaned["name"],
        "relationship": cleaned.get("relationship", ""),
        "date_of_birth": cleaned.get("date_of_birth", ""),
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    created = get_storage().create_record(g.owner, "family_members", member)
    return jsonify({"message": "Family member added successfully", "member": created}), 201


@app.route("/api/family-members/<member_id>", methods=["GET"])
@require_auth
def get_family_member(member_id):
    return jsonify(get_storage().get_record(g.owner, "family_members", member_id))


@app.route("/api/family-members/<member_id>", methods=["PUT"])
@require_auth
def update_family_member(member_id):
    data = request.get_json(silent=True)
    cleaned, error = validate_family_member(data)
    if error:
        return jsonify(error), 400

    changes = {
        "name": cleaned["name"],
        "relationship": cleaned.get("relationship", ""),
        "date_of_birth": cleaned.get("date_of_birth", ""),
    }
    member = get_storage().update_record(g.owner, "family_members", member_id, changes)
    return jsonify({"message": "Family member updated successfully", "member": member})


@app.route("/api/family-members/<member_id>", methods=["DELETE"])
@require_auth
def delete_family_member(member_id):
    if member_id == DEFAULT_MEMBER_ID:
        return jsonify({"error": "The account holder record cannot be deleted"}), 400

    # Safe delete: never orphan records. Refuse while anything still points at
    # this member and tell the user what to move or remove first.
    counts = get_storage().member_record_counts(g.owner, member_id)
    if counts:
        return jsonify({
            "error": "This family member still has associated records. Reassign or "
                     "remove them before deleting the member.",
            "details": counts,
        }), 409

    removed = get_storage().delete_record(g.owner, "family_members", member_id)
    return jsonify({"message": "Family member deleted successfully", "member": removed})


# ---------------------------------------------------------------
# Medical history
# Owner-scoped medical records (condition, diagnosis date, allergies,
# existing conditions, treatment, notes) linked to a family member.
# ---------------------------------------------------------------
MEDICAL_TEXT_FIELDS = ("allergies", "existing_conditions", "treatment", "notes")


def _clean_optional_text(data, fields, errors, cleaned):
    for field in fields:
        value = data.get(field)
        if value in (None, ""):
            cleaned[field] = ""
        elif not isinstance(value, str):
            errors[field] = "'{}' must be text".format(field)
        else:
            cleaned[field] = value.strip()


def _clean_optional_date(data, field, errors, cleaned, allow_future=False):
    value = data.get(field)
    if value in (None, ""):
        cleaned[field] = ""
        return
    if not isinstance(value, str) or not is_valid_date(value.strip()):
        errors[field] = "'{}' must be a valid date (YYYY-MM-DD)".format(field)
        return
    parsed = datetime.strptime(value.strip(), "%Y-%m-%d").date()
    if not allow_future and parsed > datetime.now().date():
        errors[field] = "'{}' cannot be in the future".format(field)
        return
    cleaned[field] = value.strip()


def validate_history(data):
    if not isinstance(data, dict):
        return None, {"error": "Request body must be a JSON object"}

    errors = {}
    cleaned = {}

    condition = data.get("condition")
    if not isinstance(condition, str) or not condition.strip():
        errors["condition"] = "'condition' is required and cannot be empty"
    else:
        cleaned["condition"] = condition.strip()

    _clean_optional_text(data, MEDICAL_TEXT_FIELDS, errors, cleaned)
    _clean_optional_date(data, "diagnosis_date", errors, cleaned)

    if errors:
        return None, {"error": "Validation failed", "details": errors}
    return cleaned, None


@app.route("/api/medical-history", methods=["GET"])
@require_auth
def get_medical_history():
    records = get_storage().list_records(g.owner, "medical_histories")
    member = request.args.get("member_id")
    if member:
        records = [r for r in records if r.get("member_id") == member]
    return jsonify(records)


@app.route("/api/medical-history", methods=["POST"])
@require_auth
def add_medical_history():
    data = request.get_json(silent=True)
    cleaned, error = validate_history(data)
    if error:
        return jsonify(error), 400

    member_id, member_error = resolve_member_id(g.owner, data.get("member_id"))
    if member_error:
        return jsonify({"error": "Validation failed", "details": {"member_id": member_error}}), 400

    record = {
        "id": str(uuid.uuid4()),
        "member_id": member_id,
        "condition": cleaned["condition"],
        "diagnosis_date": cleaned.get("diagnosis_date", ""),
        "allergies": cleaned.get("allergies", ""),
        "existing_conditions": cleaned.get("existing_conditions", ""),
        "treatment": cleaned.get("treatment", ""),
        "notes": cleaned.get("notes", ""),
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    created = get_storage().create_record(g.owner, "medical_histories", record)
    return jsonify({"message": "Medical history added successfully", "record": created}), 201


@app.route("/api/medical-history/<history_id>", methods=["GET"])
@require_auth
def get_medical_history_item(history_id):
    return jsonify(get_storage().get_record(g.owner, "medical_histories", history_id))


@app.route("/api/medical-history/<history_id>", methods=["PUT"])
@require_auth
def update_medical_history(history_id):
    data = request.get_json(silent=True)
    cleaned, error = validate_history(data)
    if error:
        return jsonify(error), 400

    changes = {
        "condition": cleaned["condition"],
        "diagnosis_date": cleaned.get("diagnosis_date", ""),
        "allergies": cleaned.get("allergies", ""),
        "existing_conditions": cleaned.get("existing_conditions", ""),
        "treatment": cleaned.get("treatment", ""),
        "notes": cleaned.get("notes", ""),
    }
    if "member_id" in data:
        member_id, member_error = resolve_member_id(g.owner, data.get("member_id"))
        if member_error:
            return jsonify({"error": "Validation failed",
                            "details": {"member_id": member_error}}), 400
        changes["member_id"] = member_id

    record = get_storage().update_record(g.owner, "medical_histories", history_id, changes)
    return jsonify({"message": "Medical history updated successfully", "record": record})


@app.route("/api/medical-history/<history_id>", methods=["DELETE"])
@require_auth
def delete_medical_history(history_id):
    removed = get_storage().delete_record(g.owner, "medical_histories", history_id)
    return jsonify({"message": "Medical history deleted successfully", "record": removed})


# ---------------------------------------------------------------
# Doctor & treatment history
# Owner-scoped visits (doctor, hospital, appointment date, diagnosis,
# treatment, prescription notes, follow-up date, notes).
# ---------------------------------------------------------------
VISIT_TEXT_FIELDS = (
    "specialization", "hospital", "diagnosis", "treatment", "prescription_notes", "notes",
)


def validate_visit(data):
    if not isinstance(data, dict):
        return None, {"error": "Request body must be a JSON object"}

    errors = {}
    cleaned = {}

    doctor_name = data.get("doctor_name")
    if not isinstance(doctor_name, str) or not doctor_name.strip():
        errors["doctor_name"] = "'doctor_name' is required and cannot be empty"
    else:
        cleaned["doctor_name"] = doctor_name.strip()

    _clean_optional_text(data, VISIT_TEXT_FIELDS, errors, cleaned)
    # Appointment / follow-up dates may legitimately be in the future.
    _clean_optional_date(data, "visit_date", errors, cleaned, allow_future=True)
    _clean_optional_date(data, "follow_up_date", errors, cleaned, allow_future=True)

    visit_date = cleaned.get("visit_date")
    follow_up = cleaned.get("follow_up_date")
    if visit_date and follow_up and follow_up < visit_date:
        errors["follow_up_date"] = "'follow_up_date' cannot be earlier than 'visit_date'"

    if errors:
        return None, {"error": "Validation failed", "details": errors}
    return cleaned, None


@app.route("/api/doctor-visits", methods=["GET"])
@require_auth
def get_doctor_visits():
    records = get_storage().list_records(g.owner, "doctor_visits")
    member = request.args.get("member_id")
    if member:
        records = [r for r in records if r.get("member_id") == member]
    return jsonify(records)


@app.route("/api/doctor-visits", methods=["POST"])
@require_auth
def add_doctor_visit():
    data = request.get_json(silent=True)
    cleaned, error = validate_visit(data)
    if error:
        return jsonify(error), 400

    member_id, member_error = resolve_member_id(g.owner, data.get("member_id"))
    if member_error:
        return jsonify({"error": "Validation failed", "details": {"member_id": member_error}}), 400

    record = {
        "id": str(uuid.uuid4()),
        "member_id": member_id,
        "doctor_name": cleaned["doctor_name"],
        "specialization": cleaned.get("specialization", ""),
        "hospital": cleaned.get("hospital", ""),
        "visit_date": cleaned.get("visit_date", ""),
        "diagnosis": cleaned.get("diagnosis", ""),
        "treatment": cleaned.get("treatment", ""),
        "prescription_notes": cleaned.get("prescription_notes", ""),
        "follow_up_date": cleaned.get("follow_up_date", ""),
        "notes": cleaned.get("notes", ""),
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    created = get_storage().create_record(g.owner, "doctor_visits", record)
    return jsonify({"message": "Doctor visit added successfully", "record": created}), 201


@app.route("/api/doctor-visits/<visit_id>", methods=["GET"])
@require_auth
def get_doctor_visit(visit_id):
    return jsonify(get_storage().get_record(g.owner, "doctor_visits", visit_id))


@app.route("/api/doctor-visits/<visit_id>", methods=["PUT"])
@require_auth
def update_doctor_visit(visit_id):
    data = request.get_json(silent=True)
    cleaned, error = validate_visit(data)
    if error:
        return jsonify(error), 400

    changes = {
        "doctor_name": cleaned["doctor_name"],
        "specialization": cleaned.get("specialization", ""),
        "hospital": cleaned.get("hospital", ""),
        "visit_date": cleaned.get("visit_date", ""),
        "diagnosis": cleaned.get("diagnosis", ""),
        "treatment": cleaned.get("treatment", ""),
        "prescription_notes": cleaned.get("prescription_notes", ""),
        "follow_up_date": cleaned.get("follow_up_date", ""),
        "notes": cleaned.get("notes", ""),
    }
    if "member_id" in data:
        member_id, member_error = resolve_member_id(g.owner, data.get("member_id"))
        if member_error:
            return jsonify({"error": "Validation failed",
                            "details": {"member_id": member_error}}), 400
        changes["member_id"] = member_id

    record = get_storage().update_record(g.owner, "doctor_visits", visit_id, changes)
    return jsonify({"message": "Doctor visit updated successfully", "record": record})


@app.route("/api/doctor-visits/<visit_id>", methods=["DELETE"])
@require_auth
def delete_doctor_visit(visit_id):
    removed = get_storage().delete_record(g.owner, "doctor_visits", visit_id)
    return jsonify({"message": "Doctor visit deleted successfully", "record": removed})


# ---------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------
# Storage-layer errors (owned records) -> precise status codes
@app.errorhandler(NotFound)
def _storage_not_found(error):
    return jsonify({"error": error.message}), 404


@app.errorhandler(Forbidden)
def _storage_forbidden(error):
    return jsonify({"error": error.message}), 403


@app.errorhandler(StorageError)
def _storage_error(error):
    app.logger.error("Storage error: %s", error.message)
    return jsonify({"error": "Storage error"}), 500


# Generic HTTP errors (avoid exposing internal details)
@app.errorhandler(404)
def not_found(_error):
    return jsonify({"error": "Resource not found"}), 404


@app.errorhandler(405)
def method_not_allowed(_error):
    return jsonify({"error": "Method not allowed"}), 405


@app.errorhandler(500)
def internal_error(_error):
    return jsonify({"error": "Internal server error"}), 500


# Run application
if __name__ == "__main__":
    # Debug mode (auto-reload + interactive debugger) is opt-in via FLASK_DEBUG=1
    # so it is never enabled by default; the Werkzeug debugger console is an
    # arbitrary-code-execution risk if the port is ever exposed.
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    # Render injects PORT and expects the app to bind 0.0.0.0. Local development
    # keeps the original 127.0.0.1:5000 default.
    port = int(os.environ.get("PORT", "5000"))
    host = os.environ.get("HOST", "127.0.0.1")
    app.run(host=host, port=port, debug=debug)
