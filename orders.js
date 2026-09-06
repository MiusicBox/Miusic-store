// orders.js — ระบบจัดการออเดอร์ (เชื่อมกับ Firestore จริงของเว็บ Music Store)
// ใช้ collection "songs" ที่มีอยู่แล้วเป็นแหล่งข้อมูลเพลง/ราคา
// และสร้าง collection ใหม่ชื่อ "orders" สำหรับเก็บออเดอร์
// ===================================================
import { db } from "./firebase-init.js?v=20260905-fix1";
import {
  collection, getDocs, getDoc, setDoc, query, orderBy, where, doc, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { uploadOrderZip } from "./storage-adapter.js?v=20260904-rawzip";

/* ---------------- สถานะออเดอร์ (4 สถานะ) ---------------- */
const STATUS_ORDER = ["pending_verify", "processing", "completed", "cancelled"];
const STATUS_CONFIG = {
  pending_verify: { emoji: "🟡", label: "รอตรวจสอบการโอน", color: "#F5B400", bg: "rgba(245,180,0,.15)" },
  processing:     { emoji: "🔵", label: "ชำระเงินแล้ว - กำลังส่งเพลง", color: "#3B9EFF", bg: "rgba(59,158,255,.15)" },
  completed:      { emoji: "🟢", label: "สำเร็จ", color: "var(--success)", bg: "rgba(41,204,113,.15)" },
  cancelled:      { emoji: "🔴", label: "ยกเลิก", color: "var(--danger)", bg: "rgba(255,107,107,.15)" },
};

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// Safari (และเบราว์เซอร์มือถือส่วนใหญ่) เมิน HTML `download` attribute สำหรับลิงก์ข้ามโดเมน
// เลยเปิดไฟล์เสียง/วิดีโอด้วยเครื่องเล่นในตัวแทนที่จะดาวน์โหลดให้ — ต้องสั่ง Cloudinary ให้ส่งไฟล์
// แบบ Content-Disposition: attachment โดยแทรก fl_attachment เข้าไปใน URL แทน
function toCloudinaryDownloadUrl(url) {
  if (!url || typeof url !== "string") return url;
  const marker = "/upload/";
  const idx = url.indexOf(marker);
  if (idx === -1) return url; // ไม่ใช่ URL รูปแบบ Cloudinary มาตรฐาน ปล่อยผ่านไม่แตะต้อง
  if (url.includes("/fl_attachment")) return url; // ใส่ไปแล้ว ไม่ใส่ซ้ำ
  return url.slice(0, idx + marker.length) + "fl_attachment/" + url.slice(idx + marker.length);
}
function formatLAK(v) { return Number(v || 0).toLocaleString("en-US") + " LAK"; }
function debounce(fn, wait) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; }
// แอดมินย่อยทำได้ทุกอย่างในหน้าออเดอร์ตามปกติ ยกเว้นลบประวัติออเดอร์ (สงวนไว้ให้แอดมินหลักเท่านั้น)
// role ถูกตั้งค่าไว้ที่ window.__currentAdminRole โดย app-admin.js ตอนล็อกอินสำเร็จ
function isMainAdmin() { return window.__currentAdminRole === "main"; }
// ชื่อฟิลด์จริงใน Firestore คือ playlist_name แต่รองรับข้อมูลเก่าที่อาจใช้ name ด้วย
function getPlaylistName(playlist) {
  return String(playlist?.playlist_name ?? playlist?.name ?? "");
}

// งานสร้าง ZIP ถูกกันซ้ำไว้ในหน้านี้ เพื่อไม่ให้ออเดอร์เดียวกันถูกสร้างหลายไฟล์
// หาก Admin เปิด/กดซ้ำระหว่างที่กำลังดาวน์โหลด WAV จาก Cloud
const zipJobs = new Set();
let jsZipModulePromise = null;

async function loadJSZip() {
  if (!jsZipModulePromise) {
    jsZipModulePromise = import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm")
      .then((module) => module.default || module);
  }
  return jsZipModulePromise;
}

function orderToast(message, type = "") {
  if (window.__showToast) window.__showToast(message, type);
  else if (type === "error") alert(message);
}

function getOrderPlaylistIds(order) {
  const ids = [];
  if (order?.playlist_id) ids.push(String(order.playlist_id));
  if (Array.isArray(order?.playlist_ids)) {
    order.playlist_ids.forEach((id) => id && ids.push(String(id)));
  }
  if (Array.isArray(order?.playlists)) {
    order.playlists.forEach((playlist) => {
      const id = typeof playlist === "string"
        ? playlist
        : (playlist?.id || playlist?.playlist_id);
      if (id) ids.push(String(id));
    });
  }
  if (typeof order?.playlist === "string") {
    ids.push(String(order.playlist));
  } else if (order?.playlist?.id || order?.playlist?.playlist_id) {
    ids.push(String(order.playlist.id || order.playlist.playlist_id));
  }
  return [...new Set(ids)];
}

/*
 * รวมเพลงจากทั้ง items ของออเดอร์และ playlist ที่อ้างถึง
 * รองรับข้อมูลเก่า (playlist songs ถูก snapshot ไว้ใน items) และข้อมูลที่มี
 * เพลงเดี่ยว + playlist ในออเดอร์เดียวกัน โดยไม่แก้ข้อมูลเดิม
 */
async function resolveOrderSongs(order) {
  const songMap = new Map();
  (order?.items || []).forEach((item) => {
    if (!item?.song_id) return;
    songMap.set(String(item.song_id), {
      id: String(item.song_id),
      title: item.title || "เพลง",
    });
  });

  const playlistIds = getOrderPlaylistIds(order);
  const playlistSnaps = await Promise.all(
    playlistIds.map((playlistId) =>
      getDocs(query(collection(db, "songs"), where("playlist_id", "==", playlistId)))
    )
  );
  playlistSnaps.forEach((snap) => {
    snap.docs.forEach((songDoc) => {
      const song = songDoc.data();
      if (!songMap.has(songDoc.id)) {
        songMap.set(songDoc.id, { id: songDoc.id, title: song.song_name || "เพลง" });
      }
    });
  });

  return [...songMap.values()];
}

function safeZipFileName(value, fallback) {
  const cleaned = String(value || fallback || "เพลง.wav")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return /\.wav$/i.test(cleaned) ? cleaned : `${cleaned}.wav`;
}

