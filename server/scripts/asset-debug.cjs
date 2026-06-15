const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
const aid='asset-20260503111653-kerfs';
console.log('=== 查找资产:',aid,'===');

// project_assets
const pa=db.prepare('SELECT * FROM project_assets WHERE volc_asset_id=?').get(aid);
if(pa) console.log('project_assets:', pa.name, 'project_id:', pa.project_id, 'group_id:', pa.asset_group_id, 'status:', pa.status, 'review:', pa.review_status);
else console.log('project_assets: NOT FOUND');

// task_assets (通过 image_uri)
const ta=db.prepare("SELECT id,task_id,asset_type,image_uri FROM task_assets WHERE image_uri LIKE ?").all('%kerfs%');
console.log('task_assets引用:', ta.length, '条');
ta.forEach(r=>console.log('  task#'+r.task_id, r.asset_type, r.image_uri));

// 查包含这个asset引用的任务
const tasks=db.prepare("SELECT id,user_id,status,error_message,created_at FROM tasks WHERE error_message LIKE '%kerfs%' OR error_message LIKE '%20260503111653%' ORDER BY id DESC LIMIT 10").all();
console.log('关联任务:', tasks.length, '条');
tasks.forEach(t=>{
  const u=db.prepare('SELECT email FROM users WHERE id=?').get(t.user_id);
  console.log('  task#'+t.id, u?u.email:'?', t.status, (t.error_message||'').substring(0,120), t.created_at);
});

// asset_groups里找
const ag=db.prepare('SELECT * FROM asset_groups WHERE volc_group_id LIKE ?').all('%202605031116%');
console.log('asset_groups:', ag.length, '条');
ag.forEach(g=>console.log('  ', g.id, g.name, g.volc_group_id, 'volc_id:', g.volc_id));

// 看看这个asset应该属于哪个volc_id
console.log('\n=== 查最近使用kerfs资产的错误 ===');
const errs=db.prepare("SELECT id,user_id,error_message,created_at FROM tasks WHERE error_message LIKE '%not found%' ORDER BY id DESC LIMIT 10").all();
errs.forEach(e=>{
  const u=db.prepare('SELECT email FROM users WHERE id=?').get(e.user_id);
  console.log('task#'+e.id, u?u.email:'?', (e.error_message||'').substring(0,150), e.created_at);
});
db.close();
