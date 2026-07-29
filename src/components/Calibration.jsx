import { useState, useEffect, useMemo, useRef } from 'react';
import { calcDDay, getDDayLabel, getDDayColor, formatDate } from '../utils/dateUtils';
import { nextCalibDate, latestCalibHistory as latestHistory, effectiveCalib } from '../utils/calibUtils';
import { fetchCalibration, upsertCalibration, deleteCalibration, saveCalibFile, openCalibFile, revealCalibFile, syncGetConfig, syncUpload } from '../lib/api';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
let hid = 0;
function newHistoryId() { return `h${Date.now()}_${hid++}`; }

// 컬럼 순서(고정) + 기본 너비(px) — 헤더 사이 구분선을 드래그해 너비 조절
const CALIB_COL_ORDER = ['expand', 'idx', 'no', 'sn', 'cert_no', 'name', 'calib_date', 'next_calib_date', 'dday', 'calibNote', 'note', 'manage'];
const CALIB_COL_DEFAULT_W = {
  expand: 28, idx: 40, no: 110, sn: 100, cert_no: 110, name: 140,
  calib_date: 100, next_calib_date: 100, dday: 70, calibNote: 140, note: 140, manage: 140,
};
const CALIB_COL_STORE_KEY = 'em-calib-table-cols';

