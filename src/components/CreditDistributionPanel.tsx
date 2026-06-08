import { useState, useEffect } from 'react';
import { formatDateTime } from '../utils/datetime';
import { useApp } from '../context/AppContext';
import {
  fetchCreditDistributions,
  fetchDistributionSummary,
  fetchAdminQuotas,
  updateAdminQuota,
  takeBackDistribution,
  recycleTeamCredits,
  type DistributionLogItem,
  type DistributionSummary,
  type AdminQuotaItem,
} from '../services/authService';

const METHOD_LABELS: Record<string, string> = {
  activation_code: '激活码充值',
  activation_code_daily: '激活码充值',
  manual_set: '后台手动调分',
  manual_add: '后台手动增加',
  checkin: '签到',
  self_paying: '管理员自费发分',
  code_refund: '自费发分退还',
  recycling: '积分回收',
};

const METHOD_COLORS: Record<string, string> = {
  activation_code: 'bg-blue-500/20 text-blue-400',
  activation_code_daily: 'bg-sky-400/20 text-sky-300',
  manual_set: 'bg-amber-500/20 text-amber-400',
  manual_add: 'bg-emerald-500/20 text-emerald-400',
  checkin: 'bg-purple-500/20 text-purple-400',
  self_paying: 'bg-red-500/20 text-red-400',
  code_refund: 'bg-teal-500/20 text-teal-400',
  recycling: 'bg-orange-500/20 text-orange-400',
};

const PAGE_SIZE = 10;

function getDefaultStartDate() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split('T')[0];
}

function getDefaultEndDate() {
  return new Date().toISOString().split('T')[0];
}

