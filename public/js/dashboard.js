/* ============================================================
   MediTrack — dashboard.js  (Phases 6 & 8)
   Today's schedule, progress ring and Taken / Missed actions.
   ============================================================ */

import { $, escapeHtml, formatTime, formatDateLong, todayKey, toast } from "./utils.js";
import { on, getTodayDoses, getMedicines, setDoseStatus, checkDayRollover } from "./store.js";

export function initDashboard() {
  const list = $("#today-list");
  const dateEl = $("#dashboard-date");

  function renderDate() {
    dateEl.textContent = formatDateLong(todayKey());
  }

  function render(doses) {
    renderDate();
    renderProgress(doses);
    renderList(doses);
  }

  list.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-status]");
    if (!button) return;

    button.disabled = true;
    try {
      await setDoseStatus(button.dataset.id, button.dataset.status);
      toast(button.dataset.status === "pending" ? "Marked as pending." : `Marked as ${button.dataset.status}.`, "success");
    } catch (error) {
      console.error(error);
      toast("Could not update the dose.", "error");
      button.disabled = false;
    }
  });

  on("today", render);
  render(getTodayDoses());

  // Keep the date and "today" pointer fresh if the app stays open.
  setInterval(() => {
    renderDate();
    checkDayRollover();
  }, 60 * 1000);
}

/* ---------- Progress ---------- */

function renderProgress(doses) {
  const taken = doses.filter((d) => d.status === "taken").length;
  const missed = doses.filter((d) => d.status === "missed").length;
  const pending = doses.filter((d) => d.status === "pending").length;
  const total = doses.length;

  $("#stat-taken").textContent = taken;
  $("#stat-pending").textContent = pending;
  $("#stat-missed").textContent = missed;

  const percent = total === 0 ? 0 : Math.round((taken / total) * 100);
  $("#progress-percent").textContent = `${percent}%`;

  const ring = $("#ring-fill");
  const radius = ring.r.baseVal.value;
  const circumference = 2 * Math.PI * radius;
  ring.style.strokeDasharray = `${circumference}`;
  ring.style.strokeDashoffset = `${circumference * (1 - percent / 100)}`;
  ring.style.stroke = percent === 100 ? "var(--color-taken)" : "var(--color-primary)";
}

/* ---------- List ---------- */

function doseItem(dose) {
  const time = escapeHtml(formatTime(dose.time));
  const meta = escapeHtml(dose.dosage) + (dose.instructions ? ` · ${escapeHtml(dose.instructions)}` : "");
  const info = `
    <div class="dose-item__info">
      <span class="dose-item__name">${escapeHtml(dose.medicineName)}</span>
      <span class="dose-item__meta">${meta}</span>
    </div>`;

  if (dose.status === "pending") {
    return `
      <div class="dose-item status-pending">
        <span class="dose-item__time">${time}</span>
        ${info}
        <div class="dose-item__actions">
          <button class="btn btn--taken btn--sm" data-status="taken" data-id="${dose.id}">
            <svg class="ico"><use href="#icon-check" /></svg> Taken
          </button>
          <button class="btn btn--missed btn--sm" data-status="missed" data-id="${dose.id}">
            <svg class="ico"><use href="#icon-x" /></svg> Missed
          </button>
        </div>
      </div>`;
  }

  const isTaken = dose.status === "taken";
  const icon = isTaken ? "icon-check" : "icon-x";
  return `
    <div class="dose-item status-${dose.status}">
      <span class="dose-item__time">${time}</span>
      ${info}
      <button class="badge badge--${dose.status}" data-status="pending" data-id="${dose.id}"
        title="Tap to undo" aria-label="Undo — mark as pending">
        <svg class="ico"><use href="#${icon}" /></svg> ${isTaken ? "Taken" : "Missed"}
      </button>
    </div>`;
}

function renderList(doses) {
  const list = $("#today-list");

  if (doses.length === 0) {
    const hasMedicines = getMedicines().length > 0;
    list.innerHTML = `
      <div class="empty">
        <div class="empty__icon"><svg class="ico"><use href="#icon-pill" /></svg></div>
        <p><strong>Nothing scheduled today</strong></p>
        <p>${
          hasMedicines
            ? "Your medicines have no doses for today."
            : "Add a medicine to build today's schedule."
        }</p>
      </div>`;
    return;
  }

  list.innerHTML = doses.map(doseItem).join("");
}
