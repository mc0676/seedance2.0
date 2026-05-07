import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/seedance.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;

export function initDatabase() {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  const existingTableCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get().count;

  if (existingTableCount === 0) {
    const schemaPath = path.join(__dirname, 'schema.sql');
    db.exec(fs.readFileSync(schemaPath, 'utf-8'));
    console.log('[database] 全新安装，已应用 schema.sql');
  }

  console.log(`[database] 数据库初始化成功：${DB_PATH}`);
  return db;
}

export function getDatabase() {
  if (!db) return initDatabase();
  return db;
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    console.log('[database] 数据库连接已关闭');
  }
}

export function transaction(fn) {
  const database = getDatabase();
  return database.transaction(fn)();
}

export default { initDatabase, getDatabase, closeDatabase, transaction };
