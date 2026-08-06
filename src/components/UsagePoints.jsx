import { useState, useEffect, useMemo } from 'react';
import { formatDate } from '../utils/dateUtils';
import {
  fetchUsagePoints, upsertUsagePoint, deleteUsagePoint,
  saveCalibFile, uploadCalibAttachment, openCalibFile, revealCalibFile, syncGetConfig,
} from '../lib/api';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

const PROGRESS_OPTIONS = ['접수', '진행중', '완료', '보류'];
const PROGRESS_COLOR = {
  '접수': 'bg-gray-100 text-gray-600',
  '진행중': 'bg-amber-100 text-amber-700',
  '완료': 'bg-emerald-100 text-emerald-700',
  '보류': 'bg-red-100 text-red-700',
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyForm() {
  return {
    category: '', created_date: todayStr(), author_name: '', room_name: '', room_number: '',
    point_number: '', reason: '', photoThumb: '', photoFileName: '', photoFilePath: '', photoGistKey: '',
    progress: '접수', note: '',
  };
}

// 사진을 캔버스로 축소해 표 미리보기용(작게)·원본 첨부용(크게) data URL을 만든다.
function resizeImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
        else { width = Math.round(width * maxDim / height); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

export default function UsagePoints({ adminUnlocked }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [openingId, setOpeningId] = useState(null);

  useEffect(() => {
    fetchUsagePoints().then(list => setData(list || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  function showNotice(text, isError) {
    setNotice({ text, isError });
    setTimeout(() => setNotice(null), 3500);
  }

  function requireAdmin() {
    if (!adminUnlocked) { showNotice('관리자 잠금 해제가 필요합니다.', true); return false; }
    return true;
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter(u => [u.category, u.author_name, u.room_name, u.room_number, u.point_number, u.reason, u.note]
      .some(v => String(v || '').toLowerCase().includes(q)));
  }, [data, search]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => (b.created_date || '').localeCompare(a.created_date || '')), [filtered]);

  function openAdd() {
    if (!requireAdmin()) return;
    setEditingId(null);
    setForm(emptyForm());
    setShowForm(true);
  }
  function openEdit(item) {
    if (!requireAdmin()) return;
    setEditingId(item.id);
    setForm({ ...emptyForm(), ...item });
    setShowForm(true);
  }

  async function handlePhotoChange(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingPhoto(true);
    try {
      const thumb = await resizeImage(file, 260, 0.55);
      setForm(f => ({ ...f, photoThumb: thumb }));
      if (isElectron) {
        const full = await resizeImage(file, 1400, 0.75);
        const b64 = full.split(',')[1];
        const desired = `usagepoint_${Date.now()}_${file.name.replace(/[^\w.\-가-힣 ()]/g, '_')}`;
        const r = await saveCalibFile(desired, b64);
        if (r?.ok) {
          let gistKey = '';
          try {
            const cfg = await syncGetConfig();
            if (cfg?.hasToken) {
              gistKey = `attach_up_${Date.now()}.jpg.b64`;
              const ur = await uploadCalibAttachment(gistKey, b64);
              if (!ur?.ok) gistKey = '';
            }
          } catch { /* 공유 설정 없으면 로컬 저장만 유지 */ }
          setForm(f => ({ ...f, photoFileName: r.name, photoFilePath: r.path, photoGistKey: gistKey }));
        } else {
          showNotice('사진 저장 실패: ' + (r?.error || ''), true);
        }
      }
    } catch (err) {
      showNotice('사진 처리 실패: ' + err.message, true);
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleSave() {
    if (!requireAdmin()) return;
    if (!form.room_name && !form.point_number) { showNotice('실명 또는 사용점번호를 입력하세요.', true); return; }
    setSaving(true);
    try {
      const item = editingId ? { ...form, id: editingId } : { ...form };
      const saved = await upsertUsagePoint(item);
      setData(prev => editingId ? prev.map(d => d.id === editingId ? saved : d) : [...prev, saved]);
      window.electronAPI?.notifyDataChanged?.();
      setShowForm(false);
      showNotice('저장되었습니다.');
    } catch (e) {
      showNotice('저장 실패: ' + e.message, true);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!requireAdmin()) return;
    setConfirmDeleteId(null);
    try {
      await deleteUsagePoint(id);
      setData(prev => prev.filter(d => d.id !== id));
      window.electronAPI?.notifyDataChanged?.();
    } catch (e) {
      showNotice('삭제 실패: ' + e.message, true);
    }
  }

  async function quickSetProgress(item, progress) {
    if (!requireAdmin()) return;
    try {
      const saved = await upsertUsagePoint({ ...item, progress });
      setData(prev => prev.map(d => d.id === item.id ? saved : d));
      window.electronAPI?.notifyDataChanged?.();
    } catch (e) {
      showNotice('변경 실패: ' + e.message, true);
    }
  }

  async function openOriginal(item) {
    if (!item.photoFilePath && !item.photoGistKey) return;
    setOpeningId(item.id);
    try {
      const r = await openCalibFile(item.photoFilePath, item.photoGistKey, item.photoFileName);
      if (r && !r.ok) showNotice('열기 실패: ' + (r.error || ''), true);
    } finally {
      setOpeningId(null);
    }
  }

  if (loading) {
    return <div className="p-6 text-sm text-gray-400">불러오는 중...</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-gray-800">사용점 관리</h1>
        <div className="flex items-center gap-2">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="검색 (분류·작성자·실명·사용점번호 등)"
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm w-64" />
          <button onClick={openAdd} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">+ 추가</button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
        <table className="text-sm w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-3 py-3 text-gray-500 font-medium text-center">분류</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">작성일</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">작성자</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">실명</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">실번호</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">사용점번호</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">사유</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">사진</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">진행상황</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">비고</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">관리</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sorted.map(item => (
              <tr key={item.id} className="hover:bg-gray-50">
                <td className="px-3 py-2 text-center text-gray-600">{item.category || '—'}</td>
                <td className="px-3 py-2 text-center text-gray-500 text-xs">{formatDate(item.created_date)}</td>
                <td className="px-3 py-2 text-center text-gray-600">{item.author_name || '—'}</td>
                <td className="px-3 py-2 text-center text-gray-600">{item.room_name || '—'}</td>
                <td className="px-3 py-2 text-center text-gray-600">{item.room_number || '—'}</td>
                <td className="px-3 py-2 text-center font-medium text-gray-800">{item.point_number || '—'}</td>
                <td className="px-3 py-2 text-center text-gray-500 text-xs max-w-[160px] truncate" title={item.reason || ''}>{item.reason || '—'}</td>
                <td className="px-3 py-2 text-center">
                  {item.photoThumb ? (
                    <img src={item.photoThumb} onClick={() => setLightbox(item)} alt="사진"
                      className="w-12 h-12 object-cover rounded-lg cursor-pointer mx-auto border border-gray-200 hover:opacity-80" />
                  ) : <span className="text-gray-300 text-xs">—</span>}
                </td>
                <td className="px-3 py-2 text-center">
                  <select value={item.progress || '접수'} disabled={!adminUnlocked}
                    onChange={e => quickSetProgress(item, e.target.value)}
                    className={`text-xs rounded-full px-2 py-1 border-0 font-medium cursor-pointer disabled:cursor-default ${PROGRESS_COLOR[item.progress] || 'bg-gray-100 text-gray-600'}`}>
                    {PROGRESS_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2 text-center text-gray-500 text-xs max-w-[140px] truncate" title={item.note || ''}>{item.note || '—'}</td>
                <td className="px-3 py-2 text-center whitespace-nowrap">
                  {adminUnlocked && (
                    <>
                      <button onClick={() => openEdit(item)} className="px-2 py-1 text-blue-600 hover:bg-blue-50 rounded text-xs mr-1">수정</button>
                      <button onClick={() => setConfirmDeleteId(item.id)} className="px-2 py-1 text-red-500 hover:bg-red-50 rounded text-xs">삭제</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-10 text-center text-gray-400 text-sm">등록된 사용점이 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="font-bold text-gray-800">{editingId ? '사용점 수정' : '사용점 추가'}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">분류</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">작성일</label>
                <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.created_date} onChange={e => setForm(f => ({ ...f, created_date: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">작성자이름</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.author_name} onChange={e => setForm(f => ({ ...f, author_name: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">진행상황</label>
                <select className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.progress} onChange={e => setForm(f => ({ ...f, progress: e.target.value }))}>
                  {PROGRESS_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500">실명</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.room_name} onChange={e => setForm(f => ({ ...f, room_name: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">실번호</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.room_number} onChange={e => setForm(f => ({ ...f, room_number: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">사용점번호</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.point_number} onChange={e => setForm(f => ({ ...f, point_number: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-gray-500">사유</label>
                <textarea className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" rows={2} value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-gray-500">비고</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-gray-500">사진첨부</label>
                <div className="flex items-center gap-3 mt-1">
                  {form.photoThumb && <img src={form.photoThumb} alt="미리보기" className="w-16 h-16 object-cover rounded-lg border border-gray-200" />}
                  <input type="file" accept="image/*" onChange={handlePhotoChange} disabled={uploadingPhoto}
                    className="text-xs text-gray-500 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-gray-100 file:text-gray-600 file:text-xs" />
                  {uploadingPhoto && <span className="text-xs text-gray-400">처리 중…</span>}
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={handleSave} disabled={saving} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {saving ? '저장 중…' : '저장'}
              </button>
              <button onClick={() => setShowForm(false)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[300] p-6" onClick={() => setLightbox(null)}>
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <img src={lightbox.photoThumb} alt="사진" className="w-full max-h-[70vh] object-contain rounded-lg" />
            <div className="flex justify-between items-center">
              <p className="text-xs text-gray-400 truncate">{lightbox.photoFileName || ''}</p>
              <div className="flex gap-2">
                {(lightbox.photoFilePath || lightbox.photoGistKey) && isElectron && (
                  <>
                    <button onClick={() => openOriginal(lightbox)} disabled={openingId === lightbox.id}
                      className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-xs disabled:opacity-50">
                      {openingId === lightbox.id ? '⏳ 다운로드 중…' : '📄 원본 열기'}
                    </button>
                    <button onClick={() => revealCalibFile(lightbox.photoFilePath, lightbox.photoGistKey, lightbox.photoFileName)}
                      className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-xs">📁 폴더 열기</button>
                  </>
                )}
                <button onClick={() => setLightbox(null)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50">닫기</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteId !== null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xs p-5 space-y-4">
            <p className="text-sm text-gray-700">삭제하시겠습니까?</p>
            <div className="flex gap-2">
              <button onClick={() => handleDelete(confirmDeleteId)} className="flex-1 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">삭제</button>
              <button onClick={() => setConfirmDeleteId(null)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div className="fixed top-4 right-4 z-[400] flex flex-col gap-2 max-w-sm">
          <div className={`px-4 py-3 rounded-xl shadow-xl flex items-start gap-3 ${notice.isError ? 'bg-red-500 text-white' : 'bg-green-600 text-white'}`}>
            <span className="text-sm font-medium flex-1 leading-snug">{notice.text}</span>
            <button onClick={() => setNotice(null)} className={`text-lg leading-none shrink-0 ${notice.isError ? 'text-red-200 hover:text-white' : 'text-green-200 hover:text-white'}`}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}
