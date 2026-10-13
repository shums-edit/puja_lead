import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, query, orderBy,
  runTransaction, updateDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, CLUB_NAME, TOKEN_PREFIX } from "./firebase-config.js";

/* ============================================================
   Helpers
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tokenStr = (n) => `${TOKEN_PREFIX}-${String(n).padStart(3, "0")}`;
const isPhone = (v) => /^[6-9]\d{9}$/.test(String(v || ""));
const toDate = (ts) => (ts && ts.toDate ? ts.toDate() : null);
const fmtTime = (ts) => {
  const d = toDate(ts);
  return d ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
};

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
const loading = (on) => $("#loader").classList.toggle("show", on);

/** Simple modal. buttons: [{label, cls, value}] → resolves with value */
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
  });
}
const confirmBox = (title, text, okLabel = "Yes", okCls = "btn-primary") =>
  modal(`<h3>${title}</h3><p>${text}</p>`, [
    { label: "No", cls: "btn-light", value: false },
    { label: okLabel, cls: okCls, value: true },
  ]);

/* ============================================================
   Firebase
   ============================================================ */
const configMissing = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PASTE");
let app, auth, db;
if (!configMissing) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

/* ============================================================
   State
   ============================================================ */
let leads = [];
let unsubLeads = null;
let editingId = null;
let bodyId = null;
let giftId = null;
let energyTouched = false;
let leadFilter = "all";

const CHALLENGES = [
  "Joint / Knee Pain", "Back Pain", "Low Energy / Fatigue",
  "Digestive Issues / Acidity", "Weight Gain / Weight Loss", "Other", "None",
];

/* ============================================================
   Status logic
   ============================================================ */
const bodyDone = (l) => !!(l.height && l.weight && l.bmi && l.bmiCategory);

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
  if ((l.challenges || []).includes("Other") && !l.challengeOther) m.push("Other challenge details");
  if (!l.wantsConsultation) m.push("Wellness Consultation (Yes/No)");
  if (!l.incomeInterest) m.push("Income opportunity (Yes/No)");
  if (!l.height) m.push("Height");
  if (!l.weight) m.push("Weight");
  if (!l.bmi) m.push("BMI");
  if (!l.bmiCategory) m.push("BMI Category");
  return m;
}
const isComplete = (l) => missingItems(l).length === 0;

function matches(l, q) {
  if (!q) return true;
  q = q.trim().toLowerCase();
  return (
    (l.token || "").toLowerCase().includes(q) ||
    String(l.tokenNo || "") === q.replace(/^\D+/, "").replace(/^0+/, "") ||
    (l.name || "").toLowerCase().includes(q) ||
    (l.mobile || "").includes(q) ||
    (l.whatsapp || "").includes(q)
  );
}

/* ============================================================
   Auth
   ============================================================ */
function showScreen(id) {
  $$(".screen").forEach((s) => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

$("#pwToggle").onclick = () => {
  const inp = $("#loginPassword");
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  $("#eyeOpen").classList.toggle("hidden", show);
  $("#eyeClosed").classList.toggle("hidden", !show);
  $("#pwToggle").setAttribute("aria-label", show ? "Hide password" : "Show password");
};

$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  if (configMissing) return;
  $("#loginError").textContent = "";
  $("#loginBtn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("#loginEmail").value.trim(), $("#loginPassword").value);
  } catch (err) {
    const code = err.code || "";
    $("#loginError").textContent =
      code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")
        ? "Wrong email or password."
        : code.includes("too-many-requests")
          ? "Too many attempts. Wait a minute and try again."
          : code.includes("network")
            ? "No internet connection."
            : "Login failed. Please try again.";
  } finally {
    $("#loginBtn").disabled = false;
  }
};

$("#logoutBtn").onclick = async () => {
  if (await confirmBox("Logout?", "You will need to login again to continue.", "Logout", "btn-danger")) {
    signOut(auth);
  }
};

if (configMissing) {
  showScreen("#loginScreen");
  $("#setupWarning").classList.remove("hidden");
  $("#loginBtn").disabled = true;
} else {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      showScreen("#appScreen");
      startLeads();
    } else {
      if (unsubLeads) { unsubLeads(); unsubLeads = null; }
      leads = [];
      showScreen("#loginScreen");
    }
  });
}

