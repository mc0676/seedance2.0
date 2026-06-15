const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
console.log('=== 超1h僵尸锁详情 ===');
const locks=db.prepare("SELECT cl.*,u.email FROM credit_locks cl JOIN users u ON u.id=cl.user_id WHERE cl.status='locked' AND cl.created_at<datetime('now','-1 hour') ORDER BY cl.created_at").all();
locks.forEach(l=>console.log('id:',l.id,'user:',l.email,'credits:',l.locked_credits,'task:',l.task_id||l.image_record_id||l.enhancement_id||l.task_happyhorse_id,'created:',l.created_at));

console.log('\n=== 僵尸锁对应任务状态 ===');
for(const l of locks){
  if(l.task_id){
    const t=db.prepare('SELECT id,status,error_message FROM tasks WHERE id=?').get(l.task_id);
    if(t) console.log('task',l.task_id,'status:',t.status,'error:',(t.error_message||'').substring(0,60));
    else console.log('task',l.task_id,'NOT FOUND');
  } else if(l.enhancement_id){
    const e=db.prepare('SELECT id,status FROM video_enhancements WHERE id=?').get(l.enhancement_id);
    console.log('enhance',l.enhancement_id,e?e.status:'NOT FOUND');
  } else if(l.task_happyhorse_id){
    const h=db.prepare('SELECT id,status FROM tasks_happyhorse WHERE id=?').get(l.task_happyhorse_id);
    console.log('happyhorse',l.task_happyhorse_id,h?h.status:'NOT FOUND');
  } else if(l.image_record_id){
    const i=db.prepare('SELECT id,status FROM image_records WHERE id=?').get(l.image_record_id);
    console.log('image',l.image_record_id,i?i.status:'NOT FOUND');
  }
}
db.close();
