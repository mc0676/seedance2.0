/**
 * 手动恢复卡在 generating 状态的任务
 *
 * 用法：node recover-stuck-tasks.cjs [--dry-run]
 *   --dry-run  仅查询，不实际修改 DB
 */
const DRY_RUN = process.argv.includes('--dry-run');

const D = require('/app/server/node_modules/better-sqlite3');
const db = new D('/app/server/data/seedance.db');

const ARK_BASE_URL = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';

// ── 积分计算（对齐 pricingService.actualCredits） ──

function getModelPricing(modelKey) {
  return db.prepare('SELECT * FROM model_pricing WHERE model_key = ? AND enabled = 1').get(modelKey);
}

function actualCredits(modelKey, tokens, params = {}) {
  const pricing = getModelPricing(modelKey);
  if (!pricing) { console.warn('  无 model_pricing，使用 fallback'); return Math.ceil(tokens * 0.028); }

  const hasVideo = !!(params.videoUrl || params.video_url);
  const resolution = params.resolution || '720p';
  const isHigh = resolution === '1080p';
  let unitPriceYuanPerMTok; // 元/百万tokens
  if (hasVideo) {
    unitPriceYuanPerMTok = isHigh ? pricing.price_with_video_high : pricing.price_with_video_low;
  } else {
    unitPriceYuanPerMTok = isHigh ? pricing.price_no_video_high : pricing.price_no_video_low;
  }
  const yuan = (tokens * unitPriceYuanPerMTok) / 1_000_000;
  return Math.ceil(yuan * 100);
}

// ── 查询 Ark API ──

async function getArkTask(apiKey, taskId) {
  const resp = await fetch(`${ARK_BASE_URL}/contents/generations/tasks/${taskId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return await resp.json();
}

// ── 主逻辑 ──

async function main() {
  const tasks = db.prepare(`
    SELECT t.*, vkg.ark_model_key
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN volc_key_groups vkg ON vkg.id = p.volc_id
    WHERE t.status = 'generating'
      AND t.deleted_at IS NULL
      AND (t.submit_id IS NOT NULL OR t.history_id IS NOT NULL)
    ORDER BY t.created_at
  `).all();

  console.log(`发现 ${tasks.length} 个 generating 任务\n`);

  for (const t of tasks) {
    const arkTaskId = t.submit_id || t.history_id;
    const apiKey = t.ark_model_key;
    console.log(`─── #${t.id} ${t.task_kind} model=${t.model} ───`);
    console.log(`  arkTaskId: ${arkTaskId}`);
    console.log(`  prompt: ${(t.prompt || '').slice(0, 50)}`);

    if (!apiKey) {
      console.log(`  ❌ 无 API Key，跳过`);
      continue;
    }

    let result;
    try {
      result = await getArkTask(apiKey, arkTaskId);
    } catch (e) {
      console.log(`  ❌ Ark 查询失败: ${e.message}`);
      continue;
    }

    const status = result.status;
    console.log(`  Ark 状态: ${status}`);

    if (status === 'succeeded') {
      const videoUrl = result.content?.video_url || null;
      const tokens = Number(result.usage?.total_tokens) || Number(result.usage?.completion_tokens) || 0;

      if (!videoUrl) {
        console.log(`  ⚠️ succeeded 但无 video_url，跳过`);
        continue;
      }

      // 计算积分
      const credits = actualCredits(t.model, tokens, {
        videoUrl,
        resolution: t.resolution,
      });

      // 查积分锁状态
      const lock = db.prepare('SELECT * FROM credit_locks WHERE task_id = ?').get(t.id);

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] → done, video_url=${videoUrl.slice(0,50)}... tokens=${tokens} credits=${credits}`);
        if (lock && lock.status === 'locked') {
          console.log(`  [DRY-RUN] settle 积分锁 #${lock.id}: ${lock.locked_credits}→${credits} (返还 ${lock.locked_credits - credits})`);
        }
      } else {
        db.prepare(`
          UPDATE tasks SET status='done', video_url=?, download_status='pending',
            progress='', error_message=NULL, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(videoUrl, t.id);

        // settle 积分
        if (lock && lock.status === 'locked') {
          const finalCredits = Math.max(0, Math.floor(credits));
          const refund = lock.locked_credits - finalCredits;

          const user = db.prepare('SELECT credits, unlimited_credits FROM users WHERE id=?').get(t.user_id);
          if (user && !user.unlimited_credits) {
            const newCredits = Math.max(0, user.credits - finalCredits);
            db.prepare('UPDATE users SET credits=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(newCredits, t.user_id);
            console.log(`  扣积分: ${user.credits}→${newCredits} (实扣${finalCredits}, 返还${refund})`);
          } else {
            console.log(`  无限额度，实扣=${finalCredits}`);
          }

          db.prepare(`
            UPDATE credit_locks SET status='settled', actual_credits=?, settled_at=CURRENT_TIMESTAMP WHERE id=?
          `).run(finalCredits, lock.id);

          // usage_logs
          db.prepare(`
            INSERT INTO usage_logs (user_id, task_id, model, action, credits_cost, status)
            VALUES (?, ?, ?, 'generate_video', ?, 'success')
          `).run(t.user_id, t.id, t.model, finalCredits);
        } else {
          console.log(`  ⚠️ 积分锁 ${lock ? lock.status : '不存在'}，跳过结算`);
        }

        console.log(`  ✅ 已恢复 → done, tokens=${tokens} credits=${credits} video=${videoUrl.slice(0, 60)}`);
      }

    } else if (status === 'failed') {
      const errMsg = result.error?.message || result.error?.code || 'Ark 任务失败';

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] → error: ${errMsg}`);
      } else {
        db.prepare(`
          UPDATE tasks SET status='error', error_message=?, progress='',
            completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(errMsg, t.id);

        const lock = db.prepare('SELECT * FROM credit_locks WHERE task_id=? AND status=?').get(t.id, 'locked');
        if (lock) {
          db.prepare(`
            UPDATE credit_locks SET status='released', release_reason=?, settled_at=CURRENT_TIMESTAMP WHERE id=?
          `).run('手动恢复：' + errMsg, lock.id);
          console.log(`  释放积分锁: ${lock.locked_credits}`);
        }

        console.log(`  ❌ 已标记 → error: ${errMsg}`);
      }

    } else {
      // pending / running / queued — 仍在生成中
      console.log(`  ⏳ 仍在生成中 (${status})，不处理`);
    }
  }

  // 汇总
  const remaining = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status='generating' AND deleted_at IS NULL").get();
  console.log(`\n===== 恢复后剩余 generating: ${remaining.c} =====`);
}

main()
  .then(() => { console.log('完成'); db.close(); })
  .catch(e => { console.error(e); db.close(); process.exit(1); });
