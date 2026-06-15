const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
const targets=db.prepare('SELECT id,email,credits FROM users WHERE credits BETWEEN 6400 AND 6700').all();
console.log('=== 余额6400~6700的用户 ===');
for(const u of targets){
  const l=db.prepare("SELECT SUM(locked_credits) s,COUNT(*) c FROM credit_locks WHERE user_id=? AND status='locked'").get(u.id);
  console.log(u.email, u.credits+'cr', '锁:'+(l.s||0)+'cr', l.c+'条');
}
// 如果没找到6460，扩大范围
const wider=db.prepare('SELECT id,email,credits FROM users WHERE credits BETWEEN 6300 AND 6700').all();
const found6460=wider.find(u=>u.credits===6460);
if(!found6460){
  console.log('\n无精确6460，最近5个:');
  wider.sort((a,b)=>Math.abs(a.credits-6460)-Math.abs(b.credits-6460)).slice(0,5).forEach(u=>console.log(u.email,u.credits+'cr'));
}

// 展示1276083891的生成记录
console.log('\n=== 1276083891@qq.com 最近10次生成 ===');
const u1=db.prepare('SELECT id,email,credits FROM users WHERE email=?').get('1276083891@qq.com');
if(u1){
  const tasks=db.prepare('SELECT t.id,t.resolution,t.duration,t.ratio,t.status,t.progress,t.created_at FROM tasks t WHERE t.user_id=? ORDER BY t.id DESC LIMIT 10').all(u1.id);
  tasks.forEach(t=>console.log('task#'+t.id, t.resolution||'?', t.duration+'s', t.ratio||'?', t.status, t.progress||'', t.created_at));
  const usage=db.prepare('SELECT SUM(credits_cost) s,COUNT(*) c FROM usage_logs WHERE user_id=? AND created_at>datetime("now","-1 day")').get(u1.id);
  console.log('今日消耗:',usage.s||0,'cr', usage.c,'次');
  const locks=db.prepare("SELECT id,locked_credits,task_id,created_at FROM credit_locks WHERE user_id=? AND status='locked'").all(u1.id);
  console.log('当前锁定:',locks.length>0?JSON.stringify(locks):'无');
}

// 找1288锁定的用户
console.log('\n=== 锁定1288cr的用户 ===');
const l1288=db.prepare("SELECT user_id,SUM(locked_credits) s FROM credit_locks WHERE status='locked' GROUP BY user_id HAVING s=1288 OR s=644 OR s=515").all();
l1288.forEach(l=>{
  const u=db.prepare('SELECT email,credits FROM users WHERE id=?').get(l.user_id);
  if(u) console.log(u.email, u.credits+'cr', '锁:'+l.s+'cr');
});
db.close();
