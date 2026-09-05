// app-admin.js — หน้า Admin: Login (Firebase Auth) + CRUD (Firestore) + อัปโหลดไฟล์ (Cloudinary)
// ===================================================
import { db, auth, uploadToCloudinary } from "./firebase-init.js?v=20260905-fix1";
import { uploadFullSong } from "./storage-adapter.js?v=20260904-rawzip";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, getDocs, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut,
  reauthenticateWithCredential, EmailAuthProvider, updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initOrdersView } from "./orders.js?v=20260905-fix1";
import { resolveCurrentAdminRole, initAdminsView } from "./admin-roles.js";

const CACHE = { songs: [], categories: [], djs: [], playlists: [] };
let currentAdminRole = null; // "main" | "sub" — ของบัญชีที่ล็อกอินอยู่ตอนนี้
let editingSongId = null, editingCatId = null, editingDjId = null, editingPlaylistId = null;
let pendingSongFile = null, pendingCoverFile = null, pendingDjImageFile = null, existingDjImageUrl = "";
let pendingPlaylistCoverFile = null, existingPlaylistCoverUrl = "";
let pendingFullSongFile = null, existingFullFileUrl = "";
let confirmAction = null;

// จำกัดขนาดไฟล์ WAV สูงสุด (ปรับได้ตามแผน Cloudinary — ฟรีแพลนอัปโหลดสูงสุดไฟล์ละ 100MB)
const MAX_FULL_WAV_SIZE_MB = 100;
function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function showToast(message, type) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.className = "toast"; }, 2600);
}
function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatPrice(v) { return Number(v || 0).toLocaleString("en-US") + " LAK"; }
function debounce(fn, wait) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; }

// ---------------- ดึงชื่อเพลงจากชื่อไฟล์ ----------------
// ตัดแค่นามสกุลไฟล์ออก (.mp3 / .wav ฯลฯ) ส่วนที่เหลือคงไว้ทุกตัวอักษรเหมือนชื่อไฟล์เดิม
function nameFromFile(fileName) {
  return String(fileName || "").replace(/\.[^/.]+$/, "").trim();
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------- Auth ----------------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    showLogin();
    return;
  }
  try {
    await showAdmin();
  } catch (err) {
    document.getElementById("loginError").textContent =
      "เปิดหน้า Admin ไม่สำเร็จ: " + (err.message || err) + " — ตรวจสอบอินเทอร์เน็ตและ Firebase Rules";
    showLogin();
    await signOut(auth).catch(() => {});
  }
});

document.getElementById("loginBtn").addEventListener("click", async () => {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const btn = document.getElementById("loginBtn");
  document.getElementById("loginError").textContent = "";
  btn.disabled = true; btn.textContent = "กำลังเข้าสู่ระบบ...";
  try {
    await withTimeout(
      signInWithEmailAndPassword(auth, email, password),
      15000,
      "เชื่อมต่อ Firebase นานเกินไป"
    );
    // onAuthStateChanged จะเรียก showAdmin() ต่อเอง (รวมถึงเช็คสิทธิ์แอดมิน) — รอสักครู่แล้วคืนปุ่มกลับ
  } catch (err) {
    document.getElementById("loginError").textContent =
      err?.code === "auth/invalid-credential"
        ? "อีเมลหรือรหัสผ่านไม่ถูกต้อง"
        : "เข้าสู่ระบบไม่สำเร็จ: " + (err.message || err);
  }
  btn.disabled = false; btn.textContent = "เข้าสู่ระบบ";
});
document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

// ================= เปลี่ยนรหัสผ่านของฉัน (ทุกแอดมินทำได้ ไม่จำกัดเฉพาะแอดมินหลัก) =================
function resetChangePasswordForm() {
  document.getElementById("cpCurrentPassword").value = "";
  document.getElementById("cpNewPassword").value = "";
  document.getElementById("cpConfirmPassword").value = "";
  document.getElementById("cpFeedback").textContent = "";
}
document.getElementById("changePasswordBtn").addEventListener("click", () => {
  resetChangePasswordForm();
  document.getElementById("changePasswordBackdrop").classList.add("show");
});
document.getElementById("changePasswordClose").addEventListener("click", () => {
  document.getElementById("changePasswordBackdrop").classList.remove("show");
});
document.getElementById("changePasswordSaveBtn").addEventListener("click", async function () {
  const feedback = document.getElementById("cpFeedback");
  const currentPassword = document.getElementById("cpCurrentPassword").value;
  const newPassword = document.getElementById("cpNewPassword").value;
  const confirmPassword = document.getElementById("cpConfirmPassword").value;
  feedback.style.color = "var(--danger)";

  if (!currentPassword || !newPassword || !confirmPassword) { feedback.textContent = "กรุณากรอกให้ครบทุกช่อง"; return; }
  if (newPassword.length < 6) { feedback.textContent = "รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร"; return; }
  if (newPassword !== confirmPassword) { feedback.textContent = "ยืนยันรหัสผ่านใหม่ไม่ตรงกัน"; return; }

  const btn = this; btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  feedback.textContent = "";
  try {
    const user = auth.currentUser;
    // Firebase บังคับให้ล็อกอินสดๆ ก่อนเปลี่ยนรหัสผ่าน (sensitive operation) จึงต้อง reauthenticate ด้วยรหัสผ่านเดิมก่อนเสมอ
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, newPassword);
    feedback.style.color = "var(--success)";
    feedback.textContent = "เปลี่ยนรหัสผ่านสำเร็จแล้ว ✓";
    showToast("เปลี่ยนรหัสผ่านสำเร็จ", "success");
    setTimeout(() => { document.getElementById("changePasswordBackdrop").classList.remove("show"); }, 1000);
  } catch (err) {
    if (err && err.code === "auth/wrong-password") feedback.textContent = "รหัสผ่านปัจจุบันไม่ถูกต้อง";
    else if (err && err.code === "auth/too-many-requests") feedback.textContent = "ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่";
    else feedback.textContent = "เปลี่ยนรหัสผ่านไม่สำเร็จ: " + (err.message || err);
  }
  btn.disabled = false; btn.textContent = "บันทึกรหัสผ่านใหม่";
});

