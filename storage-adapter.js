// storage-adapter.js
// ===================================================
// ชั้นกลางสำหรับอัปโหลดไฟล์ (เพลง/รูปภาพ) — ทุกส่วนของแอปเรียกผ่านฟังก์ชันในไฟล์นี้
// แทนที่จะยิงไปหา Cloudinary ตรงๆ เพื่อให้สลับผู้ให้บริการ Storage ในอนาคต (เช่น Cloudflare R2)
// ได้โดยไม่ต้องแก้โค้ดฝั่ง admin/orders เลย
//
// วิธีย้ายไป R2 ในอนาคต:
//   1. Implement เมธอด upload() ใน R2Provider ด้านล่างให้ครบ (ต้องมี backend/Cloud Function
//      สร้าง presigned URL ให้ก่อน เพราะ R2 secret key ห้ามฝังในโค้ดฝั่ง browser)
//   2. เปลี่ยนค่า ACTIVE_PROVIDER เป็น "r2"
//   3. เสร็จ — โค้ดที่เหลือไม่ต้องแก้
// ===================================================
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } from "./firebase-init.js";

// สร้าง Error สำหรับกรณีอัปโหลดถูกยกเลิก (ให้ผู้เรียกเช็คได้ด้วย err.name === "AbortError")
function makeAbortError() {
  const err = new Error("อัปโหลดถูกยกเลิก");
  err.name = "AbortError";
  return err;
}

// ---------------- Cloudinary Provider (ใช้งานจริงตอนนี้) ----------------
const CloudinaryProvider = {
  name: "cloudinary",

  // folder: โฟลเดอร์ปลายทางใน Cloudinary
  // หมายเหตุ: ถ้า unsigned upload preset ตั้งค่า "Folder" เป็น Fixed/Disabled ไว้ พารามิเตอร์นี้จะถูกเมิน
  // และไฟล์จะถูกเก็บตาม path ที่ preset กำหนดแทน — เข้า Cloudinary Console > Upload presets เพื่อเช็ค/แก้ได้
  // signal (ไม่บังคับ): ส่ง AbortController().signal เข้ามาเพื่อยกเลิกอัปโหลดจริงกลางทางได้ (ยิง xhr.abort())
  async upload(file, { folder = "", resourceType = "auto" } = {}, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;
      const formData = new FormData();
      formData.append("file", file);
      formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
      if (folder) formData.append("folder", folder);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);

      if (signal) {
        if (signal.aborted) { reject(makeAbortError()); return; }
        signal.addEventListener("abort", () => xhr.abort());
      }

      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) {
          // ส่งทั้งเปอร์เซ็นต์และจำนวนไบต์จริง (loaded/total) ให้ผู้เรียกใช้แสดงผลแบบ "2 MB / 6 MB" แบบเรียลไทม์ได้
          onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
        }
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.secure_url) {
            resolve({ url: data.secure_url, publicId: data.public_id, provider: "cloudinary" });
          } else {
            // ปฏิเสธจาก Cloudinary เอง (เช่น format/preset ไม่อนุญาต) — ไม่ใช่ปัญหาเครือข่าย
            // จึงไม่ติด retryable=true เพราะลองใหม่ไปก็จะพังซ้ำเหมือนเดิม
            reject(new Error(data.error ? data.error.message : `อัปโหลดไม่สำเร็จ (HTTP ${xhr.status})`));
          }
        } catch (err) {
          reject(err);
        }
      };
      xhr.onerror = () => {
        const err = new Error(
          "เชื่อมต่อ Cloudinary ไม่สำเร็จ — ตรวจสอบ Cloud Name, Upload Preset, CORS หรือการเชื่อมต่ออินเทอร์เน็ต"
        );
        err.retryable = true; // ปัญหาเครือข่าย — ลองใหม่ได้
        reject(err);
      };
      xhr.ontimeout = () => {
        const err = new Error("Cloudinary ใช้เวลาตอบกลับนานเกินไป");
        err.retryable = true; // timeout — ลองใหม่ได้
        reject(err);
      };
      xhr.onabort = () => reject(makeAbortError()); // ผู้ใช้กดยกเลิกเอง — ห้าม retry เด็ดขาด
      xhr.timeout = 10 * 60 * 1000;
      xhr.send(formData);
    });
  },
};

