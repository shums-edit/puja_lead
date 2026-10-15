import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, onSnapshot, query, where,
  runTransaction, updateDoc, setDoc, deleteDoc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, OWNER_EMAILS, KEY_HASH, CLUB_EMAIL_DOMAIN } from "./firebase-config.js";

/* ============================================================
   Helpers
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tokenStr = (code, n) => `${code}-${String(n).padStart(3, "0")}`;
const isPhone = (v) => /^[6-9]\d{9}$/.test(String(v || ""));
const toDate = (ts) => (ts && ts.toDate ? ts.toDate() : null);
const tsMs = (ts) => (toDate(ts)?.getTime() || 0);
const fmtTime = (ts) => {
  const d = toDate(ts);
  return d ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
};
const clubPassword = (clubId, pin) => `PL#${clubId}#${pin}`;
const ownerEmails = OWNER_EMAILS.map((e) => e.toLowerCase());

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2800);
}
const loading = (on) => $("#loader").classList.toggle("show", on);

/** Modal. buttons: [{label, cls, value}] → resolves with value */
function modal(html, buttons = [{ label: "OK", cls: "btn-primary", value: true }]) {
  return new Promise((resolve) => {
    $("#modalBody").innerHTML = html;
    const act = $("#modalActions");
    act.innerHTML = "";
    buttons.forEach((b) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `btn ${b.cls || "btn-light"}`;
      el.textContent = b.label;
      el.onclick = () => { $("#modal").classList.add("hidden"); resolve(b.value); };
      act.appendChild(el);
    });
    $("#modal").classList.remove("hidden");
    $("#modalBody input")?.focus();
  });
}
const confirmBox = (title, text, okLabel = "Yes", okCls = "btn-primary") =>
  modal(`<h3>${title}</h3><p>${text}</p>`, [
    { label: "No", cls: "btn-light", value: false },
    { label: okLabel, cls: okCls, value: true },
  ]);

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Ask for the 10-digit security key. Resolves true only if correct. */
async function askKey(title, text, okLabel = "Delete Forever", okCls = "btn-danger") {
  const ok = await modal(
    `<h3>${title}</h3><p>${text}</p>
     <label class="field"><span>10-digit security key</span>
     <input type="password" id="keyInput" inputmode="numeric" maxlength="10" autocomplete="off" /></label>`,
    [{ label: "Cancel", cls: "btn-light", value: false }, { label: okLabel, cls: okCls, value: true }]
  );
  if (!ok) return false;
  const val = ($("#keyInput")?.value || "").trim();
  if ((await sha256(val)) !== KEY_HASH) {
    toast("Wrong security key.", true);
    return false;
  }
  return true;
}

// password show/hide buttons
const EYE_OPEN = `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>`;
const EYE_CLOSED = `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M2.1 3.5 3.5 2.1l18.4 18.4-1.4 1.4-3.2-3.2A11 11 0 0 1 12 19C5 19 2 12 2 12a17.6 17.6 0 0 1 4.2-5.4L2.1 3.5zM12 5c7 0 10 7 10 7a17.4 17.4 0 0 1-3.1 4.4l-3.5-3.5A4.5 4.5 0 0 0 10.1 7.6L7.9 5.4A11 11 0 0 1 12 5zm-4.4 6.4a4.5 4.5 0 0 0 5 5z"/></svg>`;
$$(".pw-toggle").forEach((btn) => {
  btn.innerHTML = EYE_OPEN;
  btn.onclick = () => {
    const inp = document.getElementById(btn.dataset.target);
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    btn.innerHTML = show ? EYE_CLOSED : EYE_OPEN;
  };
});

/* ============================================================
   Firebase
   ============================================================ */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
let creatorApp = null; // secondary app used only to create club accounts
function getCreatorApp() {
  if (!creatorApp) creatorApp = initializeApp(firebaseConfig, "club-creator");
  return creatorApp;
}
const getCreatorAuth = () => getAuth(getCreatorApp());
const getCreatorDb = () => getFirestore(getCreatorApp());

/* ============================================================
   State
   ============================================================ */
let clubs = [];            // active clubs (public list)
let allClubs = [];         // incl. deleted clubs
let requests = [];         // pending club requests (owner only)
let unsubRequests = null;
let mode = null;           // "club" | "owner"
let myClub = null;         // {id, name, code}
let leads = [];            // club's leads (incl. deleted)
let unsubLeads = null;
let editingId = null, bodyId = null, giftId = null;
let energyTouched = false;
let leadFilter = "all";

let ownerLeads = [];
let unsubOwner = null;
let ownerSel = "ALL";
let ownerTab = "clubs";

const CHALLENGES = [
  "Joint / Knee Pain", "Back Pain", "Low Energy / Fatigue",
  "Digestive Issues / Acidity", "Weight Gain / Weight Loss", "Other", "None",
];

/* ============================================================
   Status logic
   ============================================================ */
const bodyDone = (l) => !!(l.height && l.weight && l.bmi && l.bmiCategory);
const bodySkipped = (l) => !!l.bodySkipped && !bodyDone(l);
const bodyHandled = (l) => bodyDone(l) || bodySkipped(l); // done OR skipped
const active = () => leads.filter((l) => !l.deleted);

function missingItems(l) {
  const m = [];
  if (!l.name) m.push("Full Name");
  if (!l.age) m.push("Age");
  if (!isPhone(l.mobile)) m.push("Valid Mobile No.");
  if (!isPhone(l.whatsapp)) m.push("Valid WhatsApp No.");
  if (!l.occupation) m.push("Occupation");
  if (!l.healthGoal) m.push("Health Goal");
  if (!l.healthRating) m.push("Health rating (1–10)");
  if (!l.energyLevel) m.push("Energy Level");
  if (!l.onMedication) m.push("Regular medication (Yes/No)");
  if (l.onMedication === "Yes" && !l.medicationDetails) m.push("Medicine / condition details");
  if (!(l.challenges || []).length) m.push("Physical challenges");
  if ((l.challenges || []).includes("Other") && !l.challengeOther) m.push("Other disease details");
  if (!l.wantsConsultation) m.push("Wellness Consultation (Yes/No)");
  if (!l.incomeInterest) m.push("Income opportunity (Yes/No)");
  if (!bodySkipped(l)) {
    if (!l.height) m.push("Height");
    if (!l.weight) m.push("Weight");
    if (!l.bmi) m.push("BMI");
    if (!l.bmiCategory) m.push("BMI Category");
  }
  return m;
}
const isComplete = (l) => missingItems(l).length === 0;

function matches(l, q) {
  if (!q || !q.trim()) return true;
  q = q.trim().toLowerCase();
  const num = q.replace(/^\D+/, "").replace(/^0+/, "");
  return (
    (l.token || "").toLowerCase().includes(q) ||
    (num && String(l.tokenNo || "") === num) ||
    (l.name || "").toLowerCase().includes(q) ||
    (l.mobile || "").includes(q) ||
    (l.whatsapp || "").includes(q)
  );
}

/* ============================================================
   Screens & login
   ============================================================ */
function showScreen(id) {
  $$(".screen").forEach((s) => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
  window.scrollTo({ top: 0 });
}

// public club list (for dropdown + owner panel)
onSnapshot(collection(db, "clubs"), (snap) => {
  allClubs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "en", { sensitivity: "base" }));
  clubs = allClubs.filter((c) => !c.deleted);
  renderClubSelect();
  if (mode === "owner") { renderClubList(); renderOwnerSelects(); renderOwnerStats(); renderOwner(); }
}, (err) => {
  console.error(err);
  $("#clubSelect").innerHTML = `<option value="">Could not load clubs</option>`;
});

function renderClubSelect() {
  const sel = $("#clubSelect");
  const prev = sel.value || localStorage.getItem("lastClub") || "";
  sel.innerHTML = clubs.length
    ? `<option value="">— Select your name —</option>` +
      clubs.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")
    : `<option value="">No clubs approved yet</option>`;
  if (clubs.some((c) => c.id === prev)) sel.value = prev;
}