function showLogin() { document.getElementById("loginScreen").style.display = "flex"; document.getElementById("adminShell").style.display = "none"; }
async function showAdmin() {
  // ตรวจสอบสิทธิ์แอดมินของบัญชีนี้ก่อนปล่อยเข้าใช้งาน (บูตสแตรปแอดมินหลักคนแรกอัตโนมัติถ้ายังไม่เคยตั้งค่าระบบแอดมินเลย)
  let roleInfo;
  try {
    roleInfo = await withTimeout(
      resolveCurrentAdminRole(auth.currentUser),
      15000,
      "ตรวจสอบสิทธิ์ Admin นานเกินไป"
    );
  } catch (err) {
    // ส่วนใหญ่เกิดจาก Firestore Security Rules ยังไม่อนุญาตให้อ่าน/เขียน collection "admins"
    document.getElementById("loginError").textContent =
      "ตรวจสอบสิทธิ์แอดมินไม่สำเร็จ: " + (err.message || err) + " — ถ้าเพิ่งเพิ่มระบบจัดการแอดมิน ให้ตรวจสอบ Firestore Rules ว่าอนุญาต collection \"admins\" แล้วหรือยัง";
    await signOut(auth);
    return;
  }
  if (!roleInfo) {
    document.getElementById("loginError").textContent = "บัญชีนี้ไม่มีสิทธิ์เข้าใช้งานระบบ Admin กรุณาติดต่อแอดมินหลักเพื่อเพิ่มบัญชีให้ก่อน";
    await signOut(auth);
    return;
  }
  currentAdminRole = roleInfo.role;
  window.__currentAdminRole = currentAdminRole;

  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("adminShell").style.display = "block";
  document.getElementById("qaManageAdmins").style.display = currentAdminRole === "main" ? "" : "none";
  const s = await withTimeout(
    getDoc(doc(db, "settings", "main")),
    15000,
    "โหลดการตั้งค่าเว็บไซต์นานเกินไป"
  );
  if (s.exists()) document.getElementById("adminSiteName").textContent = s.data().website_name || "Music Store";
  await withTimeout(loadDashboard(), 20000, "โหลดข้อมูล Dashboard นานเกินไป");
}

// ---------------- View switching ----------------
function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.style.display = "none");
  document.getElementById(id).style.display = "block";
}
document.querySelectorAll(".back-btn").forEach(b => b.addEventListener("click", () => { showView("view-dashboard"); loadDashboard(); }));
document.getElementById("qaAddSong").addEventListener("click", async () => { showView("view-songs"); await loadSongs(); openAddSong(); });
document.getElementById("qaManageSongs").addEventListener("click", () => { showView("view-songs"); loadSongs(); });
document.getElementById("qaManageCats").addEventListener("click", () => { showView("view-categories"); loadCategories(); });
document.getElementById("qaManageDjs").addEventListener("click", () => { showView("view-djs"); loadDjs(); });
document.getElementById("qaManagePlaylists").addEventListener("click", () => { showView("view-playlists"); loadPlaylists(); });
document.getElementById("qaBulkUpload").addEventListener("click", () => { openBulkUpload(); });
document.getElementById("qaOrders").addEventListener("click", () => { showView("view-orders"); initOrdersView(); });
document.getElementById("qaSettings").addEventListener("click", () => { showView("view-settings"); loadSettings(); });
document.getElementById("qaManageAdmins").addEventListener("click", () => {
  if (currentAdminRole !== "main") { showToast("เฉพาะแอดมินหลักเท่านั้นที่เข้าหน้านี้ได้", "error"); return; }
  showView("view-admins"); initAdminsView();
});

async function loadDashboard() {
  const [songsSnap, catSnap, djSnap, playlistSnap] = await Promise.all([
    getDocs(collection(db, "songs")), getDocs(collection(db, "categories")), getDocs(collection(db, "djs")), getDocs(collection(db, "playlists"))
  ]);
  document.getElementById("statSongs").textContent = songsSnap.size;
  document.getElementById("statCats").textContent = catSnap.size;
  document.getElementById("statDjs").textContent = djSnap.size;
  document.getElementById("statPlaylists").textContent = playlistSnap.size;
}

// ================= SONGS =================
let songSelectMode = false;
const selectedSongIds = new Set();
let currentSongListView = [];

async function loadSongs() {
  const [songsSnap, catSnap, djSnap, playlistSnap] = await Promise.all([
    getDocs(collection(db, "songs")), getDocs(collection(db, "categories")), getDocs(collection(db, "djs")), getDocs(collection(db, "playlists"))
  ]);
  CACHE.songs = songsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  CACHE.categories = catSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  CACHE.djs = djSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  CACHE.playlists = playlistSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  populateSelect("fCategory", CACHE.categories, "id", "category_name");
  populateSelect("fDj", CACHE.djs, "id", "dj_name");
  populateSelect("fPlaylist", CACHE.playlists, "id", "playlist_name");
  selectedSongIds.clear();
  updateSongBulkBar();
  renderSongList(CACHE.songs);
}
function populateSelect(id, items, valueKey, labelKey) {
  const sel = document.getElementById(id);
  const current = sel.value;
  sel.innerHTML = '<option value="">— ไม่ระบุ —</option>' + items.map(it => `<option value="${it[valueKey]}">${escapeHtml(it[labelKey])}</option>`).join("");
  sel.value = current;
}
function renderSongList(list) {
  currentSongListView = list;
  const wrap = document.getElementById("songList");
  if (list.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มีเพลง</div>'; return; }
  wrap.innerHTML = list.map(s => `
    <div class="list-row">
      ${songSelectMode ? `<input type="checkbox" class="song-select-chk" data-id="${s.id}" ${selectedSongIds.has(s.id) ? "checked" : ""} style="width:20px;height:20px;flex-shrink:0;">` : ""}
      <img src="${s.cover_url || ""}">
      <div class="info"><div class="n1">${escapeHtml(s.song_name)}</div>
      <div class="n2">${escapeHtml(s.dj_name || "-")} · ${escapeHtml(s.category_name || "-")} · ${formatPrice(s.price)}</div></div>
      <div class="row-actions">
        <button class="icon-btn" data-edit="${s.id}">✎</button>
        <button class="icon-btn danger" data-del="${s.id}">🗑</button>
      </div>
    </div>`).join("");
  wrap.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openEditSong(b.getAttribute("data-edit"))));
  wrap.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => confirmDeleteSong(b.getAttribute("data-del"))));
  wrap.querySelectorAll(".song-select-chk").forEach(chk => chk.addEventListener("change", () => {
    const id = chk.getAttribute("data-id");
    if (chk.checked) selectedSongIds.add(id); else selectedSongIds.delete(id);
    updateSongBulkBar();
  }));
}

