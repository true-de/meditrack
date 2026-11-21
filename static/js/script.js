/* ============================================================
   MediTrack – Smart Medicine Management System
   Frontend logic: talks to the Flask REST API via fetch()
   ============================================================ */

const API_URL = "/api/medicines";
const REMINDER_API = "/api/reminders";
const REMINDER_LOG_API = "/api/reminder-logs";
const EXPIRY_API = "/api/expiry";

/* All protected API calls go through the Firebase authentication layer,
   which attaches the ID token and transparently refreshes it on 401. */
const apiFetch = (url, options) => window.MediTrackAuth.apiFetch(url, options);

const EXPIRING_DAYS = 30; // a medicine is "expiring" within this many days
const EXPIRING_7_DAYS = 7; // the tighter "needs attention" window
const UPCOMING_LIMIT = 5;

/* ---------- Reminder constants ---------- */
// Supported schedule frequencies -> number of reminder times required
const FREQUENCY_TIME_COUNT = {
    "Once daily": 1,
    "Twice daily": 2,
    "Three times daily": 3,
    "Four times daily": 4,
};
const DUE_GRACE_MINUTES = 60;       // a dose stays "Due" this long before it reads as "Missed"
const REMINDER_UPCOMING_LIMIT = 6;  // future occurrences shown in the Upcoming panel
const NOTIF_POLL_MS = 30000;        // how often the scheduler checks for due reminders
const NOTIF_ENABLED_KEY = "meditrack.notifications.enabled";
const NOTIF_SENT_KEY = "meditrack.notifications.sent";
const EXPIRY_DISMISSED_KEY = "meditrack.expiry.dismissed";

/* ---------- State ---------- */
let medicines = [];
let reminders = [];
let reminderLogs = [];
let expiryData = { summary: {}, medicines: [] };
let lastExpiryDay = null;
let editingId = null;
let pendingDeleteId = null;
let detailsEditId = null;
let editingReminderId = null;
let pendingDeleteReminderId = null;
let currentView = "dashboard";
let notifTimer = null;

/* ---------- Element references ---------- */
const $ = (id) => document.getElementById(id);

const els = {};
let medicineModal;
let deleteModal;
let detailsModal;
let reminderModal;
let reminderDeleteModal;

/* ============================================================
   Init
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
    cacheElements();
    medicineModal = new bootstrap.Modal($("medicineModal"));
    deleteModal = new bootstrap.Modal($("deleteModal"));
    detailsModal = new bootstrap.Modal($("detailsModal"));
    reminderModal = new bootstrap.Modal($("reminderModal"));
    reminderDeleteModal = new bootstrap.Modal($("reminderDeleteModal"));
    bindEvents();
    // Data is only loaded after Firebase Authentication reports a signed-in
    // user (see window.MediTrack below); until then the auth screen is shown.
    window.MediTrackAuth.init();
});

/* ------------------------------------------------------------
   Authentication lifecycle hooks (invoked by auth.js)
   ------------------------------------------------------------ */
window.MediTrack = {
    onSignedIn() {
        // Reached only for an authenticated user — start loading dashboard data.
        loadMedicines();
        loadReminders();
        updateNotifUI();
        startReminderScheduler();
    },
    onSignedOut() {
        // Clear in-memory data and stop background work so nothing leaks
        // between sessions and no protected data is shown while signed out.
        medicines = [];
        reminders = [];
        reminderLogs = [];
        expiryData = { summary: {}, medicines: [] };
        lastExpiryDay = null;
        if (notifTimer) { clearInterval(notifTimer); notifTimer = null; }
        renderAll();
        renderReminderAll();
        renderExpiry();
    },
};

function cacheElements() {
    [
        "sidebar", "sidebarBackdrop", "sidebarToggle", "pageTitle",
        "refreshBtn", "topAddBtn", "navAddMedicine", "toolbarAddBtn", "emptyAddBtn",
        "searchInput", "statusFilter", "sortSelect",
        "statTotal", "statActive", "statExpiring", "statExpired",
        "invActiveBar", "invActiveCount", "invActivePct",
        "invExpiringBar", "invExpiringCount", "invExpiringPct",
        "invExpiredBar", "invExpiredCount", "invExpiredPct", "inventorySummary",
        "upcomingList",
        "medicinesBody", "tableLoading", "tableEmpty", "emptyTitle", "emptyText",
        "expiryStatTotal", "expiryStatExpired", "expiryStat7", "expiryStat30", "expiryStatActive",
        "expiryAlertsCount", "expiryAlertList",
        "expirySearch", "expiryFilter", "expirySort", "expiryBody", "expiryEmpty",
        "expiryEmptyTitle", "expiryEmptyText",
        "settingsTotal", "settingsLastLoaded", "settingsReloadBtn",
        "medicineForm", "medicineModalTitle", "medicineId",
        "name", "dosage", "frequency", "start_date", "expiry_date", "notes",
        "saveBtn", "saveSpinner", "saveBtnText",
        "deleteName", "confirmDeleteBtn", "deleteSpinner", "deleteBtnText",
        "dtlName", "dtlStatus", "dtlDosage", "dtlFrequency", "dtlStart",
        "dtlExpiry", "dtlExpiryStatus", "dtlExpiryWarning", "dtlNotes", "dtlId", "dtlEditBtn",
        "notifState", "notifEnableBtn", "notifDisableBtn", "notifTestBtn",
        "statActiveReminders", "statDue", "statTaken", "statMissed",
        "todayDateLabel", "todayScheduleList", "upcomingRemindersList",
        "reminderSearch", "addReminderBtn", "reminderList", "reminderEmpty", "reminderEmptyAddBtn",
        "reminderForm", "reminderModalTitle", "reminderId", "rmMedicine", "rmDosage",
        "rmFrequency", "rmStatus", "rmTimesList", "rmAddTimeBtn", "rmTimesHint", "rmTimesError",
        "rmStart", "rmEnd", "reminderSaveBtn", "reminderSaveSpinner", "reminderSaveBtnText",
        "reminderDeleteName", "confirmReminderDeleteBtn", "reminderDeleteSpinner", "reminderDeleteBtnText",
    ].forEach((id) => { els[id] = $(id); });
}

/* ============================================================
   Event wiring
   ============================================================ */
