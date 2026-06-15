const p=require('path'),D=require('better-sqlite3'),db=new D(p.resolve(__dirname,'../data/seedance.db'));
const emails=['3258527172@qq.com','1919889221@qq.com','2636924802@qq.com','2241546591@qq.com','94153144@qq.com','2896475658@qq.com'];
const phs=emails.map(()=>'?').join(',');
const users=db.prepare(`SELECT id,email,role,credits,unlimited_credits FROM users WHERE email IN (${phs})`).all(...emails);
console.log(JSON.stringify(users,null,2));
// 汇总
const total=users.filter(u=>emails.slice(0,5).includes(u.email)).reduce((s,u)=>s+u.credits,0);
console.log('源用户总积分:',total);
const target=users.find(u=>u.email==='2896475658@qq.com');
console.log('目标用户:',target?`id=${target.id} credits=${target.credits}`:'NOT FOUND');
db.close();