function updateSongBulkBar() {
  document.getElementById("songSelectedCount").textContent = `เลือกแล้ว ${selectedSongIds.size} เพลง`;
  document.getElementById("songBulkDeleteBtn").disabled = selectedSongIds.size === 0;
  const allSelected = currentSongListView.length > 0 && currentSongListView.every(s => selectedSongIds.has(s.id));
  document.getElementById("songSelectAllChk").checked = allSelected;
}

document.getElementById("songSelectModeBtn").addEventListener("click", () => {
  songSelectMode = !songSelectMode;
  selectedSongIds.clear();
  document.getElementById("songBulkBar").style.display = songSelectMode ? "flex" : "none";
  document.getElementById("songSelectModeBtn").style.background = songSelectMode ? "var(--accent)" : "";
  document.getElementById("songSelectModeBtn").style.color = songSelectMode ? "#fff" : "";
  updateSongBulkBar();
  renderSongList(currentSongListView);
});
document.getElementById("songSelectAllChk").addEventListener("change", (e) => {
  if (e.target.checked) currentSongListView.forEach(s => selectedSongIds.add(s.id));
  else selectedSongIds.clear();
  updateSongBulkBar();
  renderSongList(currentSongListView);
});
document.getElementById("songBulkDeleteBtn").addEventListener("click", () => {
  const ids = Array.from(selectedSongIds);
  if (ids.length === 0) return;
  openConfirm(`ต้องการลบเพลงที่เลือกไว้ ${ids.length} เพลงหรือไม่? (เพลงที่มี Order เก่าอยู่แล้วจะถูกปิดการขายแทนการลบ เพื่อไม่ให้ไฟล์เต็มหาย)`, async () => {
    let deletedCount = 0, hiddenCount = 0;
    for (const id of ids) {
      const hasOrders = await songHasOrders(id);
      if (hasOrders) {
        await updateDoc(doc(db, "songs", id), { status: "hidden", updated_at: new Date().toISOString() });
        hiddenCount++;
      } else {
        await deleteDoc(doc(db, "songs", id));
        deletedCount++;
      }
    }
    selectedSongIds.clear();
    songSelectMode = false;
    document.getElementById("songBulkBar").style.display = "none";
    document.getElementById("songSelectModeBtn").style.background = "";
    document.getElementById("songSelectModeBtn").style.color = "";
    showToast(`ลบแล้ว ${deletedCount} เพลง${hiddenCount > 0 ? ` · ปิดการขาย ${hiddenCount} เพลง (มี Order เก่า)` : ""}`, "success");
    loadSongs();
    loadDashboard();
  });
});

// ฟังก์ชันกรองและแสดงผลรายการเพลง
const handleSongSearch = (e) => {
  const q = e.target.value.trim().toLowerCase();
  renderSongList(CACHE.songs.filter(s => [s.song_name, s.artist, s.dj_name, s.category_name].join(" ").toLowerCase().includes(q)));
};

const searchInputEl = document.getElementById("songSearch");
searchInputEl.addEventListener("input", debounce(handleSongSearch, 200));

// เพิ่มการดักจับปุ่ม Enter และลูกศร เพื่อซ่อนแป้นพิมพ์บนมือถือ
searchInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
    searchInputEl.blur(); // สั่งปิดแป้นพิมพ์
  }
});

function resetSongForm() {
  editingSongId = null; pendingSongFile = null; pendingCoverFile = null;
  pendingFullSongFile = null; existingFullFileUrl = "";
  document.getElementById("songFormTitle").textContent = "เพิ่มเพลง";
  ["fSongName", "fArtist", "fPrice", "fDesc"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("fDj").value = ""; document.getElementById("fCategory").value = ""; document.getElementById("fStatus").value = "active";
  document.getElementById("fPlaylist").value = "";
  document.getElementById("songFileInput").value = ""; document.getElementById("coverFileInput").value = "";
  document.getElementById("songFilePicker").textContent = "📁 แตะเพื่อเลือกไฟล์เพลงจาก iPhone/iPad";
  document.getElementById("songFilePicker").className = "file-picker";
  document.getElementById("coverFilePicker").textContent = "🖼️ แตะเพื่อเลือกรูปปก";
  document.getElementById("coverFilePicker").className = "file-picker";
  document.getElementById("fullSongFileInput").value = "";
  document.getElementById("fullSongFilePicker").textContent = "🔒 แตะเพื่อเลือกไฟล์ WAV เต็ม";
  document.getElementById("fullSongFilePicker").className = "file-picker";
  document.getElementById("fullSongFileMeta").style.display = "none";
  document.getElementById("fullSongFileMeta").textContent = "";
  document.getElementById("fullSongUploadProgressWrap").style.display = "none";
  document.getElementById("songUploadProgressWrap").style.display = "none";
}
function openAddSong() { resetSongForm(); document.getElementById("songFormBackdrop").classList.add("show"); }
function openEditSong(id) {
  resetSongForm();
  const s = CACHE.songs.find(x => x.id === id);
  if (!s) return;
  editingSongId = id;
  document.getElementById("songFormTitle").textContent = "แก้ไขเพลง";
  document.getElementById("fSongName").value = s.song_name || "";
  document.getElementById("fArtist").value = s.artist || "";
  document.getElementById("fPrice").value = s.price || 0;
  document.getElementById("fDesc").value = s.description || "";
  document.getElementById("fStatus").value = s.status || "active";
  const dj = CACHE.djs.find(d => d.dj_name === s.dj_name);
  document.getElementById("fDj").value = dj ? dj.id : "";
  document.getElementById("fCategory").value = s.category_id || "";
  document.getElementById("fPlaylist").value = s.playlist_id || "";
  if (s.file_url) { document.getElementById("songFilePicker").textContent = "✔ มีไฟล์เพลงอยู่แล้ว (ไม่บังคับอัปโหลดใหม่)"; document.getElementById("songFilePicker").className = "file-picker filled"; }
  if (s.cover_url) { document.getElementById("coverFilePicker").textContent = "✔ มีรูปปกอยู่แล้ว"; document.getElementById("coverFilePicker").className = "file-picker filled"; }
  existingFullFileUrl = s.full_file_url || "";
  if (existingFullFileUrl) {
    document.getElementById("fullSongFilePicker").textContent = `🔒✔ มีไฟล์เต็มอยู่แล้ว${s.full_file_name ? " (" + s.full_file_name + ")" : ""} — ไม่บังคับอัปโหลดใหม่`;
    document.getElementById("fullSongFilePicker").className = "file-picker filled";
  }
  document.getElementById("songFormBackdrop").classList.add("show");
}
document.getElementById("addSongBtn").addEventListener("click", openAddSong);
document.getElementById("songFormClose").addEventListener("click", () => document.getElementById("songFormBackdrop").classList.remove("show"));

document.getElementById("songFileInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingSongFile = f;
  document.getElementById("songFilePicker").textContent = "🎵 " + f.name;
  document.getElementById("songFilePicker").className = "file-picker filled";

  const nameField = document.getElementById("fSongName");
  if (!editingSongId && !nameField.value.trim()) {
    nameField.value = nameFromFile(f.name);
  }
});
document.getElementById("coverFileInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingCoverFile = f;
  document.getElementById("coverFilePicker").textContent = "🖼️ " + f.name;
  document.getElementById("coverFilePicker").className = "file-picker filled";
});

