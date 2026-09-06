// app-user.js — หน้า User: ดึงข้อมูลจาก Firestore, เล่นเพลงจาก Cloudinary โดยตรง
// ===================================================
import { db } from "./firebase-init.js?v=20260905-fix1";
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { initCart } from "./app-cart.js?v=20260905-fix1";

const STATE = {
  songs: [], categories: [], djs: [], playlists: [], settings: {},
  currentCategory: "all", currentDj: null, search: "",
  currentView: "home",
  currentPlayingId: null,   // id ของเพลงที่กำลังเล่น/พักอยู่ในเครื่องเล่น
  currentLoadingId: null,   // id ของเพลงที่กำลังโหลดอยู่
  cart: []
};
const AUDIO = new Audio();
let audioUnlocked = false;

function showToast(message, type) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.className = "toast"; }, 2600);
}

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatPrice(v) { return Number(v || 0).toLocaleString("en-US") + " LAK"; }

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function buildWhatsAppLink(number, text) {
  const clean = String(number || "").replace(/[^0-9]/g, "");
  return "https://wa.me/" + clean + "?text=" + encodeURIComponent(text);
}

function debounce(fn, wait) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; }
const { loadCart, bindCartEvents, addToCart } = initCart({
  state: STATE,
  showToast,
  escapeHtml,
  formatPrice,
  buildWhatsAppLink
});

async function init() {
  loadCart();
  bindCartEvents();
  const [songsSnap, catSnap, djSnap, playlistSnap, settingsSnap] = await Promise.all([
    getDocs(collection(db, "songs")),
    getDocs(collection(db, "categories")),
    getDocs(collection(db, "djs")),
    getDocs(collection(db, "playlists")),
    getDoc(doc(db, "settings", "main"))
  ]);
  STATE.songs = songsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.status !== "hidden");
  STATE.categories = catSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  STATE.djs = djSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  STATE.playlists = playlistSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  STATE.settings = settingsSnap.exists() ? settingsSnap.data() : {};

  const siteNameEl = document.getElementById("siteName");
  if (siteNameEl) siteNameEl.textContent = STATE.settings.website_name || "Music Store";
  document.title = STATE.settings.website_name || "Music Store";

  if (STATE.settings.meta_description) {
    const metaTag = document.querySelector('meta[name="description"]');
    if (metaTag) metaTag.setAttribute("content", STATE.settings.meta_description);
  }
  if (STATE.settings.website_logo) {
    const logo = document.getElementById("siteLogo");
    if (logo) {
      logo.src = STATE.settings.website_logo;
      logo.style.display = "block";
    }
  }
  renderCategoryChips();
  renderDjRow();
  renderPlaylists();
  renderSongGrid();
  setView("home");
  togglePlaylistsVisibility();
}