function showLoginForm(which) {
  $("#clubLoginForm").classList.toggle("hidden", which !== "club");
  $("#ownerLoginForm").classList.toggle("hidden", which !== "owner");
  $("#requestForm").classList.toggle("hidden", which !== "request");
  $("#loginSub").textContent = { club: "Club Login", owner: "Owner Login", request: "Request Club Access" }[which];
  $("#switchLogin").classList.toggle("hidden", which !== "club");
  $("#requestLink").classList.toggle("hidden", which !== "club");
  $("#backToClub").classList.toggle("hidden", which === "club");
}
$("#switchLogin").onclick = () => showLoginForm("owner");
$("#requestLink").onclick = () => showLoginForm("request");
$("#backToClub").onclick = () => showLoginForm("club");

/* ---------- Club access request (public) ---------- */
const reqForm = $("#requestForm");
const codeClean = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
const digits = (v, n) => v.replace(/\D/g, "").slice(0, n);
reqForm.rqCode.addEventListener("input", () => (reqForm.rqCode.value = codeClean(reqForm.rqCode.value)));
reqForm.rqPin.addEventListener("input", () => (reqForm.rqPin.value = digits(reqForm.rqPin.value, 4)));
reqForm.rqMobile.addEventListener("input", () => (reqForm.rqMobile.value = digits(reqForm.rqMobile.value, 10)));

reqForm.onsubmit = async (e) => {
  e.preventDefault();
  const err = $("#requestError");
  err.textContent = "";
  const name = reqForm.rqName.value.trim();
  const mobile = reqForm.rqMobile.value.trim();
  const code = reqForm.rqCode.value.trim();
  const pin = reqForm.rqPin.value.trim();
  if (!name) return (err.textContent = "Enter your name.");
  if (!isPhone(mobile)) return (err.textContent = "Enter a valid 10-digit mobile number.");
  if (!/^[A-Z0-9]{2,6}$/.test(code)) return (err.textContent = "Short code: 2–6 letters/numbers, e.g. RAHUL.");
  if (!/^\d{4}$/.test(pin)) return (err.textContent = "PIN must be exactly 4 digits.");
  const id = code.toLowerCase();
  if (allClubs.some((c) => c.id === id)) return (err.textContent = `Code ${code} is already taken. Choose another.`);

  $("#requestBtn").disabled = true;
  loading(true);
  const ca = getCreatorAuth();
  try {
    const email = `club-${id}-${Date.now()}@${CLUB_EMAIL_DOMAIN}`;
    const cred = await createUserWithEmailAndPassword(ca, email, clubPassword(id, pin));
    try {
      await setDoc(doc(getCreatorDb(), "clubRequests", id), {
        name, mobile, code, pin, uid: cred.user.uid, authEmail: email,
        origCode: code, origPin: pin, createdAt: serverTimestamp(),
      });
    } catch (ex2) {
      console.error(ex2);
      err.textContent = `Code ${code} is already requested or taken. Choose another.`;
      return;
    }
    reqForm.reset();
    loading(false);
    await modal(`<h3>Request sent ✅</h3>
      <p>Thank you, <b>${esc(name)}</b>. Your request is waiting for approval.</p>
      <p>Once approved, select your name on the login page and enter your PIN.</p>`);
    showLoginForm("club");
  } catch (ex) {
    console.error(ex);
    err.textContent = accountError(ex);
  } finally {
    try { await signOut(ca); } catch (_) {}
    loading(false);
    $("#requestBtn").disabled = false;
  }
};

$("#clubPin").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4)));

$("#clubLoginForm").onsubmit = async (e) => {
  e.preventDefault();
  const err = $("#clubLoginError");
  err.textContent = "";
  const club = clubs.find((c) => c.id === $("#clubSelect").value);
  const pin = $("#clubPin").value.trim();
  if (!club) return (err.textContent = "Select your club.");
  if (!/^\d{4}$/.test(pin)) return (err.textContent = "Enter the 4-digit PIN.");
  $("#clubLoginBtn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, club.authEmail, clubPassword(club.id, pin));
    try { localStorage.setItem("lastClub", club.id); } catch (_) {}
    $("#clubPin").value = "";
  } catch (ex) {
    const c = ex.code || "";
    err.textContent = c.includes("too-many-requests")
      ? "Too many wrong attempts. Wait a few minutes."
      : c.includes("network") ? "No internet connection." : "Wrong PIN for this club.";
  } finally {
    $("#clubLoginBtn").disabled = false;
  }
};

$("#ownerLoginForm").onsubmit = async (e) => {
  e.preventDefault();
  $("#loginError").textContent = "";
  $("#loginBtn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("#loginEmail").value.trim(), $("#loginPassword").value);
    $("#loginPassword").value = "";
  } catch (ex) {
    const c = ex.code || "";
    $("#loginError").textContent = c.includes("too-many-requests")
      ? "Too many attempts. Wait a minute and try again."
      : c.includes("network") ? "No internet connection." : "Wrong email or password.";
  } finally {
    $("#loginBtn").disabled = false;
  }
};

const doLogout = async () => {
  if (await confirmBox("Logout?", "You will need to login again to continue.", "Logout", "btn-danger")) signOut(auth);
};
$("#logoutBtn").onclick = doLogout;
$("#ownerLogoutBtn").onclick = doLogout;

function stopListeners() {
  if (unsubLeads) { unsubLeads(); unsubLeads = null; }
  if (unsubOwner) { unsubOwner(); unsubOwner = null; }
  if (unsubRequests) { unsubRequests(); unsubRequests = null; }
  leads = []; ownerLeads = []; requests = []; myClub = null; mode = null;
}

onAuthStateChanged(auth, async (user) => {
  stopListeners();
  if (!user) { showScreen("#loginScreen"); return; }

  if (ownerEmails.includes((user.email || "").toLowerCase())) {
    mode = "owner";
    showScreen("#ownerScreen");
    renderClubList(); renderOwnerSelects();
    startOwnerLeads();
    startRequests();
    return;
  }

  // club account → find its club
  try {
    const m = await getDoc(doc(db, "members", user.uid));
    if (!m.exists()) throw new Error("no-member");
    const c = await getDoc(doc(db, "clubs", m.data().clubId));
    if (!c.exists() || c.data().deleted) throw new Error("no-club");
    myClub = { id: c.id, ...c.data() };
    mode = "club";
    $("#clubTitle").textContent = myClub.name;
    resetRegForm();
    openTab("register");
    showScreen("#appScreen");
    startClubLeads();
  } catch (ex) {
    console.error(ex);
    await signOut(auth);
    $("#clubLoginError").textContent = "This club login is not active. Ask the owner for the current PIN.";
  }
});

/* ============================================================
   CLUB: live leads
   ============================================================ */
function startClubLeads() {
  const q = query(collection(db, "leads"), where("clubId", "==", myClub.id));
  unsubLeads = onSnapshot(q, (snap) => {
    leads = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.tokenNo || 0) - (a.tokenNo || 0));
    renderAll();
  }, async (err) => {
    console.error(err);
    if (err.code === "permission-denied") {
      await signOut(auth);
      $("#clubLoginError").textContent = "Your login was changed or removed. Login again or contact the owner.";
    } else {
      toast("Could not load data. Check internet.", true);
    }
  });
}

/* ============================================================
   CLUB: tabs
   ============================================================ */