document.getElementById("fullSongFileInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const picker = document.getElementById("fullSongFilePicker");
  const meta = document.getElementById("fullSongFileMeta");
  const isWav = /\.wav$/i.test(f.name) || f.type === "audio/wav" || f.type === "audio/x-wav";
  if (!isWav) {
    showToast("กรุณาเลือกไฟล์นามสกุล .wav เท่านั้นสำหรับเพลงเต็ม", "error");
    e.target.value = "";
    pendingFullSongFile = null;
    meta.style.display = "none";
    return;
  }
  const sizeMb = f.size / (1024 * 1024);
  if (sizeMb > MAX_FULL_WAV_SIZE_MB) {
    showToast(`ไฟล์ใหญ่เกินไป (${sizeMb.toFixed(1)} MB) — จำกัดไม่เกิน ${MAX_FULL_WAV_SIZE_MB} MB`, "error");
    e.target.value = "";
    pendingFullSongFile = null;
    meta.style.display = "none";
    return;
  }
  pendingFullSongFile = f;
  picker.textContent = "🔒 " + f.name;
  picker.className = "file-picker filled";
  meta.textContent = `ขนาดไฟล์: ${formatFileSize(f.size)}`;
  meta.style.display = "block";
});

document.getElementById("songSaveBtn").addEventListener("click", async function () {
  const name = document.getElementById("fSongName").value.trim();
  if (!name) { showToast("กรุณากรอกชื่อเพลง", "error"); return; }
  const btn = this; btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    let fileUrl = null, coverUrl = null, fullFileUrl = null, fullFilePublicId = null, fullFileName = null;
    if (pendingSongFile) {
      document.getElementById("songUploadProgressWrap").style.display = "block";
      const prog = document.getElementById("songUploadProgress");
      const res = await uploadToCloudinary(pendingSongFile, (pct) => { prog.style.width = pct + "%"; });
      fileUrl = res.url;
    }
    if (pendingCoverFile) {
      const res = await uploadToCloudinary(pendingCoverFile);
      coverUrl = res.url;
    }
    if (pendingFullSongFile) {
      document.getElementById("fullSongUploadProgressWrap").style.display = "block";
      const prog = document.getElementById("fullSongUploadProgress");
      btn.textContent = "กำลังอัปโหลดไฟล์เต็ม...";
      const res = await uploadFullSong(pendingFullSongFile, (pct) => { prog.style.width = pct + "%"; });
      fullFileUrl = res.url;
      fullFilePublicId = res.publicId;
      fullFileName = pendingFullSongFile.name;
      btn.textContent = "กำลังบันทึก...";
    }
    const djSel = document.getElementById("fDj");
    const catSel = document.getElementById("fCategory");
    const plSel = document.getElementById("fPlaylist");
    const payload = {
      song_name: name,
      artist: document.getElementById("fArtist").value.trim(),
      dj_name: djSel.value ? djSel.options[djSel.selectedIndex].text : "",
      category_id: catSel.value,
      category_name: catSel.value ? catSel.options[catSel.selectedIndex].text : "",
      playlist_id: plSel.value,
      playlist_name: plSel.value ? plSel.options[plSel.selectedIndex].text : "",
      price: Number(document.getElementById("fPrice").value || 0),
      description: document.getElementById("fDesc").value.trim(),
      status: document.getElementById("fStatus").value,
      updated_at: new Date().toISOString()
    };
    if (fileUrl) payload.file_url = fileUrl;
    if (coverUrl) payload.cover_url = coverUrl;
    if (fullFileUrl) {
      payload.full_file_url = fullFileUrl;
      payload.full_file_public_id = fullFilePublicId;
      payload.full_file_name = fullFileName;
    }

    if (editingSongId) {
      await updateDoc(doc(db, "songs", editingSongId), payload);
    } else {
      payload.created_at = new Date().toISOString();
      await addDoc(collection(db, "songs"), payload);
    }
    showToast("บันทึกเพลงสำเร็จ", "success");
    document.getElementById("songFormBackdrop").classList.remove("show");
    loadSongs();
    loadDashboard();
  } catch (err) {
    showToast("บันทึกไม่สำเร็จ: " + err.message, "error");
  }
  btn.disabled = false; btn.textContent = "บันทึกเพลง";
});

// เช็คว่าเพลงนี้เคยถูกสั่งซื้อ (มีอยู่ใน Order เก่า) หรือไม่ — ใช้ก่อนลบเพลงจริง
async function songHasOrders(songId) {
  const snap = await getDocs(collection(db, "orders"));
  return snap.docs.some(d => (d.data().items || []).some(item =>
    item.song_id === songId || (Array.isArray(item.song_ids) && item.song_ids.includes(songId))
  ));
}