function uniqueZipFileName(value, usedNames) {
  const original = safeZipFileName(value, "เพลง.wav");
  if (!usedNames.has(original)) {
    usedNames.add(original);
    return original;
  }
  const dot = original.lastIndexOf(".");
  const base = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : ".wav";
  let index = 2;
  let candidate = `${base} (${index})${ext}`;
  while (usedNames.has(candidate)) {
    index += 1;
    candidate = `${base} (${index})${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

/*
 * ดาวน์โหลด WAV เต็มจาก Cloud แล้วสร้าง ZIP ก่อนจึงค่อยอัปโหลด ZIP กลับขึ้น Cloud
 * จุดสำคัญ: อ่านเฉพาะ full_file_url ของเพลง ไม่แตะ preview_url/ไฟล์ตัวอย่าง
 */
async function createOrderZip(orderId) {
  if (zipJobs.has(orderId)) return { ok: false, error: "กำลังสร้าง ZIP ของออเดอร์นี้อยู่" };
  const order = state.allOrders.find((item) => item.id === orderId);
  if (!order) return { ok: false, error: "ไม่พบออเดอร์นี้" };

  // ถ้ามี ZIP ที่สร้างสำเร็จแล้ว ใช้ลิงก์เดิมได้ ไม่สร้างไฟล์ซ้ำโดยไม่จำเป็น
  if (order.zip_status === "ready" && order.zip_download_url) {
    return { ok: true, url: order.zip_download_url };
  }

  zipJobs.add(orderId);
  const zipFileName = `Order-${orderId}.zip`;
  try {
    await updateDoc(doc(db, "orders", orderId), {
      zip_status: "preparing",
      zip_error: "",
      zip_requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const orderSongs = await resolveOrderSongs(order);
    if (orderSongs.length === 0) {
      throw new Error("ออเดอร์นี้ไม่มีรายการเพลงสำหรับสร้าง ZIP");
    }

    const JSZip = await loadJSZip();
    const zip = new JSZip();
    const usedNames = new Set();
    for (let index = 0; index < orderSongs.length; index += 1) {
      const item = orderSongs[index];
      const songSnap = await getDoc(doc(db, "songs", item.id));
      if (!songSnap.exists()) {
        throw new Error(`ไม่พบข้อมูลเพลง "${item.title}"`);
      }
      const song = songSnap.data();
      // ห้าม fallback ไปใช้ preview_url เพราะ ZIP ต้องเป็น WAV จริงเท่านั้น
      if (!song.full_file_url) {
        throw new Error(`เพลง "${song.song_name || item.title}" ยังไม่มีไฟล์เต็ม WAV บน Cloud`);
      }

      orderToast(`กำลังดึง WAV ${index + 1}/${orderSongs.length}...`);
      const response = await fetch(song.full_file_url, { mode: "cors", cache: "no-store" });
      if (!response.ok) {
        throw new Error(`ดึงไฟล์ WAV ของเพลง "${song.song_name || item.title}" ไม่สำเร็จ (${response.status})`);
      }
      const wavBlob = await response.blob();
      const entryName = uniqueZipFileName(
        song.full_file_name || `${song.song_name || item.title}.wav`,
        usedNames
      );
      zip.file(entryName, wavBlob);
    }

    orderToast("กำลังบีบอัดไฟล์ WAV เป็น ZIP...");
    const zipBlob = await zip.generateAsync(
      { type: "blob", compression: "STORE" },
      (metadata) => orderToast(`กำลังสร้าง ZIP... ${Math.round(metadata.percent)}%`)
    );
    const zipFile = new File([zipBlob], zipFileName, { type: "application/zip" });

    orderToast("กำลังอัปโหลด ZIP ขึ้น Cloud...");
    const uploadResult = await uploadOrderZip(
      zipFile,
      (percent) => orderToast(`กำลังอัปโหลด ZIP... ${percent}%`)
    );
    if (!uploadResult?.url) {
      throw new Error("Cloud ไม่ส่ง Download Link กลับมา");
    }

    const downloadUrl = toCloudinaryDownloadUrl(uploadResult.url);
    // บันทึกลิงก์หลังอัปโหลดสำเร็จเท่านั้น
    await updateDoc(doc(db, "orders", orderId), {
      zip_status: "ready",
      zip_download_url: downloadUrl,
      zip_file_name: zipFileName,
      zip_public_id: uploadResult.publicId || "",
      zip_song_count: orderSongs.length,
      zip_created_at: new Date().toISOString(),
      zip_error: "",
      updated_at: new Date().toISOString(),
    });
    return { ok: true, url: downloadUrl };
  } catch (err) {
    const errorMessage = err?.message || String(err);
    // ถ้าเกิดข้อผิดพลาด ให้คงสถานะออเดอร์เดิมไว้และไม่บันทึกลิงก์
    try {
      await updateDoc(doc(db, "orders", orderId), {
        zip_status: "failed",
        zip_error: errorMessage,
        zip_download_url: "",
        zip_file_name: "",
        updated_at: new Date().toISOString(),
      });
    } catch (statusError) {
      console.error("บันทึกสถานะ ZIP ไม่สำเร็จ:", statusError);
    }
    return { ok: false, error: errorMessage };
  } finally {
    zipJobs.delete(orderId);
  }
}

function getReceiptNumber(orderId, createdAt) {
  const date = new Date(createdAt || Date.now());
  const ymd = Number.isNaN(date.getTime())
    ? "00000000"
    : [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("");
  return `RCPT-${ymd}-${String(orderId || "000000").slice(-6).toUpperCase()}`;
}

const state = {
  songs: [],        // เพลงทั้งหมด (status: active) จาก collection "songs"
  playlists: [],     // เพลย์ลิสต์ที่ตั้งราคาเหมาไว้แล้ว จาก collection "playlists"
  searchResults: [],
  cartItems: [],     // เพลงที่เลือกไว้ในออเดอร์ที่กำลังกรอก
  allOrders: [],      // แคชออเดอร์ล่าสุดที่โหลดมา (ใช้กรองสถานะโดยไม่ต้องโหลดซ้ำ)
  historyFilter: "all", // สถานะที่กำลังกรองดูในประวัติออเดอร์
  listenersBound: false, // กันการผูก event ซ้ำเมื่อเปิดหน้านี้หลายครั้ง

  // ---- ประเภทออเดอร์ที่กำลังกรอก: "single" (เพลงเดี่ยว) หรือ "playlist" (ยกเพลย์ลิสต์) ----
  orderType: "single",
  playlistSearchResults: [],
  selectedPlaylist: null, // { id, playlist_name, price, ... } เพลย์ลิสต์ที่เลือกในฟอร์มสร้างออเดอร์ใหม่

  // ---- สถานะสำหรับโหมดแก้ไขออเดอร์ (modal) ----
  editingOrderId: null,   // id ของออเดอร์ที่กำลังแก้ไขอยู่ (null = ไม่ได้เปิด modal)
  editCartItems: [],      // เพลงในตะกร้าของ modal แก้ไข
  editSearchResults: [],  // ผลค้นหาเพลงใน modal แก้ไข
  editOrderType: "single",
  editPlaylistSearchResults: [],
  editSelectedPlaylist: null, // เพลย์ลิสต์ที่เลือกใน modal แก้ไข

  // ---- ธงบอกว่า "ยอดรวม" ถูกผู้ใช้แก้ไขเองหรือไม่ ----
  // true = ใช้ค่าที่ผู้ใช้พิมพ์เอง, false = คำนวณอัตโนมัติจากราคาเพลงในตะกร้า (หรือราคาเหมาเพลย์ลิสต์)
  cartTotalEdited: false,     // สำหรับฟอร์มสร้างออเดอร์ใหม่
  editCartTotalEdited: false, // สำหรับ modal แก้ไขออเดอร์
  storeName: "Music Store",
};

/* ---------------- โหลดเพลงจริงจาก Firestore ---------------- */
async function loadSongsFromDatabase() {
  const q = query(collection(db, "songs"), where("status", "==", "active"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ---------------- โหลดออเดอร์ทั้งหมดจาก Firestore ---------------- */
async function loadOrdersFromDatabase() {
  const q = query(collection(db, "orders"), orderBy("created_at", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ---------------- โหลดเพลย์ลิสต์จริงจาก Firestore (สำหรับขายยกเพลย์ลิสต์) ----------------
   หมายเหตุ: เอาไว้เฉพาะเพลย์ลิสต์ที่ตั้ง "ราคาเหมา" ไว้แล้ว (price > 0) เพราะถือว่าเป็นชุดที่ขายทั้งชุดได้
   เพลย์ลิสต์ที่ไม่ได้ตั้งราคา (ปล่อยว่าง/0) จะไม่โผล่ในช่องค้นหานี้ */
async function loadPlaylistsFromDatabase() {
  const snap = await getDocs(collection(db, "playlists"));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => Number(p.price || 0) > 0);
}

async function loadStoreName() {
  try {
    const snap = await getDoc(doc(db, "settings", "main"));
    return snap.exists() ? String(snap.data().website_name || "Music Store") : "Music Store";
  } catch (err) {
    console.warn("โหลดชื่อร้านไม่สำเร็จ ใช้ชื่อเริ่มต้นแทน:", err);
    return "Music Store";
  }
}

/* ---------------- หาเพลงทั้งหมดที่อยู่ในเพลย์ลิสต์ที่เลือก ----------------
   อ้างอิงจากฟิลด์ playlist_id บนเอกสารเพลงแต่ละเพลง (บันทึกไว้ตอนเพิ่ม/แก้ไขเพลงในหน้า "จัดการเพลง")
   ถ้าฐานข้อมูลจริงเก็บฟิลด์นี้ชื่ออื่น ให้แก้ตรง s.playlist_id ด้านล่างนี้จุดเดียว */
function getSongsInPlaylist(playlistId) {
  return state.songs.filter((s) => s.playlist_id === playlistId);
}

/* ---------------- คำนวณ ---------------- */
function calculateCartTotal(items) {
  return items.reduce((sum, item) => sum + Number(item.price || 0), 0);
}
function calculateOrderTotal(orderType, items, playlist) {
  return orderType === "playlist" && playlist
    ? Number(playlist.price || 0)
    : calculateCartTotal(items);
}

// รองรับหน้า admin.html รุ่นเก่าที่ยังไม่มี modal ใบเสร็จ
function ensureReceiptElements() {
  if (document.getElementById("receiptBackdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "receiptBackdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>ใบเสร็จดิจิทัล</h3>
        <button class="modal-close" id="receiptClose">✕</button>
      </div>
      <div id="receiptContent"></div>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn secondary" id="receiptCopyBtn" type="button" style="flex:1;">คัดลอกรายละเอียด</button>
        <button class="btn" id="receiptPrintBtn" type="button" style="flex:1;">พิมพ์ / บันทึกเป็น PDF</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
}
// รองรับหน้า admin.html รุ่นเก่าที่ยังไม่มี modal ไฟล์เพลงเต็ม
function ensureFullFilesElements() {
  if (document.getElementById("fullFilesBackdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "fullFilesBackdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>ไฟล์เพลงเต็มสำหรับส่งลูกค้า</h3>
        <button class="modal-close" id="fullFilesClose">✕</button>
      </div>
       <p style="color:var(--text-dim);font-size:13px;margin-top:0;">ระบบจะสร้าง ZIP จาก WAV เต็มให้อัตโนมัติหลังยืนยันโอน — ลิงก์นี้สำหรับ Admin เท่านั้น ห้ามส่งลิงก์นี้ตรงให้ลูกค้า</p>
      <div id="fullFilesContent"></div>
    </div>
  `;
  document.body.appendChild(backdrop);
}
function calculateStats(orders) {
  // totalOrders = ออเดอร์ทั้งหมดทุกสถานะ (ปริมาณงานรวม)
  // totalSongsSold / totalRevenue = นับเฉพาะออเดอร์ที่ "สำเร็จ" แล้วเท่านั้น
  // เพื่อไม่ให้ออเดอร์ที่ยังรอตรวจสอบหรือถูกยกเลิกไปปนกับยอดขายจริง
  const totalOrders = orders.length;
  const completed = orders.filter((o) => o.status === "completed");
  // นับจำนวนเพลงต่อ Order: รายการปกติ (เพลงเดี่ยว) นับ 1, รายการที่เป็นเพลย์ลิสต์ (kind: "playlist",
  // มาจากตะกร้าแบบผสม/หลายเพลย์ลิสต์) ให้นับตามจำนวนเพลงจริงใน song_ids แทนการนับเป็น 1 รายการ
  const totalSongsSold = completed.reduce((sum, o) => {
    const items = o.items || [];
    const count = items.reduce((itemSum, item) => {
      if (item?.kind === "playlist") return itemSum + (Array.isArray(item.song_ids) ? item.song_ids.length : 1);
      return itemSum + 1;
    }, 0);
    return sum + count;
  }, 0);
  const totalRevenue = completed.reduce((sum, o) => sum + Number(o.total || 0), 0);
  // แยกนับว่าออเดอร์ที่สำเร็จแล้วเป็นแบบ "เพลงเดี่ยว" หรือ "ยกเพลย์ลิสต์" กี่ออเดอร์
  // ออเดอร์เก่าที่ไม่มีฟิลด์ order_type (สร้างก่อนอัปเดตนี้) ให้นับเป็นเพลงเดี่ยวไว้ก่อน
  const singleCount = completed.filter((o) => (o.order_type || "single") === "single").length;
  const playlistCount = completed.filter((o) => o.order_type === "playlist").length;
  // ออเดอร์แบบผสม (เพลง+เพลย์ลิสต์ หรือหลายเพลย์ลิสต์ ที่สั่งซื้อจากตะกร้าฝั่งลูกค้า)
  const mixedCount = completed.filter((o) => o.order_type === "mixed").length;
  return { totalOrders, totalSongsSold, totalRevenue, singleCount, playlistCount, mixedCount };
}

/* ---------------- Render: ผลค้นหาเพลง (ฟอร์มสร้างออเดอร์ใหม่) ---------------- */
function renderSearchResults() {
  const container = document.getElementById("ordSearchResults");
  container.innerHTML = "";

  if (state.searchResults.length === 0) return;

  state.searchResults.forEach((song) => {
    const alreadyAdded = state.cartItems.some((i) => i.songId === song.id);
    const row = document.createElement("div");
    row.className = "list-row";
    row.innerHTML = `
      <img src="${song.cover_url || ""}">
      <div class="info">
        <div class="n1">${escapeHtml(song.song_name)}</div>
        <div class="n2">${escapeHtml(song.dj_name || song.artist || "-")} · ${formatLAK(song.price)}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-add="${song.id}" ${alreadyAdded ? "disabled" : ""} style="${alreadyAdded ? "opacity:.4;" : "background:var(--accent);color:#fff;"}">
          ${alreadyAdded ? "✓" : "＋"}
        </button>
      </div>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      addToCart(btn.getAttribute("data-add"));
    });
  });
}

/* ---------------- Render: ตะกร้าออเดอร์ปัจจุบัน (ฟอร์มสร้างออเดอร์ใหม่) ---------------- */
function renderCart() {
  const container = document.getElementById("ordCartItems");
  const totalEl = document.getElementById("ordCartTotal");
  const hintEl = document.getElementById("ordTotalHint");
  container.innerHTML = "";

  if (state.orderType === "playlist" && state.selectedPlaylist) {
    const badge = document.createElement("div");
    badge.style.cssText = "font-size:12px;font-weight:700;color:var(--accent);margin-bottom:6px;";
    badge.textContent = `🎶 ยกเพลย์ลิสต์: ${getPlaylistName(state.selectedPlaylist)} (${state.cartItems.length} เพลง)`;
    container.appendChild(badge);
  }

  if (state.cartItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.style.padding = "10px 0";
    empty.textContent = state.orderType === "playlist" ? "ยังไม่ได้เลือกเพลย์ลิสต์" : "ยังไม่ได้เลือกเพลง";
    container.appendChild(empty);
  } else {
    state.cartItems.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "list-row";
      // โหมดยกเพลย์ลิสต์: เพลงถูกดึงมาอัตโนมัติทั้งชุด ไม่ให้ลบทีละเพลง (ลบได้แค่ยกเลิกทั้งเพลย์ลิสต์)
      const removeBtn = state.orderType === "playlist"
        ? ""
        : `<div class="row-actions"><button class="icon-btn danger" data-remove="${index}">🗑</button></div>`;
      row.innerHTML = `
        <div class="info"><div class="n1">${escapeHtml(item.title)}</div><div class="n2">${formatLAK(item.price)}</div></div>
        ${removeBtn}
      `;
      container.appendChild(row);
    });
    container.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => removeFromCart(Number(btn.getAttribute("data-remove"))));
    });
  }

  // ยอดเพลงเดี่ยว = ผลรวมราคาเพลง / ยกเพลย์ลิสต์ = ราคาเหมาของเพลย์ลิสต์
  const computedTotal = calculateOrderTotal(
    state.orderType,
    state.cartItems,
    state.selectedPlaylist
  );
  totalEl.value = computedTotal;
  if (hintEl) {
    hintEl.textContent = `คำนวณอัตโนมัติ: ${
      state.orderType === "playlist" ? "ราคาเหมาเพลย์ลิสต์" : "รวมราคาเพลงที่เลือก"
    }`;
  }
}

/* ---------------- Render: ผลค้นหาเพลย์ลิสต์ (ฟอร์มสร้างออเดอร์ใหม่) ---------------- */
function renderPlaylistSearchResults() {
  const container = document.getElementById("ordPlaylistResults");
  if (!container) return;
  container.innerHTML = "";
  if (state.selectedPlaylist) return; // เลือกแล้ว ไม่ต้องโชว์ผลค้นหาซ้ำ
  if (state.playlistSearchResults.length === 0) return;

  state.playlistSearchResults.forEach((pl) => {
    const songCount = getSongsInPlaylist(pl.id).length;
    const card = document.createElement("div");
    card.className = "playlist-result-card";
    card.innerHTML = `
      <img src="${pl.cover_url || ""}">
      <div class="info" style="flex:1;">
        <div class="n1">${escapeHtml(getPlaylistName(pl))}</div>
        <div class="n2">${songCount} เพลง · ราคาเหมา ${formatLAK(pl.price)}</div>
      </div>
    `;
    card.addEventListener("click", () => selectPlaylist(pl.id));
    container.appendChild(card);
  });
}

/* ---------------- Render: การ์ดเพลย์ลิสต์ที่เลือกไว้ (ฟอร์มสร้างออเดอร์ใหม่) ---------------- */
function renderPlaylistSelected() {
  const container = document.getElementById("ordPlaylistSelected");
  if (!container) return;
  container.innerHTML = "";
  if (!state.selectedPlaylist) return;

  const pl = state.selectedPlaylist;
  const card = document.createElement("div");
  card.className = "playlist-selected-card";
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div style="font-weight:800;">🎶 ${escapeHtml(getPlaylistName(pl))}</div>
      <button class="icon-btn" id="ordPlaylistClearBtn">✕</button>
    </div>
    <div style="font-size:12px;color:var(--text-dim);">${state.cartItems.length} เพลง · ราคาเหมา ${formatLAK(pl.price)}</div>
  `;
  container.appendChild(card);
  document.getElementById("ordPlaylistClearBtn").addEventListener("click", clearSelectedPlaylist);
}

/* ---------------- เลือกเพลย์ลิสต์: ดึงเพลงทั้งชุด + ราคาเหมา มาลงออเดอร์เดียวจบ ---------------- */
function selectPlaylist(playlistId) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (!pl) return;

  const songs = getSongsInPlaylist(pl.id);
  state.selectedPlaylist = pl;
  state.cartItems = songs.map((s) => ({ songId: s.id, title: s.song_name, price: Number(s.price || 0) }));
  state.cartTotalEdited = false; // กลับไปใช้ราคาเหมาของเพลย์ลิสต์เป็นค่าตั้งต้นเสมอ
  document.getElementById("ordPlaylistSearch").value = "";
  state.playlistSearchResults = [];

  renderPlaylistSelected();
  renderPlaylistSearchResults();
  renderCart();
}

function clearSelectedPlaylist() {
  state.selectedPlaylist = null;
  state.cartItems = [];
  state.cartTotalEdited = false;
  renderPlaylistSelected();
  renderPlaylistSearchResults();
  renderCart();
}

function handlePlaylistSearchInput(e) {
  const q = e.target.value.trim().toLowerCase();
  state.playlistSearchResults = !q ? [] : state.playlists.filter((p) => getPlaylistName(p).toLowerCase().includes(q));
  renderPlaylistSearchResults();
}

/* ---------------- สลับประเภทออเดอร์: เพลงเดี่ยว ↔ ยกเพลย์ลิสต์ (ฟอร์มสร้างออเดอร์ใหม่) ---------------- */
function switchOrderType(type) {
  if (state.orderType === type) return;
  state.orderType = type;

  document.querySelectorAll('#ordTypeToggle [data-order-type]').forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-order-type") === type);
  });
  document.getElementById("ordSingleSection").style.display = type === "single" ? "" : "none";
  document.getElementById("ordPlaylistSection").style.display = type === "playlist" ? "" : "none";

  // ล้างสิ่งที่เลือกไว้จากโหมดก่อนหน้า กันข้อมูลเพลงเดี่ยว/เพลย์ลิสต์ปนกัน
  state.cartItems = [];
  state.cartTotalEdited = false;
  state.selectedPlaylist = null;
  state.searchResults = [];
  state.playlistSearchResults = [];
  document.getElementById("ordSongSearch").value = "";
  document.getElementById("ordPlaylistSearch").value = "";

  renderSearchResults();
  renderPlaylistSelected();
  renderPlaylistSearchResults();
  renderCart();
}

