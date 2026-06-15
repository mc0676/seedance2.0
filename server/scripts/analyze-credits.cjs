const D=require('better-sqlite3'),db=new D('/app/server/data/seedance.db');
console.log('=== 近24h消耗TOP10 ===');
const top=db.prepare(`SELECT u.email,SUM(ul.credits_cost) spent,COUNT(*) calls,
  SUM(CASE WHEN ul.status='failed' THEN 1 ELSE 0 END) failed
  FROM usage_logs ul JOIN users u ON u.id=ul.user_id
  WHERE ul.created_at>datetime('now','-1 day')
  GROUP BY ul.user_id ORDER BY spent DESC LIMIT 10`).all();
top.forEach(r=>console.log(r.email, r.spent+'cr', r.calls+'calls', r.failed+'fail'));

console.log('\n=== 失败浪费积分 TOP10 ===');
const w=db.prepare(`SELECT u.email,ul.model,ul.credits_cost,ul.error_message,ul.created_at
  FROM usage_logs ul JOIN users u ON u.id=ul.user_id
  WHERE ul.status='failed' AND ul.credits_cost>0 AND ul.created_at>datetime('now','-1 day')
  ORDER BY ul.credits_cost DESC LIMIT 10`).all();
w.forEach(r=>console.log(r.email, r.model, r.credits_cost+'cr', (r.error_message||'').slice(0,100), r.created_at));
if(w.length===0) console.log('无');

console.log('\n=== 今日统计 ===');
const today=db.prepare(`SELECT SUM(credits_cost) total,COUNT(*) calls,
  SUM(CASE WHEN status='failed' THEN credits_cost ELSE 0 END) wasted
  FROM usage_logs WHERE created_at>datetime('now','start of day')`).get();
console.log('消耗:',today.total,'cr  浪费:',today.wasted,'cr  调用:',today.calls);

console.log('\n=== 负余额用户 ===');
const neg=db.prepare('SELECT email,credits FROM users WHERE credits<0 ORDER BY credits LIMIT 10').all();
neg.forEach(r=>console.log(r.email,r.credits));
if(neg.length===0) console.log('无');

// 检查是否有异常大额单次消耗
console.log('\n=== 单次大额消耗(>100cr) ===');
const big=db.prepare(`SELECT u.email,ul.credits_cost,ul.model,ul.status,ul.created_at
  FROM usage_logs ul JOIN users u ON u.id=ul.user_id
  WHERE ul.credits_cost>100 AND ul.created_at>datetime('now','-1 day')
  ORDER BY ul.credits_cost DESC LIMIT 10`).all();
big.forEach(r=>console.log(r.email, r.credits_cost+'cr', r.model, r.status, r.created_at));
if(big.length===0) console.log('无');

db.close();