function openTab(name) {
  $$("#appScreen .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$("#appScreen .panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  window.scrollTo({ top: 0 });
}
$$("#appScreen .tab").forEach((t) => (t.onclick = () => openTab(t.dataset.tab)));

/* ============================================================
   CLUB: register form
   ============================================================ */
const regForm = $("#regForm");

$("#healthRating").innerHTML = Array.from({ length: 10 }, (_, i) =>
  `<label><input type="radio" name="healthRating" value="${i + 1}"><i>${i + 1}</i></label>`).join("");
$("#challengeList").innerHTML = CHALLENGES.map((c) =>
  `<label><input type="checkbox" name="challenge" value="${c}"> ${c === "Other" ? "Other Disease" : c}</label>`).join("");

$("#challengeList").addEventListener("change", (e) => {
  const box = e.target;
  if (box.name !== "challenge") return;
  if (box.value === "None" && box.checked) {
    $$("input[name=challenge]").forEach((c) => { if (c.value !== "None") c.checked = false; });
  } else if (box.checked) {
    $('input[name=challenge][value="None"]').checked = false;
  }
  $("#otherWrap").classList.toggle("hidden", !$('input[name=challenge][value="Other"]').checked);
  $("#challengeList").classList.remove("invalid-group");
});

regForm.addEventListener("change", (e) => {
  if (e.target.name === "onMedication") $("#medDetailsWrap").classList.toggle("hidden", e.target.value !== "Yes");
  if (e.target.type === "radio") e.target.closest(".seg, .rating")?.classList.remove("invalid-group");
});

["mobile", "whatsapp"].forEach((n) => {
  regForm[n].addEventListener("input", () => {
    regForm[n].value = regForm[n].value.replace(/\D/g, "").slice(0, 10);
    if (n === "mobile" && $("#sameAsMobile").checked) regForm.whatsapp.value = regForm.mobile.value;
  });
});
$("#sameAsMobile").onchange = (e) => {
  regForm.whatsapp.readOnly = e.target.checked;
  if (e.target.checked) regForm.whatsapp.value = regForm.mobile.value;
};

function setEnergyUI(touched) {
  energyTouched = touched;
  const s = $("#energy"), out = $("#energyOut");
  s.closest(".slider-wrap").classList.remove("invalid-group");
  s.classList.toggle("untouched", !touched);
  out.classList.toggle("unset", !touched);
  out.textContent = touched ? `${s.value} / 10` : "Drag to set";
}
$("#energy").addEventListener("input", () => setEnergyUI(true));
regForm.addEventListener("input", (e) => e.target.classList?.remove("invalid"));

function readRegForm() {
  const f = regForm;
  const radio = (n) => f.querySelector(`input[name=${n}]:checked`)?.value || "";
  const challenges = $$("input[name=challenge]:checked").map((c) => c.value);
  const onMedication = radio("onMedication");
  return {
    name: f.name.value.trim(),
    age: f.age.value ? Number(f.age.value) : null,
    mobile: f.mobile.value.trim(),
    whatsapp: f.whatsapp.value.trim(),
    occupation: f.occupation.value.trim(),
    healthGoal: f.healthGoal.value.trim(),
    healthRating: Number(radio("healthRating")) || null,
    energyLevel: energyTouched ? Number($("#energy").value) : null,
    onMedication,
    medicationDetails: onMedication === "Yes" ? f.medicationDetails.value.trim() : "",
    challenges,
    challengeOther: challenges.includes("Other") ? f.challengeOther.value.trim() : "",
    wantsConsultation: radio("wantsConsultation"),
    incomeInterest: radio("incomeInterest"),
  };
}

function validateReg(d) {
  const f = regForm;
  const fail = (el, msg) => {
    el.classList.add(el.tagName === "INPUT" ? "invalid" : "invalid-group");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (el.tagName === "INPUT") el.focus({ preventScroll: true });
    toast(msg, true);
    return false;
  };
  if (!d.name) return fail(f.name, "Enter Full Name");
  if (!d.age || d.age < 1 || d.age > 120) return fail(f.age, "Enter a valid Age");
  if (!d.occupation) return fail(f.occupation, "Enter Occupation");
  if (!isPhone(d.mobile)) return fail(f.mobile, "Enter a valid 10-digit Mobile No.");
  if (!isPhone(d.whatsapp)) return fail(f.whatsapp, "Enter a valid 10-digit WhatsApp No.");
  if (!d.healthGoal) return fail(f.healthGoal, "Enter Health Goal");
  if (!d.healthRating) return fail($("#healthRating"), "Select health rating 1–10");
  if (!d.energyLevel) return fail($("#energy").closest(".slider-wrap"), "Set the Energy Level slider");
  if (!d.onMedication) return fail(f.querySelector("input[name=onMedication]").closest(".seg"), "Select medication Yes / No");
  if (d.onMedication === "Yes" && !d.medicationDetails) return fail(f.medicationDetails, "Specify medicine / condition");
  if (!d.challenges.length) return fail($("#challengeList"), "Tick at least one physical challenge (or None)");
  if (d.challenges.includes("Other") && !d.challengeOther) return fail(f.challengeOther, "Write the other disease");
  if (!d.wantsConsultation) return fail(f.querySelector("input[name=wantsConsultation]").closest(".seg"), "Select Wellness Consultation Yes / No");
  if (!d.incomeInterest) return fail(f.querySelector("input[name=incomeInterest]").closest(".seg"), "Select income opportunity Yes / No");
  return true;
}

function resetRegForm() {
  regForm.reset();
  regForm.whatsapp.readOnly = false;
  $("#energy").value = 5;
  setEnergyUI(false);
  $("#medDetailsWrap").classList.add("hidden");
  $("#otherWrap").classList.add("hidden");
  $$(".invalid, .invalid-group", regForm).forEach((el) => el.classList.remove("invalid", "invalid-group"));
  editingId = null;
  $("#regTitle").textContent = "New Registration";
  $("#regSubmit").textContent = "Register & Get Token";
  $("#cancelEditBtn").classList.add("hidden");
}
$("#cancelEditBtn").onclick = () => { resetRegForm(); openTab("leads"); };

function fillRegForm(l) {
  resetRegForm();
  const f = regForm;
  f.name.value = l.name || "";
  f.age.value = l.age || "";
  f.mobile.value = l.mobile || "";
  f.whatsapp.value = l.whatsapp || "";
  f.occupation.value = l.occupation || "";
  f.healthGoal.value = l.healthGoal || "";
  const setRadio = (n, v) => { const r = f.querySelector(`input[name=${n}][value="${v}"]`); if (r) r.checked = true; };
  setRadio("healthRating", l.healthRating);
  if (l.energyLevel) { $("#energy").value = l.energyLevel; setEnergyUI(true); }
  setRadio("onMedication", l.onMedication);
  $("#medDetailsWrap").classList.toggle("hidden", l.onMedication !== "Yes");
  f.medicationDetails.value = l.medicationDetails || "";
  $$("input[name=challenge]").forEach((c) => (c.checked = (l.challenges || []).includes(c.value)));
  $("#otherWrap").classList.toggle("hidden", !(l.challenges || []).includes("Other"));
  f.challengeOther.value = l.challengeOther || "";
  setRadio("wantsConsultation", l.wantsConsultation);
  setRadio("incomeInterest", l.incomeInterest);
  editingId = l.id;
  $("#regTitle").textContent = `Edit ${l.token}`;
  $("#regSubmit").textContent = "Update Registration";
  $("#cancelEditBtn").classList.remove("hidden");
  openTab("register");
}

regForm.onsubmit = async (e) => {
  e.preventDefault();
  const d = readRegForm();
  if (!validateReg(d)) return;

  const dup = active().find((l) => l.mobile === d.mobile && l.id !== editingId);
  if (dup) {
    const go = await confirmBox("Mobile already registered",
      `<b>${esc(d.mobile)}</b> is already registered as <b>${esc(dup.token)} – ${esc(dup.name)}</b>.<br><br>Register again anyway?`,
      "Yes, continue");
    if (!go) return;
  }

  loading(true);
  $("#regSubmit").disabled = true;
  try {
    if (editingId) {
      await updateDoc(doc(db, "leads", editingId), { ...d, updatedAt: serverTimestamp(), updatedBy: myClub.name });
      const l = leads.find((x) => x.id === editingId);
      toast(`${l?.token || "Entry"} updated`);
      resetRegForm();
      openTab("leads");
    } else {
      const clubRef = doc(db, "clubs", myClub.id);
      const leadRef = doc(collection(db, "leads"));
      const code = myClub.code;
      const tokenNo = await runTransaction(db, async (tx) => {
        const snap = await tx.get(clubRef);
        const next = snap.data()?.nextToken || 1;
        tx.update(clubRef, { nextToken: next + 1 });
        tx.set(leadRef, {
          ...d,
          clubId: myClub.id, clubName: myClub.name, clubCode: code,
          tokenNo: next, token: tokenStr(code, next),
          height: "", heightUnit: "cm", weight: "", bmi: "", bmiCategory: "",
          giftGiven: false, followUpDone: false, deleted: false,
          createdAt: serverTimestamp(), createdBy: myClub.name,
        });
        return next;
      });
      resetRegForm();
      window.scrollTo({ top: 0 });
      loading(false);
      $("#regSubmit").disabled = false;
      await modal(
        `<h3>Registered ✅</h3>
         <p><b>${esc(d.name)}</b> is registered. Tell the visitor this token for the Body Check.</p>
         <div class="token-big">${tokenStr(code, tokenNo)}</div>`,
        [{ label: "Next Registration", cls: "btn-primary", value: true }]
      );
    }
  } catch (err) {
    console.error(err);
    toast("Save failed. Check internet and try again.", true);
  } finally {
    loading(false);
    $("#regSubmit").disabled = false;
  }
};

/* ============================================================
   CLUB: body check
   ============================================================ */
const bodyForm = $("#bodyForm");

function miniItem(l, right) {
  return `<button type="button" class="mini-item" data-id="${l.id}">
    <span class="token">${esc(l.token)}</span>
    <span class="grow"><div class="nm">${esc(l.name)}</div><div class="sub">${esc(l.mobile)} · Age ${esc(l.age)}</div></span>
    ${right}
  </button>`;
}

function renderBodyList() {
  const q = $("#bodySearch").value;
  let list;
  if (q.trim()) {
    list = active().filter((l) => matches(l, q));
    $("#bodyListLabel").textContent = `Search results (${list.length})`;
  } else {
    list = active().filter((l) => !bodyHandled(l)).reverse();
    $("#bodyListLabel").textContent = `Waiting for body check (${list.length})`;
  }
  $("#bodyList").innerHTML = list.length
    ? list.slice(0, 60).map((l) => miniItem(l, bodyDone(l)
        ? `<span class="badge b-ok">Done</span>`
        : bodySkipped(l) ? `<span class="badge b-skip">Skipped</span>` : `<span class="badge b-warn">Pending</span>`)).join("")
    : `<div class="empty">${q.trim() ? "No match found." : "No one is waiting. 🎉"}</div>`;
}
$("#bodySearch").addEventListener("input", renderBodyList);
$("#bodyList").addEventListener("click", (e) => {
  const b = e.target.closest(".mini-item");
  if (b) openBody(b.dataset.id);
});

function openBody(id) {
  const l = leads.find((x) => x.id === id);
  if (!l) return;
  bodyId = id;
  $("#bodyPerson").innerHTML = `
    <div class="pc-top"><span class="token">${esc(l.token)}</span><span class="pc-name">${esc(l.name)}</span></div>
    <div class="pc-sub">Age ${esc(l.age)} · ${esc(l.mobile)} · ${esc(l.occupation)}</div>`;
  bodyForm.height.value = l.height || "";
  bodyForm.heightUnit.value = l.heightUnit || "cm";
  bodyForm.weight.value = l.weight || "";
  bodyForm.bmi.value = l.bmi || "";
  $$("input[name=bmiCategory]", bodyForm).forEach((r) => (r.checked = r.value === l.bmiCategory));
  $$(".invalid, .invalid-group", bodyForm).forEach((el) => el.classList.remove("invalid", "invalid-group"));
  $("#bodySubmit").textContent = bodyDone(l) ? "Update Body Check" : "Save Body Check";
  $("#bodySkip").classList.toggle("hidden", bodyHandled(l));
  $("#bodyPick").classList.add("hidden");
  bodyForm.classList.remove("hidden");
  openTab("body");
}
function closeBody() {
  bodyId = null;
  bodyForm.classList.add("hidden");
  $("#bodyPick").classList.remove("hidden");
  $("#bodySearch").value = "";
  renderBodyList();
}
$("#bodyBack").onclick = closeBody;
bodyForm.addEventListener("input", (e) => e.target.classList?.remove("invalid"));
bodyForm.addEventListener("change", (e) => {
  if (e.target.name === "bmiCategory") e.target.closest(".seg").classList.remove("invalid-group");
});

bodyForm.onsubmit = async (e) => {
  e.preventDefault();
  const f = bodyForm;
  const d = {
    height: f.height.value.trim(),
    heightUnit: f.heightUnit.value,
    weight: f.weight.value.trim(),
    bmi: f.bmi.value.trim(),
    bmiCategory: f.querySelector("input[name=bmiCategory]:checked")?.value || "",
  };
  const fail = (el, msg) => {
    el.classList.add(el.tagName === "INPUT" ? "invalid" : "invalid-group");
    if (el.tagName === "INPUT") el.focus();
    toast(msg, true);
  };
  if (!d.height) return fail(f.height, "Enter Height");
  if (!d.weight) return fail(f.weight, "Enter Weight");
  if (!d.bmi) return fail(f.bmi, "Enter BMI");
  if (!d.bmiCategory) return fail(f.querySelector("input[name=bmiCategory]").closest(".seg"), "Select BMI Category");

  loading(true);
  try {
    await updateDoc(doc(db, "leads", bodyId), { ...d, bodySkipped: false, bodyCheckAt: serverTimestamp() });
    const l = leads.find((x) => x.id === bodyId);
    toast(`Body check saved for ${l?.token || ""}`);
    closeBody();
  } catch (err) {
    console.error(err);
    toast("Save failed. Check internet and try again.", true);
  } finally {
    loading(false);
  }
};

$("#bodySkip").onclick = async () => {
  const l = leads.find((x) => x.id === bodyId);
  if (!l) return;
  const ok = await confirmBox("Skip body check?",
    `Skip body check for <b>${esc(l.token)} – ${esc(l.name)}</b>? They can still get the gift. You can fill the body details later.`,
    "Yes, Skip", "btn-gold");
  if (!ok) return;
  loading(true);
  try {
    await updateDoc(doc(db, "leads", l.id), { bodySkipped: true, bodySkippedAt: serverTimestamp() });
    toast(`Body check skipped for ${l.token}`);
    closeBody();
  } catch (err) {
    console.error(err);
    toast("Save failed. Check internet and try again.", true);
  } finally {
    loading(false);
  }
};

/* ============================================================
   CLUB: verify & gift
   ============================================================ */
function renderGiftList() {
  const q = $("#giftSearch").value;
  let list;
  if (q.trim()) {
    list = active().filter((l) => matches(l, q));
    $("#giftListLabel").textContent = `Search results (${list.length})`;
  } else {
    list = active().filter((l) => !l.giftGiven).reverse();
    $("#giftListLabel").textContent = `Gift not given yet (${list.length})`;
  }
  const badge = (l) => l.giftGiven
    ? `<span class="badge b-ok">Gift given</span>`
    : isComplete(l) ? `<span class="badge b-ok">Ready</span>` : `<span class="badge b-bad">Incomplete</span>`;
  $("#giftList").innerHTML = list.length
    ? list.slice(0, 60).map((l) => miniItem(l, badge(l))).join("")
    : `<div class="empty">${q.trim() ? "No match found." : "Everyone has received their gift. 🎉"}</div>`;
}
$("#giftSearch").addEventListener("input", renderGiftList);
$("#giftList").addEventListener("click", (e) => {
  const b = e.target.closest(".mini-item");
  if (b) openGift(b.dataset.id);
});

const clubLabel = (l) => {
  const c = allClubs.find((x) => x.id === l.clubId);
  return `${c ? c.name : l.clubName}${c && c.deleted ? " (club deleted)" : ""}`;
};

function detailTable(l, showClub = false) {
  const row = (k, v) => `<tr><td>${k}</td><td>${v === "" || v == null ? "<span style='color:#b42318'>—</span>" : esc(v)}</td></tr>`;
  const sec = (t) => `<tr class="sec"><td colspan="2">${t}</td></tr>`;
  const ch = (l.challenges || []).map((c) => (c === "Other" ? `Other Disease${l.challengeOther ? `: ${l.challengeOther}` : ""}` : c)).join(", ");
  return `<table class="detail-table">
    ${sec("1. Contact Information")}
    ${showClub ? row("Club", clubLabel(l)) : ""}
    ${row("Token", l.token)}
    ${row("Full Name", l.name)}
    ${row("Age", l.age)}
    ${row("Mobile No.", l.mobile)}
    ${row("WhatsApp", l.whatsapp)}
    ${row("Occupation", l.occupation)}
    ${sec("2. Health Self-Assessment")}
    ${row("Health Goal", l.healthGoal)}
    ${row("Health rating", l.healthRating ? `${l.healthRating} / 10` : "")}
    ${row("Energy Level", l.energyLevel ? `${l.energyLevel} / 10` : "")}
    ${row("Regular medication", l.onMedication)}
    ${l.onMedication === "Yes" ? row("Medicine / condition", l.medicationDetails) : ""}
    ${row("Physical challenges", ch)}
    ${sec("3. Body Parameter Check")}
    ${bodySkipped(l) ? `<tr><td colspan="2"><span class="badge b-skip">Body check skipped</span></td></tr>` : ""}
    ${row("Height", l.height ? `${l.height} ${l.heightUnit || ""}` : "")}
    ${row("Weight", l.weight ? `${l.weight} kg` : "")}
    ${row("BMI", l.bmi)}
    ${row("BMI Category", l.bmiCategory)}
    ${sec("4. Preferences &amp; Next Steps")}
    ${row("Wellness Consultation", l.wantsConsultation)}
    ${row("Income opportunity", l.incomeInterest)}
    ${sec("Record")}
    ${row("Registered", fmtTime(l.createdAt))}
    ${row("Body check", bodySkipped(l) ? `Skipped · ${fmtTime(l.bodySkippedAt)}` : fmtTime(l.bodyCheckAt))}
    ${row("Gift", l.giftGiven ? `Given · ${fmtTime(l.giftAt)}` : "Not given")}
    ${l.deleted ? row("In Recycle Bin since", fmtTime(l.deletedAt)) : ""}
  </table>`;
}

function openGift(id) {
  const l = leads.find((x) => x.id === id);
  if (!l) return;
  giftId = id;
  paintGift(l);
  $("#giftPick").classList.add("hidden");
  $("#giftView").classList.remove("hidden");
  openTab("gift");
}
function paintGift(l) {
  const miss = missingItems(l);
  let status;
  if (l.giftGiven) status = `<div class="all-good">🎁 Gift already given · ${fmtTime(l.giftAt)}</div>`;
  else if (miss.length) status = `<div class="missing"><b>Incomplete. Do not give the gift.</b> Missing:<ul>${miss.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>`;
  else status = `<div class="all-good">✅ All details complete. Verify mobile number with the visitor, then give the gift.</div>`;
  $("#giftDetails").innerHTML = `<div class="card">${detailTable(l)}${status}</div>`;
  const btn = $("#giftBtn");
  btn.disabled = l.giftGiven || miss.length > 0;
  btn.textContent = l.giftGiven ? "Gift Already Given" : "Mark Gift Given";
}
function closeGift() {
  giftId = null;
  $("#giftView").classList.add("hidden");
  $("#giftPick").classList.remove("hidden");
  $("#giftSearch").value = "";
  renderGiftList();
}
$("#giftBack").onclick = closeGift;

$("#giftBtn").onclick = async () => {
  const l = leads.find((x) => x.id === giftId);
  if (!l || l.giftGiven || !isComplete(l)) return;
  const ok = await confirmBox("Give gift?", `Confirm gift handed to <b>${esc(l.token)} – ${esc(l.name)}</b>.`, "Yes, Gift Given", "btn-gold");
  if (!ok) return;
  loading(true);
  try {
    await updateDoc(doc(db, "leads", l.id), { giftGiven: true, giftAt: serverTimestamp() });
    toast(`🎁 Gift marked for ${l.token}`);
    closeGift();
  } catch (err) {
    console.error(err);
    toast("Save failed. Check internet and try again.", true);
  } finally {
    loading(false);
  }
};

/* ============================================================
   CLUB: leads list + recycle bin
   ============================================================ */
$("#leadFilters").addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  leadFilter = c.dataset.f;
  $$("#leadFilters .chip").forEach((x) => x.classList.toggle("active", x === c));
  renderLeads();
});
$("#leadSearch").addEventListener("input", renderLeads);

