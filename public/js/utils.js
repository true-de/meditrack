/* ============================================================
   MediTrack — utils.js
   Small shared helpers: DOM, dates, toasts, modals.
   ============================================================ */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/* ---------- Dates ---------- */

/** Returns a "YYYY-MM-DD" key for a given date (local time). */
export function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export const todayKey = () => dateKey();

/** "08:30" -> 510 (minutes since midnight). */
export function minutesFromHHMM(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Current time in minutes since midnight. */
export function nowMinutes(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/** "08:30" -> "8:30 AM". */
export function formatTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${period}`;
}

/** "2026-11-21" -> "Friday, 21 November 2026". */
export function formatDateLong(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** "2026-11-21" -> "Today" / "Yesterday" / "Fri, 21 Nov 2026". */
export function formatDateShort(key) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  if (key === dateKey(today)) return "Today";

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (key === dateKey(yesterday)) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/* ---------- Text ---------- */

export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/* ---------- Toasts ---------- */

export function toast(message, type = "info") {
  const container = $("#toast-container");
  if (!container) return;

  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.textContent = message;
  container.appendChild(el);

  setTimeout(() => {
    el.style.transition = "opacity 0.3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

/* ---------- Modals ---------- */

export function openModal(el) {
  el.hidden = false;
  document.body.style.overflow = "hidden";
}

export function closeModal(el) {
  el.hidden = true;
  document.body.style.overflow = "";
}

/* ---------- Confirm dialog ---------- */

let confirmResolve = null;
let confirmWired = false;

function settleConfirm(value) {
  if (confirmResolve) {
    confirmResolve(value);
    confirmResolve = null;
  }
}

function wireConfirmModal() {
  const modal = $("#confirm-modal");
  modal.addEventListener("click", (event) => {
    if (event.target.matches("[data-close-confirm]")) {
      closeModal(modal);
      settleConfirm(false);
    }
  });
  $("#confirm-ok").addEventListener("click", () => {
    closeModal(modal);
    settleConfirm(true);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) {
      closeModal(modal);
      settleConfirm(false);
    }
  });
}

/** Shows the confirm dialog and resolves true when confirmed. */
export function confirmAction({ title = "Are you sure?", text = "", confirmLabel = "Confirm" } = {}) {
  if (!confirmWired) {
    wireConfirmModal();
    confirmWired = true;
  }
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = confirmLabel;
  openModal($("#confirm-modal"));
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}