function renderCategoryChips() {
  const wrap = document.getElementById("categoryChips");
  if (!wrap) return;
  let html = `<div class="chip${STATE.currentCategory === "all" ? " active" : ""}" data-cat="all">ทั้งหมด</div>`;
  STATE.categories.forEach(c => {
    html += `<div class="chip${STATE.currentCategory === c.id ? " active" : ""}" data-cat="${c.id}">${escapeHtml(c.category_name)}</div>`;
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll(".chip").forEach(el => {
    el.addEventListener("click", () => {
      STATE.currentCategory = el.getAttribute("data-cat");
      STATE.currentDj = null;
      // หน้า "ทั้งหมด" แสดงส่วน DJ เหมือนเดิม แต่หน้าหมวดหมู่
      // ต้องซ่อนส่วน DJ เพื่อให้เห็นเฉพาะเพลงของหมวดที่เลือก
      setView(STATE.currentView);
      renderCategoryChips();
      renderSongGrid();
      // เมื่อเลือกหมวดหมู่ ให้แสดงเฉพาะรายการเพลงของหมวดนั้น
      // และซ่อนเพลย์ลิสต์ไว้จนกว่าจะกลับไปที่ "ทั้งหมด"
      renderPlaylists();
      togglePlaylistsVisibility();
    });
  });
}

function renderDjRow() {
  const wrap = document.getElementById("djRow");
  if (!wrap) return;
  wrap.innerHTML = STATE.djs.map(d =>
    `<div class="dj-item" data-dj="${d.id}">
      <img class="dj-avatar" src="${d.image_url || ""}">
      <div class="dj-name">${escapeHtml(d.dj_name)}</div>
    </div>`
  ).join("");
  wrap.querySelectorAll(".dj-item").forEach(el => {
    el.addEventListener("click", () => {
      const selectedDjId = el.getAttribute("data-dj");
      // กด DJ คนเดิมซ้ำอีกครั้งเพื่อยกเลิกตัวกรองและแสดงเพลงของ DJ ทุกคน
      STATE.currentDj = STATE.currentDj === selectedDjId ? null : selectedDjId;
      STATE.currentCategory = "all";
      renderCategoryChips();
      renderSongGrid();
      renderPlaylists();
      togglePlaylistsVisibility();
      const gridTitle = document.getElementById("gridTitle");
      if (gridTitle) gridTitle.scrollIntoView({ behavior: "smooth" });
    });
  });
}

function normalizeCategoryValue(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function getCategoryValues(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(getCategoryValues);

  // รองรับกรณีที่เก็บหมวดหมู่เป็น object หรือ DocumentReference
  if (typeof value === "object") {
    return [
      value.id,
      value.category_id,
      value.categoryId,
      value.category_name,
      value.categoryName,
      value.name
    ].flatMap(getCategoryValues);
  }

  const normalized = normalizeCategoryValue(value);
  return normalized ? [normalized] : [];
}

function songBelongsToCurrentCategory(song) {
  if (STATE.currentCategory === "all") return true;

  const category = STATE.categories.find(c => c.id === STATE.currentCategory);
  const selectedValues = [
    STATE.currentCategory,
    category && category.id,
    category && category.category_name,
    category && category.name
  ].flatMap(getCategoryValues);

  // รองรับทั้งข้อมูลใหม่/เก่าที่บันทึกเป็น id, ชื่อหมวดหมู่,
  // array ของหมวดหมู่ หรือ object ของหมวดหมู่
  const songValues = [
    song.category_id,
    song.categoryId,
    song.category_ids,
    song.categoryIds,
    song.category,
    song.category_name,
    song.categoryName,
    song.categories
  ].flatMap(getCategoryValues);

  return songValues.some(value => selectedValues.includes(value));
}

function getFilteredSongs() {
  return STATE.songs.filter(s => {
    if (STATE.currentDj) {
      const dj = STATE.djs.find(d => d.id === STATE.currentDj);
      if (!dj || s.dj_name !== dj.dj_name) return false;
    }
    if (!songBelongsToCurrentCategory(s)) return false;
    if (STATE.search) {
      const q = STATE.search.toLowerCase();
      // ค้นหาทั้งจากข้อมูลเพลง และค้นหาชื่อเพลย์ลิสต์ที่เพลงนี้สังกัดอยู่ด้วย
      const pl = STATE.playlists.find(p => p.id === s.playlist_id);
      const playlistName = pl ? pl.playlist_name : "";
      
      const hay = [s.song_name, s.artist, s.dj_name, s.category_name, playlistName].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderSongGrid() {
  const list = getFilteredSongs();
  const grid = document.getElementById("songGrid");
  const empty = document.getElementById("emptyState");
  if (!grid) return;
  if (list.length === 0) {
    grid.innerHTML = "";
    if (empty) {
      empty.style.display = "block";
      empty.textContent = STATE.currentCategory !== "all"
        ? "หมวดหมู่นี้ยังไม่มีเพลง"
        : (STATE.search ? `ไม่พบเพลงที่ค้นหา "${STATE.search}"` : "ไม่พบเพลง");
    }
    return;
  }
  if (empty) empty.style.display = "none";
  grid.innerHTML = list.map(s => `
    <div class="song-card" data-id="${s.id}">
      <div class="song-cover">
        <img src="${s.cover_url || ""}">
        <button class="play-btn" data-play="${s.id}"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></button>
      </div>
      <div class="song-info">
        <div class="song-name">${escapeHtml(s.song_name)}</div>
        <div class="song-artist">${escapeHtml(s.artist || "")}</div>
        ${s.dj_name ? `<div class="song-dj">DJ: ${escapeHtml(s.dj_name)}</div>` : ""}
        <div class="song-footer" style="display: flex; justify-content: flex-end; align-items: center; margin-top: auto;">
          <button class="cart-add-btn" type="button" data-add-cart="${s.id}" aria-label="เพิ่ม ${escapeHtml(s.song_name)} ลงตะกร้า">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
            ${formatPrice(s.price)}
          </button>
        </div>
      </div>
    </div>
  `).join("");

  grid.querySelectorAll("[data-play]").forEach(el => {
    el.addEventListener("click", (ev) => { ev.stopPropagation(); unlockAudio(); playSong(el.getAttribute("data-play")); });
  });

  grid.querySelectorAll("[data-add-cart]").forEach(el => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const song = findSong(el.getAttribute("data-add-cart"));
      if (song) {
        addToCart(song);
      }
    });
  });

  grid.querySelectorAll(".song-card").forEach(el => {
    el.addEventListener("click", () => openSongModal(el.getAttribute("data-id")));
  });
  updatePlayButtonsUI();
}

const openPlaylists = new Set();

function renderPlaylists() {
  const container = document.getElementById("playlistsContainer");
  if (!container) return;
  if (STATE.playlists.length === 0) { container.innerHTML = ""; return; }

  // กรองเพลย์ลิสต์ตามคำค้นหาด้วย (ถ้าช่องค้นหาตรงกับชื่อเพลย์ลิสต์ จะแสดงเพลย์ลิสต์นั้น)
  const filteredPlaylists = STATE.playlists.filter(pl => {
    if (!STATE.search) return true;
    const q = STATE.search.toLowerCase();
    const matchPlName = pl.playlist_name.toLowerCase().includes(q);
    const hasMatchingSongs = STATE.songs.some(s => s.playlist_id === pl.id && [s.song_name, s.artist, s.dj_name].join(" ").toLowerCase().includes(q));
    return matchPlName || hasMatchingSongs;
  });

  container.innerHTML = filteredPlaylists.map(pl => {
    const songs = STATE.songs.filter(s => s.playlist_id === pl.id);
    if (songs.length === 0) return "";
    const isOpen = openPlaylists.has(pl.id) || (STATE.search && STATE.search.length > 0); // เปิดอัตโนมัติเมื่อกำลังค้นหา
    const cover = pl.cover_url || songs[0].cover_url || "";
    return `
      <div class="playlist-block" data-playlist-id="${pl.id}">
        <div class="playlist-folder-btn" data-toggle-playlist="${pl.id}">
          <div class="playlist-folder-cover">
            <img src="${cover}">
          </div>
          <div class="playlist-folder-info">
            <div class="playlist-folder-name">${escapeHtml(pl.playlist_name)}</div>
            <div class="playlist-folder-count">${songs.length} เพลง</div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: flex-end; justify-content: flex-end; margin-left: auto; padding-right: 8px;">
            ${pl.price ? `<button type="button" class="cart-add-btn playlist-folder-price" data-add-cart-playlist="${pl.id}" aria-label="เพิ่มเพลย์ลิสต์ ${escapeHtml(pl.playlist_name)} ลงตะกร้า">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
              ${formatPrice(pl.price)}
            </button>` : ""}
          </div>
          <svg class="playlist-folder-arrow${isOpen ? "" : " is-closed"}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="playlist-row-wrap${isOpen ? "" : " is-closed"}">
          <div class="playlist-row">
            ${songs.map(s => `
              <div class="playlist-song-row" data-id="${s.id}">
                <div class="playlist-cover">
                  <img src="${s.cover_url || pl.cover_url || ""}">
                  <button class="playlist-play-btn" data-play="${s.id}">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
                  </button>
                </div>
                <div class="playlist-info">
                  <div class="playlist-item-name">${escapeHtml(s.song_name)}</div>
                  <div class="playlist-item-sub">${escapeHtml(s.dj_name || s.artist || "")}</div>
                </div>
                <div class="playlist-item-price" style="display: flex; flex-direction: column; align-items: flex-end; justify-content: flex-end; position: absolute; right: 0; bottom: 0;">
                  <div style="display: inline-flex; align-items: center; gap: 4px;">
                    <button class="cart-add-btn playlist-add-cart" type="button" data-add-cart-song="${s.id}" aria-label="เพิ่ม ${escapeHtml(s.song_name)} ลงตะกร้า">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
                      ${formatPrice(s.price)}
                    </button>
                  </div>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll("[data-toggle-playlist]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-toggle-playlist");
      const block = btn.closest(".playlist-block");
      const wrap = block.querySelector(".playlist-row-wrap");
      const arrow = btn.querySelector(".playlist-folder-arrow");
      const willOpen = wrap.classList.contains("is-closed");
      wrap.classList.toggle("is-closed");
      arrow.classList.toggle("is-closed");
      if (willOpen) openPlaylists.add(id); else openPlaylists.delete(id);
    });
  });

  container.querySelectorAll("[data-add-cart-playlist]").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const pl = STATE.playlists.find(p => p.id === btn.getAttribute("data-add-cart-playlist"));
      if (!pl) return;
      const plSongs = STATE.songs.filter(s => s.playlist_id === pl.id);
      const firstSong = plSongs[0];
      addToCart({
        id: `playlist:${pl.id}`,
        song_name: `เพลย์ลิสต์: ${pl.playlist_name}`,
        cover_url: pl.cover_url || firstSong?.cover_url || "",
        dj_name: `${plSongs.length} เพลง`,
        price: pl.price,
        kind: "playlist",
        // Snapshot รายชื่อ+ไอดีเพลงในเพลย์ลิสต์ ณ ตอนเพิ่มลงตะกร้า
        // ใช้แสดงผล "ดูรายการเพลง" ในตะกร้า/ใบเสร็จ และตรวจเพลงซ้ำกับเพลงเดี่ยวเท่านั้น
        // (ไม่ถูกนำมาคิดราคาแยก ราคายังคงเป็นราคาเหมาเพลย์ลิสต์เท่านั้น)
        song_ids: plSongs.map(s => String(s.id)),
        songs: plSongs.map(s => ({ id: String(s.id), song_name: String(s.song_name || "เพลง") }))
      });
    });
  });

  container.querySelectorAll("[data-add-cart-song]").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const song = findSong(btn.getAttribute("data-add-cart-song"));
      if (song) {
        addToCart(song);
      }
    });
  });

  container.querySelectorAll("[data-play]").forEach(el => {
    el.addEventListener("click", (ev) => { ev.stopPropagation(); unlockAudio(); playSong(el.getAttribute("data-play")); });
  });
  container.querySelectorAll(".playlist-song-row").forEach(el => {
    el.addEventListener("click", () => openSongModal(el.getAttribute("data-id")));
  });
  updatePlayButtonsUI();
}