/* ---------------- Render: Dashboard สถิติออเดอร์ ---------------- */
function renderStats(orders) {
  const stats = calculateStats(orders);
  document.getElementById("ordStatCount").textContent = stats.totalOrders.toLocaleString("en-US");
  document.getElementById("ordStatSongs").textContent = stats.totalSongsSold.toLocaleString("en-US");
  document.getElementById("ordStatRevenue").textContent = formatLAK(stats.totalRevenue);
  document.getElementById("ordStatSingleCount").textContent = stats.singleCount.toLocaleString("en-US");
  document.getElementById("ordStatPlaylistCount").textContent = stats.playlistCount.toLocaleString("en-US");
}

/* ---------------- Render: แถบกรองสถานะ ---------------- */
function renderFilterPills() {
  const wrap = document.getElementById("ordStatusFilter");
  if (!wrap) return;
  const filters = [{ key: "all", label: "ทั้งหมด" }].concat(
    STATUS_ORDER.map((k) => ({ key: k, label: `${STATUS_CONFIG[k].emoji} ${STATUS_CONFIG[k].label}` }))
  );
  wrap.innerHTML = filters.map((f) =>
    `<button data-filter="${f.key}" class="${state.historyFilter === f.key ? "active" : ""}">${f.label}</button>`
  ).join("");
  wrap.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.historyFilter = btn.getAttribute("data-filter");
      renderFilterPills();
      renderHistory();
    });
  });
}

