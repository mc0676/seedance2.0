const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
const u=db.prepare('SELECT id,email,credits FROM users WHERE email=?').get('1276083891@qq.com');
const all=db.prepare("SELECT credits_cost,status,created_at,task_id FROM usage_logs WHERE user_id=? AND created_at>='2026-06-03 00:00:00' ORDER BY created_at").all(u.id);
console.log('现在余额:',u.credits);
let sum=0;
all.forEach(r=>{
  sum+=r.credits_cost;
  const cst=new Date(new Date(r.created_at+'Z').getTime()+8*3600000).toISOString().substring(11,19);
  console.log(cst, r.credits_cost+'cr', r.status, 'task#'+r.task_id);
});
console.log('消耗:',sum+'cr');
console.log('08:00余额:',u.credits+sum);
db.close();