function startLeads() {
  if (unsubLeads) return;
  const q = query(collection(db, "leads"), orderBy("tokenNo", "desc"));
  unsubLeads = onSnapshot(q, (snap) => {
    leads = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  }, (err) => {
    console.error(err);
    toast("Could not load data. Check internet / Firestore rules.", true);
  });
}

/* ============================================================
   Tabs
   ============================================================ */
function openTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  window.scrollTo({ top: 0 });
}
$$(".tab").forEach((t) => (t.onclick = () => openTab(t.dataset.tab)));

/* ============================================================
   REGISTER form
   ============================================================ */
const regForm = $("#regForm");

// build 1–10 rating
$("#healthRating").innerHTML = Array.from({ length: 10 }, (_, i) =>
  `<label><input type="radio" name="healthRating" value="${i + 1}"><i>${i + 1}</i></label>`).join("");

// build challenges
$("#challengeList").innerHTML = CHALLENGES.map((c) =>
  `<label><input type="checkbox" name="challenge" value="${c}"> ${c}</label>`).join("");

$("#challengeList").addEventListener("change", (e) => {
  const box = e.target;
  if (box.name !== "challenge") return;
  if (box.value === "None" && box.checked) {
    $$('input[name=challenge]').forEach((c) => { if (c.value !== "None") c.checked = false; });
  } else if (box.checked) {
    $('input[name=challenge][value="None"]').checked = false;
  }
  $("#otherWrap").classList.toggle("hidden", !$('input[name=challenge][value="Other"]').checked);
  $("#challengeList").classList.remove("invalid-group");
});

// medication yes → details
regForm.addEventListener("change", (e) => {
  if (e.target.name === "onMedication") {
    $("#medDetailsWrap").classList.toggle("hidden", e.target.value !== "Yes");
  }
  if (e.target.type === "radio") e.target.closest(".seg, .rating")?.classList.remove("invalid-group");
});

// digits only for phone fields
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

