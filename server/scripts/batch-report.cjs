const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
const emails=[
'DOUCHU@outlook.com','932234764@qq.com','2323043253@qq.com','3457516476@qq.com','3355674297@qq.com',
'2980769884@qq.com','3394920492@qq.com','3540821692@qq.com','2543087641@qq.com','1254156553@qq.com',
'3330594861@qq.com','3398755978@qq.com','1165416949@qq.com','2146188985@qq.com','1369363842@qq.com',
'2676694254@qq.com','2899714251@qq.com','3082882262@qq.com','2146482552@qq.com','3356037985@qq.com',
'2694918188@qq.com','3415669424@qq.com','1814279459@qq.com','3587573649@qq.com','2746505750@qq.com',
'239029228@qq.com','656788826@qq.com','2431208577@qq.com','2737565043@qq.com','1870595942@qq.com',
'3314155921@qq.com','3301825134@qq.com','2952543354@qq.com','774489080@qq.com',
];
const phs=emails.map(()=>'?').join(',');
const since='2026-05-29 00:00:00';
let total=0,totalCalls=0,totalFail=0;
console.log('用户'.padEnd(28),'消耗'.padStart(8),'调用'.padStart(5),'失败'.padStart(5),'余额'.padStart(8),'注册'.padStart(12));
console.log('-'.repeat(70));
for(const e of emails){
  const u=db.prepare('SELECT id,email,credits,created_at FROM users WHERE email=?').get(e);
  if(!u){console.log(e.padEnd(28),'NOT FOUND');continue;}
  const s=db.prepare("SELECT COALESCE(SUM(credits_cost),0) spent,COUNT(*) c,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) f FROM usage_logs WHERE user_id=? AND created_at>=?").get(u.id,since);
  total+=s.spent; totalCalls+=s.c; totalFail+=s.f;
  console.log(u.email.padEnd(28),String(s.spent).padStart(8),String(s.c).padStart(5),String(s.f).padStart(5),String(u.credits).padStart(8),u.created_at.substring(0,10));
}
console.log('-'.repeat(70));
console.log('合计'.padEnd(28),String(total).padStart(8),String(totalCalls).padStart(5),String(totalFail).padStart(5));
db.close();