export default function CreditDistributionPanel() {
  const [startDate, setStartDate] = useState(getDefaultStartDate);
  const [endDate, setEndDate] = useState(getDefaultEndDate);
  const [method, setMethod] = useState('');
  const [page, setPage] = useState(1);
  const [includeSelfPaid, setIncludeSelfPaid] = useState(false);

  const [rows, setRows] = useState<DistributionLogItem[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 });
  const [summary, setSummary] = useState<DistributionSummary | null>(null);
  const [loading, setLoading] = useState(false);

  // 额度管理
  const { currentUser } = useApp();
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const isUser = !isSuperAdmin && currentUser?.role !== 'admin';
  const [quotaModalOpen, setQuotaModalOpen] = useState(false);
  const [quotaList, setQuotaList] = useState<AdminQuotaItem[]>([]);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [editingQuota, setEditingQuota] = useState<{ adminId: number; totalQuota: string; dailyQuota: string } | null>(null);
  const [quotaSaving, setQuotaSaving] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [distRes, sumRes] = await Promise.all([
        fetchCreditDistributions({ page, pageSize: PAGE_SIZE, startDate, endDate, method: method || undefined }),
        fetchDistributionSummary({ startDate, endDate }),
      ]);
      setRows(distRes.rows);
      setPagination(distRes.pagination);
      setSummary(sumRes);
    } catch (e) {
      console.error('Failed to load distribution data', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [page, startDate, endDate, method]);

  const openQuotaModal = async () => {
    setQuotaModalOpen(true);
    setQuotaLoading(true);
    try {
      const list = await fetchAdminQuotas();
      setQuotaList(list);
    } catch {} finally {
      setQuotaLoading(false);
    }
  };

  const startEditQuota = (item: AdminQuotaItem) => {
    setEditingQuota({
      adminId: item.adminId,
      totalQuota: item.totalQuota > 0 ? String(item.totalQuota) : '',
      dailyQuota: item.dailyQuota > 0 ? String(item.dailyQuota) : '',
    });
  };

  const saveQuota = async () => {
    if (!editingQuota) return;
    setQuotaSaving(true);
    try {
      await updateAdminQuota(editingQuota.adminId, {
        totalQuota: editingQuota.totalQuota ? parseInt(editingQuota.totalQuota) : 0,
        dailyQuota: editingQuota.dailyQuota ? parseInt(editingQuota.dailyQuota) : 0,
      });
      // 刷新列表
      const list = await fetchAdminQuotas();
      setQuotaList(list);
      setEditingQuota(null);
    } catch (e: any) {
      alert(e.message || '保存失败');
    } finally {
      setQuotaSaving(false);
    }
  };

  const handleFilterChange = (setter: (v: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };

  const handleTakeBack = async (id: number) => {
    if (!confirm('确认撤回此发放记录？撤回量取决于接收用户当前余额。')) return;
    try {
      const res = await takeBackDistribution(id);
      alert(`撤回成功：${res.takenBack} 积分（${res.status}）`);
      loadData();
    } catch (e: any) { console.error('[撤回失败]', e); alert(e.message || '撤回失败'); }
  };

  const handleRecycleTeam = async () => {
    if (!confirm('确认回收小组所有成员积分？此操作将清空所有组员积分并转入你的账户。')) return;
    try {
      const res = await recycleTeamCredits();
      const parts = [];
      if (res.dailyTakenBack > 0) parts.push(`每日额度归还 ${res.dailyTakenBack}`);
      if (res.returnedToCreator > 0) parts.push(`退还创建者 ${res.returnedToCreator}`);
      if (res.recycled > 0) parts.push(`回收 ${res.recycled}`);
      alert(`回收成功：${parts.join('，')}，共 ${res.total} 积分`);
      loadData();
    } catch (e: any) { alert(e.message || '回收失败'); }
  };

  return (
    <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl overflow-hidden mb-8">
      <div className="p-6 border-b border-gray-800 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">发分统计</h2>
          <p className="text-gray-400 text-sm mt-1">统计管理员给用户发放积分的记录，支持按时段、方式筛选和按管理员汇总</p>
        </div>
        {isSuperAdmin && (
          <button
            onClick={openQuotaModal}
            className="px-4 py-2 bg-amber-600/20 border border-amber-500/40 hover:bg-amber-600/30 rounded-lg text-amber-400 text-sm font-medium transition-all"
          >
            额度管理
          </button>
        )}
      </div>

      {/* 筛选栏 */}
      <div className="p-4 border-b border-gray-800 flex flex-wrap items-center gap-3">
        <label className="text-gray-400 text-xs">时段</label>
        <input
          type="date"
          value={startDate}
          onChange={(e) => handleFilterChange(setStartDate, e.target.value)}
          className="bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
        />
        <span className="text-gray-500 text-sm">至</span>
        <input
          type="date"
          value={endDate}
          onChange={(e) => handleFilterChange(setEndDate, e.target.value)}
          className="bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
        />
        <label className="text-gray-400 text-xs ml-2">方式</label>
        <select
          value={method}
          onChange={(e) => handleFilterChange(setMethod, e.target.value)}
          className="bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
        >
          <option value="">全部</option>
          <option value="manual_add">后台手动增加</option>
          <option value="manual_set">后台手动调分</option>
          <option value="activation_code">激活码充值（非每日）</option>
          <option value="activation_code_daily">激活码充值（每日）</option>
          <option value="checkin">签到</option>
          <option value="self_paying">管理员自费发分</option>
          <option value="code_refund">自费发分退还</option>
        </select>
        <button
          onClick={loadData}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-sm font-medium transition-all"
        >
          查询
        </button>
        <label className="ml-3 flex items-center gap-1.5 text-gray-400 text-xs cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeSelfPaid}
            onChange={(e) => setIncludeSelfPaid(e.target.checked)}
            className="w-3.5 h-3.5"
          />
          包含管理员自费信息
        </label>
      </div>

      {/* 汇总卡片 */}
      {summary && (
        <div className="p-4 border-b border-gray-800 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-[#0f111a] rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-white">{summary.totalCount}</div>
            <div className="text-gray-400 text-xs mt-1">发放次数</div>
          </div>
          <div className="bg-[#0f111a] rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-emerald-400">{summary.totalCredits}</div>
            <div className="text-gray-400 text-xs mt-1">发放积分总额</div>
          </div>
          <div className="bg-[#0f111a] rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-amber-400">{summary.admins.filter(a => a.admin_id > 0).length}</div>
            <div className="text-gray-400 text-xs mt-1">参与管理员数</div>
          </div>
          <div className="bg-[#0f111a] rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-purple-400">{rows.length > 0 ? new Set(rows.map(r => r.recipient_id)).size : 0}</div>
            <div className="text-gray-400 text-xs mt-1">当前页受益用户数</div>
          </div>
        </div>
      )}

      {/* 管理员汇总表 */}
      {summary && summary.admins.length > 0 && (
        <div className="p-4 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-white mb-3">按管理员汇总</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-left border-b border-gray-800">
                  <th className="py-2 pr-4 font-medium">管理员</th>
                  <th className="py-2 pr-4 font-medium text-right">发放次数</th>
                  <th className="py-2 pr-4 font-medium text-right">发放积分总额</th>
                </tr>
              </thead>
              <tbody>
                {summary.admins.map((a) => (
                  <tr key={a.admin_id} className="border-b border-gray-800/50 text-white">
                    <td className="py-2.5 pr-4">
                      {a.admin_name || a.admin_email}
                    </td>
                    <td className="py-2.5 pr-4 text-right">{a.distribution_count}</td>
                    <td className="py-2.5 pr-4 text-right text-emerald-400 font-medium">{a.total_credits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 发放记录明细表 */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-white">发放记录明细</h3>
          {!isUser && (
            <button
              onClick={handleRecycleTeam}
              className="px-3 py-1.5 text-xs bg-orange-600/20 border border-orange-500/40 hover:bg-orange-600/30 rounded-lg text-orange-400 font-medium transition-all"
            >
              回收 {currentUser?.department || '本组'} 的成员积分
            </button>
          )}
        </div>
        {loading ? (
          <div className="text-center text-gray-400 py-8">加载中...</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-gray-400 py-8">未查询到记录</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 pr-3 font-medium">发放时间</th>
                    <th className="py-2 pr-3 font-medium">发放管理员</th>
                    <th className="py-2 pr-3 font-medium">接收用户</th>
                    <th className="py-2 pr-3 font-medium text-right">积分数量</th>
                     <th className="py-2 font-medium">发放方式</th>
                     <th className="py-2 pr-3 font-medium">撤回/操作</th>
                   </tr>
                </thead>
                <tbody>
                  {rows.filter(r => includeSelfPaid || (r.method !== 'self_paying' && r.method !== 'code_refund')).map((r) => (
                    <tr key={r.id} className="border-b border-gray-800/50 text-white">
                      <td className="py-2.5 pr-3 text-gray-300 text-xs whitespace-nowrap">
                        {formatDateTime(r.created_at)}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className="text-gray-200">{r.admin_name || r.admin_email}</span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="text-gray-200">{r.recipient_name || r.recipient_email}</div>
                        {r.recipient_department && (
                          <div className="text-gray-500 text-xs">{r.recipient_department}</div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        {(r.method === 'activation_code' || r.method === 'activation_code_daily') && r.amount_of_taking_back && r.amount_of_taking_back > 0 ? (
                          r.amount_of_taking_back >= r.credits_amount ? (
                            <div>
                              <span className="text-gray-500 font-medium line-through">+{r.credits_amount}</span>
                              <div className="text-amber-400 text-xs mt-0.5">已全撤回</div>
                            </div>
                          ) : (
                            <div>
                              <span className="text-emerald-400 font-medium">+{r.credits_amount}</span>
                              <div className="text-amber-400 text-xs mt-0.5">已撤回 {r.amount_of_taking_back}</div>
                            </div>
                          )
                        ) : r.credits_amount >= 0 ? (
                          <span className="text-emerald-400 font-medium">+{r.credits_amount}</span>
                        ) : (
                          <span className="text-red-400 font-medium">{r.credits_amount}</span>
                        )}
                      </td>
                       <td className="py-2.5">
                         <span className={`px-2 py-0.5 rounded-full text-xs ${METHOD_COLORS[r.method] || 'bg-gray-500/20 text-gray-400'}`}>
                           {METHOD_LABELS[r.method] || r.method}
                         </span>
                       </td>
                        <td className="py-2.5">
                          {r.method === 'activation_code' || r.method === 'activation_code_daily' ? (
                            r.amount_of_taking_back && r.amount_of_taking_back >= r.credits_amount ? (
                              <span className="text-xs text-gray-500">—</span>
                            ) : (
                              <button
                                onClick={() => handleTakeBack(r.id)}
                                className="px-2 py-0.5 text-xs bg-red-500/10 border border-red-500/30 text-red-400 rounded hover:bg-red-500/20 transition-colors"
                              >{r.amount_of_taking_back && r.amount_of_taking_back > 0 ? '继续撤回' : '撤回'}</button>
                            )
                          ) : r.method === 'recycling' ? (
                            <span className="text-xs text-gray-500">—</span>
                          ) : (
                            <span className="text-xs text-gray-500">—</span>
                          )}
                        </td>
                     </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 分页 */}
            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 text-sm">
                <span className="text-gray-400">
                  共 {pagination.total} 条记录，第 {pagination.page}/{pagination.totalPages} 页
                </span>
                <div className="flex gap-2">
                  <button
                    disabled={pagination.page <= 1}
                    onClick={() => setPage(pagination.page - 1)}
                    className="px-3 py-1.5 bg-[#0f111a] border border-gray-700 rounded-lg text-gray-300 hover:border-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    上一页
                  </button>
                  <button
                    disabled={pagination.page >= pagination.totalPages}
                    onClick={() => setPage(pagination.page + 1)}
                    className="px-3 py-1.5 bg-[#0f111a] border border-gray-700 rounded-lg text-gray-300 hover:border-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 额度管理弹窗 */}
      {quotaModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { setQuotaModalOpen(false); setEditingQuota(null); }}>
          <div
            className="bg-[#1c1f2e] border border-gray-700 rounded-2xl w-full max-w-3xl mx-4 max-h-[85vh] overflow-y-auto p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-semibold text-white">管理员发分额度设置</h3>
              <button onClick={() => { setQuotaModalOpen(false); setEditingQuota(null); }} className="text-gray-400 hover:text-white transition-all text-xl leading-none">&times;</button>
            </div>

            {quotaLoading ? (
              <div className="text-center text-gray-400 py-8">加载中...</div>
            ) : quotaList.length === 0 ? (
              <div className="text-center text-gray-400 py-8">暂未发现普通管理员账号</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 text-left border-b border-gray-800">
                      <th className="py-2 pr-3 font-medium">管理员</th>
                      <th className="py-2 pr-3 font-medium text-right">今日预计发放</th>
                      <th className="py-2 pr-3 font-medium text-right">实际发放</th>
                      <th className="py-2 pr-3 font-medium text-right">累计发放</th>
                      <th className="py-2 font-medium text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quotaList.map((item) => {
                      const isEditing = editingQuota?.adminId === item.adminId;
                      return (
                        <tr key={item.adminId} className="border-b border-gray-800/50 text-white">
                          <td className="py-2.5 pr-3">
                            <div className="text-gray-200">{item.adminName || item.adminEmail}</div>
                            {item.adminDepartment && (
                              <div className="text-gray-500 text-xs">{item.adminDepartment}</div>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 text-right">
                            {isEditing ? (
                              <input
                                type="number"
                                min="0"
                                value={editingQuota!.dailyQuota}
                                onChange={(e) => setEditingQuota({ ...editingQuota!, dailyQuota: e.target.value })}
                                placeholder="不限"
                                className="w-20 bg-[#0f111a] border border-gray-700 rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:border-amber-500"
                              />
                            ) : item.dailyQuota > 0 ? (
                              <span className="text-blue-400">
                                {item.todayDailyUsed.toLocaleString()}/{item.dailyQuota.toLocaleString()}
                              </span>
                            ) : (
                              <span className={(item.todayDailyUsed + item.todaySelfPaying) > 0 ? 'text-blue-400' : 'text-gray-500'}>0</span>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 text-right">
                            <span className={(item.todayDailyUsed + item.todaySelfPaying) > 0 ? 'text-emerald-400' : 'text-gray-500'}>
                              {(item.todayDailyUsed + item.todaySelfPaying).toLocaleString()}
                            </span>
                            {item.todaySelfPaying > 0 && (
                              <span className="text-amber-400 text-xs ml-1">
                                （其中 {item.todaySelfPaying} 为预计之外）
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 text-right">
                            <span className={item.totalUsed > 0 ? 'text-gray-200' : 'text-gray-500'}>
                              {item.totalUsed.toLocaleString()}
                            </span>
                          </td>
                          <td className="py-2.5 text-right">
                            {isEditing ? (
                              <div className="flex items-center gap-1 justify-end">
                                <button
                                  onClick={saveQuota}
                                  disabled={quotaSaving}
                                  className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-lg text-xs font-medium transition-all"
                                >
                                  {quotaSaving ? '...' : '保存'}
                                </button>
                                <button
                                  onClick={() => setEditingQuota(null)}
                                  className="px-2.5 py-1 bg-gray-600 hover:bg-gray-500 rounded-lg text-xs transition-all"
                                >
                                  取消
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => startEditQuota(item)}
                                className="px-2.5 py-1 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs text-gray-300 transition-all"
                              >
                                调整
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}