// energy slider
function setEnergyUI(touched) {
  energyTouched = touched;
  $("#energy").closest(".slider-wrap").classList.remove("invalid-group");
  const s = $("#energy"), out = $("#energyOut");
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
  if (d.challenges.includes("Other") && !d.challengeOther) return fail(f.challengeOther, "Write the Other challenge");
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

  // duplicate mobile check
  const dup = leads.find((l) => l.mobile === d.mobile && l.id !== editingId);
  if (dup) {
    const go = await confirmBox("Mobile already registered",
      `<b>${esc(d.mobile)}</b> is already registered as <b>${esc(dup.token)} – ${esc(dup.name)}</b>.<br><br>Register again anyway?`,
      "Yes, continue");
    if (!go) return;
  }

  loading(true);
  $("#regSubmit").disabled = true;
  try {
    const user = auth.currentUser?.email || "";
    if (editingId) {
      await updateDoc(doc(db, "leads", editingId), { ...d, updatedAt: serverTimestamp(), updatedBy: user });
      const l = leads.find((x) => x.id === editingId);
      toast(`${l?.token || "Entry"} updated`);
      resetRegForm();
      openTab("leads");
    } else {
      const counterRef = doc(db, "meta", "counter");
      const leadRef = doc(collection(db, "leads"));
      const tokenNo = await runTransaction(db, async (tx) => {
        const snap = await tx.get(counterRef);
        const next = snap.exists() ? (snap.data().next || 1) : 1;
        tx.set(counterRef, { next: next + 1 });
        tx.set(leadRef, {
          ...d,
          tokenNo: next,
          token: tokenStr(next),
          height: "", heightUnit: "cm", weight: "", bmi: "", bmiCategory: "",
          giftGiven: false,
          followUpDone: false,
          createdAt: serverTimestamp(),
          createdBy: user,
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
         <div class="token-big">${tokenStr(tokenNo)}</div>`,
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
   BODY CHECK
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
    list = leads.filter((l) => matches(l, q));
    $("#bodyListLabel").textContent = `Search results (${list.length})`;
  } else {
    list = leads.filter((l) => !bodyDone(l)).slice().reverse(); // oldest waiting first
    $("#bodyListLabel").textContent = `Waiting for body check (${list.length})`;
  }
  $("#bodyList").innerHTML = list.length
    ? list.slice(0, 60).map((l) => miniItem(l, bodyDone(l)
        ? `<span class="badge b-ok">Done</span>` : `<span class="badge b-warn">Pending</span>`)).join("")
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
    await updateDoc(doc(db, "leads", bodyId), {
      ...d, bodyCheckAt: serverTimestamp(), bodyCheckBy: auth.currentUser?.email || "",
    });
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

/* ============================================================
   VERIFY & GIFT
   ============================================================ */
function renderGiftList() {
  const q = $("#giftSearch").value;
  let list;
  if (q.trim()) {
    list = leads.filter((l) => matches(l, q));
    $("#giftListLabel").textContent = `Search results (${list.length})`;
  } else {
    list = leads.filter((l) => !l.giftGiven).slice().reverse();
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

function detailTable(l) {
  const row = (k, v) => `<tr><td>${k}</td><td>${v === "" || v == null ? "<span style='color:#b42318'>—</span>" : esc(v)}</td></tr>`;
  const sec = (t) => `<tr class="sec"><td colspan="2">${t}</td></tr>`;
  const ch = (l.challenges || []).map((c) => (c === "Other" && l.challengeOther ? `Other: ${l.challengeOther}` : c)).join(", ");
  return `<table class="detail-table">
    ${sec("1. Contact Information")}
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
    ${row("Height", l.height ? `${l.height} ${l.heightUnit || ""}` : "")}
    ${row("Weight", l.weight ? `${l.weight} kg` : "")}
    ${row("BMI", l.bmi)}
    ${row("BMI Category", l.bmiCategory)}
    ${sec("4. Preferences &amp; Next Steps")}
    ${row("Wellness Consultation", l.wantsConsultation)}
    ${row("Income opportunity", l.incomeInterest)}
    ${sec("Record")}
    ${row("Registered", fmtTime(l.createdAt))}
    ${row("Body check", fmtTime(l.bodyCheckAt))}
    ${row("Gift", l.giftGiven ? `Given · ${fmtTime(l.giftAt)}` : "Not given")}
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
    await updateDoc(doc(db, "leads", l.id), {
      giftGiven: true, giftAt: serverTimestamp(), giftBy: auth.currentUser?.email || "",
    });
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
   LEADS
   ============================================================ */
$("#leadFilters").addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  leadFilter = c.dataset.f;
  $$(".chip").forEach((x) => x.classList.toggle("active", x === c));
  renderLeads();
});
$("#leadSearch").addEventListener("input", renderLeads);

function filteredLeads() {
  const q = $("#leadSearch").value;
  return leads.filter((l) => {
    if (!matches(l, q)) return false;
    if (leadFilter === "followup") return !l.followUpDone;
    if (leadFilter === "consult") return l.wantsConsultation === "Yes";
    if (leadFilter === "income") return l.incomeInterest === "Yes";
    if (leadFilter === "incomplete") return !isComplete(l);
    return true;
  });
}

function renderLeads() {
  const list = filteredLeads();
  $("#leadCount").textContent = `${list.length} lead${list.length === 1 ? "" : "s"}`;
  $("#leadList").innerHTML = list.length ? list.map((l) => {
    const b = [];
    b.push(bodyDone(l) ? `<span class="badge b-ok">Body ✓</span>` : `<span class="badge b-warn">Body pending</span>`);
    b.push(l.giftGiven ? `<span class="badge b-ok">Gift ✓</span>` : `<span class="badge b-warn">No gift</span>`);
    if (l.wantsConsultation === "Yes") b.push(`<span class="badge b-ok">Consultation</span>`);
    if (l.incomeInterest === "Yes") b.push(`<span class="badge b-ok">Income</span>`);
    return `<div class="lead-card" data-id="${l.id}">
      <div class="lc-top"><span class="token">${esc(l.token)}</span><span class="nm">${esc(l.name)}</span></div>
      <div class="lc-sub">Age ${esc(l.age)} · ${esc(l.occupation)} · ${esc(l.mobile)} · ${fmtTime(l.createdAt)}</div>
      <div class="lc-badges">${b.join("")}</div>
      <div class="lc-actions">
        <a href="tel:${esc(l.mobile)}">📞 Call</a>
        <a class="wa" href="https://wa.me/91${esc(l.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a>
        <button type="button" class="view" data-act="view">View</button>
        <label class="fu"><input type="checkbox" data-act="fu" ${l.followUpDone ? "checked" : ""}> Follow-up done</label>
      </div>
    </div>`;
  }).join("") : `<div class="empty">No leads found.</div>`;
}

$("#leadList").addEventListener("click", (e) => {
  const card = e.target.closest(".lead-card");
  if (!card) return;
  if (e.target.dataset.act === "view") openDetail(card.dataset.id);
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

async function openDetail(id) {
  const l = leads.find((x) => x.id === id);
  if (!l) return;
  const act = await modal(`<h3>${esc(l.token)} – ${esc(l.name)}</h3>${detailTable(l)}`, [
    { label: "Delete", cls: "btn-danger", value: "del" },
    { label: "Edit Form", cls: "btn-light", value: "edit" },
    { label: "Body Check", cls: "btn-light", value: "body" },
    { label: "Close", cls: "btn-primary", value: null },
  ]);
  if (act === "edit") fillRegForm(l);
  else if (act === "body") openBody(l.id);
  else if (act === "del") {
    const ok = await confirmBox("Delete entry?", `Permanently delete <b>${esc(l.token)} – ${esc(l.name)}</b>? This cannot be undone.`, "Delete", "btn-danger");
    if (!ok) return;
    try {
      await deleteDoc(doc(db, "leads", l.id));
      toast(`${l.token} deleted`);
    } catch (err) {
      toast("Delete failed. Check internet.", true);
    }
  }
}

/* CSV export */
$("#exportBtn").onclick = () => {
  const list = filteredLeads().slice().reverse();
  if (!list.length) return toast("Nothing to export", true);
  const cols = [
    ["Token", (l) => l.token], ["Full Name", (l) => l.name], ["Age", (l) => l.age],
    ["Mobile", (l) => l.mobile], ["WhatsApp", (l) => l.whatsapp], ["Occupation", (l) => l.occupation],
    ["Health Goal", (l) => l.healthGoal], ["Health Rating (1-10)", (l) => l.healthRating],
    ["Energy Level (1-10)", (l) => l.energyLevel], ["Regular Medication", (l) => l.onMedication],
    ["Medicine / Condition", (l) => l.medicationDetails],
    ["Physical Challenges", (l) => (l.challenges || []).join("; ")], ["Other Challenge", (l) => l.challengeOther],
    ["Height", (l) => l.height], ["Height Unit", (l) => l.heightUnit], ["Weight (kg)", (l) => l.weight],
    ["BMI", (l) => l.bmi], ["BMI Category", (l) => l.bmiCategory],
    ["Wellness Consultation", (l) => l.wantsConsultation], ["Income Opportunity", (l) => l.incomeInterest],
    ["Gift Given", (l) => (l.giftGiven ? "Yes" : "No")], ["Follow-up Done", (l) => (l.followUpDone ? "Yes" : "No")],
    ["Registered At", (l) => fmtTime(l.createdAt)], ["Registered By", (l) => l.createdBy],
  ];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.map((c) => cell(c[0])).join(","),
    ...list.map((l) => cols.map((c) => cell(c[1](l))).join(","))].join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `puja-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${list.length} leads`);
};

/* ============================================================
   Render all
   ============================================================ */
function renderStats() {
  const today = new Date().toDateString();
  $("#statToday").textContent = leads.filter((l) => toDate(l.createdAt)?.toDateString() === today).length;
  $("#statTotal").textContent = leads.length;
  $("#statBody").textContent = leads.filter(bodyDone).length;
  $("#statGift").textContent = leads.filter((l) => l.giftGiven).length;
}

function renderAll() {
  renderStats();
  renderBodyList();
  renderGiftList();
  renderLeads();
  // keep open gift view live (e.g. body check saved on another phone)
  if (giftId) {
    const l = leads.find((x) => x.id === giftId);
    if (l) paintGift(l); else closeGift();
  }
  if (bodyId && !leads.find((x) => x.id === bodyId)) closeBody();
}

document.title = `Wellness Campaign – ${CLUB_NAME}`;
setEnergyUI(false);
