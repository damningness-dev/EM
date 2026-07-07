import { useState, useEffect, useMemo } from 'react';
import { calcDDay, getDDayLabel, getDDayColor, formatDate } from '../utils/dateUtils';
import { fetchCalibration, upsertCalibration, deleteCalibration, saveCalibFile, openCalibFile, revealCalibFile } from '../lib/api';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
let hid = 0;
function newHistoryId() { return `h${Date.now()}_${hid++}`; }

export default function Calibration() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const [sortKey, setSortKey] = useState(null);   // null = 수동(드래그) 순서
  const [sortDir, setSortDir] = useState('asc');
  const [dragIdx, setDragIdx] = useState(null);
  const [dropIdx, setDropIdx] = useState(null);

  useEffect(() => {
    fetchCalibration().then(d => { setData(d); setLoading(false); });
  }, []);

  const enriched = useMemo(() => data.map(item => ({
    ...item,
    dday: item.next_calib_date && item.next_calib_date !== '미사용' ? calcDDay(item.next_calib_date) : null,
  })), [data]);

  const filtered = useMemo(() => {
    let list = enriched;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(i =>
        i.no?.toLowerCase().includes(q) || i.sn?.toLowerCase().includes(q) ||
        i.name?.toLowerCase().includes(q) || i.cert_no?.toLowerCase().includes(q)
      );
    }
    if (filter === 'urgent') list = list.filter(i => i.dday !== null && i.dday >= 0 && i.dday <= 60);
    if (filter === 'expired') list = list.filter(i => i.dday !== null && i.dday < 0);
    return list;
  }, [enriched, search, filter]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    if (!sortKey) return list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const dir = sortDir === 'desc' ? -1 : 1;
    return list.sort((a, b) => {
      if (sortKey === 'dday') {
        const av = a.dday ?? Infinity, bv = b.dday ?? Infinity;
        return (av - bv) * dir;
      }
      return String(a[sortKey] || '').localeCompare(String(b[sortKey] || ''), 'ko', { numeric: true }) * dir;
    });
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key) {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); }
    else if (sortDir === 'asc') setSortDir('desc');
    else { setSortKey(null); setSortDir('asc'); } // 수동(드래그) 순서로 복귀
  }
  function sortArrow(key) {
    if (sortKey !== key) return <span className="text-gray-300">↕</span>;
    return <span className="text-blue-600">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  }

  function toggleExpand(id) {
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }

  // ─── 드래그 순서 변경 (수동 정렬 모드에서만) ───
  async function handleRowDrop(targetIdx) {
    if (dragIdx === null || dragIdx === targetIdx) { setDragIdx(null); setDropIdx(null); return; }
    const arr = [...sorted];
    const [moved] = arr.splice(dragIdx, 1);
    arr.splice(targetIdx, 0, moved);
    // sort_order 재부여 후 저장
    const updates = arr.map((it, i) => ({ ...it, sort_order: i }));
    setData(prev => prev.map(d => updates.find(u => u.id === d.id) || d));
    setDragIdx(null); setDropIdx(null);
    try { for (const u of updates) await upsertCalibration(stripDday(u)); window.electronAPI?.notifyDataChanged?.(); } catch { /* ignore */ }
  }

  function stripDday(item) { const { dday, ...rest } = item; return rest; }

  async function saveEdit() {
    setSaving(true);
    const orig = data.find(d => d.id === editingId) || {};
    const payload = { ...orig, id: editingId,
      no: form.no, sn: form.sn, cert_no: form.cert_no,
      calib_date: form.calib_date || null, next_calib_date: form.next_calib_date || null,
      name: form.name, note: form.note };
    try {
      const saved = await upsertCalibration(payload);
      setData(prev => prev.map(d => d.id === editingId ? saved : d));
      setEditingId(null);
      window.electronAPI?.notifyDataChanged?.();
    } catch (e) { alert('저장 실패: ' + e.message); }
    setSaving(false);
  }

  async function handleDelete(id) {
    if (!confirm('삭제하시겠습니까?')) return;
    await deleteCalibration(id);
    setData(prev => prev.filter(d => d.id !== id));
    window.electronAPI?.notifyDataChanged?.();
  }

  async function addItem() {
    setSaving(true);
    const payload = {
      no: form.no || '', sn: form.sn || '', cert_no: form.cert_no || '',
      calib_date: form.calib_date || null, next_calib_date: form.next_calib_date || null,
      name: form.name || '', note: form.note || '', history: [], sort_order: data.length,
    };
    try {
      const saved = await upsertCalibration(payload);
      setData(prev => [...prev, saved]);
      setShowAdd(false); setForm({});
      window.electronAPI?.notifyDataChanged?.();
    } catch (e) { alert('추가 실패: ' + e.message); }
    setSaving(false);
  }

  // ─── 연도별 교정내역(history) ───
  async function persistHistory(item, history) {
    const saved = await upsertCalibration(stripDday({ ...item, history }));
    setData(prev => prev.map(d => d.id === item.id ? saved : d));
    window.electronAPI?.notifyDataChanged?.();
  }
  function addHistory(item) {
    const y = new Date().getFullYear();
    const entry = { id: newHistoryId(), year: y, cert_no: '', calib_date: '', next_calib_date: '', note: '' };
    persistHistory(item, [...(item.history || []), entry]);
  }
  function updateHistory(item, hidx, patch) {
    const history = (item.history || []).map((h, i) => i === hidx ? { ...h, ...patch } : h);
    persistHistory(item, history);
  }
  function removeHistory(item, hidx) {
    persistHistory(item, (item.history || []).filter((_, i) => i !== hidx));
  }

  async function uploadFileForHistory(item, hidx, file) {
    if (!file) return;
    if (!isElectron) { alert('파일 첨부는 데스크톱 앱에서만 지원됩니다.'); return; }
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const r = await saveCalibFile(file.name, b64);
    if (r?.ok) updateHistory(item, hidx, { fileName: r.name, filePath: r.path });
    else alert('파일 저장 실패: ' + (r?.error || ''));
  }

  const expiredCount = enriched.filter(i => i.dday !== null && i.dday < 0).length;
  const urgentCount = enriched.filter(i => i.dday !== null && i.dday >= 0 && i.dday <= 60).length;

  if (loading) return <LoadingSpinner />;

  const canDrag = !sortKey && !search && filter === 'all';
  const COLS = [
    { key: null, label: 'No.', w: 'w-8', sortable: false },
    { key: 'no', label: '관리번호', sortable: true },
    { key: 'sn', label: 'S/N', sortable: true },
    { key: 'cert_no', label: '성적서번호', sortable: true },
    { key: 'name', label: '장비명', sortable: true },
    { key: 'calib_date', label: '교정일', sortable: true },
    { key: 'next_calib_date', label: '차기교정일', sortable: true },
    { key: 'dday', label: 'D-Day', sortable: true, center: true },
  ];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">교정 관리</h1>
        <button onClick={() => { setShowAdd(true); setForm({}); }} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">+ 추가</button>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <input type="text" placeholder="관리번호, S/N, 장비명 검색..." value={search} onChange={e => setSearch(e.target.value)} className="flex-1 min-w-48 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
        <div className="flex gap-2">
          {[
            { key: 'all', label: `전체 (${enriched.length})` },
            { key: 'expired', label: `만료 (${expiredCount})`, color: 'text-red-600' },
            { key: 'urgent', label: `임박 (${urgentCount})`, color: 'text-orange-500' },
          ].map(({ key, label, color }) => (
            <button key={key} onClick={() => setFilter(key)} className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${filter === key ? 'bg-blue-600 text-white border-blue-600' : `border-gray-200 ${color || 'text-gray-600'} hover:bg-gray-50`}`}>{label}</button>
          ))}
        </div>
      </div>

      <p className="text-xs text-gray-400">
        {canDrag ? '행을 드래그해 순서를 바꾸거나, ' : ''}헤더를 클릭해 정렬 · ▶ 를 눌러 연도별 교정내역·첨부파일을 관리하세요.
        {sortKey && <button onClick={() => setSortKey(null)} className="ml-2 text-blue-500 hover:underline">수동 순서로</button>}
      </p>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="w-6" />
                {COLS.map(c => (
                  <th key={c.label} className={`px-4 py-3 text-gray-500 font-medium ${c.center ? 'text-center' : 'text-left'} ${c.w || ''} ${c.sortable ? 'cursor-pointer select-none hover:text-gray-800' : ''}`}
                    onClick={c.sortable ? () => toggleSort(c.key) : undefined}>
                    {c.label} {c.sortable && sortArrow(c.key)}
                  </th>
                ))}
                <th className="text-center px-4 py-3 text-gray-500 font-medium">비고</th>
                <th className="text-center px-4 py-3 text-gray-500 font-medium">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sorted.map((item, idx) => {
                const isExp = expanded.has(item.id);
                const isDrop = dropIdx === idx && dragIdx !== null && dragIdx !== idx;
                return (
                  <FragmentRow key={item.id}>
                    <tr
                      className={`hover:bg-gray-50 ${item.dday !== null && item.dday < 0 ? 'bg-red-50' : ''} ${isDrop ? 'border-t-2 border-blue-500' : ''}`}
                      draggable={canDrag && editingId !== item.id}
                      onDragStart={canDrag ? () => setDragIdx(idx) : undefined}
                      onDragOver={canDrag ? e => { e.preventDefault(); setDropIdx(idx); } : undefined}
                      onDrop={canDrag ? () => handleRowDrop(idx) : undefined}
                      onDragEnd={() => { setDragIdx(null); setDropIdx(null); }}
                    >
                      <td className="px-1 text-center text-gray-300">
                        <button onClick={() => toggleExpand(item.id)} className={`text-[10px] transition-transform ${isExp ? 'rotate-90 text-blue-500' : ''}`} title="교정내역">▶</button>
                      </td>
                      {editingId === item.id ? (
                        <>
                          <td className="px-4 py-2 text-gray-400">{idx + 1}</td>
                          <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" value={form.no || ''} onChange={e => setForm(f => ({ ...f, no: e.target.value }))} /></td>
                          <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" value={form.sn || ''} onChange={e => setForm(f => ({ ...f, sn: e.target.value }))} /></td>
                          <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" value={form.cert_no || ''} onChange={e => setForm(f => ({ ...f, cert_no: e.target.value }))} /></td>
                          <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></td>
                          <td className="px-4 py-2"><input type="date" className="w-full border rounded px-2 py-1 text-sm" value={form.calib_date || ''} onChange={e => setForm(f => ({ ...f, calib_date: e.target.value }))} /></td>
                          <td className="px-4 py-2"><input type="date" className="w-full border rounded px-2 py-1 text-sm" value={form.next_calib_date && form.next_calib_date !== '미사용' ? form.next_calib_date : ''} onChange={e => setForm(f => ({ ...f, next_calib_date: e.target.value }))} /></td>
                          <td className="px-4 py-2 text-center text-gray-300">—</td>
                          <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" placeholder="비고" value={form.note || ''} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} /></td>
                          <td className="px-4 py-2 text-center whitespace-nowrap">
                            <button onClick={saveEdit} disabled={saving} className="px-2 py-1 bg-blue-600 text-white rounded text-xs mr-1 disabled:opacity-50">저장</button>
                            <button onClick={() => setEditingId(null)} className="px-2 py-1 bg-gray-200 rounded text-xs">취소</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3 text-gray-400">{idx + 1}</td>
                          <td className="px-4 py-3 font-medium text-gray-800">{item.no}</td>
                          <td className="px-4 py-3 text-gray-600">{item.sn}</td>
                          <td className="px-4 py-3 text-gray-500 text-xs">{item.cert_no}</td>
                          <td className="px-4 py-3 text-gray-600">{item.name}</td>
                          <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(item.calib_date)}</td>
                          <td className="px-4 py-3 text-gray-500 text-xs">{item.next_calib_date === '미사용' ? '미사용' : formatDate(item.next_calib_date)}</td>
                          <td className={`px-4 py-3 text-center font-semibold text-sm ${getDDayColor(item.dday)}`}>{getDDayLabel(item.dday)}</td>
                          <td className="px-4 py-3 text-center text-xs text-gray-400">{item.note}</td>
                          <td className="px-4 py-3 text-center whitespace-nowrap">
                            <button onClick={() => { setEditingId(item.id); setForm({ ...item }); }} className="px-2 py-1 text-blue-600 hover:bg-blue-50 rounded text-xs mr-1">수정</button>
                            <button onClick={() => handleDelete(item.id)} className="px-2 py-1 text-red-500 hover:bg-red-50 rounded text-xs">삭제</button>
                          </td>
                        </>
                      )}
                    </tr>
                    {isExp && (
                      <tr>
                        <td colSpan={11} className="p-0 bg-gray-50/60">
                          <HistoryPanel item={item}
                            onAdd={() => addHistory(item)}
                            onUpdate={(hidx, patch) => updateHistory(item, hidx, patch)}
                            onRemove={hidx => removeHistory(item, hidx)}
                            onUpload={(hidx, file) => uploadFileForHistory(item, hidx, file)}
                          />
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h2 className="font-bold text-gray-800">교정 장비 추가</h2>
            <div className="grid grid-cols-2 gap-3">
              {[{ key: 'no', label: '관리번호' }, { key: 'sn', label: 'S/N' }, { key: 'name', label: '장비명' }, { key: 'cert_no', label: '성적서번호' }].map(({ key, label }) => (
                <div key={key}>
                  <label className="text-xs text-gray-500">{label}</label>
                  <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
                </div>
              ))}
              <div>
                <label className="text-xs text-gray-500">교정일</label>
                <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.calib_date || ''} onChange={e => setForm(f => ({ ...f, calib_date: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">차기교정일</label>
                <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.next_calib_date || ''} onChange={e => setForm(f => ({ ...f, next_calib_date: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">비고</label>
              <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.note || ''} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={addItem} disabled={saving} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">추가</button>
              <button onClick={() => setShowAdd(false)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FragmentRow({ children }) { return <>{children}</>; }

function HistoryPanel({ item, onAdd, onUpdate, onRemove, onUpload }) {
  const history = [...(item.history || [])].sort((a, b) => (b.year || 0) - (a.year || 0));
  async function open(path) { const r = await openCalibFile(path); if (r && !r.ok) alert('열기 실패: ' + (r.error || '')); }
  return (
    <div className="px-8 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-600">📁 연도별 교정내역</span>
        <button onClick={onAdd} className="text-xs px-2 py-1 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 font-medium">+ 내역 추가</button>
      </div>
      {history.length === 0 ? (
        <p className="text-xs text-gray-400 py-2">등록된 교정내역이 없습니다.</p>
      ) : (
        <div className="space-y-1.5">
          {history.map((h) => {
            const realIdx = (item.history || []).findIndex(x => x.id === h.id);
            return (
              <div key={h.id} className="flex flex-wrap items-center gap-2 bg-white border border-gray-100 rounded-lg px-3 py-2">
                <input type="number" value={h.year || ''} onChange={e => onUpdate(realIdx, { year: parseInt(e.target.value) || '' })}
                  className="w-16 border border-gray-200 rounded px-1.5 py-1 text-xs text-center" placeholder="연도" />
                <input value={h.cert_no || ''} onChange={e => onUpdate(realIdx, { cert_no: e.target.value })}
                  className="w-32 border border-gray-200 rounded px-1.5 py-1 text-xs" placeholder="성적서번호" />
                <label className="text-[10px] text-gray-400">교정일<input type="date" value={h.calib_date || ''} onChange={e => onUpdate(realIdx, { calib_date: e.target.value })} className="ml-1 border border-gray-200 rounded px-1 py-1 text-xs" /></label>
                <label className="text-[10px] text-gray-400">차기<input type="date" value={h.next_calib_date || ''} onChange={e => onUpdate(realIdx, { next_calib_date: e.target.value })} className="ml-1 border border-gray-200 rounded px-1 py-1 text-xs" /></label>
                <input value={h.note || ''} onChange={e => onUpdate(realIdx, { note: e.target.value })}
                  className="flex-1 min-w-24 border border-gray-200 rounded px-1.5 py-1 text-xs" placeholder="비고" />
                {h.filePath ? (
                  <span className="flex items-center gap-1">
                    <button onClick={() => open(h.filePath)} className="text-xs px-2 py-1 bg-emerald-50 text-emerald-600 rounded hover:bg-emerald-100" title={h.fileName}>📄 열기</button>
                    <button onClick={() => revealCalibFile(h.filePath)} className="text-xs px-1.5 py-1 text-gray-400 hover:text-gray-700" title="폴더에서 보기">📂</button>
                    <button onClick={() => onUpdate(realIdx, { fileName: '', filePath: '' })} className="text-xs text-gray-300 hover:text-red-500" title="첨부 제거">✕</button>
                  </span>
                ) : (
                  <label className="text-xs px-2 py-1 bg-gray-100 text-gray-500 rounded hover:bg-gray-200 cursor-pointer">
                    📎 파일첨부
                    <input type="file" className="hidden" onChange={e => { onUpload(realIdx, e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                )}
                <button onClick={() => onRemove(realIdx)} className="text-xs text-gray-300 hover:text-red-500 px-1" title="내역 삭제">🗑</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LoadingSpinner() {
  return <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;
}
