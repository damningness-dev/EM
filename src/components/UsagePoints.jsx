import { useState, useEffect, useMemo } from 'react';
import { formatDate } from '../utils/dateUtils';
import {
  fetchUsagePoints, upsertUsagePoint, deleteUsagePoint,
  fetchUsagePointCategories, saveUsagePointCategories,
  saveCalibFile, uploadCalibAttachment, openCalibFile, revealCalibFile, syncGetConfig, syncUpload,
} from '../lib/api';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

const MAJOR_CATEGORIES = ['공조', '가스', '용수', '기타'];
const DEFAULT_CATEGORIES = { '공조': [], '가스': [], '용수': [], '기타': [] };
const PROGRESS_OPTIONS = ['접수', '진행중', '완료', '보류'];
const PROGRESS_COLOR = {
  '접수': 'bg-gray-100 text-gray-600',
  '진행중': 'bg-amber-100 text-amber-700',
  '완료': 'bg-emerald-100 text-emerald-700',
  '보류': 'bg-red-100 text-red-700',
};
const USAGEPOINT_COLS = 13;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyForm(currentMember) {
  return {
    major_category: '', minor_category: '', created_date: todayStr(),
    author_id: currentMember?.id || '', author_name: currentMember?.username || '',
    room_name: '', room_number: '', point_number: '', reason: '',
    photoThumb: '', photoFileName: '', photoFilePath: '', photoGistKey: '',
    progress: '접수', progress_note: '', note: '',
  };
}

// 표 미리보기·수정 화면 미리보기용으로만 캔버스에서 작게 축소한다.
// 원본 파일은 손대지 않고 그대로 저장/공유해 다운로드 시 화질이 깨지지 않게 한다.
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

