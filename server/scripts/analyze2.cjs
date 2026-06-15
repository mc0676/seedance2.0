const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
const topEmails=['1165416949@qq.com','2694918188@qq.com','2746505750@qq.com','3587573649@qq.com','774489080@qq.com','3457516476@qq.com','3314155921@qq.com','3398755978@qq.com','3330594861@qq.com','1369363842@qq.com','2146188954@qq.com','3540821692@qq.com'];
console.log('=== 账号注册时间+余额 ===');
for(const e of topEmails){
  const u=db.prepare('SELECT email,credits,unlimited_credits,role,created_at FROM users WHERE email=?').get(e);
  if(u) console.log(u.email, u.credits+'cr', u.unlimited_credits?'无限':'', u.role, u.created_at);
  else console.log(e,'NOT FOUND');
}
console.log('\n=== 近24h按小时消耗 ===');
const h=db.prepare("SELECT strftime('%m-%d %H:00',created_at) h, SUM(credits_cost) s, COUNT(*) c FROM usage_logs WHERE created_at>datetime('now','-1 day') GROUP BY h ORDER BY h").all();
h.forEach(r=>console.log(r.h, r.s+'cr', r.c+'次'));
console.log('\n=== 任务类型分布 ===');
const m=db.prepare("SELECT model,SUM(credits_cost) s,COUNT(*) c FROM usage_logs WHERE created_at>datetime('now','-1 day') GROUP BY model ORDER BY s DESC").all();
m.forEach(r=>console.log(r.model, r.s+'cr', r.c+'次'));
db.close();
