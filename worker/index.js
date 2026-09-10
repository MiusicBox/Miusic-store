// worker/index.js
// ===================================================
// Backend เดียวที่เพิ่มเข้ามาเพื่อรองรับการย้าย Storage จาก Cloudinary ไป Cloudflare R2
//
// ทำไมต้องมีไฟล์นี้:
//   Cloudinary รองรับ "unsigned upload" ยิงตรงจาก browser ได้เลย แต่ R2 ไม่มีโหมดแบบนี้
//   การเขียนไฟล์เข้า R2 ต้องทำผ่าน Worker ที่มี binding ไปยัง bucket เท่านั้น (หรือเซ็น presigned URL
//   ด้วย Access Key/Secret ซึ่งห้ามฝังในโค้ดฝั่ง browser) — จึงเลือกวิธีให้ browser อัปโหลดไฟล์มาที่
//   Worker นี้ก่อน แล้ว Worker ค่อยเขียนต่อเข้า R2 ผ่าน binding (ไม่ต้องยุ่งกับการเซ็น request เลย)
//
// ขอบเขต: ไฟล์นี้รับผิดชอบเฉพาะ path "/api/*" เท่านั้น (ตั้งค่าไว้ใน wrangler.jsonc ผ่าน
// run_worker_first) — ทุก path อื่นๆ ของเว็บ (index.html, admin.html, .js, .css เดิมทั้งหมด)
// ยังถูกเสิร์ฟเป็น static asset ตามปกติ ไม่ผ่าน Worker นี้เลย จึงไม่กระทบระบบเดิมส่วนอื่น
// ===================================================

// โฟลเดอร์เหล่านี้เดิมใช้ toCloudinaryDownloadUrl() เติม fl_attachment ให้บังคับดาวน์โหลด
// (ไฟล์เพลงเต็ม/ไฟล์ ZIP ออเดอร์ — ไม่ใช่ไฟล์ที่เปิดเล่น/แสดงผลตรงๆ บนเว็บ)
// ย้ายมา R2 แล้วให้ตั้ง Content-Disposition ตอนอัปโหลดแทน เพื่อให้พฤติกรรม "กดแล้วดาวน์โหลดทันที" เหมือนเดิม
const FORCE_DOWNLOAD_FOLDERS = new Set(["full-songs", "order-zips"]);

function corsHeaders() {
  // ใช้งานจริงเป็น same-origin (เว็บกับ Worker อยู่โดเมนเดียวกัน) จึงไม่จำเป็นต้องเปิด CORS
  // แต่ใส่ไว้แบบกว้างๆ เผื่อกรณีทดสอบจากเครื่อง dev คนละ origin ไม่ให้ต้องมาแก้ไฟล์นี้เพิ่ม
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// สุ่มชื่อไฟล์ปลายทางใน R2 ให้ไม่ชนกัน (คล้าย public_id ของ Cloudinary) แต่ยังเก็บนามสกุลไฟล์เดิมไว้
// เพื่อให้เบราว์เซอร์/แอปเดา content type และเปิดไฟล์ได้ถูกต้อง
function buildObjectKey(folder, originalName) {
  const safeFolder = (folder || "").replace(/[^a-zA-Z0-9/_-]/g, "").replace(/^\/+|\/+$/g, "");
  const extMatch = /\.[a-zA-Z0-9]+$/.exec(originalName || "");
  const ext = extMatch ? extMatch[0] : "";
  const uniquePart = `${Date.now()}-${crypto.randomUUID()}`;
  return (safeFolder ? `${safeFolder}/` : "") + uniquePart + ext;
}

async function handleUpload(request, env) {
  if (!env.BUCKET) {
    return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  }
  if (!env.R2_PUBLIC_BASE_URL) {
    return jsonResponse({ error: "ยังไม่ได้ตั้งค่า R2_PUBLIC_BASE_URL ใน wrangler.jsonc" }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return jsonResponse({ error: "อ่านข้อมูลอัปโหลดไม่สำเร็จ (ต้องเป็น multipart/form-data)" }, 400);
  }

  const file = form.get("file");
  const folder = String(form.get("folder") || "");
  const resourceType = String(form.get("resourceType") || "auto");

  if (!file || typeof file === "string") {
    return jsonResponse({ error: "ไม่พบไฟล์ที่จะอัปโหลด (field 'file')" }, 400);
  }

  const key = buildObjectKey(folder, file.name);
  const httpMetadata = {
    contentType: file.type || "application/octet-stream",
  };

  // เดิม (Cloudinary): orders.js ใช้ toCloudinaryDownloadUrl() แปะ fl_attachment ต่อท้าย URL
  // ตอนแสดงผลทุกครั้งที่ผู้ใช้กดลิงก์ดาวน์โหลด — ย้ายมาตั้งตอนอัปโหลดครั้งเดียวแทน ผลลัพธ์
  // ปลายทาง (กดแล้วดาวน์โหลดไฟล์ทันที ไม่เปิดเล่นในแท็บใหม่) เหมือนเดิมทุกประการ
  const isForceDownload = FORCE_DOWNLOAD_FOLDERS.has(folder) || resourceType === "raw";
  if (isForceDownload) {
    const downloadName = (file.name || key.split("/").pop() || "download").replace(/"/g, "");
    httpMetadata.contentDisposition = `attachment; filename="${downloadName}"`;
  }

  try {
    await env.BUCKET.put(key, file.stream(), { httpMetadata });
  } catch (err) {
    return jsonResponse({ error: "เขียนไฟล์เข้า R2 ไม่สำเร็จ: " + (err?.message || String(err)) }, 502);
  }

  const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const url = `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  return jsonResponse({ url, publicId: key, provider: "r2" }, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    // path อื่นใต้ /api/* ที่ยังไม่มี — เผื่อ Phase ถัดไป (D1) จะมาเพิ่มทีหลัง ไม่เกี่ยวกับ Phase นี้
    return jsonResponse({ error: "ไม่พบ endpoint นี้" }, 404);
  },
};