/* ---------------- Render: ประวัติออเดอร์ ---------------- */
function renderHistory() {
  const wrap = document.getElementById("ordHistoryList");
  const orders = state.historyFilter === "all"
    ? state.allOrders
    : state.allOrders.filter((o) => o.status === state.historyFilter);

  if (orders.length === 0) {
    wrap.innerHTML = `<div class="empty-state">ไม่พบออเดอร์ในสถานะนี้</div>`;
    return;
  }
  wrap.innerHTML = orders.map((o) => {
    const date = o.created_at ? new Date(o.created_at) : null;
    const dateStr = date ? date.toLocaleDateString("th-TH") + " " + date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : "-";
    const songNames = (o.items || []).map(i => escapeHtml(i.title)).join(", ");
    const cfg = STATUS_CONFIG[o.status] || STATUS_CONFIG.pending_verify;
    const options = STATUS_ORDER.map((k) =>
      `<option value="${k}" ${o.status === k ? "selected" : ""}>${STATUS_CONFIG[k].emoji} ${STATUS_CONFIG[k].label}</option>`
    ).join("");
    const isPlaylistOrder = o.order_type === "playlist";
    const isMixedOrder = o.order_type === "mixed";
    const typeBadge = isPlaylistOrder
      ? `<span class="order-type-badge" style="background:rgba(122,92,255,.15);color:var(--accent);">🎶 ยกเพลย์ลิสต์${o.playlist_name ? " · " + escapeHtml(o.playlist_name) : ""}</span>`
      : isMixedOrder
        ? `<span class="order-type-badge" style="background:rgba(245,180,0,.15);color:#F5B400;">🛒 เพลง+เพลย์ลิสต์ (${(o.items || []).length} รายการ)</span>`
        : `<span class="order-type-badge" style="background:rgba(255,255,255,.08);color:var(--text-dim);">🎵 เพลงเดี่ยว</span>`;
    const zipInfo = o.zip_download_url
      ? `<div class="n2" style="color:var(--success);">📦 ${escapeHtml(o.zip_file_name || `Order-${o.id}.zip`)} · ${Number(o.zip_song_count || (o.items || []).length)} เพลง · <a href="${escapeHtml(toCloudinaryDownloadUrl(o.zip_download_url))}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">ดาวน์โหลด ZIP</a></div>`
      : o.zip_status === "failed"
        ? `<div class="n2" style="color:var(--danger);">⚠️ สร้าง ZIP ไม่สำเร็จ: ${escapeHtml(o.zip_error || "ไม่ทราบสาเหตุ")}</div>`
        : o.zip_status === "preparing"
          ? `<div class="n2" style="color:var(--accent);">⏳ กำลังสร้าง ZIP...</div>`
          : "";
    return `
      <div class="list-row" style="flex-direction:column;align-items:stretch;gap:8px;">
        <div class="info">
          ${typeBadge}
          <div class="n1">${escapeHtml(o.customer_name)} · ${formatLAK(o.total)}</div>
          <div class="n2">${dateStr} · ${escapeHtml(o.whatsapp)}</div>
          <div class="n2">${songNames}</div>
          ${zipInfo}
        </div>
        <span class="status-badge" style="background:${cfg.bg};color:${cfg.color};">${cfg.emoji} ${cfg.label}</span>
        <select class="status-select" data-order-id="${o.id}">${options}</select>
        <div class="row-actions" style="justify-content:flex-end;">
          <button class="icon-btn" data-receipt-order="${o.id}" title="ดูใบเสร็จ">🧾</button>
          ${(o.status === "processing" || o.status === "completed") ? `<button class="icon-btn" data-fullfiles-order="${o.id}" title="ไฟล์เต็มสำหรับส่งลูกค้า">📥</button>` : ""}
          ${o.zip_status === "failed" ? `<button class="icon-btn" data-retry-zip-order="${o.id}" title="สร้าง ZIP ใหม่">🔁</button>` : ""}
          <button class="icon-btn" data-edit-order="${o.id}" title="แก้ไขออเดอร์">✏️</button>
          ${isMainAdmin() ? `<button class="icon-btn danger" data-delete-order="${o.id}" title="ลบออเดอร์">🗑</button>` : ""}
        </div>
      </div>
    `;
  }).join("");

  wrap.querySelectorAll("[data-order-id]").forEach((sel) => {
    sel.addEventListener("change", () => handleStatusChange(sel.getAttribute("data-order-id"), sel.value));
  });
  wrap.querySelectorAll("[data-receipt-order]").forEach((btn) => {
    btn.addEventListener("click", () => openReceipt(btn.getAttribute("data-receipt-order")));
  });
  wrap.querySelectorAll("[data-fullfiles-order]").forEach((btn) => {
    btn.addEventListener("click", () => openFullFilesModal(btn.getAttribute("data-fullfiles-order")));
  });
  wrap.querySelectorAll("[data-retry-zip-order]").forEach((btn) => {
    btn.addEventListener("click", () => retryOrderZip(btn.getAttribute("data-retry-zip-order")));
  });
  wrap.querySelectorAll("[data-edit-order]").forEach((btn) => {
    btn.addEventListener("click", () => openEditOrderModal(btn.getAttribute("data-edit-order")));
  });
  wrap.querySelectorAll("[data-delete-order]").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteOrder(btn.getAttribute("data-delete-order")));
  });
}

/* ---------------- ใบเสร็จดิจิทัล ---------------- */
function getReceiptStatusLabel(status) {
  return STATUS_CONFIG[status]?.label || "รอตรวจสอบการโอน";
}

function buildReceiptCopyText(order, receiptNumber, total, playlistName) {
  const date = order.created_at ? new Date(order.created_at) : new Date();
  const dateText = Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
  const itemLines = order.order_type === "playlist"
    ? [`1. เพลย์ลิสต์: ${playlistName} — ${formatLAK(total)}`]
    : (order.items || []).map((item, index) =>
        `${index + 1}. ${item.title || "เพลง"} — ${formatLAK(item.price)}`
      );
  return [
    order.store_name || state.storeName || "Music Store",
    "ใบเสร็จรับเงิน / รายละเอียด Order",
    `เลขที่: ${receiptNumber}`,
    `วันที่: ${dateText}`,
    `สถานะ: ${getReceiptStatusLabel(order.status)}`,
    "",
    `ลูกค้า: ${order.customer_name || "-"}`,
    `WhatsApp: ${order.whatsapp || "-"}`,
    "",
    "รายการสั่งซื้อ:",
    ...(itemLines.length ? itemLines : ["ไม่มีรายการสินค้า"]),
    "",
    `รวมทั้งสิ้น: ${formatLAK(total)}`,
    "กรุณาโอนเงินตามช่องทางที่ร้านแจ้ง"
  ].join("\n");
}