export default function UsagePoints({ adminUnlocked, currentMember }) {
  const [data, setData] = useState([]);
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [majorFilter, setMajorFilter] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(() => emptyForm(currentMember));
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [showCatManager, setShowCatManager] = useState(false);
  const [catDraft, setCatDraft] = useState(null);
  const [newMinor, setNewMinor] = useState({});

  useEffect(() => {
    Promise.all([fetchUsagePoints(), fetchUsagePointCategories()])
      .then(([list, cats]) => { setData(list || []); setCategories(cats || DEFAULT_CATEGORIES); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function showNotice(text, isError) {
    setNotice({ text, isError });
    setTimeout(() => setNotice(null), 3500);
  }

  function requireAdmin() {
    if (!adminUnlocked) { showNotice('관리자 잠금 해제가 필요합니다.', true); return false; }
    return true;
  }

  // 사용점 목록이 바뀌면(추가·수정·삭제·진행상황) em-data.json에 저장된 뒤, 공유
  // 설정(Gist ID + 토큰)이 있으면 자동으로 Gist에 업로드해 다른 PC와 공유한다.
  // 관리자가 아니어도 이 PC에 공유 토큰이 설정되어 있으면 바로 반영된다 —
  // 반대로 이 PC에 토큰이 없으면 다음 자동 동기화 때까지는 이 PC에만 남아있다.
  async function syncAfterChange() {
    try {
      const cfg = await syncGetConfig();
      if (!cfg?.gistId || !cfg?.hasToken) return;
      await syncUpload();
    } catch { /* 조용히 건너뜀 — 로컬 저장은 이미 성공했으므로 */ }
  }

  // 작성자 본인(접수 상태일 때만) 또는 관리자만 수정·삭제할 수 있다.
  // 관리자가 접수를 진행중으로 바꾸고 나면 작성자는 더 이상 손댈 수 없다.
  function canManage(item) {
    if (adminUnlocked) return true;
    if (!currentMember) return false;
    const isAuthor = item.author_id ? item.author_id === currentMember.id : (!!item.author_name && item.author_name === currentMember.username);
    return isAuthor && (item.progress || '접수') === '접수';
  }

  const filtered = useMemo(() => {
    let list = data;
    if (majorFilter !== 'all') list = list.filter(u => u.major_category === majorFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(u => [u.major_category, u.minor_category, u.author_name, u.room_name, u.room_number, u.point_number, u.reason, u.note]
        .some(v => String(v || '').toLowerCase().includes(q)));
    }
    return list;
  }, [data, search, majorFilter]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => (b.created_date || '').localeCompare(a.created_date || '')), [filtered]);

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm(currentMember));
    setShowForm(true);
  }
  function openEdit(item) {
    if (!canManage(item)) { showNotice('수정 권한이 없습니다.', true); return; }
    setEditingId(item.id);
    setForm({ ...emptyForm(currentMember), ...item });
    setShowForm(true);
  }
  function toggleExpand(id) {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function handlePhotoChange(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingPhoto(true);
    try {
      // 원본을 손대지 않고 그대로 올리면 휴대폰 사진(수 MB)이 공유 첨부파일 Gist
      // 업로드에서 실패하기 쉬워 다른 PC에서 "사진이 안 보이는" 문제로 이어진다.
      // 화질 손상이 거의 느껴지지 않는 선(최대 2000px, JPEG 품질 0.85)까지만
      // 제한해 저장하고, 목록 미리보기는 이보다 훨씬 작은 썸네일을 따로 만든다.
      let thumb, capped;
      try {
        [thumb, capped] = await Promise.all([resizeImage(file, 260, 0.6), resizeImage(file, 2000, 0.85)]);
      } catch {
        showNotice('사진을 불러올 수 없습니다. 지원하지 않는 이미지 형식일 수 있습니다(예: 아이폰 HEIC) — JPG·PNG로 다시 시도해보세요.', true);
        return;
      }
      setForm(f => ({ ...f, photoThumb: thumb }));
      if (isElectron) {
        const b64 = capped.split(',')[1];
        const dot = file.name.lastIndexOf('.');
        const baseName = (dot > 0 ? file.name.slice(0, dot) : file.name).replace(/[^\w.\-가-힣 ()]/g, '_');
        // 캔버스로 다시 인코딩한 결과는 항상 JPEG이므로 원래 확장자 대신 .jpg로 저장한다.
        const desired = `usagepoint_${Date.now()}_${baseName}.jpg`;
        const r = await saveCalibFile(desired, b64, 'usagepoints');
        if (r?.ok) {
          let gistKey = '';
          try {
            const cfg = await syncGetConfig();
            if (cfg?.hasToken) {
              gistKey = `attach_up_${Date.now()}.jpg.b64`;
              const ur = await uploadCalibAttachment(gistKey, b64);
              if (!ur?.ok) { gistKey = ''; showNotice('사진은 저장됐지만 공유 업로드 실패: ' + (ur?.error || ''), true); }
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
    if (editingId) {
      const existing = data.find(d => d.id === editingId);
      if (existing && !canManage(existing)) { showNotice('수정 권한이 없습니다.', true); return; }
    }
    if (!form.room_name && !form.point_number) { showNotice('실명 또는 사용점번호를 입력하세요.', true); return; }
    setSaving(true);
    try {
      const item = editingId ? { ...form, id: editingId } : { ...form };
      const saved = await upsertUsagePoint(item);
      setData(prev => editingId ? prev.map(d => d.id === editingId ? saved : d) : [...prev, saved]);
      window.electronAPI?.notifyDataChanged?.();
      syncAfterChange();
      setShowForm(false);
      showNotice('저장되었습니다.');
    } catch (e) {
      showNotice('저장 실패: ' + e.message, true);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    const existing = data.find(d => d.id === id);
    if (existing && !canManage(existing)) { showNotice('삭제 권한이 없습니다.', true); setConfirmDeleteId(null); return; }
    setConfirmDeleteId(null);
    try {
      await deleteUsagePoint(id);
      setData(prev => prev.filter(d => d.id !== id));
      window.electronAPI?.notifyDataChanged?.();
      syncAfterChange();
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
      syncAfterChange();
    } catch (e) {
      showNotice('변경 실패: ' + e.message, true);
    }
  }

  async function saveProgressNote(item, progress_note) {
    if (!requireAdmin()) return;
    try {
      const saved = await upsertUsagePoint({ ...item, progress_note });
      setData(prev => prev.map(d => d.id === item.id ? saved : d));
      window.electronAPI?.notifyDataChanged?.();
      syncAfterChange();
      showNotice('진행상황이 저장되었습니다.');
    } catch (e) {
      showNotice('저장 실패: ' + e.message, true);
    }
  }

  async function openOriginal(item) {
    if (!item.photoFilePath && !item.photoGistKey) return;
    setOpeningId(item.id);
    try {
      const r = await openCalibFile(item.photoFilePath, item.photoGistKey, item.photoFileName, 'usagepoints');
      if (r && !r.ok) showNotice('열기 실패: ' + (r.error || ''), true);
    } finally {
      setOpeningId(null);
    }
  }

  function openCatManager() {
    if (!requireAdmin()) return;
    setCatDraft(JSON.parse(JSON.stringify(categories || DEFAULT_CATEGORIES)));
    setShowCatManager(true);
  }
  function addMinor(major) {
    const v = (newMinor[major] || '').trim();
    if (!v) return;
    setCatDraft(d => ({ ...d, [major]: [...(d[major] || []), v] }));
    setNewMinor(m => ({ ...m, [major]: '' }));
  }
  function removeMinor(major, idx) {
    setCatDraft(d => ({ ...d, [major]: d[major].filter((_, i) => i !== idx) }));
  }
  function renameMinor(major, idx, value) {
    setCatDraft(d => ({ ...d, [major]: d[major].map((v, i) => i === idx ? value : v) }));
  }
  async function saveCatDraft() {
    try {
      const saved = await saveUsagePointCategories(catDraft);
      setCategories(saved || catDraft);
      syncAfterChange();
      setShowCatManager(false);
      showNotice('분류 목록이 저장되었습니다.');
    } catch (e) {
      showNotice('저장 실패: ' + e.message, true);
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
          {adminUnlocked && (
            <button onClick={openCatManager} className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-200">🏷️ 분류 관리</button>
          )}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="검색 (분류·작성자·실명·사용점번호 등)"
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm w-64" />
          <button onClick={openAdd} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">+ 추가</button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-gray-400 mr-1">대분류</span>
        {['all', ...MAJOR_CATEGORIES].map(c => (
          <button key={c} onClick={() => setMajorFilter(c)}
            className={`px-3 py-1 rounded-full text-xs font-medium border ${majorFilter === c ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            {c === 'all' ? '전체' : c}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
        <table className="text-sm w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-1 py-3"></th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">대분류</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">소분류</th>
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
            {sorted.map(item => {
              const editable = canManage(item);
              const isExp = expanded.has(item.id);
              return (
                <FragmentRow key={item.id}>
                  <tr className="hover:bg-gray-50">
                    <td className="px-1 text-center text-gray-300">
                      <button onClick={() => toggleExpand(item.id)} className={`text-[10px] transition-transform ${isExp ? 'rotate-90 text-blue-500' : ''}`} title="진행상황 메모">▶</button>
                    </td>
                    <td className="px-3 py-2 text-center text-gray-600">{item.major_category || '—'}</td>
                    <td className="px-3 py-2 text-center text-gray-600">{item.minor_category || '—'}</td>
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
                      {adminUnlocked ? (
                        (item.progress || '접수') === '접수' ? (
                          <button onClick={() => quickSetProgress(item, '진행중')}
                            className="text-xs rounded-full px-2.5 py-1 font-medium bg-gray-100 text-gray-600 hover:bg-amber-100 hover:text-amber-700"
                            title="접수 처리 — 진행중으로 변경하면 작성자는 더 이상 수정할 수 없습니다">
                            접수 ➜ 진행중
                          </button>
                        ) : (
                          <select value={item.progress} onChange={e => quickSetProgress(item, e.target.value)}
                            className={`text-xs rounded-full px-2 py-1 border-0 font-medium cursor-pointer ${PROGRESS_COLOR[item.progress] || 'bg-gray-100 text-gray-600'}`}>
                            {['진행중', '완료', '보류'].map(p => <option key={p} value={p}>{p}</option>)}
                          </select>
                        )
                      ) : (
                        <span className={`text-xs rounded-full px-2.5 py-1 font-medium inline-block ${PROGRESS_COLOR[item.progress] || PROGRESS_COLOR['접수']}`}>{item.progress || '접수'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center text-gray-500 text-xs max-w-[140px] truncate" title={item.note || ''}>{item.note || '—'}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      {editable && (
                        <>
                          <button onClick={() => openEdit(item)} className="px-2 py-1 text-blue-600 hover:bg-blue-50 rounded text-xs mr-1">수정</button>
                          <button onClick={() => setConfirmDeleteId(item.id)} className="px-2 py-1 text-red-500 hover:bg-red-50 rounded text-xs">삭제</button>
                        </>
                      )}
                    </td>
                  </tr>
                  {isExp && (
                    <tr>
                      <td colSpan={USAGEPOINT_COLS} className="p-0 bg-gray-50/60">
                        <ProgressNotePanel item={item} adminUnlocked={adminUnlocked} onSave={text => saveProgressNote(item, text)} />
                      </td>
                    </tr>
                  )}
                </FragmentRow>
              );
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={USAGEPOINT_COLS} className="px-3 py-10 text-center text-gray-400 text-sm">등록된 사용점이 없습니다.</td></tr>
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
                <label className="text-xs text-gray-500">대분류</label>
                <select className="w-full border rounded px-2 py-1.5 text-sm mt-0.5"
                  value={form.major_category} onChange={e => setForm(f => ({ ...f, major_category: e.target.value, minor_category: '' }))}>
                  <option value="">선택</option>
                  {MAJOR_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500">소분류</label>
                <input list="usagepoint-minor-cats" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5"
                  value={form.minor_category} onChange={e => setForm(f => ({ ...f, minor_category: e.target.value }))}
                  placeholder={form.major_category ? '선택 또는 입력' : '대분류를 먼저 선택하세요'} disabled={!form.major_category} />
                <datalist id="usagepoint-minor-cats">
                  {(categories[form.major_category] || []).map(v => <option key={v} value={v} />)}
                </datalist>
              </div>
              <div>
                <label className="text-xs text-gray-500">작성일</label>
                <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.created_date} onChange={e => setForm(f => ({ ...f, created_date: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">작성자</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5 disabled:bg-gray-50 disabled:text-gray-400"
                  value={form.author_name} disabled={!!currentMember}
                  onChange={e => setForm(f => ({ ...f, author_name: e.target.value }))}
                  placeholder={currentMember ? '' : '로그인하면 자동으로 채워집니다'} />
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

      {showCatManager && catDraft && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[85vh] overflow-y-auto">
            <h2 className="font-bold text-gray-800">🏷️ 분류 관리</h2>
            <p className="text-xs text-gray-400">대분류는 공조·가스·용수·기타로 고정되어 있습니다. 각 대분류 아래 소분류를 추가·수정·삭제할 수 있습니다.</p>
            {MAJOR_CATEGORIES.map(major => (
              <div key={major} className="border border-gray-100 rounded-lg p-3 space-y-2">
                <p className="text-sm font-semibold text-gray-700">{major}</p>
                <div className="space-y-1.5">
                  {(catDraft[major] || []).map((v, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input value={v} onChange={e => renameMinor(major, idx, e.target.value)} className="flex-1 border rounded px-2 py-1 text-xs" />
                      <button onClick={() => removeMinor(major, idx)} className="text-xs text-gray-300 hover:text-red-500 px-1">✕</button>
                    </div>
                  ))}
                  {(catDraft[major] || []).length === 0 && <p className="text-xs text-gray-300">등록된 소분류가 없습니다.</p>}
                </div>
                <div className="flex items-center gap-2">
                  <input value={newMinor[major] || ''} onChange={e => setNewMinor(m => ({ ...m, [major]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addMinor(major); } }}
                    placeholder="새 소분류" className="flex-1 border rounded px-2 py-1 text-xs" />
                  <button onClick={() => addMinor(major)} className="text-xs px-2.5 py-1 bg-gray-100 hover:bg-gray-200 rounded font-medium">추가</button>
                </div>
              </div>
            ))}
            <div className="flex gap-2 pt-2">
              <button onClick={saveCatDraft} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">저장</button>
              <button onClick={() => setShowCatManager(false)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[300] p-6" onClick={() => setLightbox(null)}>
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <img src={lightbox.photoThumb} alt="사진" className="w-full max-h-[70vh] object-contain rounded-lg" />
            <p className="text-[11px] text-gray-400">위 미리보기는 더 작게 압축되어 있습니다. "고화질로 열기"로 저장된 사진(최대 2000px)을 확인하세요.</p>
            <div className="flex justify-between items-center">
              <p className="text-xs text-gray-400 truncate">{lightbox.photoFileName || ''}</p>
              <div className="flex gap-2">
                {(lightbox.photoFilePath || lightbox.photoGistKey) && isElectron && (
                  <>
                    <button onClick={() => openOriginal(lightbox)} disabled={openingId === lightbox.id}
                      className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-xs disabled:opacity-50">
                      {openingId === lightbox.id ? '⏳ 다운로드 중…' : '📄 고화질로 열기'}
                    </button>
                    <button onClick={() => revealCalibFile(lightbox.photoFilePath, lightbox.photoGistKey, lightbox.photoFileName, 'usagepoints')}
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

function FragmentRow({ children }) { return <>{children}</>; }

function ProgressNotePanel({ item, adminUnlocked, onSave }) {
  const [text, setText] = useState(item.progress_note || '');
  const [busy, setBusy] = useState(false);
  const dirty = text !== (item.progress_note || '');
  return (
    <div className="px-8 py-3 flex items-start gap-3">
      <span className="text-xs font-semibold text-gray-500 shrink-0 pt-1.5">📝 진행상황 메모</span>
      {adminUnlocked ? (
        <>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
            className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-xs" placeholder="접수 처리 후 진행 상황을 기록하세요" />
          <button disabled={!dirty || busy} onClick={async () => { setBusy(true); try { await onSave(text); } finally { setBusy(false); } }}
            className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded font-semibold disabled:opacity-40 shrink-0">
            {busy ? '저장 중…' : '저장'}
          </button>
        </>
      ) : (
        <p className="flex-1 text-xs text-gray-500 whitespace-pre-wrap pt-1">{item.progress_note || '아직 작성된 진행상황이 없습니다.'}</p>
      )}
    </div>
  );
}
