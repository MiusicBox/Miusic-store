-- schema.sql
-- ===================================================
-- สคีมา Cloudflare D1 สำหรับแทนที่ Firestore + Firebase Auth
--
-- แนวคิด: ตาราง "documents" เป็นตารางกลางแบบ generic (collection, id, data JSON)
-- เลียนแบบโครงสร้าง Firestore (collection/document แบบไม่บังคับ schema ตายตัว) 1:1
-- เพื่อให้ทุก collection เดิม (songs, categories, djs, playlists, orders, discounts,
-- promotions, settings) ใช้โค้ดฝั่ง Worker ชุดเดียวกันได้ทั้งหมด โดยไม่ต้องออกแบบตาราง
-- แยกทีละ collection (ลดความเสี่ยงตีความฟิลด์ผิดจากของเดิมที่มีอยู่แล้วในแอป)
--
-- ยกเว้น collection "admins" ที่ผูกกับระบบยืนยันตัวตนโดยตรง จึงแยกเป็นตาราง
-- admin_users ต่างหาก (มี password_hash ซึ่งห้ามปนกับ JSON blob ทั่วไป)
-- ===================================================

CREATE TABLE IF NOT EXISTS documents (
  collection  TEXT NOT NULL,
  id          TEXT NOT NULL,
  data        TEXT NOT NULL, -- JSON string ของฟิลด์เอกสาร (เทียบเท่า Firestore document fields)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);

-- ใช้เร่งความเร็วตอน getDocs(collection(db, "..")) แบบไม่มีเงื่อนไข (ดึงทั้ง collection)
CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);

CREATE TABLE IF NOT EXISTS admin_users (
  id             TEXT PRIMARY KEY, -- เทียบเท่า Firebase Auth UID เดิม
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,    -- รูปแบบ "pbkdf2$<iterations>$<saltBase64>$<hashBase64>"
  display_name   TEXT,
  role           TEXT NOT NULL DEFAULT 'sub', -- 'main' | 'sub' (เหมือนเดิมทุกประการ)
  created_at     TEXT NOT NULL,
  created_by     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_admin ON sessions(admin_id);
