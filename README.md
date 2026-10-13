# Wellness Campaign – Durga Puja 2026 (Multi-Club)

## Logins
- **Club login** (default screen): select club from dropdown + 4-digit PIN. Each club sees only its own leads.
- **Owner login** (tap "Owner login"): email + password. Owners: set in `firebase-config.js` AND `firestore.rules`.

## Club screens
Register · Body Check · Verify & Gift · Leads (with 🗑 Recycle Bin: delete → bin, restore from bin).
Tokens are per club using the club's short code (e.g. SALT-001).

## Owner panel
- **Clubs**: add club (name, short code, PIN), change PIN, open a club's leads.
- **All Leads**: filter by club or All, search, view, move to bin, export CSV (with Club column).
- **Recycle Bin**: restore, or delete forever (needs the 10-digit security key).

## Firebase setup (one time)
1. Authentication → Sign-in method → **Email/Password ON**.
2. Authentication → Settings → User actions → **Enable create (sign-up) ON** (needed so the Owner panel can create club logins; strangers still can't read data because of the rules).
3. Authentication → Users: owner accounts already added.
4. Firestore Database → **Rules**: replace everything with the contents of `firestore.rules` → **Publish**.
5. Before the real camp: upgrade project to **Blaze** + set a budget alert.

## Notes
- Changing a club's PIN logs out every phone using the old PIN.
- Old test leads from the first version have no club, so they won't show anywhere. Delete them in Firestore Console (`leads` collection and `meta` collection) if you like.
