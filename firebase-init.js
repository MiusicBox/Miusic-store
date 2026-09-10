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

// ⚠️ 2026-09-10: ย้าย logic อัปโหลดไฟล์ทั้งหมดไปที่ storage-adapter.js แล้ว (ที่นั่นคือจุดเดียว
// ที่สลับ Provider ระหว่าง Cloudinary/R2 ได้จริง) ค่า CLOUDINARY_CLOUD_NAME/UPLOAD_PRESET ก็ย้ายไปอยู่
// ที่นั่นด้วย (ไม่มีไฟล์อื่นนอกจาก storage-adapter.js เรียกใช้ค่าเหล่านี้ จึงย้ายได้โดยไม่กระทบใคร)
//
// ฟังก์ชัน uploadToCloudinary ด้านล่างนี้ "เก็บชื่อเดิมไว้ตั้งใจ" แม้ชื่อจะฟังดูเหมือนยิง Cloudinary
// เพราะ app-admin.js import ชื่อนี้อยู่ 7 จุด (อัปโหลดเพลง/ปก/รูป DJ/ปกเพลย์ลิสต์) — เปลี่ยนแค่ภายใน
// ให้ไปเรียกผ่าน storage-adapter.js แทน ตอนนี้จึงอัปโหลดขึ้น R2 จริงๆ โดยไม่ต้องแก้ app-admin.js เลย
import { getStorageProvider } from "./storage-adapter.js";

export async function uploadToCloudinary(file, onProgress, signal) {
  return getStorageProvider().upload(file, {}, onProgress, signal);
}
