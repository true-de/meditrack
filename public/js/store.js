/* ============================================================
   MediTrack — store.js
   Single source of truth for data. Talks to Firestore and
   notifies view modules through a tiny event emitter.
   ============================================================ */

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { todayKey, minutesFromHHMM, nowMinutes } from "./utils.js";

/** Minutes a dose may stay pending before it is auto-marked as missed. */
const GRACE_MINUTES = 60;

/* ---------- Tiny event emitter ---------- */
const listeners = new Map();

export function on(event, callback) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(callback);
  return () => listeners.get(event).delete(callback);
}

function emit(event, payload) {
  const set = listeners.get(event);
  if (set) set.forEach((cb) => cb(payload));
}

/* ---------- State ---------- */
let uid = null;
let todayDate = todayKey();
let medicines = [];
let todayDoses = [];

let unsubMedicines = null;
let unsubToday = null;
let unsubHistory = null;

const medicinesCol = () => collection(db, "users", uid, "medicines");
const dosesCol = () => collection(db, "users", uid, "doses");
const dosesDoc = (id) => doc(db, "users", uid, "doses", id);

function doseId(date, time, medicineId) {
  return `${date}_${time.replace(":", "")}_${medicineId}`;
}

/* ---------- Public getters ---------- */
export const getMedicines = () => medicines;
export const getTodayDoses = () => todayDoses;

/* ---------- Lifecycle ---------- */

export function start(userId) {
  uid = userId;
  todayDate = todayKey();
  subscribeMedicines();
  subscribeToday();
  subscribeHistory();
}

export function stop() {
  [unsubMedicines, unsubToday, unsubHistory].forEach((fn) => fn && fn());
  unsubMedicines = unsubToday = unsubHistory = null;
  uid = null;
  medicines = [];
  todayDoses = [];
}

/* ---------- Subscriptions ---------- */

function subscribeMedicines() {
  unsubMedicines = onSnapshot(
    medicinesCol(),
    (snap) => {
      medicines = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      emit("medicines", medicines);
      syncTodayDoses();
    },
    (error) => console.error("Medicines listener failed:", error)
  );
}

function subscribeToday() {
  unsubToday = onSnapshot(
    query(dosesCol(), where("date", "==", todayDate)),
    (snap) => {
      todayDoses = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => minutesFromHHMM(a.time) - minutesFromHHMM(b.time));
      emit("today", todayDoses);
      markOverdueDoses();
    },
    (error) => console.error("Today listener failed:", error)
  );
}

function subscribeHistory() {
  unsubHistory = onSnapshot(
    query(dosesCol(), where("status", "in", ["taken", "missed"])),
    (snap) => {
      const doses = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : minutesFromHHMM(b.time) - minutesFromHHMM(a.time)));
      emit("history", doses);
    },
    (error) => console.error("History listener failed:", error)
  );
}

/* ---------- Dose generation ---------- */

/**
 * Creates today's dose documents for every active medicine/time and
 * removes pending doses that are no longer scheduled.
 */
async function syncTodayDoses() {
  if (!uid) return;

  const expected = new Map();
  for (const medicine of medicines) {
    if (medicine.active === false) continue;
    for (const time of medicine.times || []) {
      const id = doseId(todayDate, time, medicine.id);
      expected.set(id, {
        medicineId: medicine.id,
        medicineName: medicine.name,
        dosage: medicine.dosage || "",
        instructions: medicine.instructions || "",
        date: todayDate,
        time,
        status: "pending",
      });
    }
  }

  try {
    const snap = await getDocs(query(dosesCol(), where("date", "==", todayDate)));
    const existing = new Map(snap.docs.map((d) => [d.id, d.data()]));

    const batch = writeBatch(db);
    let writes = 0;

    for (const [id, data] of expected) {
      if (!existing.has(id)) {
        batch.set(dosesDoc(id), { ...data, updatedAt: serverTimestamp() });
        writes += 1;
      }
    }

    for (const [id, data] of existing) {
      if (!expected.has(id) && data.status === "pending") {
        batch.delete(dosesDoc(id));
        writes += 1;
      }
    }

    if (writes > 0) await batch.commit();
  } catch (error) {
    console.error("Could not sync today's doses:", error);
  }
}

/** Auto-marks pending doses as missed once their grace period has passed. */
async function markOverdueDoses() {
  if (!uid || todayDoses.length === 0) return;
  const current = nowMinutes();

  const overdue = todayDoses.filter(
    (dose) => dose.status === "pending" && minutesFromHHMM(dose.time) + GRACE_MINUTES < current
  );
  if (overdue.length === 0) return;

  try {
    await Promise.all(overdue.map((dose) => setDoseStatus(dose.id, "missed")));
  } catch (error) {
    console.error("Could not mark overdue doses:", error);
  }
}

/* ---------- Public actions ---------- */

export async function setDoseStatus(id, status) {
  await updateDoc(dosesDoc(id), { status, updatedAt: serverTimestamp() });
}

export async function saveMedicine(id, data) {
  const payload = {
    name: data.name.trim(),
    dosage: data.dosage.trim(),
    instructions: (data.instructions || "").trim(),
    times: data.times,
    active: true,
    updatedAt: serverTimestamp(),
  };

  if (id) {
    await updateDoc(doc(medicinesCol(), id), payload);
  } else {
    await addDoc(medicinesCol(), { ...payload, createdAt: serverTimestamp() });
  }
}

export async function deleteMedicine(id) {
  // Remove any still-pending doses for this medicine; keep taken/missed for history.
  const snap = await getDocs(query(dosesCol(), where("medicineId", "==", id)));
  const batch = writeBatch(db);
  let writes = 0;

  snap.forEach((d) => {
    if (d.data().status === "pending") {
      batch.delete(d.ref);
      writes += 1;
    }
  });

  batch.delete(doc(medicinesCol(), id));
  writes += 1;

  await batch.commit();
}

/**
 * If the calendar day has changed (app left open past midnight),
 * re-point the "today" listener at the new date.
 */
export function checkDayRollover() {
  if (!uid) return;
  const current = todayKey();
  if (current === todayDate) return;
  todayDate = current;
  if (unsubToday) unsubToday();
  subscribeToday();
  syncTodayDoses();
}
