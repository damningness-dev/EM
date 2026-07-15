import { useState, useEffect, useMemo } from 'react';
import { calcDDay, getDDayLabel, getDDayColor, formatDate } from '../utils/dateUtils';
import { fetchCalibration, upsertCalibration, deleteCalibration, saveCalibFile, openCalibFile, revealCalibFile } from '../lib/api';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
let hid = 0;
function newHistoryId() { return `h${Date.now()}_${hid++}`; }

function pad2(n) { return String(n).padStart(2, '0'); }
// 차기교정일 = 교정일 +1년 -1일 (예: 2026-05-10 → 2027-05-09)
function nextCalibDate(calibStr) {
  if (!calibStr) return '';
  const d = new Date(calibStr + 'T00:00:00');
  d.setFullYear(d.getFullYear() + 1);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function dotDate(s) { return s ? s.replaceAll('-', '.') : ''; }
// 가장 최근 교정내역(교정일 기준) — 일정관리처럼 최근 내역을 대표로 보여주기 위함
function latestHistory(item) {
  const h = item.history || [];
  if (!h.length) return null;
  return [...h].sort((a, b) => (b.calib_date || '').localeCompare(a.calib_date || '') || (b.year || 0) - (a.year || 0))[0];
}
// 대표 표시값: 최근 교정내역이 있으면 그 값, 없으면 항목 자체 값
function effectiveCalib(item) {
  const lh = latestHistory(item);
  if (!lh) return { cert_no: item.cert_no, calib_date: item.calib_date, next_calib_date: item.next_calib_date };
  return {
    cert_no: lh.cert_no || item.cert_no,
    calib_date: lh.calib_date || item.calib_date,
    next_calib_date: lh.calib_date ? nextCalibDate(lh.calib_date) : (lh.next_calib_date || item.next_calib_date),
  };
}
// 성적서 파일명: "관리번호 교정일(S/N)" + 확장자
function certFileName(no, calibDate, sn, originalName) {
  const ext = originalName && originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : '';
  const base = `${no || ''} ${dotDate(calibDate)}(${sn || ''})`.trim();
  return base + ext;
}

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
    fetchCalibration().then(async d => {
      // 기존 상단 교정정보(성적서/교정일)를 연도별 교정내역으로 1회 이관 → 이후 최신 내역에서 표시
      const migrated = [];
      const list = (d || []).map(item => {
        const hasHistory = item.history && item.history.length > 0;
        const hasBase = item.calib_date && item.calib_date !== '미사용';
        if (!hasHistory && (hasBase || item.cert_no)) {
          const y = item.calib_date ? new Date(item.calib_date + 'T00:00:00').getFullYear() : new Date().getFullYear();
          const entry = { id: newHistoryId(), year: y, cert_no: item.cert_no || '', calib_date: item.calib_date || '', next_calib_date: item.next_calib_date || '', note: '' };
          const nu = { ...item, history: [entry] };
          migrated.push(nu);
          return nu;
        }
        return item;
      });
      setData(list);
      setLoading(false);
      for (const m of migrated) { try { await upsertCalibration(m); } catch { /* ignore */ } }
    });
  }, []);

  const enriched = useMemo(() => data.map(item => {
    const eff = effectiveCalib(item);
    return {
      ...item,
      eff,
      dday: eff.next_calib_date && eff.next_calib_date !== '미사용' ? calcDDay(eff.next_calib_date) : null,
    };
  }), [data]);

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
    const effKeys = ['cert_no', 'calib_date', 'next_calib_date'];
    const getV = x => (effKeys.includes(sortKey) ? (x.eff || x)[sortKey] : x[sortKey]) || '';
    return list.sort((a, b) => {
      if (sortKey === 'dday') {
        const av = a.dday ?? Infinity, bv = b.dday ?? Infinity;
        return (av - bv) * dir;
      }
      return String(getV(a)).localeCompare(String(getV(b)), 'ko', { numeric: true }) * dir;
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
    // 교정정보(성적서번호·교정일·차기)는 연도별 교정내역에서 관리 → 식별정보·비고만 수정
    const payload = { ...orig, id: editingId, no: form.no, sn: form.sn, name: form.name, note: form.note };
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
      no: form.no || '', sn: form.sn || '', name: form.name || '', note: form.note || '',
      cert_no: '', calib_date: null, next_calib_date: null, // 교정정보는 연도별 교정내역에서 관리
      history: [], sort_order: data.length,
    };
    try {
      const saved = await upsertCalibration(payload);
      setData(prev => [...prev, saved]);
      setShowAdd(false); setForm({});
      window.electronAPI?.notifyDataChanged?.();
    } catch (e) { alert('추가 실패: ' + e.message); }
    setSaving(false);
  }

  // ─── 연도별 교정내역(history) 저장 ───
  async function persistHistory(item, history) {
    const saved = await upsertCalibration(stripDday({ ...item, history }));
    setData(prev => prev.map(d => d.id === item.id ? saved : d));
    window.electronAPI?.notifyDataChanged?.();
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
                          <td className="px-4 py-2 text-gray-400 text-xs">{(item.eff || item).cert_no || '—'}</td>
                          <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></td>
                          <td className="px-4 py-2 text-gray-400 text-xs">{formatDate((item.eff || item).calib_date)}</td>
                          <td className="px-4 py-2 text-gray-400 text-xs">{formatDate((item.eff || item).next_calib_date)}</td>
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
                          <td className="px-4 py-3 text-gray-500 text-xs">{(item.eff || item).cert_no}</td>
                          <td className="px-4 py-3 text-gray-600">{item.name}</td>
                          <td className="px-4 py-3 text-gray-500 text-xs">{formatDate((item.eff || item).calib_date)}</td>
                          <td className="px-4 py-3 text-gray-500 text-xs">{(item.eff || item).next_calib_date === '미사용' ? '미사용' : formatDate((item.eff || item).next_calib_date)}</td>
                          <td className={`px-4 py-3 text-center font-semibold text-sm ${getDDayColor(item.dday)}`}>{getDDayLabel(item.dday)}</td>
                          <td className="px-4 py-3 text-center text-xs text-gray-400">{item.note}</td>
                          <td className="px-4 py-3 text-center whitespace-nowrap">
                            {(() => {
                              const lf = latestHistory(item);
                              return lf?.filePath ? (
                                <button onClick={async () => { const r = await openCalibFile(lf.filePath); if (r && !r.ok) alert('열기 실패: ' + (r.error || '')); }}
                                  className="px-1.5 py-1 rounded text-sm mr-1 hover:bg-emerald-50" title={`최근 성적서 열기: ${lf.fileName || ''}`}>📄</button>
                              ) : null;
                            })()}
                            <button onClick={() => { setEditingId(item.id); setForm({ ...item }); }} className="px-2 py-1 text-blue-600 hover:bg-blue-50 rounded text-xs mr-1">수정</button>
                            <button onClick={() => handleDelete(item.id)} className="px-2 py-1 text-red-500 hover:bg-red-50 rounded text-xs">삭제</button>
                          </td>
                        </>
                      )}
                    </tr>
                    {isExp && (
                      <tr>
                        <td colSpan={11} className="p-0 bg-gray-50/60">
                          <HistoryPanel item={item} onSave={history => persistHistory(item, history)} />
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
              {[{ key: 'no', label: '관리번호' }, { key: 'sn', label: 'S/N' }, { key: 'name', label: '장비명' }].map(({ key, label }) => (
                <div key={key}>
                  <label className="text-xs text-gray-500">{label}</label>
                  <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
                </div>
              ))}
              <div>
                <label className="text-xs text-gray-500">비고</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.note || ''} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
              </div>
            </div>
            <p className="text-xs text-gray-400">성적서번호·교정일·차기교정일은 추가 후 행을 펼쳐 <b>연도별 교정내역</b>에 입력하세요. 가장 최근 내역이 대표로 표시됩니다.</p>
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

function HistoryPanel({ item, onSave }) {
  const [rows, setRows] = useState(() => (item.history || []).map(h => ({ ...h })));
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  function edit(idx, patch) { setRows(rs => rs.map((r, i) => i === idx ? { ...r, ...patch } : r)); setDirty(true); }
  function add() { setRows(rs => [...rs, { id: newHistoryId(), year: new Date().getFullYear(), cert_no: '', calib_date: '', note: '', fileName: '', filePath: '' }]); setDirty(true); }
  function remove(idx) { setRows(rs => rs.filter((_, i) => i !== idx)); setDirty(true); }

  async function upload(idx, file) {
    if (!file) return;
    if (!isElectron) { alert('파일 첨부는 데스크톱 앱에서만 지원됩니다.'); return; }
    const row = rows[idx];
    if (!row.calib_date) { alert('먼저 교정일을 입력하세요. (파일명이 관리번호·교정일 기준으로 저장됩니다)'); return; }
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
    const desired = certFileName(item.no, row.calib_date, item.sn, file.name);
    const r = await saveCalibFile(desired, b64);
    if (r?.ok) edit(idx, { fileName: r.name, filePath: r.path });
    else alert('파일 저장 실패: ' + (r?.error || ''));
  }

  async function save() {
    setBusy(true);
    const toSave = rows.map(r => ({ ...r, next_calib_date: r.calib_date ? nextCalibDate(r.calib_date) : '' }));
    try { await onSave(toSave); setDirty(false); } catch (e) { alert('저장 실패: ' + e.message); } finally { setBusy(false); }
  }

  async function open(path) { const r = await openCalibFile(path); if (r && !r.ok) alert('열기 실패: ' + (r.error || '')); }

  const view = rows.map((r, i) => ({ r, i })).sort((a, b) => (b.r.year || 0) - (a.r.year || 0));

  return (
    <div className="px-8 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-600">📁 연도별 교정내역</span>
        <div className="flex items-center gap-2">
          <button onClick={add} className="text-xs px-2 py-1 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 font-medium">+ 내역 추가</button>
          <button onClick={save} disabled={busy || !dirty}
            className={`text-xs px-3 py-1 rounded font-semibold ${dirty ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-400'} disabled:opacity-60`}>
            {busy ? '저장 중…' : dirty ? '저장' : '저장됨'}
          </button>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-400 py-2">등록된 교정내역이 없습니다. "+ 내역 추가"로 등록하세요.</p>
      ) : (
        <div className="space-y-1.5">
          {view.map(({ r: h, i: idx }) => (
            <div key={h.id} className="flex flex-wrap items-center gap-2 bg-white border border-gray-100 rounded-lg px-3 py-2">
              <input type="number" value={h.year || ''} onChange={e => edit(idx, { year: parseInt(e.target.value) || '' })}
                className="w-16 border border-gray-200 rounded px-1.5 py-1 text-xs text-center" placeholder="연도" />
              <input value={h.cert_no || ''} onChange={e => edit(idx, { cert_no: e.target.value })}
                className="w-32 border border-gray-200 rounded px-1.5 py-1 text-xs" placeholder="성적서번호" />
              <label className="text-[10px] text-gray-400">교정일<input type="date" value={h.calib_date || ''} onChange={e => edit(idx, { calib_date: e.target.value })} className="ml-1 border border-gray-200 rounded px-1 py-1 text-xs" /></label>
              <label className="text-[10px] text-gray-400">차기<input type="date" readOnly title="교정일 +1년 -1일 자동" value={nextCalibDate(h.calib_date) || ''} className="ml-1 border border-gray-200 rounded px-1 py-1 text-xs bg-gray-50 text-gray-500" /></label>
              <input value={h.note || ''} onChange={e => edit(idx, { note: e.target.value })}
                className="flex-1 min-w-24 border border-gray-200 rounded px-1.5 py-1 text-xs" placeholder="비고" />
              {h.filePath ? (
                <span className="flex items-center gap-1">
                  <button onClick={() => open(h.filePath)} className="text-xs px-2 py-1 bg-emerald-50 text-emerald-600 rounded hover:bg-emerald-100" title={h.fileName}>📄 열기</button>
                  <button onClick={() => revealCalibFile(h.filePath)} className="text-xs px-1.5 py-1 text-gray-400 hover:text-gray-700" title="폴더에서 보기">📂</button>
                  <button onClick={() => edit(idx, { fileName: '', filePath: '' })} className="text-xs text-gray-300 hover:text-red-500" title="첨부 제거">✕</button>
                </span>
              ) : (
                <label className="text-xs px-2 py-1 bg-gray-100 text-gray-500 rounded hover:bg-gray-200 cursor-pointer">
                  📎 파일첨부
                  <input type="file" className="hidden" onChange={e => { upload(idx, e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              )}
              <button onClick={() => remove(idx)} className="text-xs text-gray-300 hover:text-red-500 px-1" title="내역 삭제">🗑</button>
            </div>
          ))}
        </div>
      )}
      {h_fileName_hint(rows)}
    </div>
  );
}

// 파일명 규칙 안내
function h_fileName_hint(rows) {
  if (!rows.some(r => r.filePath)) return null;
  return <p className="text-[10px] text-gray-400 mt-2">첨부파일은 "관리번호 교정일(S/N)" 형식으로 저장됩니다.</p>;
}

function LoadingSpinner() {
  return <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;
}
