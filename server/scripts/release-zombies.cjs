const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
console.log('=== 所有僵尸锁对应任务状态 ===');
const locks=db.prepare("SELECT cl.*,u.email FROM credit_locks cl JOIN users u ON u.id=cl.user_id WHERE cl.status='locked' ORDER BY cl.created_at").all();
let releaseTask=[], releaseEnh=[], releaseImg=[], releaseHh=[];

for(const l of locks){
  let taskStatus='?', type='?';
  if(l.task_id){
    type='task';
    const t=db.prepare('SELECT status,error_message FROM tasks WHERE id=?').get(l.task_id);
    taskStatus=t?t.status:'NOT_FOUND';
  } else if(l.enhancement_id){
    type='enhance';
    const e=db.prepare('SELECT status FROM video_enhancements WHERE id=?').get(l.enhancement_id);
    taskStatus=e?e.status:'NOT_FOUND';
  } else if(l.image_record_id){
    type='image';
    const i=db.prepare('SELECT status FROM image_records WHERE id=?').get(l.image_record_id);
    taskStatus=i?i.status:'NOT_FOUND';
  } else if(l.task_happyhorse_id){
    type='hh';
    const h=db.prepare('SELECT status FROM tasks_happyhorse WHERE id=?').get(l.task_happyhorse_id);
    taskStatus=h?h.status:'NOT_FOUND';
  }
  const rid=l.task_id||l.enhancement_id||l.image_record_id||l.task_happyhorse_id;
  const age=Math.round((Date.now()-new Date(l.created_at+'Z').getTime())/86400000);
  const recent=age<=1?'🔓解锁':'🔒保留';
  console.log(type, '#'+rid, taskStatus, l.locked_credits+'cr', l.email, age+'天前', recent);

  if(age<=1){
    if(type==='task') releaseTask.push(l.task_id);
    else if(type==='enhance') releaseEnh.push(l.enhancement_id);
    else if(type==='image') releaseImg.push(l.image_record_id);
    else if(type==='hh') releaseHh.push(l.task_happyhorse_id);
  }
}

console.log('\n=== 最近1天可解锁 ===');
console.log('task:',releaseTask.length, releaseTask.join(','));
console.log('enhance:',releaseEnh.length, releaseEnh.join(','));
console.log('image:',releaseImg.length, releaseImg.join(','));
console.log('hh:',releaseHh.length, releaseHh.join(','));

if(releaseTask.length+releaseEnh.length+releaseImg.length+releaseHh.length>0){
  console.log('\n执行解锁...');
  for(const tid of releaseTask){
    db.prepare("UPDATE credit_locks SET status='released',release_reason='zombie cleanup' WHERE task_id=? AND status='locked'").run(tid);
    console.log('task#'+tid,'已释放');
  }
  for(const eid of releaseEnh){
    db.prepare("UPDATE credit_locks SET status='released',release_reason='zombie cleanup' WHERE enhancement_id=? AND status='locked'").run(eid);
    console.log('enhance#'+eid,'已释放');
  }
  for(const iid of releaseImg){
    db.prepare("UPDATE credit_locks SET status='released',release_reason='zombie cleanup' WHERE image_record_id=? AND status='locked'").run(iid);
    console.log('image#'+iid,'已释放');
  }
  console.log('done');
} else { console.log('无最近1天僵尸锁'); }

// 结算done但未扣费的（不分时间，仅统计）
console.log('\n=== 任务done但锁未释放(未扣费) ===');
const doneUnpaid=db.prepare("SELECT t.id,t.status,cl.locked_credits,cl.created_at,u.email FROM tasks t JOIN credit_locks cl ON cl.task_id=t.id JOIN users u ON u.id=cl.user_id WHERE t.status='done' AND cl.status='locked'").all();
doneUnpaid.forEach(r=>console.log('task#'+r.id,r.status,r.locked_credits+'cr',r.email,r.created_at));
console.log(doneUnpaid.length+'条未扣费成功任务');
db.close();
