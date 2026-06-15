const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
// 找pending素材所在项目
const projects=db.prepare("SELECT DISTINCT project_id FROM project_assets WHERE review_status='pending' AND volc_asset_id IS NOT NULL AND status='active'").all();
console.log('pending所在项目:',projects.map(p=>p.project_id));

// 逐项目调火山API同步
async function syncAssets(projectId) {
  const assets=db.prepare("SELECT id,volc_asset_id,name FROM project_assets WHERE project_id=? AND review_status='pending' AND volc_asset_id IS NOT NULL AND status='active'").all(projectId);
  console.log('项目'+projectId+':',assets.length,'个pending');
  for(const a of assets){
    try{
      const r=await fetch('http://localhost:3001/api/admin/volc-native/asset?id='+encodeURIComponent(a.volc_asset_id),{
        headers:{'X-Session-ID':'ce164a505d09add07fb32b56bc25193b35813e8de57efd2126de7c64fb88912f'}
      });
      const d=await r.json();
      if(d.success && d.data){
        const status=(d.data.Status==='Active'||d.data.Status==='approved')?'approved':(d.data.Status==='Failed'||d.data.Status==='rejected')?'rejected':'pending';
        if(status!=='pending'){
          db.prepare('UPDATE project_assets SET review_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,a.id);
          console.log('  #'+a.id, a.name,'→',status);
        } else {
          console.log('  #'+a.id, a.name,'→ 仍是pending');
        }
      }
    }catch(e){console.error('  #'+a.id,'失败:',e.message);}
  }
}

async function main(){
  for(const p of projects){
    await syncAssets(p.project_id);
  }
  const remaining=db.prepare("SELECT COUNT(*) c FROM project_assets WHERE review_status='pending' AND status='active'").get();
  console.log('\n同步后剩余pending:',remaining.c);
}
main().then(()=>db.close()).catch(e=>{console.error(e);db.close();});
