import { useState, useMemo } from 'react';
import { calcDDay, getDDayLabel, getDDayColor, formatDate } from '../utils/dateUtils';
import { getCalibration, saveCalibration } from '../utils/storage';

export default function Calibration() {
  const [data, setData] = useState(getCalibration);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | urgent | expired
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({});
  const [showAdd, setShowAdd] = useState(false);

  const enriched = useMemo(() => {
    return data.map(item => ({
      ...item,
      dday: item.nextCalibDate && item.nextCalibDate !== '미사용' ? calcDDay(item.nextCalibDate) : null,
    }));
  }, [data]);

  const filtered = useMemo(() => {
    let list = enriched;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(item =>
        item.no.toLowerCase().includes(q) ||
        item.sn.toString().toLowerCase().includes(q) ||
        (item.name && item.name.toLowerCase().includes(q)) ||
        (item.certNo && item.certNo.toLowerCase().includes(q))
      );
    }
    if (filter === 'urgent') list = list.filter(i => i.dday !== null && i.dday >= 0 && i.dday <= 60);
    if (filter === 'expired') list = list.filter(i => i.dday !== null && i.dday < 0);
    return list;
  }, [enriched, search, filter]);

  function startEdit(item) {
    setEditingId(item.id);
    setForm({ ...item });
  }

  function saveEdit() {
    const updated = data.map(d => d.id === editingId ? { ...d, ...form } : d);
    setData(updated);
    saveCalibration(updated);
    setEditingId(null);
  }

  function deleteItem(id) {
    if (!confirm('삭제하시겠습니까?')) return;
    const updated = data.filter(d => d.id !== id);
    setData(updated);
    saveCalibration(updated);
  }

  function addItem() {
    const newItem = {
      id: Date.now(),
      no: form.no || '',
      sn: form.sn || '',
      certNo: form.certNo || '',
      calibDate: form.calibDate || '',
      nextCalibDate: form.nextCalibDate || '',
      name: form.name || '',
      note: form.note || '',
    };
    const updated = [...data, newItem];
    setData(updated);
    saveCalibration(updated);
    setShowAdd(false);
    setForm({});
  }

  const expiredCount = enriched.filter(i => i.dday !== null && i.dday < 0).length;
  const urgentCount = enriched.filter(i => i.dday !== null && i.dday >= 0 && i.dday <= 60).length;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">교정 관리</h1>
        <button
          onClick={() => { setShowAdd(true); setForm({}); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          + 추가
        </button>
      </div>

      {/* 필터 바 */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="관리번호, S/N, 장비명 검색..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-48 px-3 py-2 border border-gray-200 rounded-lg text-sm"
        />
        <div className="flex gap-2">
          {[
            { key: 'all', label: `전체 (${enriched.length})` },
            { key: 'expired', label: `만료 (${expiredCount})`, color: 'text-red-600' },
            { key: 'urgent', label: `임박 (${urgentCount})`, color: 'text-orange-500' },
          ].map(({ key, label, color }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                filter === key ? 'bg-blue-600 text-white border-blue-600' : `border-gray-200 ${color || 'text-gray-600'} hover:bg-gray-50`
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 테이블 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 text-gray-500 font-medium w-8">No.</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">관리번호</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">S/N</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">성적서번호</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">장비명</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">교정일</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">차기교정일</th>
                <th className="text-center px-4 py-3 text-gray-500 font-medium">D-Day</th>
                <th className="text-center px-4 py-3 text-gray-500 font-medium">비고</th>
                <th className="text-center px-4 py-3 text-gray-500 font-medium">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.map((item, idx) => (
                <tr key={item.id} className={`hover:bg-gray-50 ${item.dday !== null && item.dday < 0 ? 'bg-red-50' : ''}`}>
                  {editingId === item.id ? (
                    <>
                      <td className="px-4 py-2 text-gray-400">{idx + 1}</td>
                      <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" value={form.no || ''} onChange={e => setForm(f => ({ ...f, no: e.target.value }))} /></td>
                      <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" value={form.sn || ''} onChange={e => setForm(f => ({ ...f, sn: e.target.value }))} /></td>
                      <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" value={form.certNo || ''} onChange={e => setForm(f => ({ ...f, certNo: e.target.value }))} /></td>
                      <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></td>
                      <td className="px-4 py-2"><input type="date" className="w-full border rounded px-2 py-1 text-sm" value={form.calibDate || ''} onChange={e => setForm(f => ({ ...f, calibDate: e.target.value }))} /></td>
                      <td className="px-4 py-2"><input type="date" className="w-full border rounded px-2 py-1 text-sm" value={form.nextCalibDate && form.nextCalibDate !== '미사용' ? form.nextCalibDate : ''} onChange={e => setForm(f => ({ ...f, nextCalibDate: e.target.value }))} /></td>
                      <td className="px-4 py-2" colSpan={2}><input className="w-full border rounded px-2 py-1 text-sm" placeholder="비고" value={form.note || ''} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} /></td>
                      <td className="px-4 py-2 text-center">
                        <button onClick={saveEdit} className="px-2 py-1 bg-blue-600 text-white rounded text-xs mr-1">저장</button>
                        <button onClick={() => setEditingId(null)} className="px-2 py-1 bg-gray-200 rounded text-xs">취소</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 text-gray-400">{idx + 1}</td>
                      <td className="px-4 py-3 font-medium text-gray-800">{item.no}</td>
                      <td className="px-4 py-3 text-gray-600">{item.sn}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{item.certNo}</td>
                      <td className="px-4 py-3 text-gray-600">{item.name}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(item.calibDate)}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{item.nextCalibDate === '미사용' ? '미사용' : formatDate(item.nextCalibDate)}</td>
                      <td className={`px-4 py-3 text-center font-semibold text-sm ${getDDayColor(item.dday)}`}>
                        {getDDayLabel(item.dday)}
                      </td>
                      <td className="px-4 py-3 text-center text-xs text-gray-400">{item.note}</td>
                      <td className="px-4 py-3 text-center">
                        <button onClick={() => startEdit(item)} className="px-2 py-1 text-blue-600 hover:bg-blue-50 rounded text-xs mr-1">수정</button>
                        <button onClick={() => deleteItem(item.id)} className="px-2 py-1 text-red-500 hover:bg-red-50 rounded text-xs">삭제</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 추가 모달 */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h2 className="font-bold text-gray-800">교정 장비 추가</h2>
            <div className="grid grid-cols-2 gap-3">
              {[
                { key: 'no', label: '관리번호' },
                { key: 'sn', label: 'S/N' },
                { key: 'name', label: '장비명' },
                { key: 'certNo', label: '성적서번호' },
              ].map(({ key, label }) => (
                <div key={key}>
                  <label className="text-xs text-gray-500">{label}</label>
                  <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
                </div>
              ))}
              <div>
                <label className="text-xs text-gray-500">교정일</label>
                <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.calibDate || ''} onChange={e => setForm(f => ({ ...f, calibDate: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">차기교정일</label>
                <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.nextCalibDate || ''} onChange={e => setForm(f => ({ ...f, nextCalibDate: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">비고</label>
              <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.note || ''} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={addItem} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">추가</button>
              <button onClick={() => setShowAdd(false)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
