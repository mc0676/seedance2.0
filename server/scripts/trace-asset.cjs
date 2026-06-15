const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
const aid='asset-20260603114017-ql6ms';
const reqId='021780458159743b9f1f8d82739748c57f1ca9984b4fb5e5b351d';
console.log('=== 资产:',aid,'===');
const pa=db.prepare('SELECT * FROM project_assets WHERE volc_asset_id=?').get(aid);
if(pa){
  console.log('名称:',pa.name,'项目:',pa.project_id,'组:',pa.asset_group_id);
  console.log('状态:',pa.status,'审核:',pa.review_status,'类型:',pa.file_type);
  console.log('volc_id:',pa.volc_id);
  const ag=db.prepare('SELECT * FROM asset_groups WHERE id=?').get(pa.asset_group_id);
  console.log('素材组:',ag?ag.name:'?','volc_group_id:',ag?ag.volc_group_id:'?','volc_id:',ag?ag.volc_id:'?');
  const proj=db.prepare('SELECT id,name,volc_id FROM projects WHERE id=?').get(pa.project_id);
  console.log('项目:',proj?proj.name:'?','volc_id:',proj?proj.volc_id:'?');
} else { console.log('NOT FOUND in project_assets'); }

console.log('\n=== 查包含此asset的任务 ===');
const tasks=db.prepare("SELECT t.id,t.user_id,t.status,t.error_message,t.created_at FROM tasks t WHERE t.error_message LIKE '%ql6ms%' OR t.error_message LIKE ? ORDER BY t.id DESC LIMIT 5").all('%'+reqId.substring(0,30)+'%');
if(tasks.length===0) console.log('任务中未找到，搜索请求ID...');
const byReq=db.prepare("SELECT t.id,t.user_id,t.status,t.error_message,t.created_at FROM tasks t WHERE t.error_message LIKE '%"+reqId.substring(0,40)+"%' COLLATE NOCASE").all();
byReq.forEach(t=>{
  const u=db.prepare('SELECT email FROM users WHERE id=?').get(t.user_id);
  console.log('task#'+t.id, u?u.email:'?', t.status, t.created_at);
  console.log('  error:',(t.error_message||'').substring(0,200));
});

// 查最近同类型错误
console.log('\n=== 最近1h asset not found 错误 ===');
const recent=db.prepare("SELECT t.id,u.email,t.error_message,t.created_at FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.error_message LIKE '%asset%not found%' AND t.created_at>datetime('now','-1 hour') ORDER BY t.id DESC LIMIT 10").all();
recent.forEach(r=>console.log('task#'+r.id, r.email, r.created_at, (r.error_message||'').substring(0,150)));

db.close();