function togglePlaylistsVisibility() {
  const wrapper = document.querySelector(".playlist-wrapper");
  if (!wrapper) return;
  // แสดงเพลย์ลิสต์เฉพาะหน้าแรกที่เลือก "ทั้งหมด" หรือแท็บเพลย์ลิสต์
  wrapper.style.display =
    STATE.currentView === "playlist" ||
    (STATE.currentView === "home" && STATE.currentCategory === "all")
      ? ""
      : "none";
}

function setView(view) {
  STATE.currentView = view;
  const showCategory = view === "home" || view === "category";
  // แสดง DJ ในหน้า "ทั้งหมด" หรือหน้า DJ เท่านั้น
  // เมื่อเลือกหมวดหมู่เฉพาะ ให้ซ่อนส่วน DJ ออกจากหน้านั้น
  const showDj =
    view === "dj" ||
    ((view === "home" || view === "category") && STATE.currentCategory === "all");
  // แท็บ DJ ต้องแสดงเพลงของ DJ ทุกคน หรือเพลงของ DJ ที่เลือก
  const showSongs = view === "home" || view === "category" || view === "dj";

  // ช่องค้นหาอยู่ใน topbar จึงยังแสดงทุกแท็บ
  const categoryChips = document.getElementById("categoryChips");
  const djSection = document.getElementById("djSection");
  if (categoryChips) categoryChips.style.display = showCategory ? "" : "none";
  if (djSection) djSection.style.display = showDj ? "" : "none";

  // แท็บเพลย์ลิสต์และ DJ ซ่อนรายการเพลงทั้งหมด ส่วนหมวดหมู่ยังดูเพลงที่กรองได้
  ["#gridTitle", "#songGrid", "#emptyState"].forEach(selector => {
    const el = document.querySelector(selector);
    if (el) el.style.display = showSongs ? "" : "none";
  });

  togglePlaylistsVisibility();

  if (view === "playlist") {
    const container = document.getElementById("playlistsContainer");
    const icon = document.getElementById("dropdownIcon");
    if (container) container.classList.remove("is-closed");
    if (icon) icon.classList.remove("is-closed");
  }
}

