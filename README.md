# MediTrack — Smart Medicine Reminder

A simple, accessible medicine reminder web app that helps users (especially
elderly people) organise, manage and track their daily medication schedules.

Built with **HTML5, CSS3, vanilla JavaScript and Firebase** — no frameworks, no build step.

---

## Features

- Email/password registration and login (Firebase Authentication)
- Personal dashboard with a daily progress ring
- Add, edit and delete medicines (name, dosage, instructions)
- Multiple daily times per medicine
- Browser notifications when a dose is due
- Mark doses as **Taken** or **Missed** (and undo)
- Medication history grouped by day, filterable by status
- Responsive, large-text, accessible blue & white UI

---

## Tech stack

| Layer      | Technology                             |
| ---------- | -------------------------------------- |
| Markup     | HTML5                                  |
| Styling    | CSS3 (custom properties, Flexbox/Grid) |
| Logic      | Vanilla JavaScript (ES modules)        |
| Auth       | Firebase Authentication                |
| Database   | Cloud Firestore                        |
| Hosting    | Firebase Hosting                       |
| Reminders  | Browser Notifications API              |

---

## Project structure

```
meditrack/
├── public/                     # Firebase Hosting web root
│   ├── index.html              # Single-page app shell
│   ├── css/styles.css          # Theme + all styles
│   ├── js/
│   │   ├── firebase-config.js  # ← paste your Firebase config here
│   │   ├── utils.js            # DOM / date / toast / modal helpers
│   │   ├── store.js            # Firestore data layer + dose logic
│   │   ├── auth.js             # Authentication
│   │   ├── medicines.js        # Medicine CRUD
│   │   ├── dashboard.js        # Today's schedule + progress
│   │   ├── history.js          # Medication history
│   │   ├── notifications.js    # Browser reminders
│   │   └── main.js             # Entry point / routing
│   └── assets/images/
├── firebase.json               # Hosting + Firestore config
├── firestore.rules             # Security rules
├── firestore.indexes.json
├── .firebaserc                 # ← set your Firebase project id
├── .gitignore
├── LICENSE
└── README.md
```

---

## Data model (Cloud Firestore)

```
users/{uid}
  displayName, email, createdAt

users/{uid}/medicines/{medicineId}
  name, dosage, instructions, times: ["08:00", "20:00"],
  active, createdAt, updatedAt

users/{uid}/doses/{doseId}
  medicineId, medicineName, dosage, instructions,
  date: "YYYY-MM-DD", time: "HH:MM",
  status: "pending" | "taken" | "missed", updatedAt
```

Doses are generated automatically for the current day from each medicine's
times. A pending dose is auto-marked **missed** one hour after its scheduled
time.

---

## Setup

### 1. Prerequisites

- A modern browser (Chrome, Edge or Firefox).
- [Node.js](https://nodejs.org/) + the Firebase CLI (only for deploy):
  ```bash
  npm install -g firebase-tools
  firebase login
  ```

### 2. Create the Firebase project (Phase 3)

1. Go to the [Firebase Console](https://console.firebase.google.com/) → **Add project**.
2. **Build → Authentication → Get started** → enable **Email/Password**.
3. **Build → Firestore Database → Create database** (start in *production mode*).
4. **Project settings → Your apps → Web (`</>`)** → register an app and copy the config.
5. Paste the config into [`public/js/firebase-config.js`](public/js/firebase-config.js),
   replacing every `YOUR_...` value.
6. Put your project id in [`.firebaserc`](.firebaserc) (`YOUR_PROJECT_ID`).

### 3. Run locally

```bash
python -m http.server 5000 --directory public
# then open http://localhost:5000
```

Using the Firebase CLI (`firebase serve --only hosting`) is recommended because
it emulates Hosting behaviour.

> Browser notifications require a secure context (`https://` or `localhost`).

---

## Deploy (Phase 10)

```bash
firebase login
firebase use --add              # select your project
firebase deploy --only firestore:rules   # publish security rules
firebase deploy                # deploy hosting + rules
```

Your app will be live at `https://<your-project-id>.web.app`.

---

## Security

- All Firestore access requires authentication.
- Security rules in [`firestore.rules`](firestore.rules) allow users to read and
  write **only their own** `users/{uid}/...` data, and validate medicine and dose
  fields. Everything else is denied.
- The Firebase web config in `firebase-config.js` is **not a secret** — it is
  safe to ship in a browser. **Never** commit service account keys
  (`serviceAccountKey.json`) or `.env` files; these are already listed in
  `.gitignore`.

## Limitations

- Reminders use the **Browser Notifications API**, so they fire while the app is
  open in a tab. True background/push reminders would require a service worker
  with Firebase Cloud Messaging — a good future enhancement.

---

## Development phases

| Phase | Scope                           | Status      |
| ----- | ------------------------------- | ----------- |
| 1     | Project setup                   | ✅ Complete |
| 2     | UI design                       | ✅ Complete |
| 3     | Firebase configuration          | ✅ Complete |
| 4     | Authentication                  | ✅ Complete |
| 5     | Medicine management             | ✅ Complete |
| 6     | Medication scheduling           | ✅ Complete |
| 7     | Notifications                   | ✅ Complete |
| 8     | History & progress tracking     | ✅ Complete |
| 9     | Testing & security              | ✅ Complete |
| 10    | GitHub integration & deployment | ⏳ Credentials required |

---

## License

MIT — see [LICENSE](LICENSE).
