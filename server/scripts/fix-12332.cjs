const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
const tx=db.transaction(()=>{
  // 释放锁
  const cl=db.prepare("UPDATE credit_locks SET status='released',release_reason='zombie poll lost' WHERE task_id=12332 AND status='locked'").run();
  console.log('锁释放:',cl.changes,'条');
  // 标记error
  const t=db.prepare("UPDATE tasks SET status='error',error_message='任务超时未完成(17h)，已释放积分',updated_at=CURRENT_TIMESTAMP WHERE id=12332").run();
  console.log('任务更新:',t.changes,'条');
  // 验证
  const v=db.prepare('SELECT t.status,t.error_message,cl.status as lock_status,cl.locked_credits FROM tasks t LEFT JOIN credit_locks cl ON cl.task_id=t.id WHERE t.id=12332').get();
  console.log('任务状态:',v.status,'锁:',v.lock_status||'无');
  const u=db.prepare('SELECT email,credits FROM users WHERE email=?').get('94153144@qq.com');
  console.log('用户:',u.email,'余额:',u.credits+'cr');
  console.log('✅ 积分已返还（锁释放，未扣款）');
});
tx();
db.close();