function filteredLeads() {
  const q = $("#leadSearch").value;
  return leads.filter((l) => {
    if (!matches(l, q)) return false;
    if (leadFilter === "bin") return !!l.deleted;
    if (l.deleted) return false;
    if (leadFilter === "followup") return !l.followUpDone;
    if (leadFilter === "consult") return l.wantsConsultation === "Yes";
    if (leadFilter === "income") return l.incomeInterest === "Yes";
    if (leadFilter === "incomplete") return !isComplete(l);
    return true;
  });
}

function badges(l) {
  const b = [];
  b.push(bodyDone(l) ? `<span class="badge b-ok">Body ✓</span>`
    : bodySkipped(l) ? `<span class="badge b-skip">Body Skipped</span>` : `<span class="badge b-warn">Body pending</span>`);
  b.push(l.giftGiven ? `<span class="badge b-ok">Gift ✓</span>` : `<span class="badge b-warn">No gift</span>`);
  if (l.wantsConsultation === "Yes") b.push(`<span class="badge b-ok">Consultation</span>`);
  if (l.incomeInterest === "Yes") b.push(`<span class="badge b-ok">Income</span>`);
  return b.join("");
}

function renderLeads() {
  const inBin = leadFilter === "bin";
  const list = filteredLeads();
  const binCount = leads.filter((l) => l.deleted).length;
  $("#leadFilters .chip-bin").textContent = `🗑 Recycle Bin (${binCount})`;
  $("#leadsTitle").textContent = inBin ? "Recycle Bin" : "Leads";
  $("#leadCount").textContent = inBin
    ? `${list.length} deleted lead${list.length === 1 ? "" : "s"} · restore any by tapping Restore`
    : `${list.length} lead${list.length === 1 ? "" : "s"}`;
  $("#leadList").innerHTML = list.length ? list.map((l) => `
    <div class="lead-card${inBin ? " in-bin" : ""}" data-id="${l.id}">
      <div class="lc-top"><span class="token">${esc(l.token)}</span><span class="nm">${esc(l.name)}</span></div>
      <div class="lc-sub">Age ${esc(l.age)} · ${esc(l.occupation)} · ${esc(l.mobile)} · ${fmtTime(l.createdAt)}</div>
      <div class="lc-badges">${badges(l)}</div>
      <div class="lc-actions">
        ${inBin
          ? `<button type="button" data-act="view">View</button>
             <button type="button" class="restore" data-act="restore">↩ Restore</button>`
          : `<a href="tel:${esc(l.mobile)}">📞 Call</a>
             <a class="wa" href="https://wa.me/91${esc(l.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a>
             <button type="button" data-act="view">View</button>
             <label class="fu"><input type="checkbox" data-act="fu" ${l.followUpDone ? "checked" : ""}> Follow-up done</label>`}
      </div>
    </div>`).join("") : `<div class="empty">${inBin ? "Recycle Bin is empty." : "No leads found."}</div>`;
}