async function copyReceiptDetails(order, receiptNumber, total, playlistName) {
  const text = buildReceiptCopyText(order, receiptNumber, total, playlistName);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    orderToast("คัดลอกรายละเอียด Order แล้ว", "success");
  } catch (err) {
    orderToast("คัดลอกไม่สำเร็จ กรุณาลองใหม่", "error");
  }
}

function openReceipt(orderId) {
  const order = state.allOrders.find((o) => o.id === orderId);
  if (!order) return;
  ensureReceiptElements();

  const playlist = order.playlist_id
    ? state.playlists.find((p) => p.id === order.playlist_id)
    : null;
  const playlistName = order.playlist_name || getPlaylistName(playlist) || "เพลย์ลิสต์";
  const total = Number.isFinite(Number(order.total))
    ? Number(order.total)
    : calculateOrderTotal(order.order_type, order.items || [], playlist);
  const date = order.created_at ? new Date(order.created_at) : new Date();
  const dateText = Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
  const receiptNumber = order.receipt_number || getReceiptNumber(order.id, order.created_at);

  const itemRows = order.order_type === "playlist"
    ? `
      <div class="receipt-line">
        <div><strong>🎶 ${escapeHtml(playlistName)}</strong><small>ยกเพลย์ลิสต์ · ${(order.items || []).length} เพลง</small></div>
        <strong>${formatLAK(total)}</strong>
      </div>
    `
    : (order.items || []).map((item) => `
      <div class="receipt-line">
        <div><strong>${escapeHtml(item.title || "เพลง")}</strong></div>
        <strong>${formatLAK(item.price)}</strong>
      </div>
    `).join("");

  const content = document.getElementById("receiptContent");
  if (!content) return;
  content.innerHTML = `
    <div class="receipt-paper">
      <div class="receipt-head">
        <h2>${escapeHtml(order.store_name || state.storeName)}</h2>
        <div>ใบเสร็จรับเงิน</div>
        <small>เลขที่ ${escapeHtml(receiptNumber)}</small>
        <small>${escapeHtml(dateText)}</small>
      </div>
      <div class="receipt-customer">
        <div><span>ลูกค้า</span><strong>${escapeHtml(order.customer_name)}</strong></div>
        <div><span>WhatsApp</span><strong>${escapeHtml(order.whatsapp)}</strong></div>
      </div>
      <div class="receipt-items">
        ${itemRows || '<div class="receipt-empty">ไม่มีรายการสินค้า</div>'}
      </div>
      <div class="receipt-total"><span>รวมทั้งสิ้น</span><strong>${formatLAK(total)}</strong></div>
      <div class="receipt-thanks">ขอบคุณที่ใช้บริการ</div>
    </div>
  `;

  const backdrop = document.getElementById("receiptBackdrop");
  backdrop.classList.add("open");
  backdrop.style.display = "flex";
  const copyBtn = document.getElementById("receiptCopyBtn");
  if (copyBtn) {
    copyBtn.onclick = () => copyReceiptDetails(order, receiptNumber, total, playlistName);
  }
}

function closeReceipt() {
  const backdrop = document.getElementById("receiptBackdrop");
  backdrop.classList.remove("open");
  backdrop.style.display = "none";
}

/* ---------------- ไฟล์เพลงเต็ม WAV สำหรับ Admin ส่งลูกค้า (หลังชำระเงินแล้วเท่านั้น) ---------------- */
async function openFullFilesModal(orderId) {
  const order = state.allOrders.find((o) => o.id === orderId);
  const content = document.getElementById("fullFilesContent");
  const backdrop = document.getElementById("fullFilesBackdrop");
  if (!order || !content || !backdrop) return;

  if (order.status !== "processing" && order.status !== "completed") {
    alert("ออเดอร์นี้ยังไม่ได้ยืนยันการชำระเงิน");
    return;
  }

  content.innerHTML = `<div class="empty-state">กำลังโหลดไฟล์...</div>`;
  backdrop.classList.add("open");
  backdrop.style.display = "flex";

  // ดึงข้อมูลเพลงล่าสุดจาก Firestore ตรงๆ (ไม่ใช้ cache) เพราะเพลงอาจถูกปิดการขาย/แก้ไขไปแล้วหลังสั่งซื้อ
  const items = order.items || [];
  // แต่ละ item ปกติแทนเพลง 1 เพลง (มี song_id) — ยกเว้น item ที่เป็น "playlist" (มาจาก Order ผสมที่สั่งจาก
  // ตะกร้าฝั่งลูกค้า) ซึ่งไม่มี song_id ตรงๆ ต้องขยายเป็นรายเพลงจาก song_ids ที่ snapshot ไว้ตอนสั่งซื้อก่อน
  const downloadRowsOf = async (songId, fallbackTitle) => {
    try {
      const snap = await getDoc(doc(db, "songs", songId));
      const song = snap.exists() ? snap.data() : null;
      if (!song || !song.full_file_url) {
        return `<div class="receipt-line"><div><strong>${escapeHtml(fallbackTitle || song?.song_name || "เพลง")}</strong><small>ยังไม่ได้อัปโหลดไฟล์เต็ม WAV</small></div></div>`;
      }
      return `
        <div class="receipt-line">
          <div><strong>${escapeHtml(fallbackTitle || song.song_name || "เพลง")}</strong><small>${escapeHtml(song.full_file_name || "full.wav")}</small></div>
          <a class="btn secondary" style="padding:8px 14px;font-size:13px;" href="${toCloudinaryDownloadUrl(song.full_file_url)}" target="_blank" rel="noopener">ดาวน์โหลด</a>
        </div>`;
    } catch (err) {
      return `<div class="receipt-line"><div><strong>${escapeHtml(fallbackTitle || "เพลง")}</strong><small>โหลดข้อมูลไม่สำเร็จ</small></div></div>`;
    }
  };

  const rowGroups = await Promise.all(items.map(async (item) => {
    if (item?.kind === "playlist") {
      let songIds = Array.isArray(item.song_ids) ? item.song_ids : [];
      // เผื่อ Order เก่า/กรณีไม่มี song_ids snapshot ไว้ ให้ query จาก playlist_id แทน
      if (songIds.length === 0 && item.playlist_id) {
        try {
          const songsSnap = await getDocs(query(collection(db, "songs"), where("playlist_id", "==", item.playlist_id)));
          songIds = songsSnap.docs.map((d) => d.id);
        } catch (_) { /* ปล่อยผ่าน แสดง header ของเพลย์ลิสต์อย่างเดียวถ้า query ไม่สำเร็จ */ }
      }
      const header = `<div class="receipt-line" style="opacity:.75;"><div><small>🎶 เพลย์ลิสต์: ${escapeHtml(item.title || "เพลย์ลิสต์")}</small></div></div>`;
      const songRows = await Promise.all(songIds.map((songId) => downloadRowsOf(songId, null)));
      return header + songRows.join("");
    }
    return downloadRowsOf(item.song_id, item.title);
  }));
  const rows = rowGroups;

  const zipRow = order.zip_download_url
    ? `<div class="receipt-line" style="background:rgba(41,204,113,.08);border:1px solid rgba(41,204,113,.25);border-radius:10px;padding:12px;margin-bottom:10px;">
        <div><strong>📦 ZIP รวมเพลงทั้งออเดอร์</strong><small>${escapeHtml(order.zip_file_name || `Order-${order.id}.zip`)} · ${Number(order.zip_song_count || items.length)} เพลง</small></div>
        <a class="btn" style="padding:8px 14px;font-size:13px;" href="${escapeHtml(toCloudinaryDownloadUrl(order.zip_download_url))}" target="_blank" rel="noopener">ดาวน์โหลด ZIP</a>
      </div>`
    : order.zip_status === "failed"
      ? `<div class="receipt-line" style="color:var(--danger);"><div><strong>⚠️ ยังสร้าง ZIP ไม่สำเร็จ</strong><small>${escapeHtml(order.zip_error || "ไม่ทราบสาเหตุ")}</small></div></div>`
      : "";
  content.innerHTML = zipRow + (rows.join("") || `<div class="empty-state">ไม่มีรายการเพลงในออเดอร์นี้</div>`);
}

function closeFullFilesModal() {
  const backdrop = document.getElementById("fullFilesBackdrop");
  backdrop.classList.remove("open");
  backdrop.style.display = "none";
}

/* ---------------- เปลี่ยนสถานะออเดอร์ ---------------- */
async function handleStatusChange(orderId, newStatus) {
  const order = state.allOrders.find((item) => item.id === orderId);
  // "ยืนยันโอนแล้ว" จะยังไม่เปลี่ยนเป็น processing จนกว่า ZIP และลิงก์จะพร้อม
  if (newStatus === "processing" && order?.status !== "processing") {
    await confirmPaymentAndCreateZip(orderId);
    return;
  }
  try {
    await updateDoc(doc(db, "orders", orderId), { status: newStatus, updated_at: new Date().toISOString() });
    await refreshDashboardAndHistory();
  } catch (err) {
    alert("เปลี่ยนสถานะไม่สำเร็จ: " + err.message);
  }
}