async function confirmDeleteSong(id) {
  const hasOrders = await songHasOrders(id);
  if (hasOrders) {
    openConfirm(
      "เพลงนี้มี Order เก่าอ้างอิงอยู่ — ไม่แนะนำให้ลบเพราะจะทำให้ไฟล์เพลงเต็มหาย ระบบจะเปลี่ยนสถานะเป็น 'ปิดการขาย (hidden)' แทนการลบจริง ต้องการดำเนินการต่อหรือไม่?",
      async () => {
        await updateDoc(doc(db, "songs", id), { status: "hidden", updated_at: new Date().toISOString() });
        showToast("ปิดการขายเพลงนี้แล้ว (ไม่ได้ลบไฟล์)", "success");
        loadSongs();
        loadDashboard();
      }
    );
    return;
  }
  openConfirm("คุณต้องการลบเพลงนี้หรือไม่?", async () => {
    await deleteDoc(doc(db, "songs", id));
    showToast("ลบเพลงแล้ว", "success");
    loadSongs();
    loadDashboard();
  });
}

// ================= CATEGORIES =================
async function loadCategories() {
  const snap = await getDocs(collection(db, "categories"));
  CACHE.categories = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const wrap = document.getElementById("catList");
  if (CACHE.categories.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มีหมวดหมู่</div>'; return; }
  wrap.innerHTML = CACHE.categories.map(c => `
    <div class="list-row"><div class="info"><div class="n1">${escapeHtml(c.category_name)}</div>
    <div class="n2">${escapeHtml(c.description || "")}</div></div>
    <div class="row-actions"><button class="icon-btn" data-edit="${c.id}">✎</button>
    <button class="icon-btn danger" data-del="${c.id}">🗑</button></div></div>`).join("");
  wrap.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openEditCat(b.getAttribute("data-edit"))));
  wrap.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    openConfirm("ลบหมวดหมู่นี้หรือไม่?", async () => {
      await deleteDoc(doc(db, "categories", b.getAttribute("data-del")));
      showToast("ลบแล้ว", "success"); loadCategories(); loadDashboard();
    });
  }));
}
function openAddCat() { editingCatId = null; document.getElementById("catFormTitle").textContent = "เพิ่มหมวดหมู่"; document.getElementById("fCatName").value = ""; document.getElementById("fCatDesc").value = ""; document.getElementById("catFormBackdrop").classList.add("show"); }
function openEditCat(id) {
  const c = CACHE.categories.find(x => x.id === id); if (!c) return;
  editingCatId = id; document.getElementById("catFormTitle").textContent = "แก้ไขหมวดหมู่";
  document.getElementById("fCatName").value = c.category_name; document.getElementById("fCatDesc").value = c.description || "";
  document.getElementById("catFormBackdrop").classList.add("show");
}
document.getElementById("addCatBtn").addEventListener("click", openAddCat);
document.getElementById("catFormClose").addEventListener("click", () => document.getElementById("catFormBackdrop").classList.remove("show"));
document.getElementById("catSaveBtn").addEventListener("click", async () => {
  const name = document.getElementById("fCatName").value.trim();
  if (!name) { showToast("กรุณากรอกชื่อหมวดหมู่", "error"); return; }
  const payload = { category_name: name, description: document.getElementById("fCatDesc").value.trim() };
  try {
    if (editingCatId) await updateDoc(doc(db, "categories", editingCatId), payload);
    else { payload.created_at = new Date().toISOString(); await addDoc(collection(db, "categories"), payload); }
    showToast("บันทึกแล้ว", "success"); document.getElementById("catFormBackdrop").classList.remove("show"); loadCategories(); loadDashboard();
  } catch (err) { showToast("บันทึกไม่สำเร็จ: " + err.message, "error"); }
});

// ================= DJs =================
async function loadDjs() {
  const snap = await getDocs(collection(db, "djs"));
  CACHE.djs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const wrap = document.getElementById("djList");
  if (CACHE.djs.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มี DJ</div>'; return; }
  wrap.innerHTML = CACHE.djs.map(d => `
    <div class="list-row"><img src="${d.image_url || ""}">
    <div class="info"><div class="n1">${escapeHtml(d.dj_name)}</div><div class="n2">${escapeHtml(d.description || "")}</div></div>
    <div class="row-actions"><button class="icon-btn" data-edit="${d.id}">✎</button>
    <button class="icon-btn danger" data-del="${d.id}">🗑</button></div></div>`).join("");
  wrap.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openEditDj(b.getAttribute("data-edit"))));
  wrap.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    openConfirm("ลบ DJ นี้หรือไม่?", async () => {
      await deleteDoc(doc(db, "djs", b.getAttribute("data-del")));
      showToast("ลบแล้ว", "success"); loadDjs(); loadDashboard();
    });
  }));
}
function resetDjForm() {
  editingDjId = null; pendingDjImageFile = null; existingDjImageUrl = "";
  document.getElementById("fDjName").value = ""; document.getElementById("fDjDesc").value = "";
  document.getElementById("djImageInput").value = "";
  document.getElementById("djImagePicker").textContent = "🖼️ แตะเพื่อเลือกรูปจาก iPhone/iPad";
  document.getElementById("djImagePicker").className = "file-picker";
}
function openAddDj() { resetDjForm(); document.getElementById("djFormTitle").textContent = "เพิ่ม DJ"; document.getElementById("djFormBackdrop").classList.add("show"); }
function openEditDj(id) {
  const d = CACHE.djs.find(x => x.id === id); if (!d) return;
  resetDjForm();
  editingDjId = id; existingDjImageUrl = d.image_url || "";
  document.getElementById("djFormTitle").textContent = "แก้ไข DJ";
  document.getElementById("fDjName").value = d.dj_name; document.getElementById("fDjDesc").value = d.description || "";
  if (existingDjImageUrl) { document.getElementById("djImagePicker").textContent = "✔ มีรูปอยู่แล้ว (แตะเพื่อเปลี่ยนรูปใหม่)"; document.getElementById("djImagePicker").className = "file-picker filled"; }
  document.getElementById("djFormBackdrop").classList.add("show");
}
document.getElementById("addDjBtn").addEventListener("click", openAddDj);
document.getElementById("djFormClose").addEventListener("click", () => document.getElementById("djFormBackdrop").classList.remove("show"));
document.getElementById("djImageInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingDjImageFile = f;
  document.getElementById("djImagePicker").textContent = "🖼️ " + f.name;
  document.getElementById("djImagePicker").className = "file-picker filled";
});
document.getElementById("djSaveBtn").addEventListener("click", async function () {
  const name = document.getElementById("fDjName").value.trim();
  if (!name) { showToast("กรุณากรอกชื่อ DJ", "error"); return; }
  const btn = this; btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    let imageUrl = existingDjImageUrl;
    if (pendingDjImageFile) {
      const res = await uploadToCloudinary(pendingDjImageFile);
      imageUrl = res.url;
    }
    const payload = { dj_name: name, description: document.getElementById("fDjDesc").value.trim(), image_url: imageUrl };
    if (editingDjId) await updateDoc(doc(db, "djs", editingDjId), payload);
    else { payload.created_at = new Date().toISOString(); await addDoc(collection(db, "djs"), payload); }
    showToast("บันทึกแล้ว", "success"); document.getElementById("djFormBackdrop").classList.remove("show"); loadDjs(); loadDashboard();
  } catch (err) {
    showToast("บันทึกไม่สำเร็จ: " + err.message, "error");
  }
  btn.disabled = false; btn.textContent = "บันทึก";
});