function findSong(id) { return STATE.songs.find(s => s.id === id); }

function unlockAudio() {
  if (audioUnlocked) return;
  AUDIO.play().catch(() => {});
  AUDIO.pause();
  audioUnlocked = true;
}

function playIconPath() { return '<path d="M8 5v14l11-7z"/>'; }
function stopIconPath() { return '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>'; }

function setPlayerIcon(playing) {
  const iconEl = document.getElementById("playerIcon");
  if (iconEl) iconEl.innerHTML = playing ? stopIconPath() : playIconPath();
}

function setPlayerLoading(loading) {
  const iconEl = document.getElementById("playerIcon");
  const spinnerEl = document.getElementById("playerSpinner");

  if (iconEl) iconEl.style.display = loading ? "none" : "block";
  if (spinnerEl) spinnerEl.style.display = loading ? "block" : "none";
}

function updatePlayButtonsUI() {
  const playingId = (!AUDIO.paused && !STATE.currentLoadingId) ? STATE.currentPlayingId : null;
  const loadingId = STATE.currentLoadingId;

  document.querySelectorAll(".play-btn[data-play], .playlist-play-btn[data-play]").forEach(btn => {
    const id = btn.getAttribute("data-play");
    let svg = btn.querySelector("svg");
    let spinner = btn.querySelector(".mini-play-spinner");

    if (!spinner) {
      spinner = document.createElement("div");
      spinner.className = "spinner mini-play-spinner";
      btn.appendChild(spinner);
    }

    if (id === loadingId) {
      if (svg) svg.style.display = "none";
      spinner.style.display = "block";
    } else {
      spinner.style.display = "none";
      if (svg) {
        svg.style.display = "block";
        svg.innerHTML = id === playingId ? stopIconPath() : playIconPath();
      }
    }
  });

  const modalBtn = document.getElementById("modalPlayBtn");
  const modalIcon = document.getElementById("modalPlayIcon");
  const modalSpinner = document.getElementById("modalPlaySpinner");
  const modalLabel = document.getElementById("modalPlayLabel");
  if (modalBtn && modalIcon) {
    const modalId = modalBtn.getAttribute("data-play");
    if (modalId && modalId === loadingId) {
      modalIcon.style.display = "none";
      if (modalSpinner) modalSpinner.style.display = "block";
      if (modalLabel) modalLabel.textContent = "กำลังโหลด...";
    } else {
      if (modalSpinner) modalSpinner.style.display = "none";
      modalIcon.style.display = "block";
      const isPlaying = modalId && modalId === playingId;
      modalIcon.innerHTML = isPlaying ? stopIconPath() : playIconPath();
      if (modalLabel) modalLabel.textContent = isPlaying ? "หยุดเพลง" : "ฟังเพลง";
    }
  }

  setPlayerIcon(playingId !== null);
  setPlayerLoading(loadingId !== null);
}