$("#leadList").addEventListener("click", (e) => {
  const card = e.target.closest(".lead-card");
  if (!card) return;
  const act = e.target.dataset.act;
  if (act === "view") openDetail(card.dataset.id);
  if (act === "restore") restoreLead(card.dataset.id);
});
$("#leadList").addEventListener("change", async (e) => {
  if (e.target.dataset.act !== "fu") return;
  const id = e.target.closest(".lead-card").dataset.id;
  const val = e.target.checked;
  try {
    await updateDoc(doc(db, "leads", id), { followUpDone: val, followUpAt: val ? serverTimestamp() : null });
  } catch (err) {
    e.target.checked = !val;
    toast("Could not update. Check internet.", true);
  }
});

async function moveToBin(l, by) {
  const ok = await confirmBox("Move to Recycle Bin?",
    `<b>${esc(l.token)} – ${esc(l.name)}</b> will be moved to the Recycle Bin. You can restore it later.`,
    "Move to Bin", "btn-danger");
  if (!ok) return;
  try {
    await updateDoc(doc(db, "leads", l.id), { deleted: true, deletedAt: serverTimestamp(), deletedBy: by });
    toast(`${l.token} moved to Recycle Bin`);
  } catch (err) {
    console.error(err);
    toast("Could not delete. Check internet.", true);
  }
}
async function restoreLead(id, list = leads) {
  const l = list.find((x) => x.id === id);
  if (!l) return;
  try {
    await updateDoc(doc(db, "leads", id), { deleted: false, restoredAt: serverTimestamp() });
    toast(`${l.token} restored`);
  } catch (err) {
    console.error(err);
    toast("Could not restore. Check internet.", true);
  }
}