// ================= PLAYLISTS =================
async function loadPlaylists() {
  const snap = await getDocs(collection(db, "playlists"));
  CACHE.playlists = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const wrap = document.getElementById("playlistList");
  if (CACHE.playlists.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มีเพลย์ลิสต์</div>'; return; }
  wrap.innerHTML = CACHE.playlists.map(p => `
    <div class="list-row"><img src="${p.cover_url || ""}">
    <div class="info"><div class="n1">${escapeHtml(p.playlist_name)}</div><div class="n2">${escapeHtml(p.description || "")}${p.price ? ` · ${formatPrice(p.price)}` : ""}</div></div>
    <div class="row-actions"><button class="icon-btn" data-edit="${p.id}">✎</button>
    <button class="icon-btn danger" data-del="${p.id}">🗑</button></div></div>`).join("");
  wrap.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openEditPlaylist(b.getAttribute("data-edit"))));
  wrap.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    openConfirm("ลบเพลย์ลิสต์นี้หรือไม่? (เพลงในเพลย์ลิสต์จะไม่ถูกลบ แค่ไม่ได้อยู่ในเพลย์ลิสต์นี้อีก)", async () => {
      await deleteDoc(doc(db, "playlists", b.getAttribute("data-del")));
      showToast("ลบแล้ว", "success"); loadPlaylists(); loadDashboard();
    });
  }));
}
function resetPlaylistForm() {
  editingPlaylistId = null; pendingPlaylistCoverFile = null; existingPlaylistCoverUrl = "";
  document.getElementById("fPlaylistName").value = ""; document.getElementById("fPlaylistDesc").value = "";
  document.getElementById("fPlaylistPrice").value = "";
  document.getElementById("playlistCoverInput").value = "";
  document.getElementById("playlistCoverPicker").textContent = "🖼️ แตะเพื่อเลือกรูปปก";
  document.getElementById("playlistCoverPicker").className = "file-picker";
}
function openAddPlaylist() { resetPlaylistForm(); document.getElementById("playlistFormTitle").textContent = "เพิ่มเพลย์ลิสต์"; document.getElementById("playlistFormBackdrop").classList.add("show"); }
function openEditPlaylist(id) {
  const p = CACHE.playlists.find(x => x.id === id); if (!p) return;
  resetPlaylistForm();
  editingPlaylistId = id; existingPlaylistCoverUrl = p.cover_url || "";
  document.getElementById("playlistFormTitle").textContent = "แก้ไขเพลย์ลิสต์";
  document.getElementById("fPlaylistName").value = p.playlist_name; document.getElementById("fPlaylistDesc").value = p.description || "";
  document.getElementById("fPlaylistPrice").value = p.price || 0;
  if (existingPlaylistCoverUrl) { document.getElementById("playlistCoverPicker").textContent = "✔ มีรูปปกอยู่แล้ว (แตะเพื่อเปลี่ยนรูปใหม่)"; document.getElementById("playlistCoverPicker").className = "file-picker filled"; }
  document.getElementById("playlistFormBackdrop").classList.add("show");
}
document.getElementById("addPlaylistBtn").addEventListener("click", openAddPlaylist);
document.getElementById("playlistFormClose").addEventListener("click", () => document.getElementById("playlistFormBackdrop").classList.remove("show"));
document.getElementById("playlistCoverInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingPlaylistCoverFile = f;
  document.getElementById("playlistCoverPicker").textContent = "🖼️ " + f.name;
  document.getElementById("playlistCoverPicker").className = "file-picker filled";
});
document.getElementById("playlistSaveBtn").addEventListener("click", async function () {
  const name = document.getElementById("fPlaylistName").value.trim();
  if (!name) { showToast("กรุณากรอกชื่อเพลย์ลิสต์", "error"); return; }
  const btn = this; btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    let coverUrl = existingPlaylistCoverUrl;
    if (pendingPlaylistCoverFile) {
      const res = await uploadToCloudinary(pendingPlaylistCoverFile);
      coverUrl = res.url;
    }
    const payload = {
      playlist_name: name,
      description: document.getElementById("fPlaylistDesc").value.trim(),
      price: Number(document.getElementById("fPlaylistPrice").value || 0),
      cover_url: coverUrl
    };
    if (editingPlaylistId) await updateDoc(doc(db, "playlists", editingPlaylistId), payload);
    else { payload.created_at = new Date().toISOString(); await addDoc(collection(db, "playlists"), payload); }
    showToast("บันทึกแล้ว", "success"); document.getElementById("playlistFormBackdrop").classList.remove("show"); loadPlaylists(); loadDashboard();
  } catch (err) {
    showToast("บันทึกไม่สำเร็จ: " + err.message, "error");
  }
  btn.disabled = false; btn.textContent = "บันทึก";
});

// ================= BULK UPLOAD (เพิ่มเพลงหลายไฟล์พร้อมกันเป็นเพลย์ลิสต์เดียว) =================
let bulkFiles = [];
let bulkFullFiles = [];
let pendingBulkCoverFile = null;