function playSong(songId) {
  const song = findSong(songId);
  if (!song || !song.file_url) { showToast("ไม่พบไฟล์เพลง", "error"); return; }

  if (STATE.currentPlayingId === songId && !STATE.currentLoadingId && AUDIO.src) {
    if (AUDIO.paused) {
      AUDIO.play().then(updatePlayButtonsUI).catch(() => {});
    } else {
      AUDIO.pause();
    }
    updatePlayButtonsUI();
    return;
  }

  AUDIO.pause();
  STATE.currentPlayingId = songId;
  STATE.currentLoadingId = songId;
  updatePlayButtonsUI();

  const coverEl = document.getElementById("playerCover");
  const titleEl = document.getElementById("playerTitle");
  const subEl = document.getElementById("playerSub");
  const barEl = document.getElementById("playerBar");
  const currTimeEl = document.getElementById("playerCurrentTime");
  const durTimeEl = document.getElementById("playerDuration");
  const seekEl = document.getElementById("playerSeek");

  if (coverEl) coverEl.src = song.cover_url || "";
  if (titleEl) titleEl.textContent = song.song_name;
  if (subEl) subEl.textContent = song.dj_name || song.artist || "";
  if (barEl) barEl.classList.add("show");
  if (currTimeEl) currTimeEl.textContent = "0:00";
  if (durTimeEl) durTimeEl.textContent = "0:00";
  if (seekEl) seekEl.value = 0;

  AUDIO.src = song.file_url;
  AUDIO.load();
  AUDIO.play().then(() => {
    STATE.currentLoadingId = null;
    updatePlayButtonsUI();
  }).catch(() => {
    showToast("แตะปุ่มเล่นที่แถบด้านล่างอีกครั้ง");
    STATE.currentLoadingId = null;
    updatePlayButtonsUI();
  });
}