async function confirmPaymentAndCreateZip(orderId) {
  const result = await createOrderZip(orderId);
  if (!result.ok) {
    await refreshDashboardAndHistory();
    orderToast(`ยืนยันโอนไม่สำเร็จ: ${result.error} — ออเดอร์ยังคงรอตรวจสอบ และสามารถกดสร้าง ZIP ใหม่ได้`, "error");
    return;
  }

  try {
    await updateDoc(doc(db, "orders", orderId), {
      status: "processing",
      payment_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await refreshDashboardAndHistory();
    orderToast("ยืนยันการโอนแล้ว และสร้าง Download Link สำหรับ Admin เรียบร้อย", "success");
  } catch (err) {
    // ZIP ยังอยู่บน Cloud แต่จะไม่แสดงเป็นออเดอร์ที่ชำระแล้วจนกว่าจะอัปเดตสถานะสำเร็จ
    await refreshDashboardAndHistory();
    orderToast("สร้าง ZIP สำเร็จ แต่เปลี่ยนสถานะออเดอร์ไม่สำเร็จ: " + err.message, "error");
  }
}

async function retryOrderZip(orderId) {
  const order = state.allOrders.find((item) => item.id === orderId);
  if (!order || zipJobs.has(orderId)) return;
  const result = await createOrderZip(orderId);
  if (!result.ok) {
    await refreshDashboardAndHistory();
    orderToast("สร้าง ZIP ใหม่ไม่สำเร็จ: " + result.error, "error");
    return;
  }

  // กรณี retry จากขั้นตอนยืนยันโอนที่ค้างอยู่ ให้เดินหน้าส่งสถานะ processing ต่ออัตโนมัติ
  if (order.status === "pending_verify") {
    await confirmPaymentAndCreateZip(orderId);
  } else {
    await refreshDashboardAndHistory();
    orderToast("สร้าง ZIP ใหม่และ Download Link เรียบร้อย", "success");
  }
}

/* =====================================================================
   ยืนยันก่อนลบ — ใช้ modal ที่มีอยู่แล้วในหน้า (confirmBackdrop) ทั้งเว็บ
   คืนค่าเป็น Promise<boolean> ว่าผู้ใช้กด "ลบ" หรือ "ยกเลิก"
   ===================================================================== */
function askConfirm(message) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById("confirmBackdrop");
    const textEl = document.getElementById("confirmText");
    const okBtn = document.getElementById("confirmOk");
    const cancelBtn = document.getElementById("confirmCancel");

    textEl.textContent = message;
    backdrop.classList.add("open");
    backdrop.style.display = "flex";

    function cleanup(result) {
      backdrop.classList.remove("open");
      backdrop.style.display = "none";
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

/* ---------------- ลบออเดอร์ ---------------- */
async function handleDeleteOrder(orderId) {
  if (!isMainAdmin()) {
    if (window.__showToast) window.__showToast("เฉพาะแอดมินหลักเท่านั้นที่ลบประวัติออเดอร์ได้", "error");
    else alert("เฉพาะแอดมินหลักเท่านั้นที่ลบประวัติออเดอร์ได้");
    return;
  }
  const order = state.allOrders.find((o) => o.id === orderId);
  const label = order ? `ออเดอร์ของ ${order.customer_name} (${formatLAK(order.total)})` : "ออเดอร์นี้";
  const ok = await askConfirm(`ต้องการลบ${label}ใช่หรือไม่? การลบไม่สามารถย้อนกลับได้`);
  if (!ok) return;

  try {
    await deleteDoc(doc(db, "orders", orderId));
    await refreshDashboardAndHistory();
  } catch (err) {
    alert("ลบออเดอร์ไม่สำเร็จ: " + err.message);
  }
}

/* =====================================================================
   แก้ไขออเดอร์ (modal)
   ===================================================================== */
function renderEditSearchResults() {
  const container = document.getElementById("eOrderSearchResults");
  if (!container) return;
  container.innerHTML = "";
  if (state.editSearchResults.length === 0) return;

  state.editSearchResults.forEach((song) => {
    const alreadyAdded = state.editCartItems.some((i) => i.songId === song.id);
    const row = document.createElement("div");
    row.className = "list-row";
    row.innerHTML = `
      <img src="${song.cover_url || ""}">
      <div class="info">
        <div class="n1">${escapeHtml(song.song_name)}</div>
        <div class="n2">${escapeHtml(song.dj_name || song.artist || "-")} · ${formatLAK(song.price)}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-eadd="${song.id}" ${alreadyAdded ? "disabled" : ""} style="${alreadyAdded ? "opacity:.4;" : "background:var(--accent);color:#fff;"}">
          ${alreadyAdded ? "✓" : "＋"}
        </button>
      </div>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll("[data-eadd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      addToEditCart(btn.getAttribute("data-eadd"));
    });
  });
}

function renderEditCart() {
  const container = document.getElementById("eOrderCartItems");
  const totalEl = document.getElementById("eOrderCartTotal");
  const hintEl = document.getElementById("eOrderTotalHint");
  if (!container || !totalEl) return;
  container.innerHTML = "";

  if (state.editOrderType === "playlist" && state.editSelectedPlaylist) {
    const badge = document.createElement("div");
    badge.style.cssText = "font-size:12px;font-weight:700;color:var(--accent);margin-bottom:6px;";
    badge.textContent = `🎶 ยกเพลย์ลิสต์: ${getPlaylistName(state.editSelectedPlaylist)} (${state.editCartItems.length} เพลง)`;
    container.appendChild(badge);
  }

  if (state.editCartItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.style.padding = "10px 0";
    empty.textContent = state.editOrderType === "playlist" ? "ยังไม่ได้เลือกเพลย์ลิสต์" : "ยังไม่ได้เลือกเพลง";
    container.appendChild(empty);
  } else {
    state.editCartItems.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "list-row";
      const removeBtn = state.editOrderType === "playlist"
        ? ""
        : `<div class="row-actions"><button class="icon-btn danger" data-eremove="${index}">🗑</button></div>`;
      row.innerHTML = `
        <div class="info"><div class="n1">${escapeHtml(item.title)}</div><div class="n2">${formatLAK(item.price)}</div></div>
        ${removeBtn}
      `;
      container.appendChild(row);
    });
    container.querySelectorAll("[data-eremove]").forEach((btn) => {
      btn.addEventListener("click", () => removeFromEditCart(Number(btn.getAttribute("data-eremove"))));
    });
  }

  const computedTotal = calculateOrderTotal(
    state.editOrderType,
    state.editCartItems,
    state.editSelectedPlaylist
  );
  totalEl.value = computedTotal;
  if (hintEl) {
    hintEl.textContent = `คำนวณอัตโนมัติ: ${
      state.editOrderType === "playlist" ? "ราคาเหมาเพลย์ลิสต์" : "รวมราคาเพลงที่เลือก"
    }`;
  }
}

function addToEditCart(songId) {
  const song = state.songs.find((s) => s.id === songId);
  if (!song) return;
  if (state.editCartItems.some((i) => i.songId === song.id)) return;
  state.editCartItems.push({ songId: song.id, title: song.song_name, price: Number(song.price || 0) });
  state.editCartTotalEdited = false; // เพลงในตะกร้าเปลี่ยน ให้กลับไปคำนวณยอดรวมอัตโนมัติอีกครั้ง
  renderEditCart();
  renderEditSearchResults();
}

function removeFromEditCart(index) {
  state.editCartItems.splice(index, 1);
  state.editCartTotalEdited = false; // เพลงในตะกร้าเปลี่ยน ให้กลับไปคำนวณยอดรวมอัตโนมัติอีกครั้ง
  renderEditCart();
  renderEditSearchResults();
}

function handleEditSearchInput(e) {
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    state.editSearchResults = [];
  } else {
    state.editSearchResults = state.songs.filter((s) =>
      [s.song_name, s.artist, s.dj_name].join(" ").toLowerCase().includes(q)
    );
  }
  renderEditSearchResults();
}

/* ---------------- Render: ผลค้นหาเพลย์ลิสต์ (modal แก้ไขออเดอร์) ---------------- */
function renderEditPlaylistSearchResults() {
  const container = document.getElementById("eOrdPlaylistResults");
  if (!container) return;
  container.innerHTML = "";
  if (state.editSelectedPlaylist) return;
  if (state.editPlaylistSearchResults.length === 0) return;

  state.editPlaylistSearchResults.forEach((pl) => {
    const songCount = getSongsInPlaylist(pl.id).length;
    const card = document.createElement("div");
    card.className = "playlist-result-card";
    card.innerHTML = `
      <img src="${pl.cover_url || ""}">
      <div class="info" style="flex:1;">
        <div class="n1">${escapeHtml(getPlaylistName(pl))}</div>
        <div class="n2">${songCount} เพลง · ราคาเหมา ${formatLAK(pl.price)}</div>
      </div>
    `;
    card.addEventListener("click", () => selectEditPlaylist(pl.id));
    container.appendChild(card);
  });
}

function renderEditPlaylistSelected() {
  const container = document.getElementById("eOrdPlaylistSelected");
  if (!container) return;
  container.innerHTML = "";
  if (!state.editSelectedPlaylist) return;

  const pl = state.editSelectedPlaylist;
  const card = document.createElement("div");
  card.className = "playlist-selected-card";
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div style="font-weight:800;">🎶 ${escapeHtml(getPlaylistName(pl))}</div>
      <button class="icon-btn" id="eOrdPlaylistClearBtn">✕</button>
    </div>
    <div style="font-size:12px;color:var(--text-dim);">${state.editCartItems.length} เพลง · ราคาเหมา ${formatLAK(pl.price)}</div>
  `;
  container.appendChild(card);
  document.getElementById("eOrdPlaylistClearBtn").addEventListener("click", clearEditSelectedPlaylist);
}

function selectEditPlaylist(playlistId) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (!pl) return;

  const songs = getSongsInPlaylist(pl.id);
  state.editSelectedPlaylist = pl;
  state.editCartItems = songs.map((s) => ({ songId: s.id, title: s.song_name, price: Number(s.price || 0) }));
  state.editCartTotalEdited = false;
  document.getElementById("eOrdPlaylistSearch").value = "";
  state.editPlaylistSearchResults = [];

  renderEditPlaylistSelected();
  renderEditPlaylistSearchResults();
  renderEditCart();
}

function clearEditSelectedPlaylist() {
  state.editSelectedPlaylist = null;
  state.editCartItems = [];
  state.editCartTotalEdited = false;
  renderEditPlaylistSelected();
  renderEditPlaylistSearchResults();
  renderEditCart();
}

function handleEditPlaylistSearchInput(e) {
  const q = e.target.value.trim().toLowerCase();
  state.editPlaylistSearchResults = !q ? [] : state.playlists.filter((p) => getPlaylistName(p).toLowerCase().includes(q));
  renderEditPlaylistSearchResults();
}

/* ---------------- สลับประเภทออเดอร์ในโหมดแก้ไข (ไม่ล้างข้อมูลอัตโนมัติ ยกเว้นผู้ใช้กดสลับเอง) ---------------- */
function switchEditOrderType(type) {
  if (state.editOrderType === type) return;
  state.editOrderType = type;

  document.querySelectorAll('#eOrdTypeToggle [data-edit-order-type]').forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-edit-order-type") === type);
  });
  document.getElementById("eOrdSingleSection").style.display = type === "single" ? "" : "none";
  document.getElementById("eOrdPlaylistSection").style.display = type === "playlist" ? "" : "none";

  state.editCartItems = [];
  state.editCartTotalEdited = false;
  state.editSelectedPlaylist = null;
  state.editSearchResults = [];
  state.editPlaylistSearchResults = [];
  document.getElementById("eOrderSongSearch").value = "";
  document.getElementById("eOrdPlaylistSearch").value = "";

  renderEditSearchResults();
  renderEditPlaylistSelected();
  renderEditPlaylistSearchResults();
  renderEditCart();
}

/* เปิด modal แก้ไข พร้อมกรอกข้อมูลออเดอร์เดิมลงในฟอร์ม */
function openEditOrderModal(orderId) {
  const order = state.allOrders.find((o) => o.id === orderId);
  if (!order) return;

  // ออเดอร์แบบผสม (เพลง+เพลย์ลิสต์ หรือหลายเพลย์ลิสต์ที่ลูกค้าสั่งจากตะกร้า) ยังไม่รองรับฟอร์มแก้ไขรายการเดิมนี้
  // (ฟอร์มเดิมออกแบบไว้สำหรับ 2 กรณี: เพลงเดี่ยวล้วน หรือเพลย์ลิสต์เดียวล้วน) เพื่อไม่ให้บันทึกทับแล้วข้อมูล
  // เพลย์ลิสต์ที่ผสมอยู่ในออเดอร์นี้หายไป — เปลี่ยนสถานะออเดอร์ผ่าน dropdown ในหน้าประวัติออเดอร์ได้ตามปกติ
  if (order.order_type === "mixed") {
    orderToast("ออเดอร์นี้มีทั้งเพลงและเพลย์ลิสต์รวมกัน ระบบแก้ไขรายการแบบเดิมยังไม่รองรับ กรุณาเปลี่ยนสถานะผ่านตัวเลือกสถานะแทน", "error");
    return;
  }

  state.editingOrderId = orderId;
  state.editCartItems = (order.items || []).map((i) => ({
    songId: i.song_id, title: i.title, price: Number(i.price || 0),
  }));
  state.editSearchResults = [];
  state.editPlaylistSearchResults = [];

  // ตั้งค่าประเภทออเดอร์และเพลย์ลิสต์ที่เลือกไว้ (ถ้าออเดอร์นี้ถูกสร้างแบบยกเพลย์ลิสต์)
  const orderType = order.order_type === "playlist" ? "playlist" : "single";
  state.editOrderType = orderType;
  state.editSelectedPlaylist = orderType === "playlist" && order.playlist_id
    ? (state.playlists.find((p) => p.id === order.playlist_id) || { id: order.playlist_id, playlist_name: order.playlist_name || "เพลย์ลิสต์", price: order.total })
    : null;

  document.querySelectorAll('#eOrdTypeToggle [data-edit-order-type]').forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-edit-order-type") === orderType);
  });
  document.getElementById("eOrdSingleSection").style.display = orderType === "single" ? "" : "none";
  document.getElementById("eOrdPlaylistSection").style.display = orderType === "playlist" ? "" : "none";

  document.getElementById("eOrderCustomerName").value = order.customer_name || "";
  document.getElementById("eOrderCustomerWhatsapp").value = order.whatsapp || "";
  document.getElementById("eOrderSongSearch").value = "";
  document.getElementById("eOrdPlaylistSearch").value = "";
  document.getElementById("eOrderFeedback").textContent = "";

  // ทุกครั้งที่แก้ไข ให้ยอดรวมกลับมาคำนวณจากข้อมูลสินค้าจริง
  state.editCartTotalEdited = false;

  renderEditCart();
  renderEditSearchResults();
  renderEditPlaylistSelected();
  renderEditPlaylistSearchResults();
  const backdrop = document.getElementById("orderFormBackdrop");
  backdrop.classList.add("open");
  backdrop.style.display = "flex";
}

