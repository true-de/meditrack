/* ============================================================
   MediTrack — main.js  (entry point)
   Wires views, navigation and the authentication lifecycle.
   ============================================================ */

import { isFirebaseConfigured, auth } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { initAuthForms, logoutUser } from "./auth.js";
import { start, stop } from "./store.js";
import { initMedicines } from "./medicines.js";
import { initDashboard } from "./dashboard.js";
import { initHistory } from "./history.js";
import { initNotifications, resetNotifications } from "./notifications.js";
import { $, $$, toast } from "./utils.js";

const SCREENS = {
    setup: $("#setup-view"),
    auth: $("#auth-view"),
    app: $("#app-view"),
};

const APP_VIEWS = ["dashboard", "medicines", "history"];

function showScreen(name) {
    Object.entries(SCREENS).forEach(([key, el]) => {
        el.hidden = key !== name;
    });
    window.scrollTo(0, 0);
}

function switchAppView(name) {
    $$(".nav-link").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.view === name));
    APP_VIEWS.forEach((view) => {
        $(`#view-${view}`).hidden = view !== name;
    });
    window.scrollTo(0, 0);
}

function initNav() {
    $$(".nav-link").forEach((btn) =>
        btn.addEventListener("click", () => switchAppView(btn.dataset.view))
    );
}

function boot() {
    if (!isFirebaseConfigured) {
        showScreen("setup");
        return;
    }

    initAuthForms();
    initMedicines();
    initDashboard();
    initHistory();
    initNotifications();
    initNav();

    $("#logout-btn").addEventListener("click", async () => {
        try {
            await logoutUser();
        } catch (error) {
            console.error(error);
            toast("Could not log out. Please try again.", "error");
        }
    });

    onAuthStateChanged(auth, (user) => {
        if (user) {
            start(user.uid);
            $("#user-name").textContent = user.displayName || user.email || "User";
            switchAppView("dashboard");
            showScreen("app");
        } else {
            stop();
            resetNotifications();
            $("#user-name").textContent = "";
            showScreen("auth");
        }
    });
}

boot();
