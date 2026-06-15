const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');

// 1276083891 完整记录
console.log('=== 1276083891@qq.com 完整记录 ===');
const u1=db.prepare('SELECT id,email,credits FROM users WHERE email=?').get('1276083891@qq.com');
if(u1) console.log('余额:',u1.credits,'cr');
const ul=db.prepare("SELECT SUM(credits_cost) s,COUNT(*) c FROM usage_logs WHERE user_id=? AND created_at>datetime('now','-1 day')").get(u1.id);
console.log('今日消耗:',(ul.s||0)+'cr', ul.c+'次');

// 所有锁定用户
console.log('\n=== 所有有锁定的用户 ===');
const all=db.prepare("SELECT u.email,u.credits,SUM(cl.locked_credits) locked,COUNT(*) cnt FROM credit_locks cl JOIN users u ON u.id=cl.user_id WHERE cl.status='locked' GROUP BY cl.user_id ORDER BY locked DESC").all();
all.forEach(r=>console.log(r.email, r.credits+'cr', '锁:'+r.locked+'cr', r.cnt+'条'));

// 找锁定1288的
console.log('\n=== 锁定=1288 ===');
const l1288=all.filter(r=>r.locked===1288);
if(l1288.length) l1288.forEach(r=>console.log(r.email,r.credits+'cr'));
else console.log('无');
db.close();