function dotDate(s) { return s ? s.replaceAll('-', '.') : ''; }
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
  const [notice, setNotice] = useState(null); // 안내/오류 토스트 (네이티브 alert 대신 사용 — alert는 인쇄/입력 포커스를 먹통으로 만듦)
  const noticeTimer = useRef(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const [sortKey, setSortKey] = useState(null);   // null = 수동(드래그) 순서
  const [sortDir, setSortDir] = useState('asc');
  const [dragIdx, setDragIdx] = useState(null);
  const [dropIdx, setDropIdx] = useState(null);
  const [colW, setColW] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem(CALIB_COL_STORE_KEY)); if (s && typeof s === 'object') return s; } catch { /* ignore */ }
    return {};
  });
  useEffect(() => { try { localStorage.setItem(CALIB_COL_STORE_KEY, JSON.stringify(colW)); } catch { /* ignore */ } }, [colW]);
  const colWidth = k => colW[k] ?? CALIB_COL_DEFAULT_W[k];
  function startColResize(e, key) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = colWidth(key);
    const onMove = ev => setColW(prev => ({ ...prev, [key]: Math.max(28, startW + ev.clientX - startX) }));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }

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
    try { for (const u of updates) await upsertCalibration(stripDday(u)); window.electronAPI?.notifyDataChanged?.(); syncAfterChange(); } catch { /* ignore */ }
  }

  function stripDday(item) { const { dday, ...rest } = item; return rest; }

  // 교정 데이터가 바뀌면(추가·수정·삭제·이력·순서) em-data.json에 저장된 뒤,
  // 공유 설정(Gist ID + 토큰)이 있으면 자동으로 Gist에 업로드해 다른 PC와 공유한다.
  async function syncAfterChange() {
    try {
      const cfg = await syncGetConfig();
      if (!cfg?.gistId || !cfg?.hasToken) return; // 공유 설정 없으면 조용히 건너뜀
      const r = await syncUpload();
      showNotice(r?.ok ? '🔄 교정 이력을 다른 PC와 공유했습니다.'
        : `⚠ 공유 업로드 실패: ${r?.error || ''}`, !r?.ok);
    } catch (e) {
      showNotice('⚠ 공유 업로드 중 오류: ' + e.message, true);
    }
  }
  // 네이티브 alert()는 Electron에서 렌더러 입력 포커스를 한동안 먹통으로 만드는 문제가 있어
  // 항상 이 비차단(non-blocking) 토스트를 사용한다.
  function showNotice(text, isError) {
    setNotice({ text, isError });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }

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
      syncAfterChange();
    } catch (e) { showNotice('저장 실패: ' + e.message, true); }
    setSaving(false);
  }

  function handleDelete(id) {
    setConfirmDeleteId(id);
  }

  async function confirmDelete() {
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    if (!id) return;
    await deleteCalibration(id);
    setData(prev => prev.filter(d => d.id !== id));
    window.electronAPI?.notifyDataChanged?.();
    syncAfterChange();
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
      syncAfterChange();
    } catch (e) { showNotice('추가 실패: ' + e.message, true); }
    setSaving(false);
  }

  // ─── 연도별 교정내역(history) 저장 ───
  async function persistHistory(item, history) {
    const saved = await upsertCalibration(stripDday({ ...item, history }));
    setData(prev => prev.map(d => d.id === item.id ? saved : d));
    window.electronAPI?.notifyDataChanged?.();
    syncAfterChange();
  }

  const expiredCount = enriched.filter(i => i.dday !== null && i.dday < 0).length;
  const urgentCount = enriched.filter(i => i.dday !== null && i.dday >= 0 && i.dday <= 60).length;

  if (loading) return <LoadingSpinner />;

  const canDrag = !sortKey && !search && filter === 'all';
  const COLS = [
    { key: null, label: 'No.', sortable: false },
    { key: 'no', label: '관리번호', sortable: true },
    { key: 'sn', label: 'S/N', sortable: true },
    { key: 'cert_no', label: '성적서번호', sortable: true },
    { key: 'name', label: '장비명', sortable: true },
    { key: 'calib_date', label: '교정일', sortable: true },
    { key: 'next_calib_date', label: '차기교정일', sortable: true },
    { key: 'dday', label: 'D-Day', sortable: true },
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
        {canDrag ? '행을 드래그해 순서를 바꾸거나, ' : ''}헤더를 클릭해 정렬 · 헤더 사이 경계를 드래그해 너비 조절 · ▶ 를 눌러 연도별 교정내역·첨부파일을 관리하세요.
        {sortKey && <button onClick={() => setSortKey(null)} className="ml-2 text-blue-500 hover:underline">수동 순서로</button>}
      </p>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-sm" style={{ tableLayout: 'fixed', width: CALIB_COL_ORDER.reduce((s, k) => s + colWidth(k), 0) }}>
            <colgroup>{CALIB_COL_ORDER.map(k => <col key={k} style={{ width: colWidth(k) }} />)}</colgroup>
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="relative border-r border-gray-200">
                  <span onMouseDown={e => startColResize(e, 'expand')} draggable={false} onDragStart={e => e.preventDefault()}
                    className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
                </th>
                {COLS.map(c => {
                  const wKey = c.key || 'idx';
                  return (
                    <th key={c.label} className={`relative px-4 py-3 text-gray-500 font-medium truncate text-center border-r border-gray-200 ${c.sortable ? 'cursor-pointer select-none hover:text-gray-800' : ''}`}
                      onClick={c.sortable ? () => toggleSort(c.key) : undefined}>
                      {c.label} {c.sortable && sortArrow(c.key)}
                      <span onMouseDown={e => startColResize(e, wKey)} draggable={false} onDragStart={e => e.preventDefault()}
                        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }}
                        onClick={e => e.stopPropagation()} title="드래그하여 너비 조절" />
                    </th>
                  );
                })}
                <th className="relative text-center px-4 py-3 text-gray-500 font-medium border-r border-gray-200">
                  교정내역
                  <span onMouseDown={e => startColResize(e, 'calibNote')} draggable={false} onDragStart={e => e.preventDefault()}
                    className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
                </th>
                <th className="relative text-center px-4 py-3 text-gray-500 font-medium border-r border-gray-200">
                  비고
                  <span onMouseDown={e => startColResize(e, 'note')} draggable={false} onDragStart={e => e.preventDefault()}
                    className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
                </th>
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
                          <td className="px-4 py-2 text-center text-gray-400">{idx + 1}</td>
                          <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm text-center" value={form.no || ''} onChange={e => setForm(f => ({ ...f, no: e.target.value }))} /></td>
                          <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm text-center" value={form.sn || ''} onChange={e => setForm(f => ({ ...f, sn: e.target.value }))} /></td>
                          <td className="px-4 py-2 text-center text-gray-400 text-xs">{(item.eff || item).cert_no || '—'}</td>
                          <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm text-center" value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></td>
                          <td className="px-4 py-2 text-center text-gray-400 text-xs">{formatDate((item.eff || item).calib_date)}</td>
                          <td className="px-4 py-2 text-center text-gray-400 text-xs">{formatDate((item.eff || item).next_calib_date)}</td>
                          <td className="px-4 py-2 text-center text-gray-300">—</td>
                          <td className="px-4 py-2 text-center text-gray-400 text-xs truncate" title={latestHistory(item)?.note || ''}>{latestHistory(item)?.note || '—'}</td>
                          <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm text-center" placeholder="비고" value={form.note || ''} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} /></td>
                          <td className="px-4 py-2 text-center whitespace-nowrap">
                            <button onClick={saveEdit} disabled={saving} className="px-2 py-1 bg-blue-600 text-white rounded text-xs mr-1 disabled:opacity-50">저장</button>
                            <button onClick={() => setEditingId(null)} className="px-2 py-1 bg-gray-200 rounded text-xs">취소</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3 text-center text-gray-400">{idx + 1}</td>
                          <td className="px-4 py-3 text-center font-medium text-gray-800">{item.no}</td>
                          <td className="px-4 py-3 text-center text-gray-600">{item.sn}</td>
                          <td className="px-4 py-3 text-center text-gray-500 text-xs">{(item.eff || item).cert_no}</td>
                          <td className="px-4 py-3 text-center text-gray-600">{item.name}</td>
                          <td className="px-4 py-3 text-center text-gray-500 text-xs">{formatDate((item.eff || item).calib_date)}</td>
                          <td className="px-4 py-3 text-center text-gray-500 text-xs">{(item.eff || item).next_calib_date === '미사용' ? '미사용' : formatDate((item.eff || item).next_calib_date)}</td>
                          <td className={`px-4 py-3 text-center font-semibold text-sm ${getDDayColor(item.dday)}`}>{getDDayLabel(item.dday)}</td>
                          <td className="px-4 py-3 text-center text-xs text-gray-400 truncate" title={latestHistory(item)?.note || ''}>{latestHistory(item)?.note || ''}</td>
                          <td className="px-4 py-3 text-center text-xs text-gray-400">{item.note}</td>
                          <td className="px-4 py-3 text-center whitespace-nowrap">
                            {(() => {
                              const lf = latestHistory(item);
                              return lf?.filePath ? (
                                <button onClick={async () => { const r = await openCalibFile(lf.filePath); if (r && !r.ok) showNotice('열기 실패: ' + (r.error || ''), true); }}
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
                        <td colSpan={12} className="p-0 bg-gray-50/60">
                          <HistoryPanel item={item} onSave={history => persistHistory(item, history)} onNotice={showNotice} />
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

      {confirmDeleteId !== null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xs p-5 space-y-4">
            <p className="text-sm text-gray-700">삭제하시겠습니까?</p>
            <div className="flex gap-2">
              <button onClick={confirmDelete} className="flex-1 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">삭제</button>
              <button onClick={() => setConfirmDeleteId(null)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2 max-w-sm">
          <div className={`px-4 py-3 rounded-xl shadow-xl flex items-start gap-3 ${notice.isError ? 'bg-red-500 text-white' : 'bg-green-600 text-white'}`}>
            <span className="text-sm font-medium flex-1 leading-snug">{notice.text}</span>
            <button onClick={() => setNotice(null)} className={`text-lg leading-none shrink-0 ${notice.isError ? 'text-red-200 hover:text-white' : 'text-green-200 hover:text-white'}`}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

function FragmentRow({ children }) { return <>{children}</>; }

function HistoryPanel({ item, onSave, onNotice }) {
  const [rows, setRows] = useState(() => (item.history || []).map(h => ({ ...h })));
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  function edit(idx, patch) { setRows(rs => rs.map((r, i) => i === idx ? { ...r, ...patch } : r)); setDirty(true); }
  function add() { setRows(rs => [...rs, { id: newHistoryId(), year: new Date().getFullYear(), cert_no: '', calib_date: '', note: '', fileName: '', filePath: '' }]); setDirty(true); }
  function remove(idx) { setRows(rs => rs.filter((_, i) => i !== idx)); setDirty(true); }

  async function upload(idx, file) {
    if (!file) return;
    if (!isElectron) { onNotice('파일 첨부는 데스크톱 앱에서만 지원됩니다.', true); return; }
    const row = rows[idx];
    if (!row.calib_date) { onNotice('먼저 교정일을 입력하세요. (파일명이 관리번호·교정일 기준으로 저장됩니다)', true); return; }
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
    const desired = certFileName(item.no, row.calib_date, item.sn, file.name);
    const r = await saveCalibFile(desired, b64);
    if (r?.ok) edit(idx, { fileName: r.name, filePath: r.path });
    else onNotice('파일 저장 실패: ' + (r?.error || ''), true);
  }

  async function save() {
    setBusy(true);
    const toSave = rows.map(r => ({ ...r, next_calib_date: r.calib_date ? nextCalibDate(r.calib_date) : '' }));
    try { await onSave(toSave); setDirty(false); } catch (e) { onNotice('저장 실패: ' + e.message, true); } finally { setBusy(false); }
  }

  async function open(path) { const r = await openCalibFile(path); if (r && !r.ok) onNotice('열기 실패: ' + (r.error || ''), true); }

  // 교정일이 최신인 내역이 가장 위로 오도록 정렬(대표값 계산에 쓰는 latestCalibHistory와
  // 동일한 기준: calib_date 내림차순, 동률이면 연도 내림차순). 교정일을 아직 입력하지
  // 않은 새 내역(+ 내역 추가로 막 만든 행)은 연도만으로 비교하면 기존 항목들 사이에
  // 끼어 들어갈 수 있으므로, 교정일이 비어있으면 항상 맨 위로 오게 한다.
  const view = rows.map((r, i) => ({ r, i })).sort((a, b) => {
    const ad = a.r.calib_date, bd = b.r.calib_date;
    if (!ad && !bd) return (b.r.year || 0) - (a.r.year || 0);
    if (!ad) return -1;
    if (!bd) return 1;
    return bd.localeCompare(ad) || (b.r.year || 0) - (a.r.year || 0);
  });

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
                className="flex-1 min-w-24 border border-gray-200 rounded px-1.5 py-1 text-xs" placeholder="교정내역" />
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
