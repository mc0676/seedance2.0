const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
const emails=['2636924802@qq.com','2896475658@qq.com','94153144@qq.com'];
const since='2026-06-03 00:00:00';
for(const e of emails){
  const u=db.prepare('SELECT id,email,credits FROM users WHERE email=?').get(e);
  if(!u){console.log(e,'NOT FOUND');continue;}
  console.log('===',u.email,'余额:',u.credits,'===');
  const tasks=db.prepare('SELECT id,resolution,duration,ratio,model,status,error_message,created_at,completed_at FROM tasks WHERE user_id=? AND created_at>=? ORDER BY id').all(u.id,since);
  if(tasks.length===0){console.log('  无任务\n');continue;}
  tasks.forEach(t=>{
    const ul=db.prepare('SELECT credits_cost FROM usage_logs WHERE task_id=?').get(t.id);
    const cst=new Date(new Date(t.created_at+'Z').getTime()+8*3600000).toISOString().substring(11,19);
    console.log(cst,'task#'+t.id, t.resolution||'?', t.duration+'s', t.ratio||'?', t.status, ul?ul.credits_cost+'cr':'?', (t.error_message||'').substring(0,60));
  });
  // 查usage_logs也看下
  const uls=db.prepare("SELECT credits_cost,status,created_at,task_id FROM usage_logs WHERE user_id=? AND created_at>=? ORDER BY created_at").all(u.id,since);
  if(uls.length>0){
    console.log('  usage_logs:');
    uls.forEach(r=>{
      const cst=new Date(new Date(r.created_at+'Z').getTime()+8*3600000).toISOString().substring(11,19);
      console.log('   ',cst,'task#'+r.task_id, r.credits_cost+'cr', r.status);
    });
  }
  console.log('');
}
db.close();
