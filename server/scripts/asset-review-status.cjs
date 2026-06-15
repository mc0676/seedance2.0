const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
console.log('=== 审核中素材总览 ===');
const s=db.prepare("SELECT review_status,COUNT(*) c,COUNT(CASE WHEN status='active' THEN 1 END) active FROM project_assets WHERE review_status IN ('pending','rejected','approved') GROUP BY review_status").all();
s.forEach(r=>console.log(r.review_status, r.c,'个','act='+r.active));

console.log('\n=== pending素材按年龄 ===');
const ages=db.prepare("SELECT CASE WHEN julianday('now')-julianday(created_at)<1 THEN '<1天' WHEN julianday('now')-julianday(created_at)<3 THEN '1-3天' WHEN julianday('now')-julianday(created_at)<7 THEN '3-7天' ELSE '>7天' END age,COUNT(*) c FROM project_assets WHERE review_status='pending' AND status='active' GROUP BY age ORDER BY MIN(created_at)").all();
ages.forEach(r=>console.log(r.age, r.c,'个'));

console.log('\n=== pending >3天 详情 ===');
const old=db.prepare("SELECT pa.id,pa.name,pa.file_type,pa.created_at,ag.name as gname,u.email FROM project_assets pa LEFT JOIN asset_groups ag ON ag.id=pa.asset_group_id LEFT JOIN users u ON u.id=pa.uploaded_by WHERE pa.review_status='pending' AND pa.status='active' AND julianday('now')-julianday(pa.created_at)>=3 ORDER BY pa.created_at").all();
old.forEach(r=>{
  const days=Math.round((Date.now()-new Date(r.created_at+'Z').getTime())/86400000);
  console.log('#'+r.id, r.name?.substring(0,20), r.file_type, days+'天', r.gname||'-', r.email||'?', r.created_at?.substring(0,10));
});

console.log('\n=== 最近pending（<1天）===');
const recent=db.prepare("SELECT pa.id,pa.name,pa.file_type,pa.created_at,ag.name as gname FROM project_assets pa LEFT JOIN asset_groups ag ON ag.id=pa.asset_group_id WHERE pa.review_status='pending' AND pa.status='active' AND julianday('now')-julianday(pa.created_at)<1 ORDER BY pa.created_at DESC LIMIT 10").all();
recent.forEach(r=>console.log('#'+r.id, r.name?.substring(0,25), r.file_type, r.gname||'-', r.created_at));

// 有volc_asset_id的pending（可通过API同步）
console.log('\n=== pending且有volc_asset_id（可同步）===');
const sync=db.prepare("SELECT COUNT(*) c FROM project_assets WHERE review_status='pending' AND volc_asset_id IS NOT NULL AND status='active'").get();
console.log(sync.c,'个可通过火山API同步');

// 无volc_asset_id的pending（无法同步）
const nosync=db.prepare("SELECT COUNT(*) c FROM project_assets WHERE review_status='pending' AND volc_asset_id IS NULL AND status='active'").get();
console.log(nosync.c,'个无volc_asset_id（无法同步）');
db.close();