function closeEditOrderModal() {
  const backdrop = document.getElementById("orderFormBackdrop");
  backdrop.classList.remove("open");
  backdrop.style.display = "none";
  state.editingOrderId = null;
  state.editCartItems = [];
  state.editSearchResults = [];
  state.editCartTotalEdited = false;
  state.editOrderType = "single";
  state.editSelectedPlaylist = null;
  state.editPlaylistSearchResults = [];
}

/* บันทึกการแก้ไขออเดอร์ลง Firestore จริง */
async function handleUpdateOrder() {
  const orderId = state.editingOrderId;
  if (!orderId) return;

  const nameInput = document.getElementById("eOrderCustomerName");
  const whatsappInput = document.getElementById("eOrderCustomerWhatsapp");
  const feedback = document.getElementById("eOrderFeedback");
  const btn = document.getElementById("eOrderSaveBtn");

  const customerName = nameInput.value.trim();
  const whatsapp = whatsappInput.value.trim();
  const total = calculateOrderTotal(
    state.editOrderType,
    state.editCartItems,
    state.editSelectedPlaylist
  );
  const existingOrder = state.allOrders.find((o) => o.id === orderId);

  feedback.style.color = "var(--danger)";
  feedback.textContent = "";

  if (!customerName || !whatsapp) {
    feedback.textContent = "กรุณากรอกชื่อลูกค้าและเบอร์ WhatsApp";
    return;
  }
  if (state.editOrderType === "playlist" && !state.editSelectedPlaylist) {
    feedback.textContent = "กรุณาเลือกเพลย์ลิสต์ที่ต้องการขาย";
    return;
  }
  if (state.editCartItems.length === 0) {
    feedback.textContent = "กรุณาเลือกเพลงอย่างน้อย 1 เพลง";
    return;
  }
  if (!Number.isFinite(total) || total < 0) {
    feedback.textContent = "กรุณากรอกยอดรวมให้ถูกต้อง";
    return;
  }

  btn.disabled = true;
  btn.textContent = "กำลังบันทึก...";

  const updatedData = {
    customer_name: customerName,
    whatsapp: whatsapp,
    items: state.editCartItems.map((i) => ({ song_id: i.songId, title: i.title, price: i.price })),
    total,
    order_type: state.editOrderType, // "single" | "playlist"
    playlist_id: state.editOrderType === "playlist" && state.editSelectedPlaylist ? state.editSelectedPlaylist.id : null,
    playlist_name: state.editOrderType === "playlist" && state.editSelectedPlaylist ? getPlaylistName(state.editSelectedPlaylist) : null,
    store_name: existingOrder?.store_name || state.storeName,
    receipt_number: existingOrder?.receipt_number || getReceiptNumber(orderId, existingOrder?.created_at),
    updated_at: new Date().toISOString(),
  };

  try {
    await updateDoc(doc(db, "orders", orderId), updatedData);
    closeEditOrderModal();
    await refreshDashboardAndHistory();
    openReceipt(orderId);
  } catch (err) {
    feedback.textContent = "บันทึกไม่สำเร็จ: " + err.message;
  }

  btn.disabled = false;
  btn.textContent = "บันทึกการแก้ไข";
}

