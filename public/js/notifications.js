/* ============================================================
   MediTrack — notifications.js  (Phase 7)
   Browser Notifications API reminders for due doses.
   ============================================================ */

import { $ } from "./utils.js";
import { getTodayDoses } from "./store.js";

const notified = new Set();
let timer = null;

const supported = "Notification" in window;

export function initNotifications() {
  const banner = $("#notification-banner");
  const bell = $("#notification-btn");
  const dot = $("#notification-dot");

  function refresh() {
    const permission = supported ? Notification.permission : "unsupported";
    banner.hidden = !supported || permission === "granted";
    dot.hidden = !supported || permission === "granted";
    bell.title = permission === "granted" ? "Reminders are on" : "Enable reminders";
  }

  async function requestPermission() {
    if (!supported) return;
    try {
      const permission = await Notification.requestPermission();
      refresh();
      if (permission === "granted") {
        new Notification("MediTrack reminders enabled", {
          body: "We'll let you know whenever a dose is due.",
        });
      }
    } catch (error) {
      console.error("Notification permission error:", error);
    }
  }

  $("#banner-notify-btn").addEventListener("click", requestPermission);
  bell.addEventListener("click", requestPermission);

  refresh();
  document.addEventListener("visibilitychange", refresh);
  startWatcher();
}

function startWatcher() {
  if (timer) return;
  timer = setInterval(checkDueDoses, 30 * 1000);
  checkDueDoses();
}

function currentHHMM() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function checkDueDoses() {
  if (!supported || Notification.permission !== "granted") return;

  const now = currentHHMM();
  for (const dose of getTodayDoses()) {
    if (dose.status !== "pending") continue;
    if (dose.time !== now) continue;
    if (notified.has(dose.id)) continue;

    notified.add(dose.id);
    const notification = new Notification("Time for your medicine", {
      body: `${dose.medicineName}${dose.dosage ? ` — ${dose.dosage}` : ""}`,
      tag: dose.id,
      requireInteraction: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }
}

/** Clears the "already notified" cache, e.g. on logout. */
export function resetNotifications() {
  notified.clear();
}