async function openBulkUpload() {
  bulkFiles = []; bulkFullFiles = []; pendingBulkCoverFile = null;
  document.getElementById("bulkNewPlaylistName").value = "";
  document.getElementById("bulkPrice").value = "";
  document.getElementById("bulkFilesInput").value = "";
  document.getElementById("bulkCoverInput").value = "";
  document.getElementById("bulkFilesPicker").textContent = "📁 แตะเพื่อเลือกไฟล์เพลงหลายไฟล์";
  document.getElementById("bulkFilesPicker").className = "file-picker";
  document.getElementById("bulkFullFilesInput").value = "";
  document.getElementById("bulkFullFilesPicker").textContent = "🔒 แตะเพื่อเลือกไฟล์ WAV เต็มหลายไฟล์";
  document.getElementById("bulkFullFilesPicker").className = "file-picker";
  document.getElementById("bulkFullFilesMeta").style.display = "none";
  document.getElementById("bulkFullFilesMeta").textContent = "";
  document.getElementById("bulkCoverPicker").textContent = "🖼️ แตะเพื่อเลือกรูปปก (ใช้ร่วมกันทั้งชุด)";
  document.getElementById("bulkCoverPicker").className = "file-picker";
  document.getElementById("bulkProgressWrap").style.display = "none";
  document.getElementById("bulkStatusText").textContent = "";

  document.getElementById("bulkCategory").innerHTML = '<option value="">กำลังโหลด...</option>';
  document.getElementById("bulkDj").innerHTML = '<option value="">กำลังโหลด...</option>';
  document.getElementById("bulkPlaylist").innerHTML = '<option value="">กำลังโหลด...</option>';

  document.getElementById("bulkUploadBackdrop").classList.add("show");

  const [catSnap, djSnap, playlistSnap] = await Promise.all([
    getDocs(collection(db, "categories")), getDocs(collection(db, "djs")), getDocs(collection(db, "playlists"))
  ]);
  CACHE.categories = catSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  CACHE.djs = djSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  CACHE.playlists = playlistSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  populateSelect("bulkCategory", CACHE.categories, "id", "category_name");
  populateSelect("bulkDj", CACHE.djs, "id", "dj_name");
  populateSelect("bulkPlaylist", CACHE.playlists, "id", "playlist_name");
}
document.getElementById("bulkUploadClose").addEventListener("click", () => document.getElementById("bulkUploadBackdrop").classList.remove("show"));

document.getElementById("bulkFilesInput").addEventListener("change", (e) => {
  bulkFiles = Array.from(e.target.files || []);
  if (bulkFiles.length === 0) return;
  document.getElementById("bulkFilesPicker").textContent = `🎵 เลือกแล้ว ${bulkFiles.length} ไฟล์`;
  document.getElementById("bulkFilesPicker").className = "file-picker filled";
});
document.getElementById("bulkFullFilesInput").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  const meta = document.getElementById("bulkFullFilesMeta");
  const nonWav = files.filter(f => !/\.wav$/i.test(f.name));
  if (nonWav.length > 0) {
    showToast("ไฟล์เพลงเต็มต้องเป็นนามสกุล .wav เท่านั้น — ตัดไฟล์ที่ไม่ใช่ WAV ออกแล้ว: " + nonWav.map(f => f.name).join(", "), "error");
  }
  bulkFullFiles = files.filter(f => /\.wav$/i.test(f.name));
  if (bulkFullFiles.length === 0) { meta.style.display = "none"; return; }
  document.getElementById("bulkFullFilesPicker").textContent = `🔒 เลือกแล้ว ${bulkFullFiles.length} ไฟล์`;
  document.getElementById("bulkFullFilesPicker").className = "file-picker filled";
  meta.textContent = "จะจับคู่กับไฟล์ตัวอย่างโดยเทียบชื่อไฟล์ (ไม่รวมนามสกุล) — เพลงที่จับคู่ไม่ได้จะยังไม่มีไฟล์เต็ม เพิ่มทีหลังได้ที่หน้าแก้ไขเพลง";
  meta.style.display = "block";
});
document.getElementById("bulkCoverInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingBulkCoverFile = f;
  document.getElementById("bulkCoverPicker").textContent = "🖼️ " + f.name;
  document.getElementById("bulkCoverPicker").className = "file-picker filled";
});

function cleanFileNameToSongName(fileName) {
  return nameFromFile(fileName);
}

// ปรับชื่อไฟล์ให้เทียบกันง่ายขึ้น: ตัดนามสกุล, ไม่สนตัวพิมพ์เล็ก-ใหญ่, ไม่สนช่องว่าง/ขีดกลาง/underscore ที่เกินมาหรือขาดไป
// (กันปัญหาไฟล์ตัวอย่างชื่อ "เพลง A.mp3" กับไฟล์เต็มชื่อ "เพลง_A .wav" ไม่จับคู่กันทั้งที่จริงๆ เป็นเพลงเดียวกัน)
function normalizeForMatch(fileName) {
  return nameFromFile(fileName)
    .trim()
    .toLowerCase()
    .replace(/[_\-]+/g, " ")   // underscore/ขีดกลาง ถือเป็นช่องว่าง
    .replace(/\s+/g, " ");     // ยุบช่องว่างซ้ำให้เหลือช่องเดียว
}

// จับคู่ไฟล์เต็ม WAV กับไฟล์ตัวอย่าง โดยเทียบชื่อไฟล์แบบยืดหยุ่น (ดู normalizeForMatch)
function matchFullFile(previewFileName, fullFilesList) {
  const key = normalizeForMatch(previewFileName);
  return fullFilesList.find(f => normalizeForMatch(f.name) === key) || null;
}

