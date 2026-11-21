/* ============================================================
   MediTrack — auth.js  (Phase 4)
   Registration, login, logout and form wiring.
   ============================================================ */

import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { $, toast } from "./utils.js";

const ERROR_MESSAGES = {
  "auth/invalid-email": "Please enter a valid email address.",
  "auth/user-not-found": "No account found with that email.",
  "auth/wrong-password": "Incorrect password. Please try again.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/email-already-in-use": "That email is already registered — try logging in.",
  "auth/weak-password": "Password should be at least 6 characters.",
  "auth/network-request-failed": "Network error. Please check your connection.",
  "auth/too-many-requests": "Too many attempts. Please wait and try again.",
};

function friendlyError(error) {
  return ERROR_MESSAGES[error?.code] || error?.message || "Something went wrong. Please try again.";
}

function showMessage(text, isSuccess = false) {
  const el = $("#auth-message");
  el.textContent = text;
  el.classList.toggle("is-success", isSuccess);
  el.hidden = !text;
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  if (!button) return;
  button.disabled = busy;
  button.dataset.label ??= button.textContent;
  button.textContent = busy ? "Please wait…" : button.dataset.label;
}

/* ---------- Actions ---------- */

export async function loginUser(email, password) {
  await signInWithEmailAndPassword(auth, email.trim(), password);
}

export async function registerUser(name, email, password) {
  const { user } = await createUserWithEmailAndPassword(auth, email.trim(), password);
  await updateProfile(user, { displayName: name.trim() });

  // Create the user's profile document.
  await setDoc(doc(db, "users", user.uid), {
    displayName: name.trim(),
    email: email.trim(),
    createdAt: serverTimestamp(),
  });
}

export async function logoutUser() {
  await signOut(auth);
}

/* ---------- Form wiring ---------- */

export function initAuthForms() {
  const loginTab = $("#tab-login");
  const registerTab = $("#tab-register");
  const loginForm = $("#login-form");
  const registerForm = $("#register-form");

  function selectTab(showLogin) {
    loginTab.classList.toggle("is-active", showLogin);
    registerTab.classList.toggle("is-active", !showLogin);
    loginTab.setAttribute("aria-selected", String(showLogin));
    registerTab.setAttribute("aria-selected", String(!showLogin));
    loginForm.hidden = !showLogin;
    registerForm.hidden = showLogin;
    showMessage("");
  }

  loginTab.addEventListener("click", () => selectTab(true));
  registerTab.addEventListener("click", () => selectTab(false));

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("");
    setBusy(loginForm, true);
    try {
      await loginUser($("#login-email").value, $("#login-password").value);
    } catch (error) {
      showMessage(friendlyError(error));
    } finally {
      setBusy(loginForm, false);
    }
  });

  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("");

    const name = $("#register-name").value.trim();
    const email = $("#register-email").value;
    const password = $("#register-password").value;

    if (!name) return showMessage("Please enter your name.");
    if (password.length < 6) return showMessage("Password must be at least 6 characters.");

    setBusy(registerForm, true);
    try {
      await registerUser(name, email, password);
    } catch (error) {
      showMessage(friendlyError(error));
    } finally {
      setBusy(registerForm, false);
    }
  });

  return { selectTab };
}

export function toastWelcome(name) {
  if (name) toast(`Welcome back, ${name}!`, "success");
}
