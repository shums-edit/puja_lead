// ============================================================
//  FIREBASE PROJECT CONFIG
// ============================================================
export const firebaseConfig = {
  apiKey: "AIzaSyBDqFDzdyn-QzQ2JJnEbzsKGuXhUAjl104",
  authDomain: "puja-lead.firebaseapp.com",
  projectId: "puja-lead",
  storageBucket: "puja-lead.firebasestorage.app",
  messagingSenderId: "499598963937",
  appId: "1:499598963937:web:c7e375c5d9a8485b4cb3a0"
};

// Owner logins (must also be listed in firestore.rules)
export const OWNER_EMAILS = [
  "tarekfitcoach786@gmail.com",
  "admin.alphaacademy@gmail.com",
];

// SHA-256 hash of the 10-digit security key (the key itself is NOT stored here)
export const KEY_HASH = "b1f3db8bb1e86ca975a8c42bdaa87588d03d7a02805e4274df565d67bc902ed1";

// Hidden email domain used for the club accounts (never shown to anyone)
export const CLUB_EMAIL_DOMAIN = "puja-lead.app";
