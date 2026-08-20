import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { formatDate } from '../utils/dateUtils';
import {
  fetchUsagePoints, upsertUsagePoint, deleteUsagePoint,
  fetchUsagePointCategories, saveUsagePointCategories,
  saveCalibFile, uploadCalibAttachment, revealCalibFile, resolveCalibImage, syncGetConfig, syncUpload,
  backfillCalibAttachments, printDoc,
} from '../lib/api';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

const MAJOR_CATEGORIES = ['공조', '가스', '용수', '기타'];
const DEFAULT_CATEGORIES = { '공조': [], '가스': [], '용수': [], '기타': [] };
const PROGRESS_OPTIONS = ['신청', '조사 중', '조치 중', '완료', '보류'];
// 예전에 저장된 값(접수·진행중)은 새 단계로 바꿔 읽는다 — 저장된 데이터를 손대지
// 않고도 화면·필터·색상이 새 구성으로 일관되게 동작하게 하기 위함.
const LEGACY_PROGRESS = { '접수': '신청', '진행중': '조치 중' };
function progressOf(item) {
  const v = item?.progress || '';
  return LEGACY_PROGRESS[v] || v || PROGRESS_OPTIONS[0];
}
const PROGRESS_COLOR = {
  '신청': 'bg-gray-100 text-gray-600',
  '조사 중': 'bg-blue-100 text-blue-700',
  '조치 중': 'bg-amber-100 text-amber-700',
  '완료': 'bg-emerald-100 text-emerald-700',
  '보류': 'bg-red-100 text-red-700',
};
const USAGEPOINT_COLS = 14; // 작업자 열 추가

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyForm(currentMember) {
  return {
    // created_date는 화면상 "작업일"이다(실제 작업한 날 — 사용자가 바꿀 수 있음).
    // created_at은 "작성일" — 이 기록을 처음 저장한 날로, 자동으로 채워지고 수정할 수 없다.
    major_category: '', minor_category: '', created_date: todayStr(), created_at: '',
    author_id: currentMember?.id || '', author_name: currentMember?.username || '',
    worker_name: '',
    room_name: '', room_number: '', point_number: '', reason: '',
    photoThumb: '', photoFileName: '', photoFilePath: '', photoGistKey: '',
    progress: PROGRESS_OPTIONS[0], progress_note: '', progress_logs: [], action_taken: '', note: '',
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
  // 기본값은 미완료 — 처리해야 할 건이 먼저 보이도록.
  const [doneFilter, setDoneFilter] = useState('open'); // 'all' | 'open'(미완료) | 'done'(완료)
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(() => emptyForm(currentMember));
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [hqUrl, setHqUrl] = useState(null);
  const [hqLoading, setHqLoading] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const [sharingPhotos, setSharingPhotos] = useState(false);
  const [printing, setPrinting] = useState(false);
  const printRef = useRef(null);
  const [showCatManager, setShowCatManager] = useState(false);
  const [catDraft, setCatDraft] = useState(null);
  const [newMinor, setNewMinor] = useState({});

  const reload = useCallback(() => {
    return Promise.all([fetchUsagePoints(), fetchUsagePointCategories()])
      .then(([list, cats]) => { setData(list || []); setCategories(cats || DEFAULT_CATEGORIES); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // 공유 동기화로 새 내용이 들어오면 화면을 바로 최신화한다 — 예전에는 이 창을
  // 열어둔 채로는 반영되지 않아 다른 메뉴에 갔다 와야 보였다.
  useEffect(() => {
    if (!window.electronAPI?.onDataChanged) return;
    return window.electronAPI.onDataChanged(() => { reload(); });
  }, [reload]);

  // 미리보기(사진)를 클릭해 확대창을 열면, 로컬/캐시에 없으면 공유 Gist에서
  // 원본을 받아 캐시에 저장한 뒤 항상 고화질(최대 2000px 저장본)로 보여준다.
  // 받는 동안에는 압축된 작은 미리보기를 대신 보여준다.
  useEffect(() => {
    setHqUrl(null);
    if (!lightbox || !isElectron) return;
    if (!lightbox.photoFilePath && !lightbox.photoGistKey) return;
    setHqLoading(true);
    resolveCalibImage(lightbox.photoFilePath, lightbox.photoGistKey, lightbox.photoFileName, 'usagepoints')
      .then(r => {
        if (r?.ok) setHqUrl(r.dataUrl);
        else showNotice('고화질 이미지를 불러오지 못했습니다: ' + (r?.error || ''), true);
      })
      .catch(e => showNotice('고화질 이미지를 불러오지 못했습니다: ' + e.message, true))
      .finally(() => setHqLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox?.id]);

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
  // 관리자가 신청을 다음 단계로 넘기고 나면 작성자는 더 이상 손댈 수 없다.
  function canManage(item) {
    if (adminUnlocked) return true;
    if (!currentMember) return false;
    const isAuthor = item.author_id ? item.author_id === currentMember.id : (!!item.author_name && item.author_name === currentMember.username);
    return isAuthor && progressOf(item) === PROGRESS_OPTIONS[0];
  }

  const filtered = useMemo(() => {
    let list = data;
    if (majorFilter !== 'all') list = list.filter(u => u.major_category === majorFilter);
    // 완료만 "완료"이고 나머지(신청·조사 중·조치 중·보류)는 모두 미완료로 묶는다.
    if (doneFilter === 'done') list = list.filter(u => progressOf(u) === '완료');
    else if (doneFilter === 'open') list = list.filter(u => progressOf(u) !== '완료');
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(u => [u.major_category, u.minor_category, u.author_name, u.worker_name, u.room_name, u.room_number, u.point_number, u.reason, u.note]
        .some(v => String(v || '').toLowerCase().includes(q)));
    }
    return list;
  }, [data, search, majorFilter, doneFilter]);

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
      // 확대해서 봐도 충분한 선(최대 3000px, JPEG 품질 0.92)까지만 제한해 저장하고,
      // 목록 미리보기는 이보다 훨씬 작은 썸네일을 따로 만든다.
      let thumb, capped;
      try {
        [thumb, capped] = await Promise.all([resizeImage(file, 260, 0.6), resizeImage(file, 3000, 0.92)]);
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
      // 작성일(created_at)은 처음 저장할 때 한 번만 채우고 이후에는 건드리지 않는다.
      // 예전에 저장된 기록에는 이 값이 없으므로, 수정 시 작업일을 그대로 물려준다.
      const existing = editingId ? data.find(d => d.id === editingId) : null;
      const createdAt = existing?.created_at || (editingId ? (existing?.created_date || '') : todayStr());
      const item = editingId
        ? { ...form, id: editingId, created_at: createdAt }
        : { ...form, created_at: createdAt };
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

  // 진행상황은 덮어쓰지 않고 한 줄씩 덧붙인다 — 누가 언제 무엇을 적었는지 남기기 위함.
  async function appendProgressLog(item, text) {
    if (!requireAdmin()) return;
    const body = String(text || '').trim();
    if (!body) return;
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `
      + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const entry = {
      id: `${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      text: body,
      author: currentMember?.username || '',
      at: stamp,
    };
    const logs = [...(Array.isArray(item.progress_logs) ? item.progress_logs : []), entry];
    try {
      const saved = await upsertUsagePoint({ ...item, progress_logs: logs });
      setData(prev => prev.map(d => d.id === item.id ? saved : d));
      window.electronAPI?.notifyDataChanged?.();
      syncAfterChange();
      showNotice('진행상황이 기록되었습니다.');
    } catch (e) {
      showNotice('저장 실패: ' + e.message, true);
    }
  }

  // 현재 화면에 보이는 목록(검색·대분류 필터가 적용된 그대로)을 A4 세로 PDF로
  // 만들어 기본 뷰어로 연다 — 달력 인쇄와 같은 방식(Windows 인쇄 대화상자가
  // 방향 설정을 무시하는 문제를 피하려고 PDF로 만든 뒤 뷰어에서 인쇄).
  async function handlePrintPdf() {
    if (printing) return;
    if (!sorted.length) { showNotice('출력할 내용이 없습니다.', true); return; }
    const src = printRef.current;
    if (!src) return;
    setPrinting(true);

    const portal = document.createElement('div');
    portal.className = 'print-portal';
    portal.appendChild(src.cloneNode(true));
    document.body.appendChild(portal);
    document.body.classList.add('is-printing');

    // 표는 세로 방향으로 여러 페이지에 걸쳐 흐르게 한다(달력처럼 한 페이지에
    // 맞출 필요가 없음). @page는 선택자로 조건부 지정이 안 되므로 덮어쓴다.
    const styleEl = document.createElement('style');
    styleEl.textContent = '@page { size: A4 portrait; margin: 10mm; }';
    document.head.appendChild(styleEl);

    const cleanup = () => {
      document.body.classList.remove('is-printing');
      portal.remove();
      styleEl.remove();
    };

    try {
      if (isElectron) {
        await new Promise(r => requestAnimationFrame(() => r())); // 렌더 안정화
        const r = await printDoc({ landscape: false, pageSize: 'A4', fileName: '사용점관리' });
        if (r?.ok) showNotice('PDF로 열었습니다. 뷰어에서 인쇄(Ctrl+P)하세요.');
        else showNotice('PDF 생성 실패: ' + (r?.error || ''), true);
      } else {
        window.print();
      }
    } catch (e) {
      showNotice('PDF 생성 실패: ' + e.message, true);
    } finally {
      cleanup();
      setPrinting(false);
    }
  }

  // 토큰이 없거나 만료된 상태에서 등록한 사진은 공유 Gist에 못 올라가, 다른 PC에서
  // 작게 압축된 미리보기만 보인다. 뒤늦게라도 원본을 올려 모든 PC가 고화질로
  // 볼 수 있게 한다(이미 올라간 사진은 건너뛴다).
  async function handleSharePhotos() {
    if (sharingPhotos) return;
    setSharingPhotos(true);
    try {
      const r = await backfillCalibAttachments();
      if (!r?.ok) { showNotice('사진 공유 실패: ' + (r?.error || ''), true); return; }
      // 원본이 이 PC에 없는 사진은 여기서 올릴 수 없다 — 그 사진을 등록한 PC에서
      // 실행해야 한다. 예전에는 이 경우에도 "모두 공유됨"이라고 잘못 안내했다.
      const otherPc = r.missingLocal
        ? ` 원본이 이 PC에 없는 사진 ${r.missingLocal}건은 올리지 못했습니다 — 그 사진을 등록한 PC에서 눌러주세요.`
        : '';
      if (r.total === 0) {
        showNotice(r.missingLocal
          ? `이 PC에서 올릴 사진은 없습니다.${otherPc}`
          : '모든 사진이 이미 공유되어 있습니다.', !!r.missingLocal);
        return;
      }
      if (r.uploaded > 0) await reload();
      const failMsg = r.failed?.length ? ` (실패 ${r.failed.length}건)` : '';
      showNotice(`📤 사진 ${r.uploaded}/${r.total}건을 공유했습니다.${failMsg}${otherPc}`,
        r.failed?.length > 0 || !!r.missingLocal);
    } catch (e) {
      showNotice('사진 공유 중 오류: ' + e.message, true);
    } finally {
      setSharingPhotos(false);
    }
  }

  // 완료 처리된 건의 조치사항 — 무엇을 해서 마무리했는지 적는 칸.
  async function saveActionTaken(item, action_taken) {
    if (!requireAdmin()) return;
    try {
      const saved = await upsertUsagePoint({ ...item, action_taken });
      setData(prev => prev.map(d => d.id === item.id ? saved : d));
      window.electronAPI?.notifyDataChanged?.();
      syncAfterChange();
      showNotice('조치사항이 저장되었습니다.');
    } catch (e) {
      showNotice('저장 실패: ' + e.message, true);
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
          <button onClick={handlePrintPdf} disabled={printing}
            title="지금 화면에 보이는 목록(검색·분류 필터 적용)을 A4 세로 PDF로 만듭니다."
            className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-200 disabled:opacity-50">
            {printing ? '🖨 준비 중…' : '🖨 PDF 출력'}
          </button>
          <button onClick={handleSharePhotos} disabled={sharingPhotos}
            title="공유에 아직 올라가지 않은 사진의 원본을 올려, 다른 PC에서도 고화질로 볼 수 있게 합니다."
            className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-200 disabled:opacity-50">
            {sharingPhotos ? '📤 공유 중…' : '📤 사진 공유'}
          </button>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="검색 (분류·작성자·작업자·실명·사용점번호 등)"
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm w-64" />
          <button onClick={openAdd} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">+ 추가</button>
        </div>
      </div>

      {/* PDF 출력 전용 표 — 화면에는 보이지 않고(부모가 display:none), 출력할 때만
          .print-portal로 복제되어 인쇄된다. 화면 표에 있는 버튼·사진·펼치기 같은
          요소를 빼고 순수 내용만 담아 인쇄물이 깔끔하게 나오게 한다. */}
      <div style={{ display: 'none' }} aria-hidden="true">
        <div ref={printRef} className="up-print">
          <h1>사용점 관리</h1>
          <p className="up-print-meta">
            출력일 {todayStr()} · 총 {sorted.length}건
            {majorFilter !== 'all' && ` · 대분류: ${majorFilter}`}
            {search.trim() && ` · 검색: "${search.trim()}"`}
          </p>
          <table>
            <colgroup>
              <col style={{ width: '4%' }} /><col style={{ width: '6%' }} /><col style={{ width: '8%' }} />
              <col style={{ width: '8%' }} /><col style={{ width: '8%' }} /><col style={{ width: '7%' }} />
              <col style={{ width: '7%' }} /><col style={{ width: '9%' }} /><col style={{ width: '6%' }} />
              <col style={{ width: '8%' }} /><col style={{ width: '13%' }} /><col style={{ width: '6%' }} />
              <col style={{ width: '11%' }} /><col style={{ width: '6%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>번호</th><th>대분류</th><th>소분류</th><th>작성일</th><th>작업일</th>
                <th>작성자</th><th>작업자</th><th>실명</th><th>실번호</th><th>사용점번호</th>
                <th>사유</th><th>진행상황</th><th>조치사항</th><th>비고</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((u, i) => (
                <tr key={u.id}>
                  <td className="up-center">{i + 1}</td>
                  <td className="up-center">{u.major_category || ''}</td>
                  <td className="up-center">{u.minor_category || ''}</td>
                  <td className="up-center">{u.created_at || ''}</td>
                  <td className="up-center">{u.created_date || ''}</td>
                  <td className="up-center">{u.author_name || ''}</td>
                  <td className="up-center">{u.worker_name || ''}</td>
                  <td>{u.room_name || ''}</td>
                  <td className="up-center">{u.room_number || ''}</td>
                  <td className="up-center">{u.point_number || ''}</td>
                  <td>{u.reason || ''}</td>
                  <td className="up-center">{progressOf(u)}</td>
                  <td>{u.action_taken || ''}</td>
                  <td>{u.note || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-gray-400 mr-1">상태</span>
        {[['all', '전체'], ['open', '미완료'], ['done', '완료']].map(([v, label]) => {
          const count = v === 'all' ? data.length
            : v === 'done' ? data.filter(u => progressOf(u) === '완료').length
            : data.filter(u => progressOf(u) !== '완료').length;
          return (
            <button key={v} onClick={() => setDoneFilter(v)}
              className={`px-3 py-1 rounded-full text-xs font-medium border ${doneFilter === v
                ? (v === 'done' ? 'bg-emerald-600 text-white border-emerald-600' : v === 'open' ? 'bg-amber-500 text-white border-amber-500' : 'bg-blue-600 text-white border-blue-600')
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {label} {count}
            </button>
          );
        })}
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
              <th className="px-3 py-3 text-gray-500 font-medium text-center">작업일</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">작성자</th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">작업자</th>
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
                    <td className="px-3 py-2 text-center text-gray-600">{item.worker_name || '—'}</td>
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
                        progressOf(item) === PROGRESS_OPTIONS[0] ? (
                          <button onClick={() => quickSetProgress(item, '조사 중')}
                            className="text-xs rounded-full px-2.5 py-1 font-medium bg-gray-100 text-gray-600 hover:bg-amber-100 hover:text-amber-700"
                            title="다음 단계로 넘기기 — 조사 중으로 바꾸면 작성자는 더 이상 수정할 수 없습니다">
                            신청 ➜ 조사 중
                          </button>
                        ) : (
                          <select value={progressOf(item)} onChange={e => quickSetProgress(item, e.target.value)}
                            className={`text-xs rounded-full px-2 py-1 border-0 font-medium cursor-pointer ${PROGRESS_COLOR[progressOf(item)] || 'bg-gray-100 text-gray-600'}`}>
                            {PROGRESS_OPTIONS.slice(1).map(p => <option key={p} value={p}>{p}</option>)}
                          </select>
                        )
                      ) : (
                        <span className={`text-xs rounded-full px-2.5 py-1 font-medium inline-block ${PROGRESS_COLOR[progressOf(item)] || PROGRESS_COLOR[PROGRESS_OPTIONS[0]]}`}>{progressOf(item)}</span>
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
                        <ProgressNotePanel item={item} adminUnlocked={adminUnlocked} currentMember={currentMember}
                          onAppend={text => appendProgressLog(item, text)}
                          onSaveAction={text => saveActionTaken(item, text)} />
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
              {/* 작성일·작성자 = 기록을 남긴 시점과 사람(자동, 수정 불가)
                  작업일·작업자 = 실제 작업한 날과 사람(직접 입력) */}
              <div>
                <label className="text-xs text-gray-500">작성일 <span className="text-gray-400">(자동)</span></label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5 bg-gray-50 text-gray-400"
                  value={form.created_at || (editingId ? (form.created_date || '—') : todayStr())} disabled readOnly />
              </div>
              <div>
                <label className="text-xs text-gray-500">작성자</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5 bg-gray-50 text-gray-400"
                  value={form.author_name} disabled readOnly
                  placeholder={currentMember ? '' : '로그인하면 자동으로 채워집니다'} />
              </div>
              <div>
                <label className="text-xs text-gray-500">작업일</label>
                <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.created_date} onChange={e => setForm(f => ({ ...f, created_date: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">작업자</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5"
                  value={form.worker_name || ''}
                  onChange={e => setForm(f => ({ ...f, worker_name: e.target.value }))}
                  placeholder="실제 작업한 사람" />
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
            <div className="relative">
              <img src={hqUrl || lightbox.photoThumb} alt="사진" className="w-full max-h-[70vh] object-contain rounded-lg" />
              {hqLoading && !hqUrl && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg">
                  <span className="text-white text-xs bg-black/50 px-3 py-1.5 rounded-full">⏳ 고화질 사진 받는 중…</span>
                </div>
              )}
            </div>
            <p className="text-[11px] text-gray-400">
              {hqUrl ? '고화질 사진(최대 3000px)입니다.'
                : hqLoading ? ''
                : !lightbox.photoGistKey
                  // 원본이 공유 Gist에 없으면 올린 PC에만 있어 다른 PC는 받을 수 없다.
                  ? '작게 압축된 미리보기입니다 — 원본이 아직 공유되지 않았습니다. 이 사진을 올린 PC에서 "📤 사진 공유"를 눌러주세요.'
                  : '작게 압축된 미리보기입니다.'}
            </p>
            <div className="flex justify-between items-center">
              <p className="text-xs text-gray-400 truncate">{lightbox.photoFileName || ''}</p>
              <div className="flex gap-2">
                {(lightbox.photoFilePath || lightbox.photoGistKey) && isElectron && (
                  <button onClick={() => revealCalibFile(lightbox.photoFilePath, lightbox.photoGistKey, lightbox.photoFileName, 'usagepoints')}
                    className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-xs">📁 폴더 열기</button>
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

// 진행상황은 고쳐 쓰는 메모가 아니라 기록(로그)이다. 저장할 때마다 내용·작성자·
// 시각이 아래에 한 줄씩 쌓이고, 지난 기록은 고치거나 지울 수 없다.
// 예전 방식(progress_note 한 칸에 덮어쓰기)으로 저장된 내용은 맨 위에 함께 보여준다.
function ProgressNotePanel({ item, adminUnlocked, currentMember, onAppend, onSaveAction }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState(item.action_taken || '');
  const [actionBusy, setActionBusy] = useState(false);
  const logs = Array.isArray(item.progress_logs) ? item.progress_logs : [];
  // 단계에 따라 어느 칸을 여는지 정한다.
  //  신청·조사 중 : 진행상황만 기록 (조치사항은 아직 숨김)
  //  조치 중      : 진행상황은 잠기고 조치사항을 작성
  //  완료         : 두 칸 모두 잠기고 남은 내역만 보인다
  const stage = progressOf(item);
  const isDone = stage === '완료';
  const isActing = stage === '조치 중';
  const canWrite = adminUnlocked && !isActing && !isDone;   // 진행상황 기록 입력
  const canWriteAction = adminUnlocked && isActing;          // 조치사항 입력
  // 조치사항은 조치 중부터 보이고, 한 번 작성한 내용은 이후 단계에서도 계속 보인다.
  const showAction = isActing || isDone || !!item.action_taken;

  // 목록이 동기화로 갱신되면 조치사항 입력칸도 최신 값을 따라간다.
  useEffect(() => { setAction(item.action_taken || ''); }, [item.action_taken]);

  async function submit() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onAppend(body);
      setText('');
    } finally { setBusy(false); }
  }

  return (
    <div className="px-8 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-gray-500">📝 진행상황 기록</span>
        <span className="text-[11px] text-gray-400">저장할 때마다 아래에 쌓이며, 지난 기록은 수정할 수 없습니다.</span>
      </div>

      {canWrite && (
        <div className="flex items-start gap-2 mb-2">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }}
            className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-xs"
            placeholder="진행 상황을 입력하고 저장하세요 (Ctrl+Enter)" />
          <button disabled={!text.trim() || busy} onClick={submit}
            className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded font-semibold disabled:opacity-40 shrink-0">
            {busy ? '저장 중…' : '저장'}
          </button>
        </div>
      )}
      {adminUnlocked && isDone && (
        <p className="text-[11px] text-emerald-600 mb-2">
          ✓ 완료 처리된 건입니다 — 진행상황·조치사항 모두 더 이상 수정할 수 없고 내역만 남습니다.
          다시 작성하려면 위 진행상황을 완료가 아닌 단계로 되돌리세요.
        </p>
      )}
      {adminUnlocked && isActing && (
        <p className="text-[11px] text-amber-600 mb-2">
          조치 중 단계입니다 — 진행상황 기록은 닫혔습니다. 아래 조치사항을 작성하세요.
        </p>
      )}

      {logs.length === 0 && !item.progress_note ? (
        <p className="text-xs text-gray-400">아직 작성된 진행상황이 없습니다.</p>
      ) : (
        <div className="space-y-1.5">
          {/* 최신 기록이 위로 오도록 역순 표시 */}
          {[...logs].reverse().map(l => (
            <div key={l.id} className="flex items-start gap-2 text-xs">
              <span className="shrink-0 text-gray-400 tabular-nums w-32">{l.at || ''}</span>
              <span className="shrink-0 font-medium text-gray-600 w-20 truncate" title={l.author}>{l.author || '—'}</span>
              <span className="flex-1 text-gray-700 whitespace-pre-wrap break-words">{l.text}</span>
            </div>
          ))}
          {item.progress_note && (
            <div className="flex items-start gap-2 text-xs pt-1.5 border-t border-gray-100">
              <span className="shrink-0 text-gray-400 w-32">이전 기록</span>
              <span className="shrink-0 w-20" />
              <span className="flex-1 text-gray-500 whitespace-pre-wrap break-words">{item.progress_note}</span>
            </div>
          )}
        </div>
      )}

      {/* 조치사항 — "조치 중"일 때만 작성할 수 있고, 완료로 넘어가면 확정되어 잠긴다. */}
      {showAction && (
      <div className="mt-3 pt-3 border-t border-gray-200">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-semibold text-emerald-700">✅ 조치사항</span>
          <span className="text-[11px] text-gray-400">
            {isDone ? '완료되어 확정된 내용입니다'
              : isActing ? '완료로 표시하면 더 이상 수정할 수 없습니다'
              : '조치 중 단계에서만 작성할 수 있습니다'}
          </span>
        </div>
        {canWriteAction ? (
          <div className="flex items-start gap-2">
            <textarea value={action} onChange={e => setAction(e.target.value)} rows={2}
              className="flex-1 border border-emerald-200 rounded px-2 py-1.5 text-xs"
              placeholder="어떤 조치로 마무리했는지 입력하세요" />
            <button
              disabled={actionBusy || action === (item.action_taken || '')}
              onClick={async () => { setActionBusy(true); try { await onSaveAction(action); } finally { setActionBusy(false); } }}
              className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded font-semibold disabled:opacity-40 shrink-0">
              {actionBusy ? '저장 중…' : '저장'}
            </button>
          </div>
        ) : (
          <p className="text-xs text-gray-600 whitespace-pre-wrap">{item.action_taken || '아직 작성된 조치사항이 없습니다.'}</p>
        )}
      </div>
      )}
    </div>
  );
}
