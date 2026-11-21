/* ============================================================
   MediTrack – Firebase Authentication (Web SDK, compat build)
   ------------------------------------------------------------
   Responsibilities:
     * Initialise the Firebase Web SDK from firebase-config.js
     * Registration, login, logout, persisted auth-state management
     * Friendly error messages + loading indicators
     * Attach the Firebase ID token (Authorization: Bearer ...) to
       every protected Flask API request and refresh it on 401/403

   Security notes:
     * Only the PUBLIC web config is used here. The Admin SDK private
       key / service account never touches the browser.
     * This is convenience for the user, NOT the security boundary —
       the Flask backend still verifies the token of every request.
   ============================================================ */
(function () {
    "use strict";

    const cfg = window.MEDITRACK_FIREBASE_CONFIG;

    let auth = null;              // firebase.auth() instance once initialised
    let ready = false;            // true once the SDK is initialised
    let lastUid = undefined;      // used to react only to real sign in/out changes
    let refreshInFlight = null;   // single in-flight forced-refresh promise (de-dupes)
    let signingOut = false;       // one logout even if several requests fail together

    const $ = (id) => document.getElementById(id);

    let els = {};

    /* ------------------------------------------------------------
       Friendly error messages
       ------------------------------------------------------------ */
    const AUTH_ERRORS = {
        "auth/invalid-email": "That email address doesn’t look valid.",
        "auth/missing-email": "Please enter your email address.",
        "auth/missing-password": "Please enter your password.",
        "auth/user-disabled": "This account has been disabled. Please contact support.",
        "auth/user-not-found": "No account found with that email. Try creating one.",
        "auth/wrong-password": "Incorrect password. Please try again.",
        "auth/invalid-credential": "Incorrect email or password. Please try again.",
        "auth/invalid-login-credentials": "Incorrect email or password. Please try again.",
        "auth/email-already-in-use": "An account with that email already exists. Try signing in instead.",
        "auth/weak-password": "Your password is too weak. Use at least 6 characters.",
        "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
        "auth/network-request-failed": "Network error. Check your connection and try again.",
        "auth/operation-not-allowed": "Email/password sign-in is not enabled for this project.",
        "auth/configuration-not-found": "Authentication is not configured for this project.",
        "auth/internal-error": "The authentication service had a problem. Please try again.",
    };

    function friendlyError(err) {
        const code = err && err.code ? String(err.code) : "";
        return AUTH_ERRORS[code] || (err && err.message) || "Something went wrong. Please try again.";
    }

    /* ------------------------------------------------------------
       UI helpers
       ------------------------------------------------------------ */
    function showAuthError(message) {
        if (!els.authError) return;
        els.authError.textContent = message;
        els.authError.classList.remove("d-none");
    }

    function clearAuthError() {
        if (!els.authError) return;
        els.authError.textContent = "";
        els.authError.classList.add("d-none");
    }

    function setBusy(kind, state) {
        if (kind === "login") {
            els.loginBtn.disabled = state;
            els.loginSpinner.classList.toggle("d-none", !state);
            els.loginBtnText.textContent = state ? "Signing in…" : "Sign in";
        } else {
            els.registerBtn.disabled = state;
            els.registerSpinner.classList.toggle("d-none", !state);
            els.registerBtnText.textContent = state ? "Creating account…" : "Create account";
        }
    }

    function showAuthTab(tab) {
        const isLogin = tab === "login";
        els.loginForm.classList.toggle("d-none", !isLogin);
        els.registerForm.classList.toggle("d-none", isLogin);
        els.tabLoginBtn.classList.toggle("active", isLogin);
        els.tabRegisterBtn.classList.toggle("active", !isLogin);
        clearAuthError();
    }

    function showAuthScreen() {
        if (els.authBoot) els.authBoot.classList.add("d-none");
        if (els.appRoot) els.appRoot.classList.add("d-none");
        if (els.authScreen) els.authScreen.classList.remove("d-none");
    }

    function showApp() {
        if (els.authBoot) els.authBoot.classList.add("d-none");
        if (els.authScreen) els.authScreen.classList.add("d-none");
        if (els.appRoot) els.appRoot.classList.remove("d-none");
    }

    // Display the signed-in account and keep data loading blocked while signed out
    function updateUserUI(user, profile) {
        const email = (profile && profile.email) || (user && user.email) || "";
        const name = (profile && profile.name) || (email ? email.split("@")[0] : "");
        if (els.userEmail) els.userEmail.textContent = name || "Account";
        if (els.userEmailFull) els.userEmailFull.textContent = email || "—";
        if (els.settingsUserEmail) els.settingsUserEmail.textContent = email || "—";
    }

    function showConfigProblem(message) {
        if (els.authBoot) els.authBoot.classList.add("d-none");
        if (els.appRoot) els.appRoot.classList.add("d-none");
        if (els.authScreen) els.authScreen.classList.remove("d-none");
        if (els.authConfigWarning) {
            els.authConfigWarning.textContent = message;
            els.authConfigWarning.classList.remove("d-none");
        }
        // Authentication cannot work without a valid config — disable the forms.
        [els.loginForm, els.registerForm].forEach((f) => {
            if (!f) return;
            f.querySelectorAll("input, button").forEach((el) => { el.disabled = true; });
        });
    }

    function configLooksValid() {
        const c = cfg || {};
        const required = ["apiKey", "authDomain", "projectId", "appId"];
        return required.every((k) => typeof c[k] === "string" && c[k] && !c[k].startsWith("PASTE_"));
    }

    /* ------------------------------------------------------------
       Toast (reuse script.js if present)
       ------------------------------------------------------------ */
    function toast(message, type) {
        if (typeof window.showToast === "function") window.showToast(message, type || "success");
    }

    /* ------------------------------------------------------------
       Auth actions
       ------------------------------------------------------------ */
    async function signInWithEmail(email, password) {
        await auth.signInWithEmailAndPassword(email, password);
    }

    async function registerWithEmail(email, password) {
        await auth.createUserWithEmailAndPassword(email, password);
    }

    async function signOut() {
        if (!auth || signingOut) return;
        signingOut = true;
        try {
            await auth.signOut();
        } catch (_) { /* ignore */ }
        finally {
            signingOut = false;
        }
    }

    // End the Firebase session only when the server says THIS token is expired
    // or revoked. A project mismatch (token_invalid) is a server configuration
    // fault — signing out would only show "session expired" on the next login.
    function shouldEndSession(payload) {
        const code = payload && payload.code;
        if (code === "token_expired" || code === "token_revoked" || code === "user_disabled") {
            return true;
        }
        if (code) return false;
        const msg = String((payload && payload.error) || "").toLowerCase();
        return msg.includes("expired") || msg.includes("revoked") || msg.includes("disabled");
    }

    async function readJson(res) {
        try {
            return await res.clone().json();
        } catch (_) {
            return {};
        }
    }

    /* ------------------------------------------------------------
       Token management
       ------------------------------------------------------------ */
    function currentUser() {
        return (auth && auth.currentUser) || null;
    }

    // Coalesce concurrent forced refreshes into ONE network request so a burst
    // of dashboard calls (medicines + reminders + logs) cannot trigger a
    // refresh storm. Resolves to a fresh token, or null on failure.
    function refreshToken() {
        const user = currentUser();
        if (!user) return Promise.resolve(null);
        if (!refreshInFlight) {
            refreshInFlight = user.getIdToken(true)
                .catch(() => null)
                .then((token) => {
                    refreshInFlight = null;
                    return token;
                });
        }
        return refreshInFlight;
    }

    // getIdToken() returns the cached token and transparently refreshes it when
    // it is (close to) expired — the SDK handles expiry timing for us.
    async function getToken(forceRefresh) {
        const user = currentUser();
        if (!user) return null;
        return forceRefresh ? refreshToken() : user.getIdToken();
    }

    // Ask the server whether it is able to verify tokens at all. Used to make
    // sure a server-side misconfiguration never signs a valid user out.
    async function serverCanVerify() {
        try {
            const res = await fetch("/api/health", { headers: { "Cache-Control": "no-cache" } });
            if (!res.ok) return { reachable: true, canVerify: true }; // 5xx: transient
            const data = await res.json();
            return { reachable: true, canVerify: !!(data && data.firebase_ready === true) };
        } catch (_) {
            return { reachable: false, canVerify: false };
        }
    }

    /* ------------------------------------------------------------
       Authenticated fetch
       ------------------------------------------------------------
       * attaches the LATEST ID token to every protected request
       * refreshes once (de-duped) on 401, then retries with the new token
       * only signs out on a genuine 401 (a real expired/revoked session)
       * NEVER signs out on a network error or a 5xx/503 (server fault)
       ------------------------------------------------------------ */
    async function apiFetch(url, options) {
        const opts = Object.assign({}, options);
        const user = currentUser();
        if (!user) {
            // No signed-in user: never hit a protected endpoint.
            const err = new Error("Please sign in to continue.");
            err.code = "auth/not-signed-in";
            throw err;
        }

        const headers = new Headers(opts.headers || {});
        headers.set("Authorization", "Bearer " + (await user.getIdToken()));
        opts.headers = headers;

        let res;
        try {
            res = await fetch(url, opts);
        } catch (networkErr) {
            // Offline / DNS / connection reset: not an authentication problem.
            const err = new Error("Network problem — please check your connection and try again.");
            err.code = "auth/network-error";
            err.cause = networkErr;
            throw err;
        }

        // A server that is down or cannot verify tokens (5xx/503) must never log
        // the user out — surface the response and let the caller handle it.
        if (res.status >= 500) return res;

        if (res.status === 401) {
            const first = await readJson(res);
            // Token may have expired: refresh once and retry with the new token.
            const fresh = await refreshToken();
            if (fresh) {
                headers.set("Authorization", "Bearer " + fresh);
                try {
                    res = await fetch(url, opts);
                } catch (networkErr) {
                    const err = new Error("Network problem — please check your connection and try again.");
                    err.code = "auth/network-error";
                    err.cause = networkErr;
                    throw err;
                }
            }

            if (res.status === 401) {
                const server = await serverCanVerify();
                const body = fresh ? await readJson(res) : first;
                if (!server.reachable || !server.canVerify) {
                    // The fault is on the server/network, not the user's session.
                    const err = new Error(server.reachable
                        ? "Sign-in could not be verified by the server right now. Please try again shortly."
                        : "Network problem — please check your connection and try again.");
                    err.code = server.reachable ? "auth/server-unavailable" : "auth/network-error";
                    throw err;
                }
                if (shouldEndSession(body)) {
                    await signOut();
                    const err = new Error("Your session has expired. Please sign in again.");
                    err.code = "auth/session-expired";
                    throw err;
                }
                const err = new Error(body.error
                    || "The server rejected this sign-in. Your Firebase session is still active — try again shortly.");
                err.code = body.code || "auth/rejected";
                throw err;
            }
        }

        // 403 (authenticated but not the owner) is returned to the caller, which
        // surfaces the backend's message via its standard error handling.
        return res;
    }

    /* ------------------------------------------------------------
       Password visibility toggle + simple client-side validation
       ------------------------------------------------------------ */
    function isValidEmail(value) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }

    function togglePassword(btn) {
        const input = document.getElementById(btn.getAttribute("data-toggle-password"));
        if (!input) return;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        const icon = btn.querySelector("i");
        if (icon) icon.className = show ? "bi bi-eye-slash" : "bi bi-eye";
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    }

    /* ------------------------------------------------------------
       User profile (Firestore users/{uid}) — created/updated on sign-in
       ------------------------------------------------------------ */
    async function syncProfile(user) {
        try {
            const res = await apiFetch("/api/users/me", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: user.displayName || "" }),
            });
            if (res.ok) {
                const payload = await res.json();
                updateUserUI(user, payload.user || payload);
            }
        } catch (_) {
            /* Best effort — never block sign-in if the profile sync fails. */
        }
    }

    /* ------------------------------------------------------------
       Event wiring
       ------------------------------------------------------------ */
    function bindUI() {
        els.tabLoginBtn.addEventListener("click", () => showAuthTab("login"));
        els.tabRegisterBtn.addEventListener("click", () => showAuthTab("register"));

        // Password visibility toggles (login + registration fields)
        Array.from(document.querySelectorAll("[data-toggle-password]")).forEach((btn) => {
            btn.addEventListener("click", () => togglePassword(btn));
        });

        els.loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            clearAuthError();
            const email = els.loginEmail.value.trim();
            const password = els.loginPassword.value;
            if (!email || !password) {
                showAuthError("Please enter both your email and password.");
                return;
            }
            if (!isValidEmail(email)) {
                showAuthError("Please enter a valid email address.");
                return;
            }
            setBusy("login", true);
            try {
                await signInWithEmail(email, password);
                els.loginForm.reset();
                // onAuthStateChanged performs the transition + data load
            } catch (err) {
                showAuthError(friendlyError(err));
            } finally {
                setBusy("login", false);
            }
        });

        els.registerForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            clearAuthError();
            const email = els.registerEmail.value.trim();
            const password = els.registerPassword.value;
            const confirm = els.registerConfirm.value;
            if (!email) { showAuthError("Please enter your email address."); return; }
            if (!isValidEmail(email)) { showAuthError("Please enter a valid email address."); return; }
            if (password.length < 6) { showAuthError("Your password must be at least 6 characters long."); return; }
            if (password !== confirm) { showAuthError("The two passwords do not match."); return; }

            setBusy("register", true);
            try {
                await registerWithEmail(email, password);
                els.registerForm.reset();
                toast("Account created — you are now signed in.");
            } catch (err) {
                showAuthError(friendlyError(err));
            } finally {
                setBusy("register", false);
            }
        });

        els.logoutBtns.forEach((btn) => btn.addEventListener("click", async (e) => {
            e.preventDefault();
            await signOut();
            toast("You have been signed out.");
        }));
    }

    /* ------------------------------------------------------------
       Auth state management
       ------------------------------------------------------------ */
    function handleAuthState(user) {
        const uid = user ? user.uid : null;
        const changed = uid !== lastUid;
        lastUid = uid;

        if (user) {
            showApp();
            updateUserUI(user);
            if (changed) {
                syncProfile(user);
                if (window.MediTrack && typeof window.MediTrack.onSignedIn === "function") {
                    window.MediTrack.onSignedIn(user);
                }
            }
        } else {
            showAuthScreen();
            updateUserUI(null);
            if (changed && window.MediTrack && typeof window.MediTrack.onSignedOut === "function") {
                window.MediTrack.onSignedOut();
            }
        }
    }

    /* ------------------------------------------------------------
       Init (called by script.js once the DOM is ready)
       ------------------------------------------------------------ */
    function init() {
        els = {
            authBoot: $("authBoot"),
            authScreen: $("authScreen"),
            appRoot: $("appRoot"),
            authError: $("authError"),
            authConfigWarning: $("authConfigWarning"),
            tabLoginBtn: $("tabLoginBtn"),
            tabRegisterBtn: $("tabRegisterBtn"),
            loginForm: $("loginForm"),
            registerForm: $("registerForm"),
            loginEmail: $("loginEmail"),
            loginPassword: $("loginPassword"),
            loginBtn: $("loginBtn"),
            loginSpinner: $("loginSpinner"),
            loginBtnText: $("loginBtnText"),
            registerEmail: $("registerEmail"),
            registerPassword: $("registerPassword"),
            registerConfirm: $("registerConfirm"),
            registerBtn: $("registerBtn"),
            registerSpinner: $("registerSpinner"),
            registerBtnText: $("registerBtnText"),
            userEmail: $("userEmail"),
            userEmailFull: $("userEmailFull"),
            settingsUserEmail: $("settingsUserEmail"),
            logoutBtns: Array.from(document.querySelectorAll("[data-action='logout']")),
        };

        bindUI();

        if (!window.firebase || !window.firebase.auth) {
            showConfigProblem("The Firebase SDK could not be loaded. Check your network connection and reload.");
            return;
        }
        if (!configLooksValid()) {
            showConfigProblem("Firebase web configuration is missing. Fill in static/js/firebase-config.js.");
            return;
        }

        try {
            if (!firebase.apps || firebase.apps.length === 0) {
                firebase.initializeApp(cfg);
            }
            auth = firebase.auth();
        } catch (err) {
            showConfigProblem("Could not initialise Firebase: " + (err && err.message ? err.message : err));
            return;
        }

        ready = true;
        // LOCAL persistence keeps the session across reloads. Set it before the
        // first listener so a refresh restores the same Firebase user.
        const persistence = firebase.auth.Auth.Persistence.LOCAL;
        const listen = () => auth.onAuthStateChanged(handleAuthState);
        if (typeof auth.setPersistence === "function") {
            auth.setPersistence(persistence).then(listen).catch(listen);
        } else {
            listen();
        }
    }

    window.MediTrackAuth = {
        init,
        apiFetch,
        getToken,
        signOut,
        isReady: () => ready,
        currentUser: () => (auth ? auth.currentUser : null),
    };
})();
