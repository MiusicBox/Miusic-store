// db-client.js
// ===================================================
// เลียนแบบหน้าตา Firestore Web SDK เฉพาะฟังก์ชันที่โปรเจกต์นี้ใช้จริง (ตรวจสอบครบทุกไฟล์แล้ว):
// collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, query, where, orderBy, onSnapshot
// แต่ข้างในยิง fetch() ไปที่ /api/db/* บน Worker (คุย Cloudflare D1) แทน Firestore จริง
//
// เหตุผลที่ทำแบบนี้: ไฟล์ app-admin.js/app-cart.js/app-promotion.js/app-user.js/orders.js/admin-roles.js
// เขียนโค้ดโดยเรียกฟังก์ชันเหล่านี้ตรงๆ กว่า 250 จุด — การทำ compat layer แบบนี้ทำให้ไฟล์เหล่านั้น
// "ไม่ต้องแก้ logic แม้แต่บรรทัดเดียว" แก้แค่บรรทัด import ให้ชี้มาไฟล์นี้แทน CDN ของ Firebase
// (เหมือนแนวทางเดียวกับ storage-adapter.js ตอนย้าย Cloudinary -> R2)
//
// ขอบเขตที่รองรับ (เท่าที่แอปนี้ใช้จริง เท่านั้น — ไม่ใช่ Firestore SDK เต็มรูปแบบ):
//   - where(field, "==", value) เท่านั้น (ไม่มีจุดไหนในแอปใช้ operator อื่น)
//   - orderBy(field, "asc"|"desc")
//   - onSnapshot ใช้กับ query(collection(db,"orders")) แบบไม่มีเงื่อนไขเท่านั้น -> จำลอง realtime
//     ด้วยการ poll ทุก 4 วินาทีแทน (D1/Worker ไม่มี realtime push แบบ Firestore)
// ===================================================

const API_BASE = "/api/db";
const SNAPSHOT_POLL_MS = 4000;

async function apiFetch(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch { /* ไม่มี body หรือไม่ใช่ JSON */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `คำขอไปยังฐานข้อมูลไม่สำเร็จ (HTTP ${res.status})`);
    if (body && body.code) err.code = body.code;
    throw err;
  }
  return body;
}

// ---------------- References (เหมือน Firestore: แค่ path ยังไม่ได้อ่าน/เขียนจริง) ----------------
export function collection(_db, path) {
  return { __type: "collection", path };
}

// doc(db, path, id) เหมือน Firestore เดิม, หรือ doc(collectionRef) แบบไม่ระบุ id
// -> สุ่ม id ฝั่ง client ทันที (เหมือน Firestore SDK จริงที่ generate ID ทันทีโดยยังไม่เขียนอะไรลงฐานข้อมูล)
export function doc(dbOrCollRef, pathOrId, maybeId) {
  if (dbOrCollRef && dbOrCollRef.__type === "collection") {
    return { __type: "doc", path: dbOrCollRef.path, id: crypto.randomUUID() };
  }
  if (maybeId !== undefined) {
    return { __type: "doc", path: pathOrId, id: maybeId };
  }
  throw new Error("db-client.js: doc() ถูกเรียกด้วยรูปแบบพารามิเตอร์ที่ไม่รองรับ");
}

// ---------------- Query builders ----------------
export function query(collRef, ...constraints) {
  const q = { __type: "query", path: collRef.path, wheres: [], orderBy: null };
  for (const c of constraints) {
    if (c.__type === "where") q.wheres.push(c);
    else if (c.__type === "orderBy") q.orderBy = c;
  }
  return q;
}
export function where(field, op, value) {
  return { __type: "where", field, op, value };
}
export function orderBy(field, dir = "asc") {
  return { __type: "orderBy", field, dir };
}

// ---------------- Snapshot helpers ----------------
function makeDocSnap(id, data, exists) {
  return { id, exists: () => exists, data: () => (exists ? data : undefined) };
}
function makeQuerySnap(docs) {
  const docSnaps = docs.map((d) => ({ id: d.id, data: () => d.data }));
  return {
    docs: docSnaps,
    empty: docSnaps.length === 0,
    size: docSnaps.length,
    forEach(fn) { docSnaps.forEach(fn); },
  };
}

// ---------------- CRUD ----------------
export async function getDoc(ref) {
  const res = await apiFetch(`/${encodeURIComponent(ref.path)}/${encodeURIComponent(ref.id)}`);
  return makeDocSnap(ref.id, res.data, res.exists);
}

async function fetchDocs(refOrQuery) {
  if (refOrQuery.__type === "query" && (refOrQuery.wheres.length || refOrQuery.orderBy)) {
    const res = await apiFetch(`/${encodeURIComponent(refOrQuery.path)}/_query`, {
      method: "POST",
      body: JSON.stringify({ wheres: refOrQuery.wheres, orderBy: refOrQuery.orderBy }),
    });
    return res.docs;
  }
  const res = await apiFetch(`/${encodeURIComponent(refOrQuery.path)}`);
  return res.docs;
}

export async function getDocs(refOrQuery) {
  const docs = await fetchDocs(refOrQuery);
  return makeQuerySnap(docs);
}

// addDoc: เทียบเท่า setDoc ด้วย id ที่สุ่มขึ้นฝั่ง client (Firestore เองก็ทำแบบนี้ภายในเช่นกัน)
export async function addDoc(collRef, data) {
  const id = crypto.randomUUID();
  await apiFetch(`/${encodeURIComponent(collRef.path)}/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ data, merge: false }),
  });
  return { id, path: collRef.path };
}

export async function setDoc(ref, data, options) {
  await apiFetch(`/${encodeURIComponent(ref.path)}/${encodeURIComponent(ref.id)}`, {
    method: "PUT",
    body: JSON.stringify({ data, merge: !!(options && options.merge) }),
  });
}

export async function updateDoc(ref, data) {
  await apiFetch(`/${encodeURIComponent(ref.path)}/${encodeURIComponent(ref.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ data }),
  });
}

export async function deleteDoc(ref) {
  await apiFetch(`/${encodeURIComponent(ref.path)}/${encodeURIComponent(ref.id)}`, { method: "DELETE" });
}

// ---------------- onSnapshot (จำลอง realtime ด้วย polling — D1/Worker ไม่มี push แบบ Firestore) ----------------
// ใช้เฉพาะกับ query(collection(db,"orders")) แบบไม่มีเงื่อนไขในแอปนี้ (ตรวจสอบแล้วทั้งโปรเจกต์)
export function onSnapshot(refOrQuery, onNext, onError) {
  let stopped = false;
  let lastSerialized = null;

  async function poll() {
    if (stopped) return;
    try {
      const docs = await fetchDocs(refOrQuery);
      const serialized = JSON.stringify(docs);
      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        onNext(makeQuerySnap(docs));
      }
    } catch (err) {
      if (onError) onError(err);
    } finally {
      if (!stopped) timer = setTimeout(poll, SNAPSHOT_POLL_MS);
    }
  }

  let timer = setTimeout(poll, 0); // ยิงครั้งแรกทันที เหมือน Firestore ที่ callback แรกมาไวมาก
  return function unsubscribe() {
    stopped = true;
    clearTimeout(timer);
  };
}