/* ---------------- Event handlers (ฟอร์มสร้างออเดอร์ใหม่) ---------------- */
function handleSearchInput(e) {
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    state.searchResults = [];
  } else {
    state.searchResults = state.songs.filter((s) =>
      [s.song_name, s.artist, s.dj_name].join(" ").toLowerCase().includes(q)
    );
  }
  renderSearchResults();
}

function addToCart(songId) {
  const song = state.songs.find((s) => s.id === songId);
  if (!song) return;
  if (state.cartItems.some((i) => i.songId === song.id)) return;
  state.cartItems.push({ songId: song.id, title: song.song_name, price: Number(song.price || 0) });
  state.cartTotalEdited = false; // เพลงในตะกร้าเปลี่ยน ให้กลับไปคำนวณยอดรวมอัตโนมัติอีกครั้ง
  renderCart();
  renderSearchResults();
}

function removeFromCart(index) {
  state.cartItems.splice(index, 1);
  state.cartTotalEdited = false; // เพลงในตะกร้าเปลี่ยน ให้กลับไปคำนวณยอดรวมอัตโนมัติอีกครั้ง
  renderCart();
  renderSearchResults();
}

async function refreshDashboardAndHistory() {
  const orders = await loadOrdersFromDatabase();
  state.allOrders = orders;
  renderStats(orders);
  renderFilterPills();
  renderHistory();
}

async function handleSubmitOrder() {
  const nameInput = document.getElementById("ordCustomerName");
  const whatsappInput = document.getElementById("ordCustomerWhatsapp");
  const feedback = document.getElementById("ordFormFeedback");
  const btn = document.getElementById("ordSubmitBtn");

  const customerName = nameInput.value.trim();
  const whatsapp = whatsappInput.value.trim();
  const total = calculateOrderTotal(
    state.orderType,
    state.cartItems,
    state.selectedPlaylist
  );

  feedback.textContent = "";
  feedback.style.color = "var(--danger)";

  if (!customerName || !whatsapp) {
    feedback.textContent = "กรุณากรอกชื่อลูกค้าและเบอร์ WhatsApp";
    return;
  }
  if (state.orderType === "playlist" && !state.selectedPlaylist) {
    feedback.textContent = "กรุณาเลือกเพลย์ลิสต์ที่ต้องการขาย";
    return;
  }
  if (state.cartItems.length === 0) {
    feedback.textContent = "กรุณาเลือกเพลงอย่างน้อย 1 เพลง";
    return;
  }
  if (!Number.isFinite(total) || total < 0) {
    feedback.textContent = "กรุณากรอกยอดรวมให้ถูกต้อง";
    return;
  }

  btn.disabled = true;
  btn.textContent = "กำลังบันทึก...";

  const order = {
    customer_name: customerName,
    whatsapp: whatsapp,
    items: state.cartItems.map((i) => ({ song_id: i.songId, title: i.title, price: i.price })),
    total,
    order_type: state.orderType, // "single" | "playlist" — ใช้แยกสถิติใน Dashboard
    playlist_id: state.orderType === "playlist" && state.selectedPlaylist ? state.selectedPlaylist.id : null,
    playlist_name: state.orderType === "playlist" && state.selectedPlaylist ? getPlaylistName(state.selectedPlaylist) : null,
    store_name: state.storeName,
    status: "pending_verify",
    created_at: new Date().toISOString(),
  };

  try {
    const orderRef = doc(collection(db, "orders"));
    order.receipt_number = getReceiptNumber(orderRef.id, order.created_at);
    await setDoc(orderRef, order);

    nameInput.value = "";
    whatsappInput.value = "";
    document.getElementById("ordSongSearch").value = "";
    document.getElementById("ordPlaylistSearch").value = "";
    state.cartItems = [];
    state.searchResults = [];
    state.cartTotalEdited = false;
    state.selectedPlaylist = null;
    state.playlistSearchResults = [];
    renderCart();
    renderSearchResults();
    renderPlaylistSelected();
    renderPlaylistSearchResults();

    feedback.style.color = "var(--success)";
    feedback.textContent = `บันทึกออเดอร์ของ ${customerName} เรียบร้อยแล้ว ✓`;

    await refreshDashboardAndHistory();
    openReceipt(orderRef.id);
  } catch (err) {
    feedback.textContent = "บันทึกไม่สำเร็จ: " + err.message;
  }

  btn.disabled = false;
  btn.textContent = "บันทึกออเดอร์";
}

/* ---------------- Init (เรียกทุกครั้งที่เปิดหน้า "จัดการออเดอร์") ---------------- */
export async function initOrdersView() {
  const loadingEl = document.getElementById("ordSongsLoading");
  ensureReceiptElements();
  ensureFullFilesElements();
  loadingEl.style.display = "block";
  loadingEl.textContent = "กำลังโหลดรายชื่อเพลง...";

  try {
    // โหลดทั้งเพลงและเพลย์ลิสต์ (ราคาเหมา) พร้อมกัน เพื่อให้ระบบขายยกเพลย์ลิสต์ใช้งานได้ทันที
    const [songs, playlists, storeName] = await Promise.all([
      loadSongsFromDatabase(),
      loadPlaylistsFromDatabase(),
      loadStoreName(),
    ]);
    state.songs = songs;
    state.playlists = playlists;
    state.storeName = storeName;
    loadingEl.style.display = "none";
  } catch (err) {
    loadingEl.textContent = "โหลดข้อมูลไม่สำเร็จ: " + err.message;
    return;
  }

  if (!state.listenersBound) {
    document.getElementById("ordSongSearch").addEventListener("input", debounce(handleSearchInput, 200));
    document.getElementById("ordSubmitBtn").addEventListener("click", handleSubmitOrder);

    // ปุ่มสลับประเภทออเดอร์: เพลงเดี่ยว / ยกเพลย์ลิสต์ (ฟอร์มสร้างออเดอร์ใหม่)
    document.querySelectorAll('#ordTypeToggle [data-order-type]').forEach((btn) => {
      btn.addEventListener("click", () => switchOrderType(btn.getAttribute("data-order-type")));
    });
    document.getElementById("ordPlaylistSearch").addEventListener("input", debounce(handlePlaylistSearchInput, 200));

    // ปุ่ม/ช่องค้นหาของ modal แก้ไขออเดอร์
    document.getElementById("eOrderSongSearch").addEventListener("input", debounce(handleEditSearchInput, 200));
    document.getElementById("eOrderSaveBtn").addEventListener("click", handleUpdateOrder);
    document.getElementById("orderFormClose").addEventListener("click", closeEditOrderModal);
    document.getElementById("orderFormBackdrop").addEventListener("click", (e) => {
      if (e.target.id === "orderFormBackdrop") closeEditOrderModal();
    });

    // ปุ่มสลับประเภทออเดอร์ในโมดัลแก้ไข
    document.querySelectorAll('#eOrdTypeToggle [data-edit-order-type]').forEach((btn) => {
      btn.addEventListener("click", () => switchEditOrderType(btn.getAttribute("data-edit-order-type")));
    });
    document.getElementById("eOrdPlaylistSearch").addEventListener("input", debounce(handleEditPlaylistSearchInput, 200));

    document.getElementById("receiptClose").addEventListener("click", closeReceipt);
    // ปุ่มคัดลอกถูกผูกกับ Order ที่เปิดอยู่ใน openReceipt()
    document.getElementById("receiptPrintBtn").addEventListener("click", () => window.print());
    document.getElementById("receiptBackdrop").addEventListener("click", (e) => {
      if (e.target.id === "receiptBackdrop") closeReceipt();
    });

    document.getElementById("fullFilesClose").addEventListener("click", closeFullFilesModal);
    document.getElementById("fullFilesBackdrop").addEventListener("click", (e) => {
      if (e.target.id === "fullFilesBackdrop") closeFullFilesModal();
    });

    state.listenersBound = true;
  }

  // รีเซ็ตฟอร์มสร้างออเดอร์ใหม่ทุกครั้งที่เปิดหน้านี้ กลับไปเริ่มที่โหมด "เพลงเดี่ยว" เสมอ
  state.cartItems = [];
  state.searchResults = [];
  state.cartTotalEdited = false;
  state.orderType = "single";
  state.selectedPlaylist = null;
  state.playlistSearchResults = [];
  document.querySelectorAll('#ordTypeToggle [data-order-type]').forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-order-type") === "single");
  });
  document.getElementById("ordSingleSection").style.display = "";
  document.getElementById("ordPlaylistSection").style.display = "none";
  document.getElementById("ordSongSearch").value = "";
  document.getElementById("ordPlaylistSearch").value = "";
  document.getElementById("ordFormFeedback").textContent = "";
  renderCart();
  renderSearchResults();
  renderPlaylistSelected();
  renderPlaylistSearchResults();

  await refreshDashboardAndHistory();
}