function bindEvents() {
    // Sidebar navigation
    document.querySelectorAll(".side-link[data-view]").forEach((link) => {
        link.addEventListener("click", (e) => {
            e.preventDefault();
            showView(link.dataset.view);
            closeSidebar();
        });
    });

    // Add medicine triggers
    els.navAddMedicine.addEventListener("click", (e) => { e.preventDefault(); openAddModal(); closeSidebar(); });
    els.topAddBtn.addEventListener("click", openAddModal);
    els.toolbarAddBtn.addEventListener("click", openAddModal);
    els.emptyAddBtn.addEventListener("click", openAddModal);

    // Refresh
    els.refreshBtn.addEventListener("click", () => { loadMedicines(true); loadReminders(); });
    els.settingsReloadBtn.addEventListener("click", () => loadMedicines(true));

    // Search, filter & sort
    els.searchInput.addEventListener("input", renderTable);
    els.statusFilter.addEventListener("change", renderTable);
    els.sortSelect.addEventListener("change", renderTable);

    // Expiry tracking controls
    els.expirySearch.addEventListener("input", renderExpiryTable);
    els.expiryFilter.addEventListener("change", renderExpiryTable);
    els.expirySort.addEventListener("change", renderExpiryTable);

    // Expiry table actions (event delegation) – reuse the medicine actions
    els.expiryBody.addEventListener("click", (e) => {
        const viewBtn = e.target.closest("[data-action='view']");
        const editBtn = e.target.closest("[data-action='edit']");
        const deleteBtn = e.target.closest("[data-action='delete']");
        if (viewBtn) openDetails(viewBtn.dataset.id);
        if (editBtn) openEditModal(editBtn.dataset.id);
        if (deleteBtn) askDelete(deleteBtn.dataset.id);
    });

    // Dismiss a single expiry alert
    els.expiryAlertList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-dismiss-alert]");
        if (btn) dismissExpiryAlert(btn.dataset.dismissAlert);
    });

    // Form submit
    els.medicineForm.addEventListener("submit", handleSubmit);

    // Row actions (event delegation)
    els.medicinesBody.addEventListener("click", (e) => {
        const viewBtn = e.target.closest("[data-action='view']");
        const editBtn = e.target.closest("[data-action='edit']");
        const deleteBtn = e.target.closest("[data-action='delete']");
        if (viewBtn) openDetails(viewBtn.dataset.id);
        if (editBtn) openEditModal(editBtn.dataset.id);
        if (deleteBtn) askDelete(deleteBtn.dataset.id);
    });

    // Delete confirm
    els.confirmDeleteBtn.addEventListener("click", handleDelete);

    // Edit from the details view
    els.dtlEditBtn.addEventListener("click", () => {
        detailsModal.hide();
        openEditModal(detailsEditId);
    });

    // Mobile sidebar
    els.sidebarToggle.addEventListener("click", openSidebar);
    els.sidebarBackdrop.addEventListener("click", closeSidebar);

    // ---- Reminders ----
    els.addReminderBtn.addEventListener("click", openAddReminder);
    els.reminderEmptyAddBtn.addEventListener("click", openAddReminder);
    els.reminderSearch.addEventListener("input", renderReminderList);
    els.reminderForm.addEventListener("submit", handleReminderSubmit);
    els.rmFrequency.addEventListener("change", onReminderFrequencyChange);
    els.rmMedicine.addEventListener("change", onReminderMedicineChange);
    els.rmAddTimeBtn.addEventListener("click", () => { addTimeRow(""); updateReminderTimesHint(); });

    // Remove a time row (custom schedules only; always keep at least one)
    els.rmTimesList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-remove-time]");
        if (!btn) return;
        if (els.rmTimesList.children.length <= 1) return;
        btn.closest(".time-row").remove();
        updateReminderTimesHint();
    });

    // Reminder card actions (event delegation)
    els.reminderList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        const id = btn.dataset.id;
        if (btn.dataset.action === "take") markNextReminderTaken(id);
        if (btn.dataset.action === "edit") openEditReminder(id);
        if (btn.dataset.action === "delete") askReminderDelete(id);
    });

    // Today's schedule actions (event delegation)
    els.todayScheduleList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        const id = btn.dataset.id;
        const time = btn.dataset.time;
        if (btn.dataset.action === "take") logOccurrence(id, todayString(), time, "taken");
        if (btn.dataset.action === "miss") logOccurrence(id, todayString(), time, "missed");
    });

    // Delete confirm
    els.confirmReminderDeleteBtn.addEventListener("click", handleReminderDelete);

    // Browser notifications
    els.notifEnableBtn.addEventListener("click", enableNotifications);
    els.notifDisableBtn.addEventListener("click", disableNotifications);
    els.notifTestBtn.addEventListener("click", sendTestNotification);
}

/* ============================================================
   API communication
   ============================================================ */
