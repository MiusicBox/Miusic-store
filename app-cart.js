// app-cart.js — ระบบตะกร้าสินค้า
// ===================================================
import { db } from "./firebase-init.js?v=20260905-fix1";
import {
  collection, doc, query, where, getDoc, getDocs, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CART_STORAGE_KEY = "music_store_cart_v1";
const CHECKOUT_ORDER_KEY = "music_store_checkout_order_v1";

export function initCart({ state, showToast, escapeHtml, formatPrice, buildWhatsAppLink }) {
  let submitting = false;
  let activeOrderId = null;
  let activeOrderKey = null;

  function loadCart() {
    try {
      const raw = localStorage.getItem(CART_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) throw new Error("cart is not an array");
      const uniqueItems = new Map();
      parsed
        .filter(item => item && item.id && item.song_name)
        .forEach(item => {
          const id = String(item.id);
          if (!uniqueItems.has(id)) {
            const kind = item.kind === "playlist" ? "playlist" : "song";
            const entry = {
              id,
              song_name: String(item.song_name),
              cover_url: String(item.cover_url || ""),
              dj_name: String(item.dj_name || ""),
              price: Math.max(0, Number(item.price) || 0),
              kind,
              quantity: 1
            };
            // เก็บ snapshot เพลงภายในเพลย์ลิสต์ไว้ต่อ (ใช้แสดงผล/ตรวจเพลงซ้ำ ไม่ใช่คิดราคา)
            if (kind === "playlist") {
              entry.song_ids = Array.isArray(item.song_ids) ? item.song_ids.map(String) : [];
              entry.songs = Array.isArray(item.songs)
                ? item.songs
                    .filter(s => s && s.id)
                    .map(s => ({ id: String(s.id), song_name: String(s.song_name || "เพลง") }))
                : [];
            }
            uniqueItems.set(id, entry);
          }
        });
      state.cart = Array.from(uniqueItems.values());
    } catch (_) {
      state.cart = [];
      try { localStorage.removeItem(CART_STORAGE_KEY); } catch (__) {}
    }
    renderCart();
  }

  function saveCart() {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(state.cart));
    } catch (_) {
      showToast("บันทึกตะกร้าไม่ได้ กรุณาตรวจสอบพื้นที่จัดเก็บของเบราว์เซอร์", "error");
    }
    renderCart();
  }

  function cartQuantity() {
    return state.cart.reduce((total, item) => total + item.quantity, 0);
  }

  function cartTotal() {
    return state.cart.reduce((total, item) => total + item.price * item.quantity, 0);
  }

  // รวม track id (song id) ทุกรายการที่ "มีอยู่แล้ว" ในตะกร้า ไม่ว่าจะเป็นเพลงเดี่ยว
  // หรือเพลงที่ซ่อนอยู่ภายในเพลย์ลิสต์ที่เพิ่มไปแล้ว — ใช้ตรวจเพลงซ้ำข้ามกันทั้งสองแบบ
  function collectCartSongIds() {
    const ids = new Set();
    state.cart.forEach(item => {
      if (item.kind === "playlist") {
        (item.song_ids || []).forEach(id => ids.add(String(id)));
      } else {
        ids.add(String(item.id));
      }
    });
    return ids;
  }

  function addToCart(song) {
    if (!song || !song.id) return;
    const kind = song.kind === "playlist" ? "playlist" : "song";
    // หมายเหตุ: เดิมมีข้อจำกัดห้ามผสมเพลงเดี่ยว/เพลย์ลิสต์ และห้ามเพิ่มเพลย์ลิสต์เกิน 1 รายการ
    // ตอนนี้รองรับตะกร้าที่มีเพลงหลายเพลง + เพลย์ลิสต์หลายรายการรวมกันแล้ว (ดู resolveCartFromDatabase/checkoutCart)
    const existing = state.cart.find(item => item.id === String(song.id));
    if (existing) {
      showToast("รายการนี้อยู่ในตะกร้าแล้ว", "error");
      return;
    }

    const existingSongIds = collectCartSongIds();
    if (kind === "song") {
      // เพลงเดี่ยวที่จะเพิ่ม ซ้ำกับเพลงที่อยู่ในเพลย์ลิสต์ที่เพิ่มไปแล้วหรือไม่ (ตรวจด้วย track id เดิม)
      if (existingSongIds.has(String(song.id))) {
        showToast("เพลงนี้อยู่ในเพลย์ลิสต์ที่คุณเพิ่มไว้แล้ว", "error");
        return;
      }
    } else {
      // เพลย์ลิสต์ที่จะเพิ่ม มีเพลงซ้ำกับเพลงเดี่ยว/เพลย์ลิสต์อื่นที่อยู่ในตะกร้าแล้วหรือไม่
      const incomingIds = Array.isArray(song.song_ids) ? song.song_ids.map(String) : [];
      const hasOverlap = incomingIds.some(id => existingSongIds.has(id));
      if (hasOverlap) {
        showToast("มีเพลงในเพลย์ลิสต์นี้อยู่ในตะกร้าแล้ว กรุณาตรวจสอบตะกร้าก่อนเพิ่ม", "error");
        return;
      }
    }

    activeOrderId = null;
    activeOrderKey = null;
    const entry = {
      id: String(song.id),
      song_name: String(song.song_name || ""),
      cover_url: String(song.cover_url || ""),
      dj_name: String(song.dj_name || ""),
      price: Math.max(0, Number(song.price) || 0),
      kind,
      quantity: 1
    };
    if (kind === "playlist") {
      entry.song_ids = Array.isArray(song.song_ids) ? song.song_ids.map(String) : [];
      entry.songs = Array.isArray(song.songs)
        ? song.songs.filter(s => s && s.id).map(s => ({ id: String(s.id), song_name: String(s.song_name || "เพลง") }))
        : [];
    }
    state.cart.push(entry);
    showToast("เพิ่มลงตะกร้าแล้ว", "success");
    saveCart();
  }

  function removeFromCart(itemId) {
    state.cart = state.cart.filter(item => item.id !== itemId);
    saveCart();
  }

  function renderCart() {
    const itemsEl = document.getElementById("cartItems");
    const summaryEl = document.getElementById("cartSummary");
    const badgeEl = document.getElementById("cartBadge");
    if (!itemsEl) return;

    const quantity = cartQuantity();
    if (badgeEl) {
      badgeEl.textContent = quantity > 99 ? "99+" : String(quantity);
      badgeEl.hidden = quantity === 0;
    }

    if (state.cart.length === 0) {
      itemsEl.innerHTML = `
        <div class="cart-empty">
          <p>ยังไม่มีเพลงในตะกร้า</p>
          <button class="btn secondary" type="button" data-cart-continue>กลับไปเลือกซื้อเพลง</button>
        </div>`;
      if (summaryEl) summaryEl.hidden = true;
      return;
    }

    itemsEl.innerHTML = state.cart.map(item => {
      const isPlaylist = item.kind === "playlist";
      const songCount = isPlaylist ? (item.songs || []).length || (item.song_ids || []).length : 0;
      const metaText = isPlaylist
        ? `เพลย์ลิสต์ · ${songCount} เพลง · ${formatPrice(item.price)}`
        : `${escapeHtml(item.dj_name || "เพลง Remix")} · ${formatPrice(item.price)} / เพลง`;
      const viewSongsBtn = (isPlaylist && (item.songs || []).length)
        ? `<button class="cart-item-viewsongs" type="button" data-cart-view-songs="${escapeHtml(item.id)}">ดูรายการเพลงในเพลย์ลิสต์ (${songCount})</button>
           <div class="cart-item-songs" id="cartSongs-${escapeHtml(item.id)}">
             ${item.songs.map(s => `<div class="cart-item-songs-row">🎵 ${escapeHtml(s.song_name)}</div>`).join("")}
           </div>`
        : "";
      return `
      <div class="cart-item" data-cart-item="${escapeHtml(item.id)}">
        <img class="cart-item-cover" src="${escapeHtml(item.cover_url)}" alt="">
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(item.song_name)}</div>
          <div class="cart-item-meta">${metaText}</div>
        </div>
        <div class="cart-item-total">${formatPrice(item.price * item.quantity)}</div>
        <button class="cart-remove" type="button" data-cart-remove="${escapeHtml(item.id)}">ลบ</button>
        ${viewSongsBtn}
      </div>
    `;
    }).join("");

    if (summaryEl) summaryEl.hidden = false;
    const quantityEl = document.getElementById("cartTotalQuantity");
    const priceEl = document.getElementById("cartTotalPrice");
    if (quantityEl) quantityEl.textContent = `${quantity} เพลง`;
    if (priceEl) priceEl.textContent = formatPrice(cartTotal());
  }

  function openCart() {
    const backdrop = document.getElementById("cartBackdrop");
    if (!backdrop) return;
    renderCart();
    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function closeCart() {
    const backdrop = document.getElementById("cartBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("show");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function renderCheckoutSummary() {
    const el = document.getElementById("checkoutSummary");
    if (!el) return;
    el.innerHTML = `
      <div class="cart-summary-row">
        <span style="color:var(--text-dim);">รายการ</span>
        <strong>${cartQuantity()} เพลง</strong>
      </div>
      <div class="cart-summary-row">
        <span style="color:var(--text-dim);">ยอดรวมโดยประมาณ</span>
        <strong style="color:var(--success);">${formatPrice(cartTotal())}</strong>
      </div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:8px;">
        ระบบจะตรวจสอบราคาและรายการล่าสุดจากฐานข้อมูลอีกครั้งก่อนสร้าง Order
      </div>
    `;
  }

  function openCheckout() {
    if (state.cart.length === 0) {
      showToast("ยังไม่มีเพลงในตะกร้า", "error");
      return;
    }
    renderCheckoutSummary();
    const feedback = document.getElementById("checkoutFeedback");
    if (feedback) feedback.textContent = "";
    closeCart();
    const backdrop = document.getElementById("checkoutBackdrop");
    if (backdrop) {
      backdrop.classList.add("show");
      backdrop.setAttribute("aria-hidden", "false");
    }
  }

  function closeCheckout() {
    if (submitting) return;
    const backdrop = document.getElementById("checkoutBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("show");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function setCheckoutFeedback(message, type = "error") {
    const el = document.getElementById("checkoutFeedback");
    if (!el) return;
    el.textContent = message;
    el.style.color = type === "success" ? "var(--success)" : "var(--danger)";
  }

  function getReceiptNumber(orderId, createdAt) {
    const date = new Date(createdAt || Date.now());
    const ymd = Number.isNaN(date.getTime())
      ? "00000000"
      : [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("");
    return `RCPT-${ymd}-${String(orderId || "000000").slice(-6).toUpperCase()}`;
  }

  function hashCheckoutKey(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function getCheckoutKey(customerName, whatsapp) {
    return hashCheckoutKey(JSON.stringify({
      customerName,
      whatsapp,
      items: state.cart.map(item => ({ id: item.id, kind: item.kind }))
    }));
  }

  function getStoredOrderId(checkoutKey) {
    try {
      const stored = JSON.parse(sessionStorage.getItem(CHECKOUT_ORDER_KEY) || "null");
      return stored?.key === checkoutKey && stored.id ? String(stored.id) : null;
    } catch (_) {
      return null;
    }
  }

  function storeOrderId(checkoutKey, orderId) {
    try {
      sessionStorage.setItem(CHECKOUT_ORDER_KEY, JSON.stringify({ key: checkoutKey, id: orderId }));
    } catch (_) {}
  }

  function clearStoredOrderId() {
    try { sessionStorage.removeItem(CHECKOUT_ORDER_KEY); } catch (_) {}
  }

  /*
   * ตรวจสอบรายการในตะกร้า + คำนวณราคาจากฐานข้อมูลจริง (ไม่เชื่อราคาที่ cache ไว้ในตะกร้า)
   *
   * หมายเหตุ (แก้บั๊ก 2026-09-05): เดิมฟังก์ชันนี้อ่านข้อมูลผ่าน Firestore Transaction
   * (transaction.get) เพื่อให้อ่าน+เขียน Order อยู่ในธุรกรรมเดียวกัน แต่พบว่า Firestore Web SDK
   * ในบางเบราว์เซอร์/เครือข่าย (โดยเฉพาะ Safari/iPad) โยน TypeError ภายใน SDK เอง
   * ("undefined is not an object (evaluating 'i.path')") เวลาปิด transaction ที่มีทั้ง
   * document read และ query read ปนกัน — จึงเปลี่ยนมาใช้การอ่านแบบธรรมดา (getDoc/getDocs)
   * แทน แล้วค่อยเขียน Order ด้วย setDoc() อีกที (ไม่ใช้ transaction) ผลลัพธ์/ราคาที่คำนวณ
   * ยังคงเหมือนเดิมทุกประการ เพียงแต่ไม่การันตี atomicity ระดับ Firestore transaction
   * (ซึ่งยอมรับได้ เพราะทุก Order ที่สร้างมีสถานะ "รอตรวจสอบการโอน" ให้แอดมินเช็คมืออยู่แล้ว)
   *
   * รองรับ 3 รูปแบบของตะกร้า:
   *  1) มีแต่เพลงเดี่ยว                      -> order_type "single"   (พฤติกรรมเดิมทุกประการ)
   *  2) มีเพลย์ลิสต์เดียว ไม่มีเพลงเดี่ยวปน     -> order_type "playlist" (พฤติกรรมเดิมทุกประการ)
   *  3) เพลงเดี่ยว+เพลย์ลิสต์ผสมกัน หรือมีเพลย์ลิสต์มากกว่า 1 รายการ -> order_type "mixed" (ใหม่)
   *     กรณีนี้ 1 รายการในตะกร้า = 1 Order Item เสมอ (เพลย์ลิสต์ไม่ถูกขยายเป็นหลายเพลง)
   *     เช่น เพลง 3 เพลง + เพลย์ลิสต์ 2 รายการ -> items.length === 5
   */
  async function resolveCartFromDatabase() {
    const songEntries = state.cart.filter(item => item.kind !== "playlist");
    const playlistEntries = state.cart.filter(item => item.kind === "playlist");

    // ---- ตรวจสอบ/ดึงราคาล่าสุดของเพลงเดี่ยวที่เพิ่มเองในตะกร้า ----
    const singleSongItems = [];
    for (const cartItem of songEntries) {
      const songSnap = await getDoc(doc(db, "songs", String(cartItem.id)));
      if (!songSnap.exists()) throw new Error(`ไม่พบเพลง "${cartItem.song_name}" ในฐานข้อมูล`);
      const song = songSnap.data();
      if (song.status === "hidden") throw new Error(`เพลง "${song.song_name || cartItem.song_name}" ปิดการขายแล้ว`);
      const price = Number(song.price);
      if (!Number.isFinite(price) || price < 0) throw new Error(`ราคาเพลง "${song.song_name || cartItem.song_name}" ไม่ถูกต้อง`);
      singleSongItems.push({
        song_id: songSnap.id,
        title: String(song.song_name || cartItem.song_name || "เพลง"),
        price,
        quantity: 1
      });
    }

    // ---- ตรวจสอบ/ดึงราคาล่าสุดของเพลย์ลิสต์แต่ละรายการในตะกร้า ----
    const playlistResolutions = [];
    for (const cartItem of playlistEntries) {
      const playlistId = String(cartItem.id).replace(/^playlist:/, "");
      const playlistSnap = await getDoc(doc(db, "playlists", playlistId));
      if (!playlistSnap.exists()) throw new Error(`ไม่พบเพลย์ลิสต์ "${cartItem.song_name}" ในฐานข้อมูล`);
      const playlist = { id: playlistSnap.id, ...playlistSnap.data() };
      const playlistPrice = Number(playlist.price);
      if (!Number.isFinite(playlistPrice) || playlistPrice <= 0) {
        throw new Error(`เพลย์ลิสต์ "${playlist.playlist_name || cartItem.song_name}" ยังไม่มีราคาขาย`);
      }

      const songsSnap = await getDocs(query(collection(db, "songs"), where("playlist_id", "==", playlistId)));
      const activeSongs = [];
      songsSnap.docs.forEach(songDoc => {
        const song = songDoc.data();
        if (song.status === "hidden") return;
        activeSongs.push({
          song_id: songDoc.id,
          title: String(song.song_name || "เพลง"),
          price: Number.isFinite(Number(song.price)) ? Number(song.price) : 0
        });
      });
      if (activeSongs.length === 0) {
        throw new Error(`เพลย์ลิสต์ "${playlist.playlist_name || cartItem.song_name}" ยังไม่มีเพลงที่เปิดขาย`);
      }
      playlistResolutions.push({ playlist, songs: activeSongs });
    }

    const settingsSnap = await getDoc(doc(db, "settings", "main"));
    const settings = settingsSnap.exists() ? settingsSnap.data() : {};

    // ===== กรณีเดิม (1): มีเพลย์ลิสต์เดียวล้วนๆ ไม่มีเพลงเดี่ยวปน — คงพฤติกรรมเดิมทุกประการ =====
    if (playlistResolutions.length === 1 && singleSongItems.length === 0) {
      const { playlist, songs } = playlistResolutions[0];
      return {
        items: songs.map(s => ({ song_id: s.song_id, title: s.title, price: s.price, quantity: 1 })),
        total: Number(playlist.price),
        orderType: "playlist",
        playlist,
        playlistIds: [playlist.id],
        settings
      };
    }

    // ===== กรณีเดิม (2): มีแต่เพลงเดี่ยว ไม่มีเพลย์ลิสต์เลย — คงพฤติกรรมเดิมทุกประการ =====
    if (playlistResolutions.length === 0) {
      const total = singleSongItems.reduce((sum, item) => sum + item.price, 0);
      if (!Number.isFinite(total) || total < 0) throw new Error("คำนวณยอดรวมจากฐานข้อมูลไม่สำเร็จ");
      return {
        items: singleSongItems,
        total,
        orderType: "single",
        playlist: null,
        playlistIds: [],
        settings
      };
    }

    // ===== กรณีใหม่ (3): เพลย์ลิสต์หลายรายการ และ/หรือ เพลงเดี่ยวปนกับเพลย์ลิสต์ =====
    const playlistLineItems = playlistResolutions.map(({ playlist, songs }) => ({
      kind: "playlist",
      playlist_id: playlist.id,
      title: String(playlist.playlist_name || playlist.name || "เพลย์ลิสต์"),
      price: Number(playlist.price),
      quantity: 1,
      song_ids: songs.map(s => s.song_id), // เก็บ snapshot ไอดีเพลงในเพลย์ลิสต์ไว้ ใช้อ้างอิงฝั่ง Admin (ไม่กระทบระบบเดิม)
      song_titles: songs.map(s => s.title) // เก็บ snapshot ชื่อเพลงคู่กัน ใช้แสดงในใบเสร็จ/ข้อความ WhatsApp เท่านั้น ไม่ใช้คิดราคา
    }));
    const songLineItems = singleSongItems.map(item => ({ kind: "song", ...item }));
    const items = [...songLineItems, ...playlistLineItems];
    const total = items.reduce((sum, item) => sum + item.price, 0);
    if (!Number.isFinite(total) || total < 0) throw new Error("คำนวณยอดรวมจากฐานข้อมูลไม่สำเร็จ");

    return {
      items,
      total,
      orderType: "mixed",
      playlist: null,
      playlistIds: playlistResolutions.map(r => r.playlist.id),
      settings
    };
  }

  function buildAdminWhatsAppText(order, receiptNumber, storeName) {
    // เพลย์ลิสต์ (ทั้งกรณีสั่งซื้อยกเพลย์ลิสต์ล้วนๆ และกรณีผสมกับเพลงเดี่ยว) แสดงรายชื่อเพลงข้างในไว้ให้
    // ลูกค้าตรวจสอบเท่านั้น — ราคาที่คิดเงินยังคงเป็นราคาเหมาเพลย์ลิสต์ ไม่บวกราคาเพลงย่อยซ้ำ
    const lines = order.order_type === "playlist"
      ? [
          `1. เพลย์ลิสต์: ${order.playlist_name || "ไม่ระบุชื่อ"} — ${formatPrice(order.total)}`,
          ...(order.items || []).map(item => `   • ${item.title}`)
        ]
      : order.items.flatMap((item, index) => {
          if (item.kind === "playlist") {
            const nested = (item.song_titles || []).map(title => `   • ${title}`);
            return [`${index + 1}. 🎶 เพลย์ลิสต์: ${item.title} — ${formatPrice(item.price)}`, ...nested];
          }
          return [`${index + 1}. ${item.title} — ${formatPrice(item.price)}`];
        });
    return [
      `สวัสดีครับ มี Order ใหม่จาก ${storeName || "Music Store"}`,
      "",
      `🧾 Order: ${receiptNumber}`,
      `👤 ลูกค้า: ${order.customer_name}`,
      `📱 WhatsApp ลูกค้า: ${order.whatsapp}`,
      "",
      "🛒 รายการสั่งซื้อ",
      ...lines,
      "",
      `🎵 จำนวนทั้งหมด: ${order.items.length} ${
        order.order_type === "playlist" ? "เพลงในเพลย์ลิสต์"
        : order.order_type === "mixed" ? "รายการ (เพลง/เพลย์ลิสต์)"
        : "เพลง"
      }`,
      `💰 ราคารวม: ${formatPrice(order.total)}`,
      "",
      "สถานะ: รอตรวจสอบการโอน"
    ].join("\n");
  }

  async function checkoutCart() {
    if (submitting) return;
    const nameInput = document.getElementById("checkoutCustomerName");
    const whatsappInput = document.getElementById("checkoutCustomerWhatsapp");
    const customerName = nameInput?.value.trim() || "";
    const whatsapp = whatsappInput?.value.trim() || "";
    if (!customerName || !whatsapp) {
      setCheckoutFeedback("กรุณากรอกชื่อลูกค้าและเบอร์ WhatsApp");
      return;
    }
    if (state.cart.length === 0) {
      setCheckoutFeedback("ยังไม่มีเพลงในตะกร้า");
      return;
    }

    submitting = true;
    const btn = document.getElementById("submitCartOrderBtn");
    if (btn) { btn.disabled = true; btn.textContent = "กำลังตรวจสอบและบันทึก..."; }
    setCheckoutFeedback("กำลังตรวจสอบรายการและราคาจากฐานข้อมูล...", "success");

    const createdAt = new Date().toISOString();
    const checkoutKey = getCheckoutKey(customerName, whatsapp);
    const reusableOrderId = activeOrderKey === checkoutKey
      ? activeOrderId
      : getStoredOrderId(checkoutKey);
    // ใช้ doc() สร้าง reference/ID ไว้ล่วงหน้า เพื่อใช้เป็น orderRef ตอนเขียนจริงด้านล่าง
    const orderRef = reusableOrderId
      ? doc(db, "orders", reusableOrderId)
      : doc(collection(db, "orders"));
    const receiptNumber = getReceiptNumber(orderRef.id, createdAt);

    let order = null;
    let resolvedSettings = {};
    try {
      // ---- อ่านราคา/รายการล่าสุดจากฐานข้อมูลก่อน แล้วค่อยเขียน Order (ไม่ใช้ Firestore Transaction) ----
      // หมายเหตุ (แก้บั๊ก 2026-09-05): เดิมใช้ runTransaction() ครอบขั้นตอนนี้ทั้งหมด แต่พบว่า
      // Firestore Web SDK บางเบราว์เซอร์ (โดยเฉพาะ Safari/iPad) โยน TypeError ภายใน SDK เอง
      // ("undefined is not an object (evaluating 'i.path')") ระหว่างปิด transaction แบบนี้
      // จึงเปลี่ยนมาอ่านแบบธรรมดาก่อน แล้วค่อยเขียนทีเดียวด้วย setDoc() แทน ผลลัพธ์ทางธุรกิจเหมือนเดิม
      // ทุกประการ เพียงไม่การันตี atomicity ระดับ transaction (ยอมรับได้ เพราะทุก Order มีสถานะ
      // "รอตรวจสอบการโอน" ให้แอดมินเช็คมืออยู่แล้ว)
      const resolved = await resolveCartFromDatabase();
      resolvedSettings = resolved.settings || {};

      const builtOrder = {
        customer_name: customerName,
        whatsapp,
        items: resolved.items, // Order Items ทั้งหมดของตะกร้า ณ ขณะสั่งซื้อ
        total: resolved.total,
        order_type: resolved.orderType, // "single" | "playlist" | "mixed"
        playlist_id: resolved.orderType === "playlist" ? (resolved.playlist?.id || null) : null,
        playlist_name: resolved.orderType === "playlist" ? (resolved.playlist?.playlist_name || null) : null,
        store_name: resolved.settings.website_name || "Music Store",
        status: "pending_verify",
        created_at: createdAt,
        receipt_number: receiptNumber
      };
      // playlist_ids เป็นฟิลด์เสริมสำหรับ Order แบบผสม (เพลง+เพลย์ลิสต์ หรือหลายเพลย์ลิสต์) เท่านั้น
      // ระบบเดิม (resolveOrderSongs ใน orders.js) อ่านฟิลด์นี้อยู่แล้วสำหรับสร้าง ZIP ดาวน์โหลด จึงไม่ต้องแก้ไฟล์นั้นเพิ่ม
      if (resolved.orderType === "mixed") {
        builtOrder.playlist_ids = resolved.playlistIds;
      }

      await setDoc(orderRef, builtOrder);
      order = builtOrder;
    } catch (err) {
      console.error("checkoutCart error:", err);
      setCheckoutFeedback("บันทึก Order ไม่สำเร็จ: " + (err?.message || err));
      submitting = false;
      if (btn) { btn.disabled = false; btn.textContent = "ยืนยันสั่งซื้อ"; }
      return;
    }

    // มาถึงจุดนี้แปลว่า Transaction commit สำเร็จแล้ว — ล้างเฉพาะรายการที่สั่งซื้อสำเร็จออกจากตะกร้า
    activeOrderId = orderRef.id;
    activeOrderKey = checkoutKey;
    storeOrderId(checkoutKey, orderRef.id);

    state.cart = [];
    try { localStorage.removeItem(CART_STORAGE_KEY); } catch (_) {}
    activeOrderId = null;
    activeOrderKey = null;
    clearStoredOrderId();
    renderCart();
    if (nameInput) nameInput.value = "";
    if (whatsappInput) whatsappInput.value = "";
    setCheckoutFeedback(`บันทึก Order ${receiptNumber} สำเร็จแล้ว`, "success");

    const number = String(resolvedSettings.whatsapp_number || "").replace(/[^0-9]/g, "");
    if (number) {
      const text = buildAdminWhatsAppText(order, receiptNumber, order.store_name);
      window.open(buildWhatsAppLink(number, text), "_blank", "noopener");
    } else {
      showToast("บันทึก Order แล้ว แต่ร้านยังไม่ได้ตั้งค่าเบอร์ WhatsApp", "error");
    }
    setTimeout(closeCheckout, 900);

    submitting = false;
    if (btn) { btn.disabled = false; btn.textContent = "ยืนยันสั่งซื้อ"; }
  }

  function bindCartEvents() {
    document.getElementById("cartToggleBtn")?.addEventListener("click", openCart);
    document.getElementById("cartCloseBtn")?.addEventListener("click", closeCart);
    document.getElementById("cartBackdrop")?.addEventListener("click", event => {
      if (event.target === event.currentTarget) closeCart();
    });
    document.getElementById("checkoutCloseBtn")?.addEventListener("click", closeCheckout);
    document.getElementById("checkoutBackdrop")?.addEventListener("click", event => {
      if (event.target === event.currentTarget) closeCheckout();
    });
    document.getElementById("cartItems")?.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.matches("[data-cart-continue]")) { closeCart(); return; }
      if (button.dataset.cartViewSongs) {
        const list = document.getElementById(`cartSongs-${button.dataset.cartViewSongs}`);
        if (list) {
          const willOpen = !list.classList.contains("is-open");
          list.classList.toggle("is-open", willOpen);
          button.textContent = button.textContent.replace(/^(ดู|ซ่อน)/, willOpen ? "ซ่อน" : "ดู");
        }
        return;
      }
      if (button.dataset.cartRemove) {
        activeOrderId = null;
        activeOrderKey = null;
        removeFromCart(button.dataset.cartRemove);
      }
    });
    document.getElementById("clearCartBtn")?.addEventListener("click", () => {
      if (state.cart.length && window.confirm("ต้องการล้างเพลงทั้งหมดออกจากตะกร้าหรือไม่?")) {
        state.cart = [];
        activeOrderId = null;
        activeOrderKey = null;
        saveCart();
        showToast("ล้างตะกร้าแล้ว", "success");
      }
    });
    document.getElementById("checkoutCartBtn")?.addEventListener("click", openCheckout);
    document.getElementById("submitCartOrderBtn")?.addEventListener("click", checkoutCart);
  }

  return {
    loadCart,
    bindCartEvents,
    addToCart,
    renderCart,
    openCart,
    closeCart,
    checkoutCart
  };
}
