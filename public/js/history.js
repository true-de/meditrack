/* ============================================================
   MediTrack — history.js  (Phase 8)
   Medication history grouped by day, with a status filter.
   ============================================================ */

import { $, escapeHtml, formatTime, formatDateShort } from "./utils.js";
import { on } from "./store.js";

let allDoses = [];

export function initHistory() {
  $("#history-filter").addEventListener("change", render);
  on("history", (doses) => {
    allDoses = doses;
    render();
  });
  render();
}

function historyItem(dose) {
  const isTaken = dose.status === "taken";
  return `
    <div class="history-item">
      <span class="history-item__time">${escapeHtml(formatTime(dose.time))}</span>
      <div class="history-item__info">
        <div>${escapeHtml(dose.medicineName)}</div>
        <div class="history-item__meta">${escapeHtml(dose.dosage || "")}</div>
      </div>
      <span class="badge badge--${dose.status}">
        <svg class="ico"><use href="#${isTaken ? "icon-check" : "icon-x"}" /></svg>
        ${isTaken ? "Taken" : "Missed"}
      </span>
    </div>`;
}

function render() {
  const list = $("#history-list");
  const filterValue = $("#history-filter").value;
  const doses = filterValue === "all" ? allDoses : allDoses.filter((d) => d.status === filterValue);

  if (doses.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty__icon"><svg class="ico"><use href="#icon-history" /></svg></div>
        <p><strong>No history yet</strong></p>
        <p>Doses you mark as taken or missed will appear here.</p>
      </div>`;
    return;
  }

  const groups = new Map();
  for (const dose of doses) {
    if (!groups.has(dose.date)) groups.set(dose.date, []);
    groups.get(dose.date).push(dose);
  }

  list.innerHTML = [...groups.entries()]
    .map(
      ([date, items]) => `
      <div class="history-group">
        <p class="history-group__date">${escapeHtml(formatDateShort(date))}</p>
        ${items.map(historyItem).join("")}
      </div>`
    )
    .join("");
}