async function openDetail(id) {
  const l = leads.find((x) => x.id === id);
  if (!l) return;
  const buttons = l.deleted
    ? [{ label: "↩ Restore", cls: "btn-primary", value: "restore" }, { label: "Close", cls: "btn-light", value: null }]
    : [
        { label: "🗑 Delete", cls: "btn-danger", value: "del" },
        { label: "Edit Form", cls: "btn-light", value: "edit" },
        { label: "Body Check", cls: "btn-light", value: "body" },
        { label: "Close", cls: "btn-primary", value: null },
      ];
  const act = await modal(`<h3>${esc(l.token)} – ${esc(l.name)}</h3>${detailTable(l)}`, buttons);
  if (act === "edit") fillRegForm(l);
  else if (act === "body") openBody(l.id);
  else if (act === "del") moveToBin(l, myClub.name);
  else if (act === "restore") restoreLead(l.id);
}

/* CSV export (shared) */
function exportCSV(list, filename, withClub) {
  if (!list.length) return toast("Nothing to export", true);
  const cols = [
    ...(withClub ? [["Club", (l) => clubLabel(l)]] : []),
    ["Token", (l) => l.token], ["Full Name", (l) => l.name], ["Age", (l) => l.age],
    ["Mobile", (l) => l.mobile], ["WhatsApp", (l) => l.whatsapp], ["Occupation", (l) => l.occupation],
    ["Health Goal", (l) => l.healthGoal], ["Health Rating (1-10)", (l) => l.healthRating],
    ["Energy Level (1-10)", (l) => l.energyLevel], ["Regular Medication", (l) => l.onMedication],
    ["Medicine / Condition", (l) => l.medicationDetails],
    ["Physical Challenges", (l) => (l.challenges || []).map((c) => (c === "Other" ? "Other Disease" : c)).join("; ")], ["Other Disease", (l) => l.challengeOther],
    ["Height", (l) => l.height], ["Height Unit", (l) => l.heightUnit], ["Weight (kg)", (l) => l.weight],
    ["BMI", (l) => l.bmi], ["BMI Category", (l) => l.bmiCategory],
    ["Body Check", (l) => (bodyDone(l) ? "Done" : bodySkipped(l) ? "Skipped" : "Pending")],
    ["Wellness Consultation", (l) => l.wantsConsultation], ["Income Opportunity", (l) => l.incomeInterest],
    ["Gift Given", (l) => (l.giftGiven ? "Yes" : "No")], ["Follow-up Done", (l) => (l.followUpDone ? "Yes" : "No")],
    ["Registered At", (l) => fmtTime(l.createdAt)],
  ];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.map((c) => cell(c[0])).join(","),
    ...list.map((l) => cols.map((c) => cell(c[1](l))).join(","))].join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${list.length} leads`);
}
$("#exportBtn").onclick = () => {
  const list = filteredLeads().slice().reverse();
  exportCSV(list, `${myClub.code}-leads`, false);
};

function renderStats() {
  const a = active();
  const today = new Date().toDateString();
  $("#statToday").textContent = a.filter((l) => toDate(l.createdAt)?.toDateString() === today).length;
  $("#statTotal").textContent = a.length;
  $("#statBody").textContent = a.filter(bodyDone).length;
  $("#statGift").textContent = a.filter((l) => l.giftGiven).length;
}

function renderAll() {
  renderStats();
  renderBodyList();
  renderGiftList();
  renderLeads();
  if (giftId) {
    const l = leads.find((x) => x.id === giftId);
    if (l && !l.deleted) paintGift(l); else closeGift();
  }
  if (bodyId) {
    const l = leads.find((x) => x.id === bodyId);
    if (!l || l.deleted) closeBody();
  }
}

/* ============================================================
   OWNER PANEL
   ============================================================ */
function openOwnerTab(name) {
  ownerTab = name;
  $$("#ownerScreen .tab").forEach((t) => t.classList.toggle("active", t.dataset.otab === name));
  $$("#ownerScreen .panel").forEach((p) => p.classList.toggle("active", p.id === `o-${name}`));
  window.scrollTo({ top: 0 });
}
$$("#ownerScreen .tab").forEach((t) => (t.onclick = () => openOwnerTab(t.dataset.otab)));

function startOwnerLeads() {
  if (unsubOwner) { unsubOwner(); unsubOwner = null; }
  ownerLeads = [];
  renderOwner();
  const base = collection(db, "leads");
  const q = ownerSel === "ALL" ? base : query(base, where("clubId", "==", ownerSel));
  unsubOwner = onSnapshot(q, (snap) => {
    ownerLeads = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt));
    renderOwner();
  }, (err) => {
    console.error(err);
    toast("Could not load leads. Check internet / rules.", true);
  });
}

function renderOwnerSelects() {
  const opts = `<option value="ALL">All clubs</option>` +
    allClubs.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.code)})${c.deleted ? " – deleted" : ""}</option>`).join("");
  ["#oClubSel", "#oBinClubSel"].forEach((s) => {
    $(s).innerHTML = opts;
    $(s).value = allClubs.some((c) => c.id === ownerSel) ? ownerSel : "ALL";
  });
}
["#oClubSel", "#oBinClubSel"].forEach((s) => {
  $(s).addEventListener("change", (e) => {
    ownerSel = e.target.value;
    $("#oClubSel").value = ownerSel;
    $("#oBinClubSel").value = ownerSel;
    startOwnerLeads();
  });
});
$("#oLeadSearch").addEventListener("input", renderOwnerLeads);
$("#oBinSearch").addEventListener("input", renderOwnerBin);

function renderOwnerStats() {
  const a = ownerLeads.filter((l) => !l.deleted);
  $("#oStatClubs").textContent = clubs.length;
  $("#oStatLeads").textContent = a.length;
  $("#oStatBody").textContent = a.filter(bodyDone).length;
  $("#oStatGift").textContent = a.filter((l) => l.giftGiven).length;
}

function renderOwner() {
  renderOwnerStats();
  renderOwnerLeads();
  renderOwnerBin();
}

function ownerCard(l, inBin) {
  return `<div class="lead-card${inBin ? " in-bin" : ""}" data-id="${l.id}">
    <div class="lc-top"><span class="token">${esc(l.token)}</span><span class="nm">${esc(l.name)}</span></div>
    <div class="lc-sub"><b>${esc(clubLabel(l))}</b> · ${esc(l.mobile)} · ${fmtTime(inBin ? l.deletedAt : l.createdAt)}</div>
    <div class="lc-badges">${badges(l)}</div>
    <div class="lc-actions">
      ${inBin
        ? `<button type="button" data-act="view">View</button>
           <button type="button" class="restore" data-act="restore">↩ Restore</button>
           <button type="button" class="danger" data-act="purge">Delete Forever</button>`
        : `<a href="tel:${esc(l.mobile)}">📞 Call</a>
           <a class="wa" href="https://wa.me/91${esc(l.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a>
           <button type="button" data-act="view">View</button>`}
    </div>
  </div>`;
}

const ownerActive = () => ownerLeads.filter((l) => !l.deleted && matches(l, $("#oLeadSearch").value));
const ownerBinned = () => ownerLeads.filter((l) => l.deleted && matches(l, $("#oBinSearch").value));

function renderOwnerLeads() {
  const list = ownerActive();
  $("#oLeadCount").textContent = `${list.length} lead${list.length === 1 ? "" : "s"}`;
  $("#oLeadList").innerHTML = list.length
    ? list.slice(0, 300).map((l) => ownerCard(l, false)).join("") +
      (list.length > 300 ? `<div class="empty">Showing first 300. Use search or pick a club, or Export CSV for all.</div>` : "")
    : `<div class="empty">No leads yet.</div>`;
}
function renderOwnerBin() {
  const list = ownerBinned();
  $("#oBinCount").textContent = `${list.length} deleted lead${list.length === 1 ? "" : "s"}`;
  $("#oPurgeAll").disabled = !list.length;
  $("#oBinList").innerHTML = list.length
    ? list.map((l) => ownerCard(l, true)).join("")
    : `<div class="empty">Recycle Bin is empty.</div>`;
}