async function loadMedicines(notify = false) {
    showLoading(true);
    try {
        const res = await apiFetch(API_URL, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json();
        medicines = Array.isArray(data) ? data : [];
        renderAll();
        if (notify) showToast("Medicine data refreshed.", "success");
    } catch (err) {
        medicines = [];
        renderAll();
        showToast(err.message || "Unable to load medicines.", "error");
    } finally {
        showLoading(false);
        // Keep the expiry dashboard in sync with the medicine records
        loadExpiry();
    }
}

async function readError(res) {
    try {
        const data = await res.json();
        if (data && data.details) return Object.values(data.details).join(" ");
        if (data && data.error) return data.error;
    } catch (_) { /* ignore parse errors */ }
    return `Request failed (${res.status}).`;
}

/* ============================================================
   Rendering
   ============================================================ */
function renderAll() {
    renderStats();
    renderInventory();
    renderUpcoming();
    renderTable();
    updateSettingsInfo();
}

function renderStats() {
    const { total, active, expiring, expired } = computeStats();
    els.statTotal.textContent = total;
    els.statActive.textContent = active;
    els.statExpiring.textContent = expiring;
    els.statExpired.textContent = expired;
}

function renderInventory() {
    const { total, active, expiring, expired } = computeStats();
    setProgress(els.invActiveBar, els.invActiveCount, els.invActivePct, active, total);
    setProgress(els.invExpiringBar, els.invExpiringCount, els.invExpiringPct, expiring, total);
    setProgress(els.invExpiredBar, els.invExpiredCount, els.invExpiredPct, expired, total);

    els.inventorySummary.textContent = total === 0
        ? "No medicines recorded yet."
        : `${active} of ${total} medicine${total === 1 ? "" : "s"} are currently active.`;
}

function setProgress(bar, countEl, pctEl, value, total) {
    const pct = total > 0 ? Math.round((value / total) * 100) : 0;
    bar.style.width = `${pct}%`;
    countEl.textContent = value;
    pctEl.textContent = `(${pct}%)`;
}

function renderUpcoming() {
    const list = els.upcomingList;
    list.innerHTML = "";

    const upcoming = medicines
        .filter((m) => m.expiry_date && getStatus(m) !== "expired")
        .sort((a, b) => daysUntil(a.expiry_date) - daysUntil(b.expiry_date))
        .slice(0, UPCOMING_LIMIT);

    if (upcoming.length === 0) {
        list.innerHTML = `<li class="empty-inline d-block">No upcoming expiries.</li>`;
        return;
    }

    upcoming.forEach((m) => {
        const days = daysUntil(m.expiry_date);
        const li = document.createElement("li");
        li.innerHTML = `
      <div>
        <div class="upcoming-name">${escapeHtml(m.name)}</div>
        <div class="upcoming-meta">${escapeHtml(m.dosage || "—")} · ${formatDate(m.expiry_date)}</div>
      </div>
      <span class="status-pill ${days <= EXPIRING_DAYS ? "pill-expiring" : "pill-active"}">
        ${days <= 0 ? "Expires today" : `in ${days} day${days === 1 ? "" : "s"}`}
      </span>`;
        list.appendChild(li);
    });
}

function renderTable() {
    const rows = getFilteredMedicines();
    const body = els.medicinesBody;
    body.innerHTML = "";

    const isEmpty = medicines.length === 0;
    const noMatches = !isEmpty && rows.length === 0;

    // Empty / no-match states
    if (isEmpty || noMatches) {
        els.tableEmpty.classList.remove("d-none");
        els.emptyTitle.textContent = isEmpty ? "No medicines yet" : "No matching medicines";
        els.emptyText.textContent = isEmpty
            ? "Start by adding your first medicine to the inventory."
            : "Try a different search term or status filter.";
        els.emptyAddBtn.classList.toggle("d-none", !isEmpty);
    } else {
        els.tableEmpty.classList.add("d-none");
    }

    rows.forEach((m) => {
        const status = getStatus(m);
        const tr = document.createElement("tr");
        tr.innerHTML = `
      <td>
        <span class="med-name">${escapeHtml(m.name)}</span>
        ${m.notes ? `<span class="med-notes">${escapeHtml(m.notes)}</span>` : ""}
      </td>
      <td>${escapeHtml(m.dosage || "—")}</td>
      <td>${escapeHtml(m.frequency || "—")}</td>
      <td>${m.expiry_date ? formatDate(m.expiry_date) : "—"}</td>
      <td>${statusPill(status)}</td>
      <td class="text-end text-nowrap">
        <button class="action-btn" data-action="view" data-id="${m.id}" title="View details" aria-label="View details">
          <i class="bi bi-eye"></i>
        </button>
        <button class="action-btn ms-1" data-action="edit" data-id="${m.id}" title="Edit" aria-label="Edit">
          <i class="bi bi-pencil-square"></i>
        </button>
        <button class="action-btn danger ms-1" data-action="delete" data-id="${m.id}" title="Delete" aria-label="Delete">
          <i class="bi bi-trash"></i>
        </button>
      </td>`;
        body.appendChild(tr);
    });
}

function statusPill(status) {
    const map = {
        active: { cls: "pill-active", icon: "bi-check-circle-fill", label: "Active" },
        expiring: { cls: "pill-expiring", icon: "bi-exclamation-triangle-fill", label: "Expiring soon" },
        expired: { cls: "pill-expired", icon: "bi-x-circle-fill", label: "Expired" },
        unknown: { cls: "pill-unknown", icon: "bi-question-circle-fill", label: "No expiry" },
    };
    const s = map[status] || map.active;
    return `<span class="status-pill ${s.cls}"><i class="bi ${s.icon}"></i>${s.label}</span>`;
}

function updateSettingsInfo() {
    els.settingsTotal.textContent = medicines.length;
    els.settingsLastLoaded.textContent = new Date().toLocaleString();
}

function showLoading(state) {
    els.tableLoading.classList.toggle("d-none", !state);
    if (state) els.tableEmpty.classList.add("d-none");
}

/* ============================================================
   Add / Edit
   ============================================================ */
function openAddModal() {
    editingId = null;
    els.medicineForm.reset();
    clearValidation();
    els.medicineModalTitle.textContent = "Add Medicine";
    els.saveBtnText.textContent = "Save Medicine";
    medicineModal.show();
}

function openEditModal(id) {
    const med = medicines.find((m) => m.id === id);
    if (!med) return;

    editingId = id;
    clearValidation();
    els.medicineId.value = med.id;
    els.name.value = med.name || "";
    els.dosage.value = med.dosage || "";
    els.frequency.value = med.frequency || "";
    els.start_date.value = med.start_date || "";
    els.expiry_date.value = med.expiry_date || "";
    els.notes.value = med.notes || "";

    els.medicineModalTitle.textContent = "Edit Medicine";
    els.saveBtnText.textContent = "Update Medicine";
    medicineModal.show();
}

/* ============================================================
   View details
   ============================================================ */
function openDetails(id) {
    const med = medicines.find((m) => m.id === id);
    if (!med) return;

    detailsEditId = id;
    els.dtlName.textContent = med.name || "—";

    const status = expiryStatus(med);
    els.dtlStatus.innerHTML = `${statusPill(status)}<span class="text-muted small">${statusHint(med)}</span>`;
    els.dtlDosage.textContent = med.dosage || "—";
    els.dtlFrequency.textContent = med.frequency || "—";
    els.dtlStart.textContent = med.start_date ? formatDate(med.start_date) : "Not set";
    els.dtlExpiry.textContent = med.expiry_date ? formatDate(med.expiry_date) : "Not set";
    els.dtlExpiryStatus.innerHTML = `${statusPill(status)}<span class="text-muted small">${statusHint(med)}</span>`;

    // Expiry warning banner (only when the medicine needs attention)
    const days = daysUntil(med.expiry_date);
    if (status === "expired" || status === "expiring") {
        const isExpired = status === "expired";
        els.dtlExpiryWarning.className = `span-2 expiry-warning ${isExpired ? "warning-red" : "warning-amber"}`;
        els.dtlExpiryWarning.innerHTML = `<i class="bi bi-exclamation-triangle-fill"></i><span>${isExpired
            ? `This medicine expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago — do not use it.`
            : `This medicine expires in ${days} day${days === 1 ? "" : "s"} — plan a replacement.`
            }</span>`;
    } else {
        els.dtlExpiryWarning.className = "span-2 d-none";
        els.dtlExpiryWarning.innerHTML = "";
    }

    els.dtlNotes.textContent = med.notes || "—";
    els.dtlId.textContent = med.id;

    detailsModal.show();
}

// Human-readable description of the dynamic status
function statusHint(med) {
    const days = daysUntil(med.expiry_date);
    if (days === null) return "No expiry date set";
    if (days < 0) return `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
    if (days === 0) return "Expires today";
    return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}

async function handleSubmit(e) {
    e.preventDefault();
    clearValidation();
    if (!validateForm()) return;

    const payload = {
        name: els.name.value.trim(),
        dosage: els.dosage.value.trim(),
        frequency: els.frequency.value.trim(),
        start_date: els.start_date.value,
        expiry_date: els.expiry_date.value,
        notes: els.notes.value.trim(),
    };

    setSaving(true);
    try {
        const url = editingId ? `${API_URL}/${editingId}` : API_URL;
        const method = editingId ? "PUT" : "POST";
        const res = await apiFetch(url, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!res.ok) throw new Error(await readError(res));

        medicineModal.hide();
        showToast(editingId ? "Medicine updated successfully." : "Medicine added successfully.", "success");
        await loadMedicines();
    } catch (err) {
        showToast(err.message || "Could not save the medicine.", "error");
    } finally {
        setSaving(false);
    }
}

function setSaving(state) {
    els.saveBtn.disabled = state;
    els.saveSpinner.classList.toggle("d-none", !state);
}

/* ============================================================
   Delete
   ============================================================ */
function askDelete(id) {
    const med = medicines.find((m) => m.id === id);
    if (!med) return;
    pendingDeleteId = id;
    els.deleteName.textContent = med.name;
    deleteModal.show();
}

async function handleDelete() {
    if (!pendingDeleteId) return;
    setDeleting(true);
    try {
        const res = await apiFetch(`${API_URL}/${pendingDeleteId}`, { method: "DELETE" });
        if (!res.ok) throw new Error(await readError(res));

        deleteModal.hide();
        showToast("Medicine deleted successfully.", "success");
        pendingDeleteId = null;
        await loadMedicines();
    } catch (err) {
        showToast(err.message || "Could not delete the medicine.", "error");
    } finally {
        setDeleting(false);
    }
}

function setDeleting(state) {
    els.confirmDeleteBtn.disabled = state;
    els.deleteSpinner.classList.toggle("d-none", !state);
    els.deleteBtnText.textContent = state ? "Deleting..." : "Delete";
}

/* ============================================================
   Navigation
   ============================================================ */
function showView(name) {
    currentView = name;
    document.querySelectorAll(".view").forEach((v) => v.classList.add("d-none"));

    const section = $(`view-${name}`);
    if (section) section.classList.remove("d-none");

    document.querySelectorAll(".side-link[data-view]").forEach((link) => {
        link.classList.toggle("active", link.dataset.view === name);
    });

    const titles = { dashboard: "Dashboard", medicines: "Medicines", expiry: "Expiry Tracking", reminders: "Reminders", settings: "Settings" };
    els.pageTitle.textContent = titles[name] || "MediTrack";

    if (name === "expiry") loadExpiry();
    if (name === "reminders") {
        updateNotifUI();
        renderReminderAll();
    }
}

function openSidebar() {
    els.sidebar.classList.add("show");
    els.sidebarBackdrop.classList.add("show");
}

function closeSidebar() {
    els.sidebar.classList.remove("show");
    els.sidebarBackdrop.classList.remove("show");
}

/* ============================================================
   Validation
   ============================================================ */
function validateForm() {
    let valid = true;

    [els.name, els.dosage, els.frequency].forEach((input) => {
        if (!input.value.trim()) {
            input.classList.add("is-invalid");
            valid = false;
        } else {
            input.classList.remove("is-invalid");
        }
    });

    // Expiry must not be before start date
    if (els.start_date.value && els.expiry_date.value) {
        if (els.expiry_date.value < els.start_date.value) {
            els.expiry_date.classList.add("is-invalid");
            valid = false;
        }
    }

    return valid;
}

function clearValidation() {
    [els.name, els.dosage, els.frequency, els.start_date, els.expiry_date].forEach((input) => {
        input.classList.remove("is-invalid");
    });
}

/* ============================================================
   Helpers
   ============================================================ */
function computeStats() {
    let total = medicines.length;
    let active = 0;
    let expiring = 0;
    let expired = 0;

    medicines.forEach((m) => {
        const status = getStatus(m);
        if (status === "expired") {
            expired += 1;
        } else {
            active += 1; // active includes those expiring soon
            if (status === "expiring") expiring += 1;
        }
    });

    return { total, active, expiring, expired };
}

// Expiry category for a medicine, incl. "unknown" when the expiry date is
// missing or invalid. Calculated live from the current date — never stored.
function expiryStatus(med) {
    const days = daysUntil(med.expiry_date);
    if (days === null) return "unknown";
    if (days < 0) return "expired";
    if (days <= EXPIRING_DAYS) return "expiring";
    return "active";
}

// Inventory status used by the medicines views (a missing date counts as active)
function getStatus(med) {
    const status = expiryStatus(med);
    return status === "unknown" ? "active" : status;
}

function getFilteredMedicines() {
    const query = els.searchInput.value.trim().toLowerCase();
    const filter = els.statusFilter.value;

    const filtered = medicines.filter((m) => {
        const matchesQuery = !query
            || (m.name || "").toLowerCase().includes(query)
            || (m.dosage || "").toLowerCase().includes(query)
            || (m.frequency || "").toLowerCase().includes(query);
        const matchesFilter = filter === "all" || getStatus(m) === filter;
        return matchesQuery && matchesFilter;
    });

    return sortMedicines(filtered);
}

// Sort the visible medicines by name or expiry date (records without an
// expiry date always sort last so they never bury real dates)
function sortMedicines(list) {
    const sort = els.sortSelect.value;
    const rows = [...list];

    if (sort === "name_asc" || sort === "name_desc") {
        const dir = sort === "name_desc" ? -1 : 1;
        rows.sort((a, b) => dir * (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
    } else if (sort === "expiry_asc" || sort === "expiry_desc") {
        const dir = sort === "expiry_desc" ? -1 : 1;
        rows.sort((a, b) => {
            const da = daysUntil(a.expiry_date);
            const db = daysUntil(b.expiry_date);
            if (da === null && db === null) return 0;
            if (da === null) return 1;
            if (db === null) return -1;
            return dir * (da - db);
        });
    }

    return rows;
}

// Parse a YYYY-MM-DD string into a local Date (avoids timezone shifts)
function parseDate(value) {
    if (!value || typeof value !== "string") return null;
    const parts = value.split("-");
    if (parts.length !== 3) return null;
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    const d = new Date(year, month - 1, day);
    // Reject out-of-range values (e.g. 2026-99-99) that Date would otherwise roll over
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return d;
}

// Whole days from today until the given date (negative = past)
function daysUntil(value) {
    const date = parseDate(value);
    if (!date) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((date.getTime() - today.getTime()) / 86400000);
}

function formatDate(value) {
    const date = parseDate(value);
    if (!date) return "—";
    return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function escapeHtml(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/* ============================================================
   Notifications
   ============================================================ */
function showToast(message, type = "success") {
    const container = $("toastContainer");
    const isError = type === "error";
    const bg = isError ? "text-bg-danger" : "text-bg-success";
    const icon = isError ? "bi-exclamation-triangle-fill" : "bi-check-circle-fill";

    const el = document.createElement("div");
    el.className = `toast align-items-center ${bg} border-0`;
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", "assertive");
    el.setAttribute("aria-atomic", "true");
    el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body"><i class="bi ${icon} me-2"></i>${escapeHtml(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;

    container.appendChild(el);
    const toast = new bootstrap.Toast(el, { delay: 3500 });
    toast.show();
    el.addEventListener("hidden.bs.toast", () => el.remove());
}

/* ============================================================
   Step 5 – Reminders
   ============================================================ */

/* ---------- Data loading ---------- */
async function loadReminders(notify = false) {
    try {
        const [rRes, lRes] = await Promise.all([
            apiFetch(REMINDER_API, { headers: { Accept: "application/json" } }),
            apiFetch(REMINDER_LOG_API, { headers: { Accept: "application/json" } }),
        ]);
        if (!rRes.ok) throw new Error(await readError(rRes));
        const rData = await rRes.json();
        const lData = lRes.ok ? await lRes.json() : [];
        reminders = Array.isArray(rData) ? rData : [];
        reminderLogs = Array.isArray(lData) ? lData : [];
        renderReminderAll();
        checkDueReminders();
        if (notify) showToast("Reminders refreshed.", "success");
    } catch (err) {
        reminders = [];
        reminderLogs = [];
        renderReminderAll();
        showToast(err.message || "Unable to load reminders.", "error");
    }
}

/* ---------- Rendering ---------- */
function renderReminderAll() {
    renderReminderStats();
    renderTodaySchedule();
    renderUpcomingReminders();
    renderReminderList();
}

function renderReminderStats() {
    const todayStr = todayString();
    let active = 0, due = 0, taken = 0, missed = 0;

    reminders.forEach((r) => {
        if (r.status === "active") active += 1;
        if (!reminderAppliesOn(r, todayStr)) return;
        r.times.forEach((t) => {
            const st = occurrenceStatus(r, todayStr, t);
            if (st === "due") due += 1;
            else if (st === "taken") taken += 1;
            else if (st === "missed") missed += 1;
        });
    });

    els.statActiveReminders.textContent = active;
    els.statDue.textContent = due;
    els.statTaken.textContent = taken;
    els.statMissed.textContent = missed;
}

function renderTodaySchedule() {
    const list = els.todayScheduleList;
    const todayStr = todayString();
    els.todayDateLabel.textContent = formatDate(todayStr);
    list.innerHTML = "";

    const items = [];
    reminders.forEach((r) => {
        if (!reminderAppliesOn(r, todayStr)) return;
        r.times.forEach((t) => items.push({ reminder: r, time: t }));
    });
    items.sort((a, b) => a.time.localeCompare(b.time));

    if (items.length === 0) {
        list.innerHTML = `<li class="empty-inline d-block">No doses scheduled for today.</li>`;
        return;
    }

    items.forEach(({ reminder, time }) => {
        const st = occurrenceStatus(reminder, todayStr, time);
        const li = document.createElement("li");
        li.className = "schedule-item";
        li.innerHTML = `
      <div class="schedule-time">${formatTime(time)}<span class="schedule-period">${periodOf(time)}</span></div>
      <div class="schedule-info">
        <div class="schedule-name">${escapeHtml(reminder.medicine_name)}</div>
        <div class="schedule-meta">${escapeHtml(reminder.dosage)} · ${escapeHtml(reminder.frequency)}</div>
      </div>
      <div class="schedule-actions">
        ${reminderStatusPill(st)}
        ${st !== "taken"
                ? `<button class="action-btn" data-action="take" data-id="${reminder.id}" data-time="${time}" title="Mark as taken" aria-label="Mark as taken"><i class="bi bi-check-lg"></i></button>`
                : ""}
        ${(st === "due" || st === "upcoming")
                ? `<button class="action-btn danger" data-action="miss" data-id="${reminder.id}" data-time="${time}" title="Mark as missed" aria-label="Mark as missed"><i class="bi bi-x-lg"></i></button>`
                : ""}
      </div>`;
        list.appendChild(li);
    });
}

function renderUpcomingReminders() {
    const list = els.upcomingRemindersList;
    list.innerHTML = "";

    const now = new Date();
    const todayStr = todayString();
    const items = [];

    // Look ahead 7 days for occurrences that are still in the future
    reminders.forEach((r) => {
        if (r.status !== "active") return;
        for (let d = 0; d < 7; d++) {
            const dateStr = addDaysString(d);
            if (!reminderAppliesOn(r, dateStr)) continue;
            r.times.forEach((t) => {
                const when = parseDateTime(dateStr, t);
                if (!when || when <= now) return;
                if (hasLog(r.id, dateStr, t)) return;
                items.push({ reminder: r, dateStr, time: t, when });
            });
        }
    });

    items.sort((a, b) => a.when - b.when);

    if (items.length === 0) {
        list.innerHTML = `<li class="empty-inline d-block">No upcoming reminders.</li>`;
        return;
    }

    items.slice(0, REMINDER_UPCOMING_LIMIT).forEach(({ reminder, dateStr, time }) => {
        const dayLabel = dateStr === todayStr ? "Today"
            : dateStr === addDaysString(1) ? "Tomorrow" : formatDate(dateStr);
        const li = document.createElement("li");
        li.innerHTML = `
      <div>
        <div class="upcoming-name">${escapeHtml(reminder.medicine_name)}</div>
        <div class="upcoming-meta">${escapeHtml(reminder.dosage)} · ${dayLabel}, ${formatTime(time)}</div>
      </div>
      <span class="status-pill pill-upcoming"><i class="bi bi-clock"></i>${dayLabel}</span>`;
        list.appendChild(li);
    });
}

function renderReminderList() {
    const wrap = els.reminderList;
    const query = (els.reminderSearch.value || "").trim().toLowerCase();
    wrap.innerHTML = "";

    const list = reminders.filter((r) =>
        !query || (r.medicine_name || "").toLowerCase().includes(query));

    list.sort((a, b) => {
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        return (a.medicine_name || "").localeCompare(b.medicine_name || "", undefined, { sensitivity: "base" });
    });

    const isEmpty = reminders.length === 0;
    const noMatches = !isEmpty && list.length === 0;
    els.reminderEmpty.classList.toggle("d-none", !(isEmpty || noMatches));
    els.reminderEmpty.querySelector("h3").textContent = noMatches ? "No matching reminders" : "No reminders yet";
    els.reminderEmpty.querySelector("p").textContent = noMatches
        ? "Try a different search term."
        : "Create a schedule to be reminded about your medicines.";

    list.forEach((r) => {
        const pending = pendingTodayOccurrence(r);
        const card = document.createElement("div");
        card.className = "reminder-card";
        card.innerHTML = `
      <div class="reminder-card-head">
        <div>
          <div class="reminder-card-name">${escapeHtml(r.medicine_name)}</div>
          <div class="reminder-card-meta">${escapeHtml(r.dosage)} · ${escapeHtml(r.frequency)}</div>
        </div>
        ${r.status === "active"
                ? `<span class="status-pill pill-active"><i class="bi bi-check-circle-fill"></i>Active</span>`
                : `<span class="status-pill pill-inactive"><i class="bi bi-pause-circle-fill"></i>Inactive</span>`}
      </div>
      <div class="time-chips">
        ${(r.times || []).map((t) => `<span class="time-chip"><i class="bi bi-clock me-1"></i>${formatTime(t)}</span>`).join("")}
      </div>
      <div class="reminder-card-dates">
        <i class="bi bi-calendar3"></i><span>${escapeHtml(formatRange(r.start_date, r.end_date))}</span>
      </div>
      <div class="reminder-card-actions">
        ${r.status === "active" && pending
                ? `<button class="btn btn-outline-primary btn-sm" data-action="take" data-id="${r.id}"><i class="bi bi-check-lg me-1"></i>Taken</button>`
                : ""}
        <button class="action-btn" data-action="edit" data-id="${r.id}" title="Edit" aria-label="Edit"><i class="bi bi-pencil-square"></i></button>
        <button class="action-btn danger" data-action="delete" data-id="${r.id}" title="Delete" aria-label="Delete"><i class="bi bi-trash"></i></button>
      </div>`;
        wrap.appendChild(card);
    });
}

function reminderStatusPill(status) {
    const map = {
        upcoming: { cls: "pill-upcoming", icon: "bi-clock", label: "Upcoming" },
        due: { cls: "pill-due", icon: "bi-bell-fill", label: "Due" },
        taken: { cls: "pill-taken", icon: "bi-check-circle-fill", label: "Taken" },
        missed: { cls: "pill-missed", icon: "bi-x-circle-fill", label: "Missed" },
        inactive: { cls: "pill-inactive", icon: "bi-pause-circle-fill", label: "Inactive" },
    };
    const s = map[status] || map.upcoming;
    return `<span class="status-pill ${s.cls}"><i class="bi ${s.icon}"></i>${s.label}</span>`;
}

/* ---------- Occurrence helpers ---------- */
// A reminder applies on a date only if it is active and within its date range
function reminderAppliesOn(reminder, dateStr) {
    if (reminder.status !== "active") return false;
    if (reminder.start_date && dateStr < reminder.start_date) return false;
    if (reminder.end_date && dateStr > reminder.end_date) return false;
    return true;
}

// Status of one scheduled occurrence (reminder + date + time)
function occurrenceStatus(reminder, dateStr, timeStr) {
    const log = findLog(reminder.id, dateStr, timeStr);
    if (log) return log.status === "taken" ? "taken" : "missed";
    if (reminder.status !== "active") return "inactive";

    const when = parseDateTime(dateStr, timeStr);
    const now = new Date();
    if (when > now) return "upcoming";

    const lateMinutes = (now - when) / 60000;
    return lateMinutes <= DUE_GRACE_MINUTES ? "due" : "missed";
}

function findLog(reminderId, dateStr, timeStr) {
    return reminderLogs.find((l) =>
        l.reminder_id === reminderId && l.date === dateStr && l.time === timeStr) || null;
}

function hasLog(reminderId, dateStr, timeStr) {
    return !!findLog(reminderId, dateStr, timeStr);
}

// Earliest today's occurrence for a reminder that has no record yet
function pendingTodayOccurrence(reminder) {
    const todayStr = todayString();
    if (!reminderAppliesOn(reminder, todayStr)) return null;
    const times = [...(reminder.times || [])].sort();
    for (const t of times) {
        if (!hasLog(reminder.id, todayStr, t)) return t;
    }
    return null;
}

/* ---------- Recording completion ---------- */
async function logOccurrence(reminderId, dateStr, timeStr, status) {
    try {
        const res = await apiFetch(`${REMINDER_API}/${reminderId}/log`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date: dateStr, time: timeStr, status }),
        });
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json();

        const idx = reminderLogs.findIndex((l) =>
            l.reminder_id === reminderId && l.date === dateStr && l.time === timeStr);
        if (idx >= 0) reminderLogs[idx] = data.log;
        else reminderLogs.push(data.log);

        renderReminderAll();
        showToast(status === "taken" ? "Marked as taken." : "Marked as missed.", "success");
    } catch (err) {
        showToast(err.message || "Could not record the reminder.", "error");
    }
}

// Mark the next pending dose (earliest today) for a reminder as taken
function markNextReminderTaken(reminderId) {
    const r = reminders.find((x) => x.id === reminderId);
    if (!r) return;
    const time = pendingTodayOccurrence(r);
    if (!time) {
        showToast("No pending dose for this reminder today.", "error");
        return;
    }
    logOccurrence(reminderId, todayString(), time, "taken");
}

/* ---------- Add / edit reminder ---------- */
function openAddReminder() {
    editingReminderId = null;
    els.reminderForm.reset();
    els.reminderId.value = "";
    populateMedicineOptions("");
    els.rmFrequency.value = "Once daily";
    els.rmStatus.value = "active";
    renderTimeRows([]);
    els.reminderModalTitle.textContent = "Add Reminder";
    els.reminderSaveBtnText.textContent = "Save Reminder";
    clearReminderValidation();
    reminderModal.show();
}

function openEditReminder(id) {
    const r = reminders.find((x) => x.id === id);
    if (!r) return;

    editingReminderId = id;
    clearReminderValidation();
    populateMedicineOptions(r.medicine_id);
    els.reminderId.value = r.id;
    els.rmMedicine.value = r.medicine_id;
    els.rmDosage.value = r.dosage || "";
    els.rmFrequency.value = FREQUENCY_TIME_COUNT[r.frequency] ? r.frequency : "Custom";
    els.rmStatus.value = r.status || "active";
    els.rmStart.value = r.start_date || "";
    els.rmEnd.value = r.end_date || "";
    renderTimeRows(r.times || []);

    els.reminderModalTitle.textContent = "Edit Reminder";
    els.reminderSaveBtnText.textContent = "Update Reminder";
    reminderModal.show();
}

function populateMedicineOptions(selectedId) {
    const select = els.rmMedicine;
    const current = selectedId || select.value;
    // Expired medicines must not receive new dosage reminders. The currently
    // selected one is still listed so an existing reminder stays editable.
    const available = medicines.filter((m) => expiryStatus(m) !== "expired" || m.id === current);
    select.innerHTML = `<option value="">Select a medicine…</option>`
        + available.map((m) => {
            const suffix = expiryStatus(m) === "expired" ? " (expired)" : "";
            return `<option value="${m.id}">${escapeHtml(m.name)}${suffix}</option>`;
        }).join("");
    if (current && available.some((m) => m.id === current)) select.value = current;
}

function onReminderMedicineChange() {
    const med = medicines.find((m) => m.id === els.rmMedicine.value);
    if (med) els.rmDosage.value = med.dosage || "";
}

// Number of times required by the current frequency (null = custom)
function requiredTimeCount() {
    return FREQUENCY_TIME_COUNT[els.rmFrequency.value] ?? null;
}

function onReminderFrequencyChange() {
    const req = requiredTimeCount();
    const existing = getTimeRowValues().filter(Boolean);
    renderTimeRows(existing.slice(0, req ?? existing.length));
}

function renderTimeRows(values) {
    els.rmTimesList.innerHTML = "";
    const req = requiredTimeCount();
    const target = req != null ? req : Math.max(values.length, 1);
    for (let i = 0; i < target; i++) addTimeRow(values[i] || "");
    els.rmAddTimeBtn.classList.toggle("d-none", req != null);
    updateReminderTimesHint();
}

function addTimeRow(value = "") {
    const row = document.createElement("div");
    row.className = "time-row";
    row.innerHTML = `
    <input type="time" class="form-control form-control-sm" value="${value}" />
    ${requiredTimeCount() == null
            ? `<button type="button" class="action-btn danger" data-remove-time title="Remove time" aria-label="Remove time"><i class="bi bi-dash-lg"></i></button>`
            : ""}`;
    els.rmTimesList.appendChild(row);
}

function getTimeRowValues() {
    return Array.from(els.rmTimesList.querySelectorAll("input[type='time']")).map((i) => i.value);
}

function updateReminderTimesHint() {
    const req = requiredTimeCount();
    const count = getTimeRowValues().length;
    els.rmTimesHint.textContent = req != null
        ? `${req} time${req === 1 ? "" : "s"} required`
        : `${count} time${count === 1 ? "" : "s"}`;
}

function clearReminderValidation() {
    els.rmMedicine.classList.remove("is-invalid");
    els.rmDosage.classList.remove("is-invalid");
    els.rmEnd.classList.remove("is-invalid");
    els.rmTimesError.classList.add("d-none");
}

function setReminderSaving(state) {
    els.reminderSaveBtn.disabled = state;
    els.reminderSaveSpinner.classList.toggle("d-none", !state);
}

async function handleReminderSubmit(e) {
    e.preventDefault();
    clearReminderValidation();

    const medId = els.rmMedicine.value;
    const dosage = els.rmDosage.value.trim();
    const frequency = els.rmFrequency.value;
    const status = els.rmStatus.value;
    const start = els.rmStart.value;
    const end = els.rmEnd.value;
    const times = getTimeRowValues().filter(Boolean);
    const req = requiredTimeCount();

    let valid = true;
    if (!medId) { els.rmMedicine.classList.add("is-invalid"); valid = false; }
    if (!dosage) { els.rmDosage.classList.add("is-invalid"); valid = false; }

    const timesInvalid = times.length === 0
        || (req != null && times.length !== req)
        || new Set(times).size !== times.length;
    if (timesInvalid) { els.rmTimesError.classList.remove("d-none"); valid = false; }
    if (start && end && end < start) { els.rmEnd.classList.add("is-invalid"); valid = false; }

    if (!valid) return;

    const med = medicines.find((m) => m.id === medId);

    // An expired medicine cannot be given a brand new dosage reminder
    if (!editingReminderId && med && expiryStatus(med) === "expired") {
        showToast("This medicine has expired and cannot receive a new reminder.", "error");
        return;
    }

    const payload = {
        medicine_id: medId,
        medicine_name: med ? med.name : els.rmMedicine.selectedOptions[0].textContent,
        dosage,
        frequency,
        times: times.sort(),
        start_date: start,
        end_date: end,
        status,
    };

    setReminderSaving(true);
    try {
        const url = editingReminderId ? `${REMINDER_API}/${editingReminderId}` : REMINDER_API;
        const method = editingReminderId ? "PUT" : "POST";
        const res = await apiFetch(url, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await readError(res));

        reminderModal.hide();
        showToast(editingReminderId ? "Reminder updated successfully." : "Reminder added successfully.", "success");
        await loadReminders();
    } catch (err) {
        showToast(err.message || "Could not save the reminder.", "error");
    } finally {
        setReminderSaving(false);
    }
}

/* ---------- Delete reminder ---------- */
function askReminderDelete(id) {
    const r = reminders.find((x) => x.id === id);
    if (!r) return;
    pendingDeleteReminderId = id;
    els.reminderDeleteName.textContent = r.medicine_name;
    reminderDeleteModal.show();
}

async function handleReminderDelete() {
    if (!pendingDeleteReminderId) return;
    setReminderDeleting(true);
    try {
        const res = await apiFetch(`${REMINDER_API}/${pendingDeleteReminderId}`, { method: "DELETE" });
        if (!res.ok) throw new Error(await readError(res));

        reminderDeleteModal.hide();
        showToast("Reminder deleted successfully.", "success");
        pendingDeleteReminderId = null;
        await loadReminders();
    } catch (err) {
        showToast(err.message || "Could not delete the reminder.", "error");
    } finally {
        setReminderDeleting(false);
    }
}

function setReminderDeleting(state) {
    els.confirmReminderDeleteBtn.disabled = state;
    els.reminderDeleteSpinner.classList.toggle("d-none", !state);
    els.reminderDeleteBtnText.textContent = state ? "Deleting..." : "Delete";
}

/* ============================================================
   Browser notifications (Notification API)
   ============================================================ */
function notificationsSupported() {
    return "Notification" in window;
}

function notificationsEnabled() {
    return notificationsSupported()
        && Notification.permission === "granted"
        && localStorage.getItem(NOTIF_ENABLED_KEY) === "1";
}

function updateNotifUI() {
    if (!notificationsSupported()) {
        els.notifState.textContent = "Browser notifications are not supported in this browser.";
        els.notifEnableBtn.classList.add("d-none");
        els.notifDisableBtn.classList.add("d-none");
        els.notifTestBtn.classList.add("d-none");
        return;
    }

    const perm = Notification.permission;
    const enabled = notificationsEnabled();

    if (perm === "denied") {
        els.notifState.textContent = "Notifications are blocked — allow them in your browser's site settings.";
    } else if (perm === "granted" && enabled) {
        els.notifState.textContent = "Notifications are on. You will be alerted while MediTrack is open.";
    } else if (perm === "granted") {
        els.notifState.textContent = "Notifications are available but currently turned off.";
    } else {
        els.notifState.textContent = "Notifications are off.";
    }

    els.notifEnableBtn.classList.toggle("d-none", enabled);
    els.notifDisableBtn.classList.toggle("d-none", !enabled);
    els.notifTestBtn.classList.toggle("d-none", perm !== "granted");
}

async function enableNotifications() {
    if (!notificationsSupported()) {
        showToast("This browser does not support notifications.", "error");
        return;
    }
    try {
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
            localStorage.setItem(NOTIF_ENABLED_KEY, "1");
            showToast("Browser notifications enabled.", "success");
        } else if (perm === "denied") {
            showToast("Notifications were blocked. Allow them in browser settings to receive reminders.", "error");
        } else {
            showToast("Notification permission was not granted.", "error");
        }
    } catch (_) {
        showToast("Could not request notification permission.", "error");
    }
    updateNotifUI();
}

function disableNotifications() {
    localStorage.setItem(NOTIF_ENABLED_KEY, "0");
    showToast("Browser notifications disabled.", "success");
    updateNotifUI();
}

function sendTestNotification() {
    if (!notificationsSupported() || Notification.permission !== "granted") {
        showToast("Enable notifications first.", "error");
        return;
    }
    showMedicineNotification({ medicine_name: "Test medicine", dosage: "Test dose" }, "08:00", true);
}

function showMedicineNotification(reminder, time, isTest = false) {
    try {
        const title = isTest ? "MediTrack test notification" : "Medicine reminder";
        const body = isTest
            ? `This is a test. ${reminder.medicine_name} · ${reminder.dosage}`
            : `${reminder.medicine_name} · ${reminder.dosage} — scheduled for ${formatTime(time)}`;
        const n = new Notification(title, {
            body,
            tag: isTest ? "meditrack-test" : `meditrack-${reminder.id}-${time}`,
        });
        n.onclick = () => { window.focus(); n.close(); };
    } catch (_) {
        /* notifications can fail silently (e.g. permission revoked) */
    }
}

/* ---------- Duplicate-notification guard ---------- */
function getSentKeys() {
    try {
        const raw = localStorage.getItem(NOTIF_SENT_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

function wasSent(key) {
    return getSentKeys().includes(key);
}

function markSent(key) {
    const keys = getSentKeys();
    if (keys.includes(key)) return;
    keys.push(key);
    localStorage.setItem(NOTIF_SENT_KEY, JSON.stringify(keys.slice(-300)));
}

// Drop keys from previous days so the store does not grow unbounded
function pruneSentKeys() {
    const todayStr = todayString();
    const kept = getSentKeys().filter((k) => (k.split("|")[1] || "") === todayStr);
    localStorage.setItem(NOTIF_SENT_KEY, JSON.stringify(kept));
}

/* ---------- Scheduler (runs only while a tab is open) ---------- */
function startReminderScheduler() {
    pruneSentKeys();
    checkDueReminders();
    if (notifTimer) clearInterval(notifTimer);
    notifTimer = setInterval(checkDueReminders, NOTIF_POLL_MS);
}

function checkDueReminders() {
    // Recompute expiry data if the calendar day rolled over while open
    checkDayChange();

    const now = new Date();
    const todayStr = todayString();
    let notified = false;

    if (notificationsEnabled()) {
        reminders.forEach((r) => {
            if (!reminderAppliesOn(r, todayStr)) return;
            r.times.forEach((t) => {
                const when = parseDateTime(todayStr, t);
                if (!when) return;
                const diffMin = (now - when) / 60000;
                // only fire within the "due" window, once per occurrence
                if (diffMin < 0 || diffMin > DUE_GRACE_MINUTES) return;

                const key = `${r.id}|${todayStr}|${t}`;
                if (hasLog(r.id, todayStr, t) || wasSent(key)) return;

                showMedicineNotification(r, t);
                markSent(key);
                notified = true;
            });
        });
    }

    if (notified) renderReminderAll();
}

/* ---------- Date / time helpers ---------- */
function toDateString(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function todayString() {
    return toDateString(new Date());
}

function addDaysString(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return toDateString(d);
}

function parseDateTime(dateStr, timeStr) {
    const d = parseDate(dateStr);
    if (!d || typeof timeStr !== "string") return null;
    const parts = timeStr.split(":");
    if (parts.length !== 2) return null;
    d.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
    return d;
}

function formatTime(hhmm) {
    if (typeof hhmm !== "string" || !hhmm.includes(":")) return "—";
    const d = parseDateTime(todayString(), hhmm);
    if (!d) return hhmm;
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function periodOf(hhmm) {
    const h = Number(String(hhmm).split(":")[0]);
    if (h < 12) return "Morning";
    if (h < 17) return "Afternoon";
    return "Night";
}

function formatRange(start, end) {
    if (!start && !end) return "No start or end date";
    if (start && end) return `${formatDate(start)} – ${formatDate(end)}`;
    if (start) return `Starts ${formatDate(start)}`;
    return `Ends ${formatDate(end)}`;
}

/* ============================================================
   Step 6 – Medicine expiry tracking
   Expiry status / days remaining are fetched from the backend
   (/api/expiry) and derived from the current date — never stored.
   Expiry alerts are kept separate from the Step 5 dosage reminders.
   ============================================================ */
function emptyExpirySummary() {
    return { total: 0, expired: 0, expiring_7: 0, expiring_30: 0, active: 0, no_expiry: 0 };
}

async function loadExpiry() {
    try {
        const res = await apiFetch(EXPIRY_API, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json();
        expiryData = {
            summary: (data && data.summary) ? data.summary : emptyExpirySummary(),
            medicines: (data && Array.isArray(data.medicines)) ? data.medicines : [],
        };
    } catch (_) {
        expiryData = { summary: emptyExpirySummary(), medicines: [] };
    }
    lastExpiryDay = todayString();
    renderExpiry();
}

// Re-load expiry data when the calendar day changes while the tab stays open
function checkDayChange() {
    const today = todayString();
    if (lastExpiryDay && lastExpiryDay !== today) {
        lastExpiryDay = today;
        loadExpiry();
    }
}

function renderExpiry() {
    if (!els.expiryStatTotal) return;
    renderExpiryStats();
    renderExpiryAlerts();
    renderExpiryTable();
}

function renderExpiryStats() {
    const s = expiryData.summary || {};
    setStatText(els.expiryStatTotal, s.total);
    setStatText(els.expiryStatExpired, s.expired);
    setStatText(els.expiryStat7, s.expiring_7);
    setStatText(els.expiryStat30, s.expiring_30);
    setStatText(els.expiryStatActive, s.active);
}

function setStatText(el, value) {
    if (el) el.textContent = (value === undefined || value === null) ? 0 : value;
}

/* ---------- Expiry alerts ---------- */
const EXPIRY_ALERT_META = {
    expired: { cls: "alert-red", icon: "bi-x-octagon-fill", label: "Expired" },
    today: { cls: "alert-red", icon: "bi-exclamation-octagon-fill", label: "Expires today" },
    "7days": { cls: "alert-amber", icon: "bi-exclamation-triangle-fill", label: "Expiring soon" },
    "30days": { cls: "alert-amber", icon: "bi-hourglass-split", label: "Expiring soon" },
};

// Build the active expiry alerts from the backend payload. Trigger points:
// 30 days before, 7 days before, on the expiry date and after expiry.
function buildExpiryAlerts() {
    const alerts = [];
    (expiryData.medicines || []).forEach((m) => {
        const days = m.days_remaining;
        if (days === null || days === undefined) return; // no usable expiry date
        let type = null;
        if (days < 0) type = "expired";
        else if (days === 0) type = "today";
        else if (days <= EXPIRING_7_DAYS) type = "7days";
        else if (days <= EXPIRING_DAYS) type = "30days";
        if (!type) return;
        alerts.push({
            key: `${m.id}|${type}|${m.expiry_date}`,
            type,
            name: m.name || "Unnamed medicine",
            dosage: m.dosage || "",
            expiry_date: m.expiry_date || "",
            days,
        });
    });
    alerts.sort((a, b) => a.days - b.days);
    return alerts;
}

function expiryAlertMessage(alert) {
    const d = Math.abs(alert.days);
    if (alert.type === "expired") return `Expired ${d} day${d === 1 ? "" : "s"} ago`;
    if (alert.type === "today") return "Expires today";
    return `Expires in ${alert.days} day${alert.days === 1 ? "" : "s"}`;
}

function renderExpiryAlerts() {
    const list = els.expiryAlertList;
    if (!list) return;
    list.innerHTML = "";

    const dismissed = getDismissedAlerts();
    const alerts = buildExpiryAlerts().filter((a) => !dismissed.includes(a.key));

    els.expiryAlertsCount.textContent = `${alerts.length} active alert${alerts.length === 1 ? "" : "s"}`;

    if (alerts.length === 0) {
        list.innerHTML = `<li class="empty-inline d-block">No expiry alerts — all medicines are within safe expiry limits.</li>`;
        return;
    }

    alerts.forEach((a) => {
        const meta = EXPIRY_ALERT_META[a.type] || EXPIRY_ALERT_META["30days"];
        const li = document.createElement("li");
        li.className = `expiry-alert ${meta.cls}`;
        li.innerHTML = `
      <span class="expiry-alert-icon"><i class="bi ${meta.icon}"></i></span>
      <div class="expiry-alert-text">
        <div class="expiry-alert-title">${escapeHtml(a.name)} — ${meta.label}</div>
        <div class="expiry-alert-meta">${expiryAlertMessage(a)} · Expiry date ${escapeHtml(formatDate(a.expiry_date))}${a.dosage ? ` · ${escapeHtml(a.dosage)}` : ""}</div>
      </div>
      <button type="button" class="expiry-alert-dismiss" data-dismiss-alert="${escapeHtml(a.key)}" title="Dismiss" aria-label="Dismiss alert"><i class="bi bi-x-lg"></i></button>`;
        list.appendChild(li);
    });
}

function getDismissedAlerts() {
    try {
        const raw = localStorage.getItem(EXPIRY_DISMISSED_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

function dismissExpiryAlert(key) {
    if (!key) return;
    const keys = getDismissedAlerts();
    if (!keys.includes(key)) {
        keys.push(key);
        localStorage.setItem(EXPIRY_DISMISSED_KEY, JSON.stringify(keys.slice(-500)));
    }
    renderExpiryAlerts();
}

/* ---------- Expiry management table ---------- */
function renderExpiryTable() {
    const body = els.expiryBody;
    if (!body) return;
    body.innerHTML = "";

    const query = (els.expirySearch.value || "").trim().toLowerCase();
    const filter = els.expiryFilter.value;

    let rows = (expiryData.medicines || []).filter((m) => {
        const matchesQuery = !query || (m.name || "").toLowerCase().includes(query);
        const matchesFilter = filter === "all" || (m.status || "unknown") === filter;
        return matchesQuery && matchesFilter;
    });
    rows = sortExpiryRows(rows, els.expirySort.value);

    const isEmpty = (expiryData.medicines || []).length === 0;
    const noMatches = !isEmpty && rows.length === 0;
    els.expiryEmpty.classList.toggle("d-none", !(isEmpty || noMatches));
    els.expiryEmptyTitle.textContent = isEmpty ? "No medicines yet" : "No matching medicines";
    els.expiryEmptyText.textContent = isEmpty
        ? "Add medicines to track their expiry dates."
        : "Try a different search term or status filter.";

    rows.forEach((m) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
      <td><span class="med-name">${escapeHtml(m.name || "—")}</span></td>
      <td>${escapeHtml(m.dosage || "—")}</td>
      <td>${m.expiry_date ? formatDate(m.expiry_date) : "—"}</td>
      <td>${daysRemainingCell(m.days_remaining)}</td>
      <td>${statusPill(m.status || "unknown")}</td>
      <td class="text-end text-nowrap">
        <button class="action-btn" data-action="view" data-id="${m.id}" title="View details" aria-label="View details"><i class="bi bi-eye"></i></button>
        <button class="action-btn ms-1" data-action="edit" data-id="${m.id}" title="Edit" aria-label="Edit"><i class="bi bi-pencil-square"></i></button>
        <button class="action-btn danger ms-1" data-action="delete" data-id="${m.id}" title="Delete" aria-label="Delete"><i class="bi bi-trash"></i></button>
      </td>`;
        body.appendChild(tr);
    });
}