const playerToggleBtn = document.getElementById("playerToggle");
if (playerToggleBtn) {
  playerToggleBtn.addEventListener("click", () => {
    unlockAudio();
    if (!AUDIO.src) return;
    if (AUDIO.paused) { AUDIO.play().then(updatePlayButtonsUI).catch(() => {}); } else { AUDIO.pause(); }
    updatePlayButtonsUI();
  });
}

let isSeeking = false;
const seekEl = document.getElementById("playerSeek");

AUDIO.addEventListener("loadedmetadata", () => {
  const durTimeEl = document.getElementById("playerDuration");
  if (durTimeEl) durTimeEl.textContent = formatTime(AUDIO.duration);
  if (seekEl) seekEl.max = AUDIO.duration || 0;
});

AUDIO.addEventListener("timeupdate", () => {
  if (isSeeking) return;
  const currTimeEl = document.getElementById("playerCurrentTime");
  if (currTimeEl) currTimeEl.textContent = formatTime(AUDIO.currentTime);
  if (seekEl) seekEl.value = AUDIO.currentTime;
});

if (seekEl) {
  seekEl.addEventListener("input", () => {
    isSeeking = true;
    const currTimeEl = document.getElementById("playerCurrentTime");
    if (currTimeEl) currTimeEl.textContent = formatTime(Number(seekEl.value));
  });
  seekEl.addEventListener("change", () => {
    AUDIO.currentTime = Number(seekEl.value);
    isSeeking = false;
  });
}

AUDIO.addEventListener("error", () => {
  showToast("เกิดข้อผิดพลาดในการโหลดไฟล์เพลง", "error");
  STATE.currentLoadingId = null;
  STATE.currentPlayingId = null;
  updatePlayButtonsUI();
});

