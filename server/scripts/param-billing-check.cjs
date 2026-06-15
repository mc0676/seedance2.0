const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
console.log('=== 最近任务: 提交参数 vs 实扣积分 ===');
const tasks=db.prepare(`
  SELECT t.id,t.resolution as sub_res,t.duration,t.ratio,t.model,
    ul.credits_cost as actual_cr,t.status,
    cl.meta,
    u.email
  FROM tasks t
  JOIN usage_logs ul ON ul.task_id=t.id
  JOIN users u ON u.id=t.user_id
  LEFT JOIN credit_locks cl ON cl.task_id=t.id
  WHERE t.created_at>datetime('now','-2 days') AND ul.credits_cost>0
  ORDER BY t.id DESC LIMIT 30
`).all();

// Calculate expected credits from meta params
const RES={ '480p':{w:858,h:480}, '720p':{w:1280,h:720}, '1080p':{w:1920,h:1080} };
function calcTokens(params){
  const r=RES[params.resolution||'720p']||RES['720p'];
  const [rw,rh]=(params.ratio||'16:9').split(':').map(Number);
  if(!rw||!rh) return Math.ceil(((params.inputDurationSec||0)+(params.outputDurationSec||5))*r.w*r.h*24/1024);
  const area=r.w*r.h,ratio=Math.max(rw,rh)/Math.min(rw,rh),short=Math.sqrt(area/ratio),long=area/short;
  return Math.ceil(((params.inputDurationSec||0)+(params.outputDurationSec||5))*short*long*24/1024);
}

let mismatch=0;
tasks.forEach(t=>{
  let meta={};
  try{meta=JSON.parse(t.meta||'{}')}catch{}
  const subRes=t.sub_res||meta.resolution||'?';
  const dur=t.duration||meta.outputDurationSec||'?';
  const ratio=t.ratio||meta.ratio||'?';
  const tokens=calcTokens({resolution:subRes,ratio:String(ratio),outputDurationSec:Number(dur),inputDurationSec:0});
  // seedance-2.0-fast has price_no_video_low=37
  const expectedCr=Math.ceil((tokens*37/1000000)*100);
  const diff=Math.abs(t.actual_cr-expectedCr);
  const flag=diff>50?'⚠️':'';
  if(diff>50)mismatch++;
  console.log('#'+t.id, t.email,'提交:'+subRes,dur+'s',ratio,'预计:',expectedCr+'cr','实扣:'+t.actual_cr+'cr',flag||'✓', t.status);
});
console.log('\n偏差>50cr的任务:',mismatch,'/',tasks.length);

console.log('\n=== 锁定中但任务已完成的 ===');
const zombies=db.prepare(`
  SELECT cl.id,cl.locked_credits,cl.created_at,t.id as tid,t.status,u.email
  FROM credit_locks cl JOIN tasks t ON t.id=cl.task_id JOIN users u ON u.id=cl.user_id
  WHERE cl.status='locked' AND t.status IN ('done','error')
  ORDER BY cl.created_at DESC LIMIT 15
`).all();
zombies.forEach(z=>console.log('lock#'+z.id,z.email,'task#'+z.tid,z.status,z.locked_credits+'cr',z.created_at));

db.close();
