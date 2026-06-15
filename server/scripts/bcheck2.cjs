const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
console.log('=== 分辨率偏差：提交480p vs 实扣积分 ===');
const t=db.prepare(`
  SELECT t.id,t.resolution as sub_res,ul.credits_cost,t.duration,t.ratio,
    cl.meta,ul.created_at,u.email
  FROM tasks t
  JOIN usage_logs ul ON ul.task_id=t.id
  JOIN users u ON u.id=t.user_id
  LEFT JOIN credit_locks cl ON cl.task_id=t.id
  WHERE t.resolution='480p' AND t.status='done'
    AND t.created_at>datetime('now','-2 days')
  ORDER BY ul.credits_cost DESC LIMIT 15
`).all();
t.forEach(r=>{
  let meta={};
  try{meta=JSON.parse(r.meta||'{}')}catch{}
  console.log(r.id, r.email, '提交:'+r.sub_res, r.duration+'s', r.ratio||'-', '实扣:'+r.credits_cost+'cr', 'metaRes:'+(meta.resolution||'?'));
});

console.log('\n=== 480p vs 720p 任务近24h统计 ===');
const stats=db.prepare(`
  SELECT t.resolution,COUNT(*) cnt,AVG(ul.credits_cost) avg_cr,MAX(ul.credits_cost) max_cr,MIN(ul.credits_cost) min_cr
  FROM tasks t JOIN usage_logs ul ON ul.task_id=t.id
  WHERE t.status='done' AND t.created_at>datetime('now','-1 day')
  GROUP BY t.resolution
`).all();
stats.forEach(r=>console.log(r.resolution||'NULL', r.cnt+'个', 'avg:'+Math.round(r.avg_cr)+'cr', 'max:'+r.max_cr+'cr', 'min:'+r.min_cr+'cr'));

// 显示未填resolution的任务
console.log('\n=== resolution=NULL 但计费559的任务样本 ===');
const n=db.prepare(`
  SELECT t.id,t.resolution,t.duration,t.ratio,ul.credits_cost,u.email
  FROM tasks t JOIN usage_logs ul ON ul.task_id=t.id JOIN users u ON u.id=t.user_id
  WHERE t.resolution IS NULL AND ul.credits_cost>500 AND t.created_at>datetime('now','-2 days')
  ORDER BY ul.credits_cost DESC LIMIT 10
`).all();
n.forEach(r=>console.log(r.id, r.email, r.resolution||'NULL', r.duration+'s', r.ratio||'-', r.credits_cost+'cr'));
db.close();