AUDIO.addEventListener("ended", () => { STATE.currentPlayingId = null; updatePlayButtonsUI(); if (seekEl) seekEl.value = 0; });
AUDIO.addEventListener("pause", updatePlayButtonsUI);
AUDIO.addEventListener("play", updatePlayButtonsUI);
AUDIO.addEventListener("waiting", () => { STATE.currentLoadingId = STATE.currentPlayingId; updatePlayButtonsUI(); });
AUDIO.addEventListener("playing", () => { STATE.currentLoadingId = null; updatePlayButtonsUI(); });

function openSongModal(songId) {
  const song = findSong(songId);
  if (!song) return;

  const coverEl = document.getElementById("modalCover");
  const nameEl = document.getElementById("modalName");
  const artistEl = document.getElementById("modalArtist");
  const djEl = document.getElementById("modalDj");
  const descEl = document.getElementById("modalDesc");
  const priceEl = document.getElementById("modalPrice");
  const modalBtn = document.getElementById("modalPlayBtn");
  const buyBtn = document.getElementById("modalBuyBtn");
  const backdropEl = document.getElementById("songModalBackdrop");

  if (coverEl) coverEl.src = song.cover_url || "";
  if (nameEl) nameEl.textContent = song.song_name;
  if (artistEl) artistEl.textContent = song.artist || "";
  if (djEl) djEl.textContent = song.dj_name ? "DJ: " + song.dj_name : "";
  if (descEl) descEl.textContent = song.description || "";
  if (priceEl) priceEl.textContent = formatPrice(song.price);

  if (modalBtn) {
    modalBtn.setAttribute("data-play", songId);
    modalBtn.onclick = () => { unlockAudio(); playSong(songId); };
  }
  if (buyBtn) {
    buyBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg><span>${formatPrice(song.price)}</span>`;
    buyBtn.setAttribute("aria-label", `เพิ่ม ${song.song_name} ลงตะกร้า`);
    buyBtn.onclick = () => {
      addToCart(song);
    };
  }
  updatePlayButtonsUI();
  if (backdropEl) backdropEl.classList.add("show");
}

const modalCloseBtn = document.getElementById("songModalClose");
const backdropEl = document.getElementById("songModalBackdrop");
if (modalCloseBtn) modalCloseBtn.addEventListener("click", () => backdropEl && backdropEl.classList.remove("show"));
if (backdropEl) backdropEl.addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove("show"); });

const searchInputEl = document.getElementById("searchInput");
if (searchInputEl) {
  searchInputEl.addEventListener("input", debounce((e) => {
    STATE.search = e.target.value.trim();
    renderSongGrid();
    renderPlaylists(); // อัปเดตการแสดงผลเพลย์ลิสต์ตามคำค้นหาด้วย
    togglePlaylistsVisibility();
  }, 250));

  // ดักจับการกดปุ่ม Enter หรือกดปุ่ม Go บนมือถือเพื่อซ่อนแป้นพิมพ์
  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      searchInputEl.blur();
    }
  });
}

document.querySelectorAll(".bottom-nav button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".bottom-nav button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.getAttribute("data-tab");
    if (tab === "home") {
      STATE.currentCategory = "all";
      STATE.currentDj = null;
      setView("home");
      renderCategoryChips();
      renderSongGrid();
      renderPlaylists();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    else if (tab === "playlist") {
      setView("playlist");
      renderPlaylists();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    else if (tab === "category") {
      STATE.currentCategory = "all";
      STATE.currentDj = null;
      setView("category");
      renderCategoryChips();
      renderSongGrid();
      renderPlaylists();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    else if (tab === "dj") {
      STATE.currentCategory = "all";
      STATE.currentDj = null;
      setView("dj");
      renderDjRow();
      renderSongGrid();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    else if (tab === "contact") {
      window.open(buildWhatsAppLink(STATE.settings.whatsapp_number, "สวัสดีครับ/ค่ะ ต้องการสอบถามเกี่ยวกับร้านเพลง"), "_blank");
    }
  });
});

init().catch(err => showToast("โหลดข้อมูลไม่สำเร็จ: " + err.message, "error"));