function daysRemainingCell(days) {
    if (days === null || days === undefined) {
        return `<span class="text-muted">—</span>`;
    }
    let cls = "days-green";
    if (days < 0) cls = "days-red";
    else if (days <= EXPIRING_DAYS) cls = "days-amber";

    let label;
    if (days < 0) label = `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`;
    else if (days === 0) label = "Today";
    else label = `${days} day${days === 1 ? "" : "s"}`;

    return `<span class="days-remaining ${cls}">${label}</span>`;
}

function sortExpiryRows(rows, sort) {
    const copy = [...rows];
    const byDays = (asc) => (a, b) => {
        const da = a.days_remaining, db = b.days_remaining;
        const na = (da === null || da === undefined);
        const nb = (db === null || db === undefined);
        if (na && nb) return 0;
        if (na) return 1; // medicines without a date always sort last
        if (nb) return -1;
        return asc ? da - db : db - da;
    };

    if (sort === "name_asc") {
        copy.sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
    } else if (sort === "days_desc") {
        copy.sort(byDays(false));
    } else if (sort === "expiry_asc" || sort === "expiry_desc") {
        const dir = sort === "expiry_desc" ? -1 : 1;
        copy.sort((a, b) => {
            const da = a.expiry_date || "";
            const db = b.expiry_date || "";
            if (!da && !db) return 0;
            if (!da) return 1;
            if (!db) return -1;
            return dir * da.localeCompare(db);
        });
    } else {
        copy.sort(byDays(true)); // days_asc (default)
    }
    return copy;
}
