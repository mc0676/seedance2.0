import { getDatabase } from '../database/index.js';

function getNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function getDiscounts() {
  const db = getDatabase();
  return db.prepare(
    `SELECT * FROM model_discounting ORDER BY model, sub_key`
  ).all();
}

/**
 * 精确匹配：model + sub_key，无通配符
 */
export function getActiveDiscount(model, subKey) {
  const db = getDatabase();
  const now = getNow();
  return db.prepare(
    `SELECT * FROM model_discounting
     WHERE model = ? AND sub_key = ?
       AND start_date <= ? AND end_date >= ?
     LIMIT 1`
  ).get(model, subKey || '', now, now) || null;
}

export function getActiveDiscounts() {
  const db = getDatabase();
  const now = getNow();
  return db.prepare(
    `SELECT * FROM model_discounting
     WHERE start_date <= ? AND end_date >= ?
     ORDER BY model, sub_key`
  ).all(now, now);
}

function normalizeDatetime(dt) {
  // '2026-05-22T14:30' or '2026-05-22 14:30:00' → '2026-05-22T14:30:00'
  if (!dt) return dt;
  let s = dt.replace(' ', 'T');
  if (s.length <= 16) s += ':00';
  return s;
}

function normalizeEndDatetime(dt) {
  let s = normalizeDatetime(dt);
  // 若未指定具体时间（默认 00:00:00），则推到当天 23:59:59，使结束日期包含全天
  if (s.endsWith('00:00:00')) {
    s = s.slice(0, -8) + '23:59:59';
  }
  return s;
}

export function upsertDiscount({ model, subKey, type, value, startDate, endDate }) {
  if (!type || !['percent', 'number'].includes(type)) throw new Error('type 必须是 percent 或 number');
  const val = parseFloat(value);
  if (isNaN(val) || val < 0) throw new Error('折扣值必须 >= 0');
  if (type === 'percent' && val > 100) throw new Error('百分比折扣需在 0-100 之间');
  if (!startDate || !endDate) throw new Error('请选择折扣起止时间');
  const s = normalizeDatetime(startDate);
  const e = normalizeEndDatetime(endDate);
  if (s > e) throw new Error('开始时间不能晚于结束时间');

  const db = getDatabase();
  db.prepare(`
    INSERT INTO model_discounting (model, sub_key, type, value, start_date, end_date, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(model, sub_key) DO UPDATE SET
      type = excluded.type,
      value = excluded.value,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      updated_at = CURRENT_TIMESTAMP
  `).run(model, subKey || '', type, val, s, e);
  return { model, subKey: subKey || '', type, value: val, startDate: s, endDate: e };
}

export function deleteDiscount(id) {
  getDatabase().prepare(`DELETE FROM model_discounting WHERE id = ?`).run(id);
}

export function computeDiscountedPrice(originalPrice, model, subKey) {
  const discount = getActiveDiscount(model, subKey);
  if (!discount) return { price: originalPrice, discount: null };
  let discounted;
  if (discount.type === 'percent') {
    discounted = Math.ceil(originalPrice * (1 - discount.value / 100));
  } else {
    discounted = Math.ceil(discount.value);
  }
  return { price: discounted, discount };
}

export default {
  getDiscounts,
  getActiveDiscount,
  getActiveDiscounts,
  upsertDiscount,
  deleteDiscount,
  computeDiscountedPrice,
};
