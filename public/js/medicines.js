/* ============================================================
   MediTrack — medicines.js  (Phase 5)
   Add / edit / delete medicines and render the medicine list.
   ============================================================ */

import { $, $$, escapeHtml, formatTime, openModal, closeModal, confirmAction, toast } from "./utils.js";
import { on, saveMedicine, deleteMedicine, getMedicines } from "./store.js";

let editingId = null;

export function initMedicines() {
  const modal = $("#medicine-modal");
  const form = $("#medicine-form");
  const list = $("#medicines-list");
  const timeInputs = $("#time-inputs");

  $("#add-medicine-btn").addEventListener("click", () => openForm());

  modal.addEventListener("click", (event) => {
    if (event.target.matches("[data-close-modal]")) closeForm();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeForm();
  });

  $("#add-time-btn").addEventListener("click", () => addTimeInput());

  timeInputs.addEventListener("click", (event) => {
    const button = event.target.closest(".remove-time");
    if (!button) return;
    if ($$(".time-row", timeInputs).length > 1) {
      button.closest(".time-row").remove();
    } else {
      toast("At least one daily time is required.", "info");
    }
  });

  form.addEventListener("submit", onSubmit);
  list.addEventListener("click", onListClick);

  on("medicines", render);
  render(getMedicines());
}

/* ---------- Form ---------- */

function addTimeInput(value = "08:00") {
  const row = document.createElement("div");
  row.className = "time-row";
  row.innerHTML = `
    <input type="time" value="${value}" required aria-label="Dose time" />
    <button type="button" class="remove-time" aria-label="Remove this time">
      <svg class="ico"><use href="#icon-x" /></svg>
    </button>`;
  $("#time-inputs").appendChild(row);
}

function collectTimes() {
  const values = $$('#time-inputs input[type="time"]')
    .map((input) => input.value)
    .filter(Boolean);
  return [...new Set(values)].sort();
}

function openForm(medicine = null) {
  editingId = medicine?.id || null;
  $("#medicine-modal-title").textContent = medicine ? "Edit Medicine" : "Add Medicine";
  $("#medicine-name").value = medicine?.name || "";
  $("#medicine-dosage").value = medicine?.dosage || "";
  $("#medicine-instructions").value = medicine?.instructions || "";
  $("#medicine-form-error").hidden = true;

  const timeInputs = $("#time-inputs");
  timeInputs.innerHTML = "";
  const times = medicine?.times?.length ? medicine.times : ["08:00"];
  times.forEach((t) => addTimeInput(t));

  openModal($("#medicine-modal"));
  $("#medicine-name").focus();
}

function closeForm() {
  closeModal($("#medicine-modal"));
  $("#medicine-form").reset();
  $("#medicine-form-error").hidden = true;
  editingId = null;
}

async function onSubmit(event) {
  event.preventDefault();

  const name = $("#medicine-name").value.trim();
  const dosage = $("#medicine-dosage").value.trim();
  const instructions = $("#medicine-instructions").value.trim();
  const times = collectTimes();

  if (!name) return showFormError("Please enter the medicine name.");
  if (!dosage) return showFormError("Please enter the dosage.");
  if (times.length === 0) return showFormError("Please add at least one daily time.");

  const button = $("#medicine-form").querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    await saveMedicine(editingId, { name, dosage, instructions, times });
    toast(editingId ? "Medicine updated." : "Medicine added.", "success");
    closeForm();
  } catch (error) {
    console.error(error);
    showFormError("Could not save the medicine. Please try again.");
  } finally {
    button.disabled = false;
  }
}

function showFormError(message) {
  const errorEl = $("#medicine-form-error");
  errorEl.textContent = message;
  errorEl.hidden = false;
}

/* ---------- List ---------- */

function medicineCard(medicine) {
  const chips = (medicine.times || [])
    .slice()
    .sort()
    .map((time) => `<span class="chip">${escapeHtml(formatTime(time))}</span>`)
    .join("");

  return `
    <article class="medicine-card">
      <span class="medicine-card__icon"><svg class="ico"><use href="#icon-pill" /></svg></span>
      <div class="medicine-card__body">
        <h3 class="medicine-card__name">${escapeHtml(medicine.name)}</h3>
        <p class="medicine-card__dosage">${escapeHtml(medicine.dosage)}</p>
        ${medicine.instructions
      ? `<p class="medicine-card__instructions">${escapeHtml(medicine.instructions)}</p>`
      : ""
    }
        <div class="chip-row">${chips}</div>
      </div>
      <div class="medicine-card__actions">
        <button class="icon-btn" data-action="edit" data-id="${medicine.id}"
          aria-label="Edit ${escapeHtml(medicine.name)}">
          <svg class="ico"><use href="#icon-edit" /></svg>
        </button>
        <button class="icon-btn" data-action="delete" data-id="${medicine.id}"
          aria-label="Delete ${escapeHtml(medicine.name)}">
          <svg class="ico"><use href="#icon-trash" /></svg>
        </button>
      </div>
    </article>`;
}

function render(medicines) {
  const list = $("#medicines-list");

  if (!medicines.length) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty__icon"><svg class="ico"><use href="#icon-pill" /></svg></div>
        <p><strong>No medicines yet</strong></p>
        <p>Add your first medicine to start tracking your doses.</p>
      </div>`;
    return;
  }

  list.innerHTML = medicines.map(medicineCard).join("");
}

async function onListClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const medicine = getMedicines().find((m) => m.id === button.dataset.id);
  if (!medicine) return;

  if (button.dataset.action === "edit") {
    openForm(medicine);
    return;
  }

  if (button.dataset.action === "delete") {
    const confirmed = await confirmAction({
      title: "Delete medicine?",
      text: `"${medicine.name}" and its pending reminders will be removed. Your history is kept.`,
      confirmLabel: "Delete",
    });
    if (!confirmed) return;

    try {
      await deleteMedicine(medicine.id);
      toast("Medicine deleted.", "success");
    } catch (error) {
      console.error(error);
      toast("Could not delete the medicine.", "error");
    }
  }
}