document.getElementById("bulkUploadBtn").addEventListener("click", async function () {
  const btn = this;
  if (bulkFiles.length === 0) { showToast("กรุณาเลือกไฟล์เพลงก่อน", "error"); return; }

  const plSel = document.getElementById("bulkPlaylist");
  const newPlaylistName = document.getElementById("bulkNewPlaylistName").value.trim();

  btn.disabled = true; btn.textContent = "กำลังอัปโหลด...";
  document.getElementById("bulkProgressWrap").style.display = "block";

  try {
    let playlistId = plSel.value;
    let playlistName = plSel.value ? plSel.options[plSel.selectedIndex].text : "";
    if (!playlistId && newPlaylistName) {
      const newDoc = await addDoc(collection(db, "playlists"), { playlist_name: newPlaylistName, description: "", price: 0, cover_url: "", created_at: new Date().toISOString() });
      playlistId = newDoc.id;
      playlistName = newPlaylistName;
    }

    let sharedCoverUrl = "";
    if (pendingBulkCoverFile) {
      const coverRes = await uploadToCloudinary(pendingBulkCoverFile);
      sharedCoverUrl = coverRes.url;
      if (playlistId) await updateDoc(doc(db, "playlists", playlistId), { cover_url: sharedCoverUrl }).catch(() => {});
    }

    const djSel = document.getElementById("bulkDj");
    const catSel = document.getElementById("bulkCategory");
    const price = Number(document.getElementById("bulkPrice").value || 0);
    const djName = djSel.value ? djSel.options[djSel.selectedIndex].text : "";
    const catId = catSel.value;
    const catName = catSel.value ? catSel.options[catSel.selectedIndex].text : "";

    let matchedCount = 0;
    const unmatchedNames = []; // เก็บชื่อเพลงที่มีไฟล์เต็มให้เลือก แต่จับคู่ไม่ได้ — จะได้รู้ทันทีว่าต้องไปแก้ไขเพลงไหนเพิ่ม
    for (let i = 0; i < bulkFiles.length; i++) {
      const file = bulkFiles[i];
      document.getElementById("bulkStatusText").textContent = `กำลังอัปโหลด ${i + 1}/${bulkFiles.length}: ${file.name}`;
      const res = await uploadToCloudinary(file, (pct) => {
        const overall = Math.round(((i + pct / 100) / bulkFiles.length) * 100);
        document.getElementById("bulkProgress").style.width = overall + "%";
      });

      const songPayload = {
        song_name: cleanFileNameToSongName(file.name),
        artist: "",
        dj_name: djName,
        category_id: catId,
        category_name: catName,
        playlist_id: playlistId,
        playlist_name: playlistName,
        file_url: res.url,
        cover_url: sharedCoverUrl,
        price: price,
        description: "",
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // ถ้าจับคู่ด้วยชื่อไฟล์ไม่ได้ แต่เลือกไฟล์ตัวอย่าง 1 ไฟล์ + ไฟล์เต็ม 1 ไฟล์พอดี — ไม่มีทางกำกวมว่าเป็นคู่ไหน จับคู่กันตรงๆ ได้เลย ไม่ต้องพึ่งชื่อไฟล์
      const matchedFull = matchFullFile(file.name, bulkFullFiles)
        || (bulkFiles.length === 1 && bulkFullFiles.length === 1 ? bulkFullFiles[0] : null);
      if (matchedFull) {
        document.getElementById("bulkStatusText").textContent = `กำลังอัปโหลดไฟล์เต็ม ${i + 1}/${bulkFiles.length}: ${matchedFull.name}`;
        const fullRes = await uploadFullSong(matchedFull, (pct) => {
          const overall = Math.round(((i + pct / 100) / bulkFiles.length) * 100);
          document.getElementById("bulkProgress").style.width = overall + "%";
        });
        songPayload.full_file_url = fullRes.url;
        songPayload.full_file_public_id = fullRes.publicId;
        songPayload.full_file_name = matchedFull.name;
        matchedCount++;
      } else if (bulkFullFiles.length > 0) {
        unmatchedNames.push(songPayload.song_name);
      }

      await addDoc(collection(db, "songs"), songPayload);
    }

    document.getElementById("bulkProgress").style.width = "100%";
    const hasUnmatched = unmatchedNames.length > 0;
    const unmatchedNote = hasUnmatched
      ? ` (มีไฟล์เต็ม ${matchedCount}/${bulkFiles.length} เพลง — ยังไม่มีไฟล์เต็ม: ${unmatchedNames.join(", ")} ไปเพิ่มทีหลังได้ที่หน้าแก้ไขเพลง)`
      : "";
    const destinationNote = playlistName ? ` เข้าเพลย์ลิสต์ "${playlistName}"` : "";
    document.getElementById("bulkStatusText").textContent = `เสร็จแล้ว! เพิ่มเพลงสำเร็จ ${bulkFiles.length} เพลง${unmatchedNote}`;
    showToast(`เพิ่มเพลง ${bulkFiles.length} เพลง${destinationNote} สำเร็จ${hasUnmatched ? ` — ${unmatchedNames.length} เพลงยังไม่มีไฟล์เต็ม (ดูรายชื่อด้านล่าง)` : ""}`, hasUnmatched ? "error" : "success");
    loadDashboard();
    // ถ้ามีเพลงจับคู่ไฟล์เต็มไม่ได้ ให้ค้างหน้าต่างไว้จนกว่าจะปิดเอง จะได้เห็นรายชื่อที่ต้องไปแก้ไขเพิ่ม
    if (!hasUnmatched) {
      setTimeout(() => { document.getElementById("bulkUploadBackdrop").classList.remove("show"); }, 1200);
    }
  } catch (err) {
    showToast("อัปโหลดไม่สำเร็จ: " + err.message, "error");
  }
  btn.disabled = false; btn.textContent = "เริ่มอัปโหลดทั้งหมด";
});

// ================= SETTINGS =================
async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "main"));
  const s = snap.exists() ? snap.data() : {};
  document.getElementById("setWebsiteName").value = s.website_name || "";
  document.getElementById("setMetaDesc").value = s.meta_description || "";
  document.getElementById("setAdminName").value = s.admin_name || "";
  document.getElementById("setWhatsapp").value = s.whatsapp_number || "";
  document.getElementById("setLogo").value = s.website_logo || "";
}
document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
  const payload = {
    website_name: document.getElementById("setWebsiteName").value.trim(),
    meta_description: document.getElementById("setMetaDesc").value.trim(),
    admin_name: document.getElementById("setAdminName").value.trim(),
    whatsapp_number: document.getElementById("setWhatsapp").value.trim(),
    website_logo: document.getElementById("setLogo").value.trim()
  };
  try {
    await setDoc(doc(db, "settings", "main"), payload, { merge: true });
    showToast("บันทึกการตั้งค่าแล้ว", "success");
  } catch (err) {
    showToast("บันทึกไม่สำเร็จ: " + err.message, "error");
  }
});

// ================= Confirm modal =================
function openConfirm(text, onOk) {
  document.getElementById("confirmText").textContent = text;
  confirmAction = onOk;
  document.getElementById("confirmBackdrop").classList.add("show");
}
document.getElementById("confirmCancel").addEventListener("click", () => document.getElementById("confirmBackdrop").classList.remove("show"));
document.getElementById("confirmOk").addEventListener("click", async () => {
  document.getElementById("confirmBackdrop").classList.remove("show");
  if (confirmAction) await confirmAction();
});

// ให้ admin-roles.js เรียกใช้ toast/confirm modal ตัวเดียวกับหน้านี้ได้ (ไม่ต้องสร้างซ้ำ)
window.__showToast = showToast;
window.__openConfirm = openConfirm;
