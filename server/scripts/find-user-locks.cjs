const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');

// 查最近有生成中任务的用户（progress字段有值或status=generating）
const gen=db.prepare("SELECT user_id,COUNT(*) cnt FROM tasks WHERE status='generating' GROUP BY user_id ORDER BY cnt DESC LIMIT 10").all();
console.log('=== 有生成中任务的用户 ===');
for(const g of gen){
  const u=db.prepare('SELECT id,email,credits FROM users WHERE id=?').get(g.user_id);
  if(!u) continue;
  const locked=db.prepare("SELECT SUM(locked_credits) total,COUNT(*) cnt FROM credit_locks WHERE user_id=? AND status='locked'").get(g.user_id);
  console.log(u.email, u.credits+'cr', '生成中:'+g.cnt+'个', '锁定:'+(locked.total||0)+'cr');
  const details=db.prepare("SELECT id,locked_credits,task_id,created_at FROM credit_locks WHERE user_id=? AND status='locked'").all(g.user_id);
  details.forEach(d=>{
    const t=d.task_id?db.prepare('SELECT id,status,resolution,duration,progress FROM tasks WHERE id=?').get(d.task_id):null;
    console.log('  lock#'+d.id, d.locked_credits+'cr', 'task#'+d.task_id, t?t.status:'?', t?t.progress||'-':'');
  });
}

// 也查余额附近(6000-7000)且有锁定的
console.log('\n=== 余额6000-7000且有锁定的用户 ===');
const nearby=db.prepare("SELECT u.id,u.email,u.credits,SUM(cl.locked_credits) locked FROM users u JOIN credit_locks cl ON cl.user_id=u.id WHERE u.credits BETWEEN 6000 AND 7000 AND cl.status='locked' GROUP BY u.id").all();
nearby.forEach(r=>console.log(r.email, r.credits+'cr', '锁定:'+r.locked+'cr'));
db.close();