async function ownerListClick(e) {
  const card = e.target.closest(".lead-card");
  if (!card) return;
  const l = ownerLeads.find((x) => x.id === card.dataset.id);
  if (!l) return;
  const act = e.target.dataset.act;
  if (act === "view") {
    const buttons = l.deleted
      ? [{ label: "↩ Restore", cls: "btn-primary", value: "restore" },
         { label: "Delete Forever", cls: "btn-danger", value: "purge" },
         { label: "Close", cls: "btn-light", value: null }]
      : [{ label: "🗑 Move to Bin", cls: "btn-danger", value: "bin" },
         { label: "Close", cls: "btn-primary", value: null }];
    const r = await modal(`<h3>${esc(l.token)} – ${esc(l.name)}</h3>${detailTable(l, true)}`, buttons);
    if (r === "restore") restoreLead(l.id, ownerLeads);
    if (r === "purge") purge([l]);
    if (r === "bin") moveToBin(l, "Owner");
  }
  if (act === "restore") restoreLead(l.id, ownerLeads);
  if (act === "purge") purge([l]);
}
$("#oLeadList").addEventListener("click", ownerListClick);
$("#oBinList").addEventListener("click", ownerListClick);

async function purge(list) {
  if (!list.length) return;
  const label = list.length === 1 ? `<b>${esc(list[0].token)} – ${esc(list[0].name)}</b>` : `<b>${list.length} leads</b>`;
  const ok = await askKey("Delete forever?", `${label} will be permanently deleted. This cannot be undone.`);
  if (!ok) return;
  loading(true);
  try {
    for (let i = 0; i < list.length; i += 400) {
      const batch = writeBatch(db);
      list.slice(i, i + 400).forEach((l) => batch.delete(doc(db, "leads", l.id)));
      await batch.commit();
    }
    toast(`Permanently deleted ${list.length} lead${list.length === 1 ? "" : "s"}`);
  } catch (err) {
    console.error(err);
    toast("Delete failed. Check internet.", true);
  } finally {
    loading(false);
  }
}
$("#oPurgeAll").onclick = () => purge(ownerBinned());

$("#oExportBtn").onclick = () => {
  const c = clubs.find((x) => x.id === ownerSel);
  exportCSV(ownerActive().slice().reverse(), c ? `${c.code}-leads` : "all-clubs-leads", true);
};

/* ---------- Delete ALL leads (all clubs) ---------- */
$("#wipeAllBtn").onclick = async () => {
  const ok = await askKey("Delete ALL leads?",
    `This permanently deletes <b>every lead from every club</b>, including the Recycle Bin.
     Clubs, names and PINs stay. Token numbers restart from 001. This cannot be undone.`,
    "Delete All Leads", "btn-danger");
  if (!ok) return;
  loading(true);
  try {
    const snap = await getDocs(collection(db, "leads"));
    const ids = snap.docs.map((d) => d.id);
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      ids.slice(i, i + 400).forEach((id) => batch.delete(doc(db, "leads", id)));
      await batch.commit();
    }
    const cb = writeBatch(db);
    clubs.forEach((c) => cb.update(doc(db, "clubs", c.id), { nextToken: 1 }));
    if (clubs.length) await cb.commit();
    loading(false);
    await modal(`<h3>All leads deleted</h3><p>${ids.length} lead${ids.length === 1 ? "" : "s"} removed. All clubs and PINs are unchanged.</p>`);
  } catch (err) {
    console.error(err);
    toast("Delete failed. Check internet and try again.", true);
  } finally {
    loading(false);
  }
};

/* ---------- Clubs management ---------- */
const revealedPins = {}; // clubId -> pin, only after the security key was entered
function renderClubList() {
  $("#clubCount").textContent = `${clubs.length} club${clubs.length === 1 ? "" : "s"}`;
  $("#clubList").innerHTML = clubs.length ? clubs.map((c) => `
    <div class="club-row" data-id="${esc(c.id)}">
      <span class="token">${esc(c.code)}</span>
      <span class="grow"><div class="nm">${esc(c.name)}</div>
        <div class="sub">${c.mobile ? `${esc(c.mobile)} · ` : ""}Tokens issued: ${Math.max((c.nextToken || 1) - 1, 0)}</div>
        <div class="pin-line">PIN: <b class="pin-val">${revealedPins[c.id] ? esc(revealedPins[c.id]) : "••••"}</b>
          <button type="button" class="pin-eye" data-act="showpin" aria-label="Show PIN">${revealedPins[c.id] ? EYE_CLOSED : EYE_OPEN}</button></div></span>
      <div class="row-btns">
        <button type="button" class="btn btn-light btn-sm" data-act="leads">Leads</button>
        <button type="button" class="btn btn-light btn-sm" data-act="pin">Change PIN</button>
        <button type="button" class="btn btn-sm btn-del" data-act="delete">Delete</button>
      </div>
    </div>`).join("") : `<div class="empty">No clubs yet. Approve a request or add one above.</div>`;
}

$("#clubList").addEventListener("click", async (e) => {
  const row = e.target.closest(".club-row");
  if (!row) return;
  const c = clubs.find((x) => x.id === row.dataset.id);
  if (!c) return;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "leads") {
    ownerSel = c.id;
    renderOwnerSelects();
    startOwnerLeads();
    openOwnerTab("leads");
  }
  if (act === "pin") changePin(c);
  if (act === "showpin") togglePin(c);
  if (act === "delete") deleteClub(c);
});

const addForm = $("#addClubForm");
addForm.clubCode.addEventListener("input", () => (addForm.clubCode.value = codeClean(addForm.clubCode.value)));
addForm.clubPinNew.addEventListener("input", () => (addForm.clubPinNew.value = digits(addForm.clubPinNew.value, 4)));
addForm.clubMobile.addEventListener("input", () => (addForm.clubMobile.value = digits(addForm.clubMobile.value, 10)));

/** Create a hidden Firebase login for a club and return its email + uid */
async function createClubAccount(clubId, pin) {
  const email = `club-${clubId}-${Date.now()}@${CLUB_EMAIL_DOMAIN}`;
  const ca = getCreatorAuth();
  const cred = await createUserWithEmailAndPassword(ca, email, clubPassword(clubId, pin));
  const uid = cred.user.uid;
  await signOut(ca);
  return { email, uid };
}
function accountError(ex) {
  const c = ex.code || "";
  if (c.includes("operation-not-allowed") || c.includes("admin-restricted")) {
    return "Firebase sign-up is OFF. Turn ON 'Enable create (sign-up)' in Authentication → Settings → User actions.";
  }
  if (c.includes("network")) return "No internet connection.";
  return "Could not create the login. Try again.";
}

/** Validate owner-entered club details. Returns error text or "" */
function clubDetailsError({ name, mobile, code, pin }, ignoreRequestId = null) {
  if (!name) return "Enter the club owner's name";
  if (!isPhone(mobile)) return "Enter a valid 10-digit mobile number";
  if (!/^[A-Z0-9]{2,6}$/.test(code)) return "Short code: 2–6 letters/numbers, e.g. RAHUL";
  if (!/^\d{4}$/.test(pin)) return "PIN must be exactly 4 digits";
  const id = code.toLowerCase();
  if (allClubs.some((c) => c.id === id)) return `Code ${code} is already used (codes of deleted clubs can't be reused)`;
  if (requests.some((r) => r.id === id && r.id !== ignoreRequestId)) return `Code ${code} is already in a pending request`;
  if (clubs.some((c) => c.name.toLowerCase() === name.toLowerCase())) return "A club with this owner name already exists";
  return "";
}

/** Create the club records (club, member link, saved PIN) in one batch */
function addClubRecords(batch, { id, name, mobile, code, pin, email, uid }) {
  batch.set(doc(db, "clubs", id), {
    name, mobile, code, authEmail: email, uid, nextToken: 1, deleted: false, createdAt: serverTimestamp(),
  });
  batch.set(doc(db, "members", uid), { clubId: id });
  batch.set(doc(db, "clubSecrets", id), { pin });
}

addForm.onsubmit = async (e) => {
  e.preventDefault();
  const d = {
    name: addForm.clubName.value.trim(),
    mobile: addForm.clubMobile.value.trim(),
    code: addForm.clubCode.value.trim(),
    pin: addForm.clubPinNew.value.trim(),
  };
  const errText = clubDetailsError(d);
  if (errText) return toast(errText, true);
  const id = d.code.toLowerCase();

  loading(true);
  $("#addClubBtn").disabled = true;
  try {
    const acc = await createClubAccount(id, d.pin);
    const batch = writeBatch(db);
    addClubRecords(batch, { ...d, id, email: acc.email, uid: acc.uid });
    await batch.commit();
    addForm.reset();
    loading(false);
    await modal(`<h3>Club added ✅</h3>
      <p><b>${esc(d.name)}</b> can now login by selecting their name and entering this PIN:</p>
      <div class="token-big">${esc(d.pin)}</div>
      <p class="note">Tokens will look like <b>${esc(d.code)}-001</b>.</p>`);
  } catch (ex) {
    console.error(ex);
    toast(accountError(ex), true);
  } finally {
    loading(false);
    $("#addClubBtn").disabled = false;
  }
};

