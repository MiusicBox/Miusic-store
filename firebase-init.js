// ===================================================
// firebase-init.js — ตั้งค่ากลาง ใช้ร่วมกันทั้ง index.html และ admin.html
// ===================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyA6wfgjq7OwEIgOb3krxQdg1EFKiVcxX1o",
  authDomain: "musicbox-store.firebaseapp.com",
  projectId: "musicbox-store",
  storageBucket: "musicbox-store.firebasestorage.app",
  messagingSenderId: "435724064019",
  appId: "1:435724064019:web:51653bba1eaa82658576e6",
  measurementId: "G-00Z619L2F1"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
// เปิดใช้งานเฉพาะตอนอยู่บนเว็บจริง (กัน error ตอนทดสอบในบางสภาพแวดล้อมที่ Analytics โหลดไม่ได้)
export const analytics = (() => {
  if (typeof window === "undefined") return null;
  try {
    return getAnalytics(app);
  } catch (err) {
    // Analytics ไม่ควรทำให้ Auth/Firestore ของหน้าเว็บหยุดทำงาน
    console.warn("Firebase Analytics ไม่พร้อมใช้งาน:", err);
    return null;
  }
})();

// ค่า Cloudinary (ใช้เก็บไฟล์เพลง/รูปภาพ แทน Firebase Storage)
export const CLOUDINARY_CLOUD_NAME = "g4nmb7ho";
export const CLOUDINARY_UPLOAD_PRESET = "music_store_unsigned";

// สร้าง Error สำหรับกรณีอัปโหลดถูกยกเลิก (แยกจาก error ทั่วไป ให้ผู้เรียกเช็คได้ด้วย err.name === "AbortError")
function makeAbortError() {
  const err = new Error("อัปโหลดถูกยกเลิก");
  err.name = "AbortError";
  return err;
}

// อัปโหลดไฟล์ใดๆ (เพลง/รูปภาพ) ขึ้น Cloudinary แบบ unsigned — คืนค่า URL ที่ใช้เล่น/แสดงได้ทันที
// signal (ไม่บังคับ): ส่ง AbortController().signal เข้ามาเพื่อให้ยกเลิกอัปโหลดจริงกลางทางได้ (ยิง xhr.abort())
// ผู้เรียกเดิมที่ไม่ส่ง signal มา จะทำงานเหมือนเดิมทุกประการ
export async function uploadToCloudinary(file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

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
          resolve({ url: data.secure_url, publicId: data.public_id });
        } else {
          reject(new Error(data.error ? data.error.message : "อัปโหลดไม่สำเร็จ"));
        }
      } catch (err) {
        reject(err);
      }
    };
    // หมายเหตุ: เดิมไม่มี timeout เลย — ถ้า request ค้าง (เน็ตหลุดกลางทาง, Safari บน iOS
    // ระงับการอัปโหลดตอนสลับแอป/ล็อกหน้าจอ ฯลฯ) promise จะค้างตลอดไปโดยไม่มี error ใดๆ โผล่มาเลย
    // ใส่ timeout ไว้กันปัญหานี้ (เท่ากับฝั่ง storage-adapter.js)
    xhr.onerror = () => reject(new Error("เชื่อมต่อ Cloudinary ไม่สำเร็จ — ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่"));
    xhr.ontimeout = () => reject(new Error("อัปโหลดไฟล์นานเกินไป (เกิน 10 นาที) — เน็ตอาจช้าหรือหลุดกลางทาง ลองใหม่อีกครั้ง"));
    xhr.onabort = () => reject(makeAbortError());
    xhr.timeout = 10 * 60 * 1000;
    xhr.send(formData);
  });
}
