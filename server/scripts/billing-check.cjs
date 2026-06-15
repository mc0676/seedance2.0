const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
console.log('=== 提交480p但返回/计费720p的任务 ===');
// tasks表有resolution字段记录提交参数，usage_logs有credits_cost
const rows=db.prepare(`
  SELECT t.id,t.user_id,t.resolution as submitted,u.email,
    ul.credits_cost,ul.model,t.status,t.created_at
  FROM tasks t
  JOIN usage_logs ul ON ul.task_id=t.id
  JOIN users u ON u.id=t.user_id
  WHERE t.resolution='480p'
    AND t.created_at>datetime('now','-3 days')
  ORDER BY t.created_at DESC LIMIT 20
`).all();
console.log('近3天480p任务:',rows.length,'条');
rows.forEach(r=>console.log(r.id, r.email, '提交:'+r.resolution, r.credits_cost+'cr', r.model, r.status, r.created_at));

// 查HappyHorse任务是否有类似问题
console.log('\n=== HappyHorse 480p提交 ===');
const hh=db.prepare(`
  SELECT id,user_id,resolution,duration,credits_used,status,created_at
  FROM tasks_happyhorse
  WHERE resolution='480p'
    AND created_at>datetime('now','-3 days')
  ORDER BY created_at DESC LIMIT 10
`).all();
hh.forEach(r=>console.log(r.id, r.resolution, r.credits_used+'cr', r.duration+'s', r.status, r.created_at));

console.log('\n=== model_pricing表 480p vs 720p定价对比 ===');
const pricing=db.prepare("SELECT model_key,label,price_no_video_low,price_no_video_high,price_with_video_low,price_with_video_high FROM model_pricing WHERE enabled=1").all();
pricing.forEach(r=>console.log(r.model_key, r.label, 'nolow:'+r.price_no_video_low, 'nohigh:'+r.price_no_video_high, 'withlow:'+r.price_with_video_low, 'withhigh:'+r.price_with_video_high));

db.close();