// ---------------- R2 Provider (เตรียมโครงไว้ — ยังไม่เปิดใช้งานจริง) ----------------
// ยังไม่ implement เพราะการอัปโหลดตรงจาก browser ไป R2 ต้องมี backend เซ็น (presign) request
// ให้ก่อนเสมอ — ไม่สามารถฝัง R2 Access Key/Secret ไว้ในโค้ดฝั่งเว็บได้
const R2Provider = {
  name: "r2",
  async upload() {
    throw new Error("R2Provider ยังไม่เปิดใช้งาน — ต้องตั้งค่า backend สำหรับสร้าง presigned URL ก่อนใช้งานจริง");
  },
};

const PROVIDERS = { cloudinary: CloudinaryProvider, r2: R2Provider };

// เปลี่ยนค่านี้เป็น "r2" ตอนพร้อมย้ายจริงในอนาคต (หลัง implement R2Provider ครบแล้ว)
const ACTIVE_PROVIDER = "cloudinary";

export function getStorageProvider() {
  return PROVIDERS[ACTIVE_PROVIDER];
}

// อัปโหลดไฟล์เพลงตัวอย่าง/รูปภาพ (ใช้ folder เดิม หรือไม่ระบุก็ได้) — คงพฤติกรรมเดิมไว้ทุกประการ
// signal (ไม่บังคับ): ส่งเข้ามาเพื่อยกเลิกอัปโหลดจริงกลางทางได้
export async function uploadToStorage(file, onProgress, folder = "", signal) {
  return getStorageProvider().upload(file, { folder }, onProgress, signal);
}

// ⚠️ retry เฉพาะจุดนี้ (เพลงเต็ม) ตามที่ผู้ใช้สั่งไว้เท่านั้น — ห้ามลาม/ย้ายไป apply กับ
// uploadToStorage หรือ uploadOrderZip โดยไม่มีคำสั่งผู้ใช้เพิ่ม
// จะ retry เฉพาะกรณี err.retryable === true (ปัญหาเครือข่าย/timeout เท่านั้น) — ไม่ retry
// เมื่อผู้ใช้กดยกเลิก (AbortError) และไม่ retry เมื่อ Cloudinary ปฏิเสธไฟล์ (format ไม่ถูกต้อง ฯลฯ)
// เพราะกรณีหลังลองใหม่ไปก็ไม่มีทางสำเร็จ มีแต่จะเสียเวลาผู้ใช้เปล่าๆ
async function withUploadRetry(uploadFn, { maxRetries = 2, delayMs = 3000, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await uploadFn();
    } catch (err) {
      lastErr = err;
      const isAbort = err?.name === "AbortError";
      const canRetry = !isAbort && err?.retryable === true && attempt < maxRetries;
      if (!canRetry) throw err;
      if (onRetry) onRetry(attempt + 1, maxRetries, err);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

// อัปโหลดไฟล์เพลงเต็ม WAV/MP3 — เก็บแยกโฟลเดอร์ "full-songs" ไม่ปนกับไฟล์ตัวอย่างที่โชว์บนเว็บ user
// (โฟลเดอร์นี้ไม่ถูก reference จากหน้าเว็บ user เลย ใช้เฉพาะฝั่ง Admin เท่านั้น)
// onRetry (ไม่บังคับ): callback(attemptNumber, maxRetries, err) — ให้ฝั่ง UI (app-admin.js) โชว์สถานะ
// "กำลังลองใหม่..." ให้ผู้ใช้เห็นตอนอัปโหลดหลุด/timeout แล้วระบบกำลังลองซ้ำอัตโนมัติ
export async function uploadFullSong(file, onProgress, signal, onRetry) {
  return withUploadRetry(
    () => getStorageProvider().upload(file, { folder: "full-songs" }, onProgress, signal),
    { maxRetries: 2, delayMs: 3000, onRetry }
  );
}

// อัปโหลด ZIP ที่ระบบสร้างจากไฟล์เต็มของออเดอร์
// แยกโฟลเดอร์จากไฟล์เพลงเดิม เพื่อไม่กระทบลิงก์/ข้อมูลเพลงที่มีอยู่แล้ว
export async function uploadOrderZip(file, onProgress, signal) {
  // ZIP เป็นไฟล์ archive ไม่ใช่รูป/วิดีโอ จึงส่งผ่าน raw/upload โดยเฉพาะ
  return getStorageProvider().upload(
    file,
    { folder: "order-zips", resourceType: "raw" },
    onProgress,
    signal
  );
}
