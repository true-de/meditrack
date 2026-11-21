"""
MediTrack - Firestore data model (design + conventions).

This module documents and centralises the Firestore structure so the storage
layer, the migration script and future UI steps all agree on names.

Relationship / ownership rules
------------------------------
* Every document carries ``owner_user_id`` = the VERIFIED Firebase Auth UID.
  The value supplied by the frontend is never trusted.
* ``member_id`` identifies the family member the record belongs to. Records
  default to ``"self"`` (the account holder) until the user adds family members.
* Document ID conventions:
    - users            -> Firebase Auth UID
    - medicines        -> the existing medicine id (preserved on migration)
    - reminders        -> the existing reminder id (preserved on migration)
    - reminder_logs    -> "<reminder_id>_<date>_<time>"  (one doc per scheduled
                          occurrence, so duplicates are impossible by design)
    - family_members / medical_histories / doctor_visits / prescriptions
                       -> the record id
* The API still exposes ``id`` (and ``reminder_id`` / ``log_id`` semantics) so
  existing Flask response formats stay compatible with the frontend.
"""

DEFAULT_PROJECT_ID = "meditrack-3a681"

# Family member that legacy records are attributed to until a real member id
# exists. Deliberately NOT a user identity - see migrate_to_firestore.py.
DEFAULT_MEMBER_ID = "self"

# Collections used by the running application.
# ``users`` holds one profile document per Firebase Auth account.
CORE_COLLECTIONS = (
    "users", "medicines", "reminders", "reminder_logs",
    "family_members", "medical_histories", "doctor_visits",
)

# Full modelled structure (documented for future steps; only the core
# collections are written today).
FIELD_SCHEMA = {
    "users": ["uid", "name", "email", "created_at", "updated_at", "account_status"],
    "family_members": [
        "id", "owner_user_id", "name", "date_of_birth",
        "relationship", "created_at",
    ],
    "medicines": [
        "medicine_id", "owner_user_id", "member_id", "name", "dosage",
        "frequency", "start_date", "expiry_date", "notes", "created_at",
    ],
    "reminders": [
        "reminder_id", "owner_user_id", "member_id", "medicine_id",
        "reminder_times", "frequency", "start_date", "end_date", "status",
        "created_at",
    ],
    "reminder_logs": [
        "log_id", "reminder_id", "scheduled_time", "completion_status",
        "completed_at",
    ],
    "medical_histories": [
        "id", "owner_user_id", "member_id", "condition", "diagnosis_date",
        "allergies", "existing_conditions", "treatment", "notes", "created_at",
    ],
    "doctor_visits": [
        "id", "owner_user_id", "member_id", "doctor_name", "specialization",
        "hospital", "visit_date", "diagnosis", "treatment",
        "prescription_notes", "follow_up_date", "notes", "created_at",
    ],
    # Designed for future Firebase Storage integration (not implemented yet).
    "prescriptions": [
        "prescription_id", "owner_user_id", "member_id", "medicine_id",
        "doctor_visit_id", "storage_path", "file_name", "content_type",
        "uploaded_at", "notes",
    ],
    "medical_documents": [
        "document_id", "owner_user_id", "member_id", "category",
        "storage_path", "file_name", "content_type", "document_date",
        "uploaded_at", "notes",
    ],
}

# Collections with their own file in JSON fallback mode and generic CRUD in the
# storage layer (family member, medical history and doctor/treatment records).
RECORD_COLLECTIONS = {
    "family_members": "family_members.json",
    "medical_histories": "medical_histories.json",
    "doctor_visits": "doctor_visits.json",
}

# Collections left for a future step (no UI / no storage methods yet).
PLANNED_COLLECTIONS = ("prescriptions", "medical_documents")


def log_document_id(reminder_id, date, time):
    """Deterministic log document id: one document per scheduled occurrence."""
    return "{}_{}_{}".format(reminder_id, date, time)
