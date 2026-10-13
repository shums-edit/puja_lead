# Wellness Campaign – Durga Puja 2026 (TS Global Wellness Club)

Lead registration app for the Puja stall. Club members enter everything; visitors don't touch the phone.

## Screens
1. **Register** (Member 2) – PDF 1 sections 1, 2, 4 + Health Goal + Energy slider → gives a token (TS-001 …)
2. **Body Check** (Member 3) – pick visitor, type Height / Weight / BMI / BMI Category exactly as the machine shows. Nothing is calculated.
3. **Verify & Gift** (Member 4) – shows full details + what's missing. "Mark Gift Given" is locked until the entry is complete (Golden Rule).
4. **Leads** – search, filters, Call / WhatsApp buttons, Follow-up done tick, View / Edit / Delete, Export CSV.

All phones see the same data live.

## Setup (one time)
1. **Firebase Console** → create a project.
2. **Authentication** → Sign-in method → enable **Email/Password**.
3. **Authentication → Users → Add user** – create one login per club member (or one shared login).
4. **Firestore Database** → Create database → then **Rules** tab, paste and Publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

5. **Project settings → Your apps → Web app (</>)** → copy the config into `firebase-config.js`.
6. **Netlify** → drag the whole folder to deploy. Open the link on each member's phone and log in.

## Before the event
- Do 2–3 test entries, then delete them from Leads.
- Token numbers keep counting up. To restart from TS-001, delete the `meta/counter` document in Firestore.
