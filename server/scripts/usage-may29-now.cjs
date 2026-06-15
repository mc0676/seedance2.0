const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
const since='2026-05-29 00:00:00';
console.log('范围: 5/29 00:00 ~ 现在 (UTC)');
console.log('');

// 总览
const t=db.prepare("SELECT SUM(credits_cost) spent,COUNT(*) calls,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) fail FROM usage_logs WHERE created_at>=?").get(since);
console.log('总消耗:',(t.spent||0).toLocaleString(),'cr  调用:',t.calls,'  失败:',t.fail||0);

// 按天
console.log('\n=== 按天 ===');
const byDay=db.prepare("SELECT date(created_at) day,SUM(credits_cost) s,COUNT(*) c,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) f FROM usage_logs WHERE created_at>=? GROUP BY day ORDER BY day").all(since);
byDay.forEach(r=>console.log(r.day, r.s.toLocaleString().padStart(8),'cr', String(r.c).padStart(5),'次','失败'+r.f));

// 按小时
console.log('\n=== 近48h按小时 ===');
const byHr=db.prepare("SELECT strftime('%m-%d %H:00',created_at) h,SUM(credits_cost) s,COUNT(*) c FROM usage_logs WHERE created_at>=datetime('now','-2 days') GROUP BY h ORDER BY h").all();
byHr.forEach(r=>console.log(r.h, r.s.toLocaleString().padStart(8),'cr', String(r.c).padStart(4),'次'));

// 按模型
console.log('\n=== 按模型 ===');
const byModel=db.prepare("SELECT model,SUM(credits_cost) s,COUNT(*) c FROM usage_logs WHERE created_at>=? GROUP BY model ORDER BY s DESC").all(since);
byModel.forEach(r=>console.log(r.model||'?', r.s.toLocaleString().padStart(8),'cr', String(r.c).padStart(5),'次'));

// TOP用户
console.log('\n=== TOP20用户 ===');
const top=db.prepare("SELECT u.email,SUM(ul.credits_cost) s,COUNT(*) c,SUM(CASE WHEN ul.status='failed' THEN 1 ELSE 0 END) f FROM usage_logs ul JOIN users u ON u.id=ul.user_id WHERE ul.created_at>=? GROUP BY ul.user_id ORDER BY s DESC LIMIT 20").all(since);
top.forEach(r=>console.log(r.email, r.s.toLocaleString().padStart(8),'cr', String(r.c).padStart(4),'次','失败'+r.f));
db.close();