async function togglePin(c) {
  if (revealedPins[c.id]) { delete revealedPins[c.id]; renderClubList(); return; }
  const ok = await askKey("Show PIN", `Enter the security key to see the PIN of <b>${esc(c.name)}</b>.`, "Show PIN", "btn-primary");
  if (!ok) return;
  try {
    const snap = await getDoc(doc(db, "clubSecrets", c.id));
    if (!snap.exists()) {
      return modal(`<h3>PIN not saved</h3><p>This club was added before PINs were saved. Use <b>Change PIN</b> once to set a new PIN, and it will be viewable after that.</p>`);
    }
    revealedPins[c.id] = snap.data().pin;
    renderClubList();
  } catch (err) {
    console.error(err);
    toast("Could not load PIN. Check that the latest Firestore rules are published.", true);
  }
}

async function changePin(c) {
  const ok = await modal(
    `<h3>Change PIN</h3><p><b>${esc(c.name)}</b>: phones logged in with the old PIN will be logged out.</p>
     <label class="field"><span>New 4-digit PIN</span>
     <input type="tel" id="newPinInput" inputmode="numeric" maxlength="4" autocomplete="off" /></label>`,
    [{ label: "Cancel", cls: "btn-light", value: false }, { label: "Save PIN", cls: "btn-primary", value: true }]
  );
  if (!ok) return;
  const pin = ($("#newPinInput")?.value || "").trim();
  if (!/^\d{4}$/.test(pin)) return toast("PIN must be exactly 4 digits", true);
  loading(true);
  try {
    const acc = await createClubAccount(c.id, pin);
    const batch = writeBatch(db);
    batch.update(doc(db, "clubs", c.id), { authEmail: acc.email, uid: acc.uid });
    batch.set(doc(db, "members", acc.uid), { clubId: c.id });
    if (c.uid) batch.delete(doc(db, "members", c.uid));
    batch.set(doc(db, "clubSecrets", c.id), { pin });
    await batch.commit();
    if (revealedPins[c.id]) { revealedPins[c.id] = pin; renderClubList(); }
    toast(`PIN changed for ${c.name}`);
  } catch (ex) {
    console.error(ex);
    toast(accountError(ex), true);
  } finally {
    loading(false);
  }
}

async function deleteClub(c) {
  const ok = await askKey("Delete club?",
    `<b>${esc(c.name)} (${esc(c.code)})</b> will be removed from the login list and its phones will be logged out.
     Its leads are <b>kept</b> in All Leads, marked "(club deleted)". The code ${esc(c.code)} can't be reused.`,
    "Delete Club", "btn-danger");
  if (!ok) return;
  loading(true);
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "clubs", c.id), { deleted: true, deletedAt: serverTimestamp(), uid: "", authEmail: "" });
    if (c.uid) batch.delete(doc(db, "members", c.uid));
    batch.delete(doc(db, "clubSecrets", c.id));
    await batch.commit();
    delete revealedPins[c.id];
    toast(`${c.name} deleted. Leads are kept.`);
  } catch (ex) {
    console.error(ex);
    toast("Could not delete club. Check internet / rules.", true);
  } finally {
    loading(false);
  }
}

/* ---------- Pending club requests ---------- */
function startRequests() {
  if (unsubRequests) unsubRequests();
  unsubRequests = onSnapshot(collection(db, "clubRequests"), (snap) => {
    requests = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt));
    renderRequests();
  }, (err) => {
    console.error(err);
    $("#requestList").innerHTML = `<div class="empty">Could not load requests. Publish the latest Firestore rules.</div>`;
  });
}

function renderRequests() {
  $("#reqCount").textContent = requests.length
    ? `Pending requests (${requests.length})` : "Pending requests (0)";
  const tab = $('#ownerScreen .tab[data-otab="clubs"]');
  tab.innerHTML = `<span class="ti">🏠</span>Clubs${requests.length ? ` <span class="tab-dot">${requests.length}</span>` : ""}`;
  $("#requestList").innerHTML = requests.length ? requests.map((r) => `
    <div class="club-row req-row" data-id="${esc(r.id)}">
      <span class="token">${esc(r.code)}</span>
      <span class="grow"><div class="nm">${esc(r.name)}</div>
        <div class="sub">${esc(r.mobile)} · requested ${fmtTime(r.createdAt)}</div></span>
      <div class="row-btns">
        <a class="btn btn-light btn-sm wa-btn" href="https://wa.me/91${esc(r.mobile)}" target="_blank" rel="noopener">WhatsApp</a>
        <button type="button" class="btn btn-light btn-sm" data-act="edit">Edit</button>
        <button type="button" class="btn btn-sm btn-del" data-act="reject">Reject</button>
        <button type="button" class="btn btn-primary btn-sm" data-act="approve">Approve</button>
      </div>
    </div>`).join("") : `<div class="empty">No pending requests.</div>`;
}

$("#requestList").addEventListener("click", async (e) => {
  const row = e.target.closest(".req-row");
  if (!row) return;
  const r = requests.find((x) => x.id === row.dataset.id);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!r || !act) return;
  if (act === "edit") editRequest(r);
  if (act === "reject") rejectRequest(r);
  if (act === "approve") approveRequest(r);
});

async function editRequest(r) {
  const ok = await modal(`<h3>Edit request</h3>
    <label class="field"><span>Club Owner's Name</span><input type="text" id="erName" value="${esc(r.name)}" /></label>
    <label class="field"><span>Mobile No.</span><input type="tel" id="erMobile" inputmode="numeric" maxlength="10" value="${esc(r.mobile)}" /></label>
    <div class="row-2">
      <label class="field"><span>Short Code</span><input type="text" id="erCode" maxlength="6" value="${esc(r.code)}" /></label>
      <label class="field"><span>4-digit PIN</span><input type="tel" id="erPin" inputmode="numeric" maxlength="4" value="${esc(r.pin)}" /></label>
    </div>`,
    [{ label: "Cancel", cls: "btn-light", value: false }, { label: "Save", cls: "btn-primary", value: true }]);
  if (!ok) return;
  const d = {
    name: $("#erName").value.trim(),
    mobile: digits($("#erMobile").value, 10),
    code: codeClean($("#erCode").value),
    pin: digits($("#erPin").value, 4),
  };
  const errText = clubDetailsError(d, r.id);
  if (errText) return toast(errText, true);
  try {
    await updateDoc(doc(db, "clubRequests", r.id), d);
    toast("Request updated");
  } catch (ex) {
    console.error(ex);
    toast("Could not update request.", true);
  }
}

async function rejectRequest(r) {
  const ok = await confirmBox("Reject request?", `Reject the request from <b>${esc(r.name)}</b> (${esc(r.code)})?`, "Reject", "btn-danger");
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "clubRequests", r.id));
    toast("Request rejected");
  } catch (ex) {
    console.error(ex);
    toast("Could not reject. Check internet.", true);
  }
}

async function approveRequest(r) {
  const errText = clubDetailsError(r, r.id);
  if (errText) return toast(errText, true);
  const ok = await confirmBox("Approve?",
    `Approve <b>${esc(r.name)}</b> with code <b>${esc(r.code)}</b>? They can login right away with their PIN.`, "Approve");
  if (!ok) return;
  loading(true);
  try {
    const id = r.code.toLowerCase();
    let email = r.authEmail, uid = r.uid;
    // code or PIN edited → the original login no longer matches, so make a new one
    if (r.code !== r.origCode || r.pin !== r.origPin) {
      const acc = await createClubAccount(id, r.pin);
      email = acc.email; uid = acc.uid;
    }
    const batch = writeBatch(db);
    addClubRecords(batch, { id, name: r.name, mobile: r.mobile, code: r.code, pin: r.pin, email, uid });
    batch.delete(doc(db, "clubRequests", r.id));
    await batch.commit();
    toast(`${r.name} approved ✅`);
  } catch (ex) {
    console.error(ex);
    toast(accountError(ex), true);
  } finally {
    loading(false);
  }
}

setEnergyUI(false);
