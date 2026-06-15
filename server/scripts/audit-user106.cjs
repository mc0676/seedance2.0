const D = require('/app/server/node_modules/better-sqlite3');
const db = new D('/app/server/data/seedance.db');
const uid = 106;
const day = '2026-06-04';

const rows = db.prepare(`
  SELECT t.id, t.duration, t.resolution, t.ratio, t.created_at,
         cl.locked_credits, cl.actual_credits, (cl.locked_credits - cl.actual_credits) refund
  FROM credit_locks cl
  LEFT JOIN tasks t ON t.id = cl.task_id
  WHERE cl.user_id = ? AND cl.status = 'settled' AND date(cl.created_at) = ?
  ORDER BY cl.created_at
`).all(uid, day);

// Convert UTC to Beijing time (+8h)
function beijing(utc) {
  const d = new Date(utc + 'Z');
  d.setHours(d.getHours() + 8);
  return d.toISOString().substring(11, 16);
}

console.log("| 序号 | 任务ID | 北京时间 | 时长 | 分辨率 | 比例 | 锁定 | 实扣 | 返还 |");
console.log("|------|--------|----------|------|--------|------|------|------|------|");
let totalLocked = 0, totalActual = 0, totalRefund = 0;
rows.forEach((r, i) => {
  const t = beijing(r.created_at);
  totalLocked += r.locked_credits;
  totalActual += r.actual_credits;
  totalRefund += r.refund;
  console.log(`| ${String(i+1).padStart(2)} | #${r.id} | ${t} | ${r.duration}s | ${r.resolution} | ${r.ratio} | ${String(r.locked_credits).padStart(4)} | ${String(r.actual_credits).padStart(4)} | ${String(r.refund).padStart(4)} |`);
});
console.log(`| **合计** | **${rows.length}条** | | | | | **${totalLocked}** | **${totalActual}** | **${totalRefund}** |`);

// Failed
console.log("\n### 失败任务 (已释放，未扣费)\n");
console.log("| 序号 | 任务ID | 北京时间 | 时长 | 错误原因 |");
console.log("|------|--------|----------|------|----------|");
const failed = db.prepare(`
  SELECT id, duration, created_at, COALESCE(error_message,'') err
  FROM tasks WHERE user_id=? AND status='error' AND deleted_at IS NULL AND date(created_at)=?
  ORDER BY created_at
`).all(uid, day);
failed.forEach((r, i) => {
  const t = beijing(r.created_at);
  const em = (r.err || '').replace(/\|/g, '\\|').substring(0, 50);
  console.log(`| ${i+1} | #${r.id} | ${t} | ${r.duration}s | ${em} |`);
});
console.log(`| **合计** | **${failed.length}条** | | | |`);

// Summary
const rel = db.prepare(
  "SELECT COUNT(*) cnt, SUM(locked_credits) s FROM credit_locks WHERE user_id=? AND status='released' AND date(created_at)=?"
).get(uid, day);

console.log("\n### 余额\n");
console.log("| 项目 | 金额 |");
console.log("|------|------|");
console.log("| 昨日剩余 (06-03) | 104 |");
console.log("| 01:48 yunyu76 充值 | +13,200 → 13,304 |");
console.log("| 08:44 yunyu83 充值 | +3,300 → 16,604 |");
console.log("| 33条成功消费 | -" + totalActual + " |");
console.log("| " + failed.length + "条失败释放 | 0 (未扣) |");
console.log("| **当前余额** | **" + (104+13200+3300-totalActual) + "** |");

console.log("\n### 手动统计 vs 实际\n");
console.log("| Duration | 手动统计 | 实际 | 差 |");
console.log("|----------|----------|------|-----|");
const durMap = {};
rows.forEach(r => { durMap[r.duration] = (durMap[r.duration]||0) + 1; });
const manual = {15:20, 14:1, 13:3, 12:1, 8:1, 7:1, 6:1, 5:0, 4:2};
Object.keys(manual).sort((a,b)=>Number(b)-Number(a)).forEach(d => {
  const m = manual[d]||0;
  const a = durMap[d]||0;
  const diff = a - m;
  console.log(`| ${d}s | ${m} | ${a} | ${diff>0?'+'+diff:diff} |`);
});
console.log(`| **合计** | **30** | **33** | **+3** |`);

db.close();
