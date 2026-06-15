const D = require('/app/server/node_modules/better-sqlite3');
const db = new D('/app/server/data/seedance.db');

console.log("=== 最近10条 error 完整上游信息 ===\n");
const rows = db.prepare(`
  SELECT t.id, t.status, u.email, t.model, t.ratio, t.duration, t.resolution,
         t.task_kind, t.error_message, t.created_at
  FROM tasks t LEFT JOIN users u ON u.id=t.user_id
  WHERE t.status='error' AND t.deleted_at IS NULL
  ORDER BY t.created_at DESC LIMIT 10
`).all();

rows.forEach((r, i) => {
  console.log("─── " + (i+1) + ". #" + r.id + " ───");
  console.log("用户: " + (r.email||'?'));
  console.log("类型: " + r.task_kind + "  模型: " + r.model);
  console.log("参数: " + r.ratio + " " + r.duration + "s " + r.resolution);
  console.log("时间: " + (r.created_at||'?'));
  console.log("上游错误:");
  console.log(r.error_message || '(无)');
  console.log("");
});

console.log("\n=== image_records 最近 error 完整信息 ===\n");
const imgRows = db.prepare(`
  SELECT * FROM image_records WHERE status='error'
  ORDER BY created_at DESC LIMIT 5
`).all();
imgRows.forEach((r, i) => {
  console.log("─── " + (i+1) + ". #" + r.id + " ───");
  console.log("用户ID: " + r.user_id + "  模型: " + r.model);
  console.log("参数: " + r.size_label + "  prompt: " + (r.prompt||'').substring(0,60));
  console.log("时间: " + (r.created_at||'?'));
  console.log("上游错误:");
  console.log(r.error_message || '(无)');
  console.log("");
});

// Also check the audio_intermediate user's reference image issue
console.log("\n=== 3540821692@qq.com 最近 audio_intermediate 参数 ===");
const audioTasks = db.prepare(`
  SELECT t.id, t.prompt, t.created_at,
    (SELECT file_path FROM task_assets WHERE task_id=t.id AND asset_type='image' LIMIT 1) ref_img
  FROM tasks t
  WHERE t.user_id=(SELECT id FROM users WHERE email='3540821692@qq.com')
    AND t.status='error' AND t.task_kind='audio_intermediate'
  ORDER BY t.created_at DESC LIMIT 3
`).all();
audioTasks.forEach(r => {
  console.log("#" + r.id + " " + r.created_at);
  console.log("  prompt: " + (r.prompt||'').substring(0,60));
  console.log("  ref_img: " + (r.ref_img||'无'));
});

db.close();
