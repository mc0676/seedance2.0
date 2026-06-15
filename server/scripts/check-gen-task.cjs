const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');

// 1) 直接查 task#1627
console.log('=== task#1627 ===');
const t1627=db.prepare('SELECT t.*,u.email FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.id=1627').get();
if(t1627) console.log(t1627.email, t1627.resolution, t1627.duration+'s', t1627.status, t1627.progress, t1627.created_at, t1627.completed_at);

// 2) 5/3 16:00~17:00 CST = 08:00~09:00 UTC
console.log('\n=== 05/03 16:00~17:00 CST ===');
const tasks=db.prepare("SELECT t.id,t.user_id,t.status,t.resolution,t.duration,t.progress,t.created_at,u.email FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.created_at BETWEEN '2026-05-03 08:00:00' AND '2026-05-03 09:00:00' ORDER BY t.id").all();
console.log(tasks.length,'条');
tasks.forEach(t=>console.log('task#'+t.id, t.email, t.resolution||'?', t.duration+'s', t.status, t.progress||'-', t.created_at));

// 3) 所有generating且超过30min的
console.log('\n=== 卡在generating >30min ===');
const gen=db.prepare("SELECT t.id,t.user_id,t.status,t.resolution,t.duration,t.progress,t.created_at,u.email FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.status='generating' AND t.created_at<datetime('now','-30 minutes') ORDER BY t.id").all();
gen.forEach(t=>console.log('task#'+t.id, t.email, t.resolution||'?', t.duration+'s', t.status, t.progress||'-', t.created_at));

// 4) 所有generating
console.log('\n=== 当前所有generating ===');
const all=db.prepare("SELECT t.id,t.user_id,t.status,t.resolution,t.duration,t.progress,t.created_at,u.email FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.status='generating' ORDER BY t.id DESC LIMIT 10").all();
all.forEach(t=>console.log('task#'+t.id, t.email, t.resolution||'?', t.duration+'s', t.status, t.progress||'-', t.created_at));
db.close();
