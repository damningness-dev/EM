import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { formatDate } from '../utils/dateUtils';
import {
  fetchUsagePoints, upsertUsagePoint, deleteUsagePoint,
  fetchUsagePointCategories, saveUsagePointCategories,
  saveCalibFile, uploadCalibAttachment, revealCalibFile, resolveCalibImage, syncGetConfig, syncUpload,
  backfillCalibAttachments, printDoc, fetchMembers,
} from '../lib/api';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

const MAJOR_CATEGORIES = ['공조', '가스', '용수', '기타'];
const DEFAULT_CATEGORIES = { '공조': [], '가스': [], '용수': [], '기타': [] };
// 신청 → 접수 → 조사 중 → 조치 중 → 완료/보류 순서로 진행된다. 신청·접수는
// 관리자가 직접 다음 단계로 넘기고(버튼 클릭), 조사 중·조치 중은 관련 정보가
// 채워지면 자동으로 넘어간다(아래 handleSave·appendProgressLog·saveActionTaken
// 참고) — 완료·보류는 조치가 끝난 뒤 관리자가 직접 고른다.
const PROGRESS_OPTIONS = ['신청', '접수', '조사 중', '조치 중', '완료', '보류'];
// 예전에 저장된 값(진행중)은 새 단계로 바꿔 읽는다 — 저장된 데이터를 손대지
// 않고도 화면·필터·색상이 새 구성으로 일관되게 동작하게 하기 위함.
const LEGACY_PROGRESS = { '진행중': '조치 중' };
function progressOf(item) {
  const v = item?.progress || '';
  return LEGACY_PROGRESS[v] || v || PROGRESS_OPTIONS[0];
}
const PROGRESS_COLOR = {
  '신청': 'bg-gray-100 text-gray-600',
  '접수': 'bg-sky-100 text-sky-700',
  '조사 중': 'bg-indigo-100 text-indigo-700',
  '조치 중': 'bg-amber-100 text-amber-700',
  '완료': 'bg-emerald-100 text-emerald-700',
  '보류': 'bg-red-100 text-red-700',
};
const USAGEPOINT_COLS = 17; // No.(화살표 합침)+제목+담당자+완료기한

// 목록 표 열 너비 — 헤더 사이 구분선을 드래그해 조절할 수 있다(교정관리와 같은 방식).
// 화살표(펼치기)는 No.와 한 열로 합쳐져 있고, 진행상황은 No. 바로 다음(제목·대분류 앞)에 온다.
const UP_COL_KEYS = ['no', 'progress', 'title', 'major', 'minor', 'workDate', 'author', 'worker', 'room', 'roomNo', 'point', 'reason', 'photo', 'note', 'assignee', 'dueDate', 'manage'];
const UP_COL_DEFAULT_W = {
  no: 64, progress: 100, title: 140, major: 76, minor: 90, workDate: 96, author: 76, worker: 76,
  room: 90, roomNo: 76, point: 100, reason: 160, photo: 76, note: 140,
  assignee: 110, dueDate: 88, manage: 96,
};
const UP_COL_STORE_KEY = 'em-usagepoints-table-cols-v3'; // 열 구성이 또 바뀌어(제목 추가) 예전 저장값과 섞이지 않도록 키를 바꿈

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 완료기한을 D-day로 표시한다(목록의 "완료기한" 열에서 사용). 지났으면 D+n(빨강), 오늘이면 D-DAY(빨강),
// 임박(3일 이하)이면 주황, 그 외엔 회색.
function dDayInfo(dueDate) {
  if (!dueDate) return null;
  const due = new Date(dueDate + 'T00:00:00');
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((due - today) / 86400000);
  const text = diff === 0 ? 'D-DAY' : diff > 0 ? `D-${diff}` : `D+${-diff}`;
  const color = diff <= 0 ? 'text-red-600' : diff <= 3 ? 'text-amber-600' : 'text-gray-500';
  return { text, color };
}

// 사진을 여러 장 지원하기 전(예전) 데이터는 photoThumb 등 단일 필드였다.
// 새 photos 배열이 있으면 그걸 쓰고, 없으면 예전 단일 필드를 배열 하나로 감싸
// 화면 어디서든 똑같이 다룰 수 있게 한다.
function photosOf(item) {
  if (Array.isArray(item?.photos) && item.photos.length) return item.photos;
  if (item?.photoThumb || item?.photoFilePath || item?.photoGistKey) {
    return [{ id: 'legacy', thumb: item.photoThumb, fileName: item.photoFileName, filePath: item.photoFilePath, gistKey: item.photoGistKey }];
  }
  return [];
}

// 담당자는 계정 목록에서 여러 명을 고르는 방식(assignees 배열)이다. 자유 입력
// 한 명이던 예전 데이터(assignee 문자열)는 배열 하나로 감싸 그대로 읽는다.
function assigneesOf(item) {
  if (Array.isArray(item?.assignees)) return item.assignees;
  if (item?.assignee) return [item.assignee];
  return [];
}

function emptyForm(currentMember) {
  return {
    title: '', // 목록에서 눌러 상세보기를 여는 제목 — 폼 맨 위에 있다.
    // created_date는 화면상 "작업일"이다(실제 작업한 날 — 사용자가 바꿀 수 있음).
    // created_at은 "작성일" — 이 기록을 처음 저장한 날로, 자동으로 채워지고 수정할 수 없다.
    major_category: '', minor_category: '', created_date: todayStr(), created_at: '',
    author_id: currentMember?.id || '', author_name: currentMember?.username || '',
    worker_name: '',
    // 담당자(여러 명)·완료기한·검토의견 — 접수 단계에서 채우며, 모두 입력해야
    // 진행상황 배지를 눌러 조사 중으로 넘어갈 수 있다.
    assignees: [], due_date: '', review_note: '',
    room_name: '', room_number: '', point_number: '', reason: '',
    photos: [], // [{ id, thumb, fileName, filePath, gistKey }, ...]
    progress: PROGRESS_OPTIONS[0], progress_note: '', progress_logs: [], action_taken: '', conclusion: '', note: '',
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
  const [memberNames, setMemberNames] = useState([]); // 담당자 체크박스 후보 = 등록된 계정 목록
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [majorFilter, setMajorFilter] = useState('all');
  // 기본값은 미완료 — 처리해야 할 건이 먼저 보이도록.
  // 'all'(전체) | 'open'(완료 제외 전체) | PROGRESS_OPTIONS 중 하나(그 단계만)
  const [doneFilter, setDoneFilter] = useState('open');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  // null이면 평소처럼 수정 가능한 팝업. 항목이 들어있으면 "상세보기"로 열렸는데
  // 수정 권한이 없는 경우라, 입력칸을 잠그고 읽기 전용으로 보여준다.
  const [viewItem, setViewItem] = useState(null);
  const [form, setForm] = useState(() => emptyForm(currentMember));
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [lightbox, setLightbox] = useState(null); // { photos: [...], index } | null
  const [hqUrl, setHqUrl] = useState(null);
  const [hqLoading, setHqLoading] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const [assigneeDropdownId, setAssigneeDropdownId] = useState(null); // 목록에서 담당자 드롭다운을 연 항목 id
  const [sharingPhotos, setSharingPhotos] = useState(false);
  const [printing, setPrinting] = useState(false);
  const printRef = useRef(null);
  const photoPrintRef = useRef(null);
  const [colW, setColW] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem(UP_COL_STORE_KEY)); if (s && typeof s === 'object') return s; } catch { /* ignore */ }
    return {};
  });
  useEffect(() => { try { localStorage.setItem(UP_COL_STORE_KEY, JSON.stringify(colW)); } catch { /* ignore */ } }, [colW]);
  const colWidth = k => colW[k] ?? UP_COL_DEFAULT_W[k];
  // 구분선을 끌면 이 열과 바로 다음 열이 폭을 서로 주고받는다(전체 합은 그대로) —
  // 표는 항상 컨테이너 폭의 100%로 그려지므로, 합이 바뀌지 않으면 다른 열들의
  // 비율도 안 바뀌어 가로 스크롤이 생기지 않으면서 이 두 열만 커지고 작아진다.
  const MIN_COL_W = 28;
  function startColResize(e, key) {
    e.preventDefault(); e.stopPropagation();
    const idx = UP_COL_KEYS.indexOf(key);
    const nextKey = UP_COL_KEYS[idx + 1];
    const startX = e.clientX;
    const startW = colWidth(key);
    const startNextW = nextKey ? colWidth(nextKey) : null;
    const onMove = ev => {
      if (nextKey) {
        const delta = Math.max(MIN_COL_W - startW, Math.min(ev.clientX - startX, startNextW - MIN_COL_W));
        setColW(prev => ({ ...prev, [key]: startW + delta, [nextKey]: startNextW - delta }));
      } else {
        // 맨 마지막(관리) 열은 넘겨줄 다음 열이 없어 자기 최소값까지만 줄어든다 —
        // 실제로는 handle이 없어(항상 nextKey가 있음) 호출되지 않는 경로.
        setColW(prev => ({ ...prev, [key]: Math.max(MIN_COL_W, startW + ev.clientX - startX) }));
      }
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }
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

  useEffect(() => {
    fetchMembers().then(ms => setMemberNames((ms || []).map(m => m.username))).catch(() => {});
  }, []);

  // 수정 팝업을 열어둔 채로 하단 진행상황 패널에서 기록을 남기면, 그 즉시
  // upsertUsagePoint로 저장되어 data가 갱신된다. 이때 form의 progress_logs·
  // action_taken·progress가 그 변화를 모르는 옛 값 그대로면, 사용자가 다른 칸을
  // 고치고 "저장"을 눌렀을 때 방금 남긴 기록을 옛 값으로 덮어써 지워버린다.
  // data가 바뀔 때마다 이 세 필드만 최신으로 맞춰 그 사고를 막는다.
  useEffect(() => {
    if (!editingId) return;
    const latest = data.find(d => d.id === editingId);
    if (!latest) return;
    setForm(f => ({ ...f, progress_logs: latest.progress_logs, action_taken: latest.action_taken, progress: latest.progress }));
  }, [data, editingId]);

  // 공유 동기화로 새 내용이 들어오면 화면을 바로 최신화한다 — 예전에는 이 창을
  // 열어둔 채로는 반영되지 않아 다른 메뉴에 갔다 와야 보였다.
  useEffect(() => {
    if (!window.electronAPI?.onDataChanged) return;
    return window.electronAPI.onDataChanged(() => { reload(); });
  }, [reload]);

  // 미리보기(사진)를 클릭해 확대창을 열면, 로컬/캐시에 없으면 공유 Gist에서
  // 원본을 받아 캐시에 저장한 뒤 항상 고화질(최대 2000px 저장본)로 보여준다.
  // 받는 동안에는 압축된 작은 미리보기를 대신 보여준다. 여러 장이면 지금 보고
  // 있는 장(index)이 바뀔 때마다 그 장의 원본을 다시 받는다.
  const lightboxPhoto = lightbox ? lightbox.photos[lightbox.index] : null;
  const lightboxItem = lightbox ? data.find(d => d.id === lightbox.itemId) : null;
  useEffect(() => {
    setHqUrl(null);
    if (!lightboxPhoto || !isElectron) return;
    if (!lightboxPhoto.filePath && !lightboxPhoto.gistKey) return;
    setHqLoading(true);
    resolveCalibImage(lightboxPhoto.filePath, lightboxPhoto.gistKey, lightboxPhoto.fileName, 'usagepoints')
      .then(r => {
        if (r?.ok) setHqUrl(r.dataUrl);
        else showNotice('고화질 이미지를 불러오지 못했습니다: ' + (r?.error || ''), true);
      })
      .catch(e => showNotice('고화질 이미지를 불러오지 못했습니다: ' + e.message, true))
      .finally(() => setHqLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox?.itemId, lightbox?.index]);

  function gotoPhoto(delta) {
    setLightbox(l => {
      if (!l || l.photos.length <= 1) return l;
      const n = l.photos.length;
      return { ...l, index: (l.index + delta + n) % n };
    });
  }
  // 확대창이 떠 있는 동안 방향키로도 다음/이전 사진, Esc로 닫기.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = e => {
      if (e.key === 'ArrowRight') gotoPhoto(1);
      else if (e.key === 'ArrowLeft') gotoPhoto(-1);
      else if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // 목록의 담당자 드롭다운 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!assigneeDropdownId) return;
    const onDocClick = e => { if (!e.target.closest('.assignee-dropdown')) setAssigneeDropdownId(null); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [assigneeDropdownId]);

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
    // '미완료'는 완료를 제외한 전체(신청·접수·조치 중·보류)를 묶어 보여준다.
    // 그 외 값은 PROGRESS_OPTIONS 중 하나를 그대로 받아 그 단계만 정확히 걸러낸다.
    if (doneFilter === 'open') list = list.filter(u => progressOf(u) !== '완료');
    else if (doneFilter !== 'all') list = list.filter(u => progressOf(u) === doneFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(u => [u.title, u.major_category, u.minor_category, u.author_name, u.worker_name, u.room_name, u.room_number, u.point_number, u.reason, u.note, ...assigneesOf(u)]
        .some(v => String(v || '').toLowerCase().includes(q)));
    }
    return list;
  }, [data, search, majorFilter, doneFilter]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => (b.created_date || '').localeCompare(a.created_date || '')), [filtered]);

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm(currentMember));
    setViewItem(null);
    setShowForm(true);
  }
  function openEdit(item) {
    if (!canManage(item)) { showNotice('수정 권한이 없습니다.', true); return; }
    setEditingId(item.id);
    // photosOf()로 예전 단일 필드 사진도 배열 형태로 맞춰 넣는다 — 안 그러면 여러
    // 장 지원 전에 등록된 사진이 폼에서는 안 보이다가 저장할 때 사라져버린다.
    setForm({ ...emptyForm(currentMember), ...item, photos: photosOf(item), assignees: assigneesOf(item) });
    setViewItem(null);
    setShowForm(true);
  }
  // 목록에 다 못 보여주는 항목을, 수정 권한 여부와 관계없이 누구나 상세히 볼 수
  // 있게 처음 작성했던 팝업을 그대로 연다. 수정 권한이 없으면 입력칸을 잠가
  // 읽기 전용으로 보여준다(작성한 값을 훼손하지 않도록).
  function openDetail(item) {
    setEditingId(item.id);
    setForm({ ...emptyForm(currentMember), ...item, photos: photosOf(item), assignees: assigneesOf(item) });
    setViewItem(canManage(item) ? null : item); // 잠금 여부 판단용
    setShowForm(true);
  }
  function toggleExpand(id) {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  // 한 장씩 처리해 끝나는 대로 갤러리에 추가한다(여러 장을 동시에 올리면
  // 파일명 충돌·업로드 순서가 꼬이기 쉬워 순서대로 처리한다).
  // 사진 한 장을 (썸네일 + 원본 저장 + 공유 업로드까지) 끝까지 처리해 항목을
  // 만든다. 중간에 실패하면 null을 반환하고 아무 것도 반영하지 않는다 —
  // 예전 코드는 실패해도 썸네일만 먼저 바꿔놔서, 목록 미리보기와 실제 열리는
  // 사진(원본 파일 경로)이 서로 다른 사진을 가리키는 사고가 있었다. 항상 전부
  // 성공했을 때만 한 번에 반영해서 이 둘이 어긋나지 않게 한다.
  async function buildPhotoEntry(file) {
    // 원본을 손대지 않고 그대로 올리면 휴대폰 사진(수 MB)이 공유 첨부파일 Gist
    // 업로드에서 실패하기 쉬워 다른 PC에서 "사진이 안 보이는" 문제로 이어진다.
    // 확대해서 봐도 충분한 선(최대 3000px, JPEG 품질 0.92)까지만 제한해 저장하고,
    // 목록 미리보기는 이보다 훨씬 작은 썸네일을 따로 만든다.
    let thumb, capped;
    try {
      [thumb, capped] = await Promise.all([resizeImage(file, 260, 0.6), resizeImage(file, 3000, 0.92)]);
    } catch {
      showNotice(`"${file.name}"을(를) 불러올 수 없습니다. 지원하지 않는 이미지 형식일 수 있습니다(예: 아이폰 HEIC) — JPG·PNG로 다시 시도해보세요.`, true);
      return null;
    }
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let entry = { id, thumb, fileName: file.name, filePath: '', gistKey: '' };
    if (isElectron) {
      const b64 = capped.split(',')[1];
      const dot = file.name.lastIndexOf('.');
      const baseName = (dot > 0 ? file.name.slice(0, dot) : file.name).replace(/[^\w.\-가-힣 ()]/g, '_');
      // 캔버스로 다시 인코딩한 결과는 항상 JPEG이므로 원래 확장자 대신 .jpg로 저장한다.
      const desired = `usagepoint_${id}_${baseName}.jpg`;
      const r = await saveCalibFile(desired, b64, 'usagepoints');
      if (!r?.ok) {
        showNotice(`"${file.name}" 저장 실패: ` + (r?.error || ''), true);
        return null;
      }
      let gistKey = '';
      try {
        const cfg = await syncGetConfig();
        if (cfg?.hasToken) {
          gistKey = `attach_up_${id}.jpg.b64`;
          const ur = await uploadCalibAttachment(gistKey, b64);
          if (!ur?.ok) { gistKey = ''; showNotice('사진은 저장됐지만 공유 업로드 실패: ' + (ur?.error || ''), true); }
        }
      } catch { /* 공유 설정 없으면 로컬 저장만 유지 */ }
      entry = { ...entry, fileName: r.name, filePath: r.path, gistKey };
    }
    return entry;
  }

  async function addOnePhoto(file) {
    const entry = await buildPhotoEntry(file);
    if (entry) setForm(f => ({ ...f, photos: [...f.photos, entry] }));
  }

  // 이미 등록된 사진을 다른 사진으로 통째로 바꾼다 — 썸네일과 실제 저장되는
  // 원본이 항상 같은 사진을 가리키도록, 새 사진 처리가 전부 끝난 뒤 한 번에
  // 교체한다(추가만 되고 원본이 안 바뀌는 사고 방지).
  async function replacePhoto(photoId, file) {
    setUploadingPhoto(true);
    try {
      const entry = await buildPhotoEntry(file);
      if (entry) setForm(f => ({ ...f, photos: f.photos.map(p => p.id === photoId ? { ...entry, id: photoId } : p) }));
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handlePhotoChange(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setUploadingPhoto(true);
    try {
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        await addOnePhoto(file);
      }
    } catch (err) {
      showNotice('사진 처리 실패: ' + err.message, true);
    } finally {
      setUploadingPhoto(false);
    }
  }

  function removePhoto(photoId) {
    setForm(f => ({ ...f, photos: f.photos.filter(p => p.id !== photoId) }));
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
      // 작업일·작업자를 비워두면 작성일·작성자를 그대로 쓴다 — 보통 발견한 사람이
      // 그날 바로 처리하는 경우가 많아, 매번 똑같은 값을 다시 입력하지 않아도 되게.
      const item = {
        ...form,
        created_at: createdAt,
        created_date: form.created_date || createdAt,
        worker_name: form.worker_name.trim() || form.author_name,
        ...(editingId ? { id: editingId } : {}),
      };
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

  // 목록에서 담당자·완료기한을 바로 고칠 때 쓴다(수정 팝업을 거치지 않고). 진행상황은
  // 여기서 자동으로 바뀌지 않는다 — 다음 단계로 넘어가는 건 진행상황 배지를 눌러야만
  // (advanceProgress) 일어난다.
  async function quickPatch(item, patch) {
    if (!canManage(item)) { showNotice('수정 권한이 없습니다.', true); return; }
    try {
      const saved = await upsertUsagePoint({ ...item, ...patch });
      setData(prev => prev.map(d => d.id === item.id ? saved : d));
      window.electronAPI?.notifyDataChanged?.();
      syncAfterChange();
    } catch (e) {
      showNotice('변경 실패: ' + e.message, true);
    }
  }

  // 진행상황 배지를 누르면 다음 단계로 넘어간다(고르는 방식이 아니라 순서대로
  // 한 단계씩). 각 전환에 필요한 입력이 다 안 돼 있으면 무엇이 빠졌는지 알려주고
  // 막는다.
  //   신청 → 접수      : 관리자 확인만 있으면 된다(그대로 유지)
  //   접수 → 조사 중    : 담당자·완료기한·검토의견 모두 필요
  //   조사 중 → 조치 중 : 조사내용 기록 + 관리자의 조치사항 지시 모두 필요
  //   조치 중 → 완료/보류: 갈림길이라 여기서 넘기지 않는다 — 펼치기의 결론 팝업으로 처리
  async function advanceProgress(item) {
    if (!requireAdmin()) return;
    const stage = progressOf(item);
    if (stage === PROGRESS_OPTIONS[0]) { await quickSetProgress(item, '접수'); return; }
    if (stage === '접수') {
      const missing = [];
      if (assigneesOf(item).length === 0) missing.push('담당자');
      if (!item.due_date) missing.push('완료기한');
      if (!String(item.review_note || '').trim()) missing.push('검토의견');
      if (missing.length) { showNotice(`${missing.join('·')}을(를) 입력해야 조사 중으로 넘어갈 수 있습니다.`, true); return; }
      await quickSetProgress(item, '조사 중');
      return;
    }
    if (stage === '조사 중') {
      const hasInvestigation = (Array.isArray(item.progress_logs) && item.progress_logs.length > 0) || !!item.progress_note;
      const hasAction = !!String(item.action_taken || '').trim();
      const missing = [];
      if (!hasInvestigation) missing.push('조사내용');
      if (!hasAction) missing.push('조치사항 지시');
      if (missing.length) { showNotice(`${missing.join('·')}을(를) 입력해야 조치 중으로 넘어갈 수 있습니다.`, true); return; }
      await quickSetProgress(item, '조치 중');
    }
  }

  // 진행상황은 덮어쓰지 않고 한 줄씩 덧붙인다 — 누가 언제 무엇을 적었는지 남기기 위함.
  // 조사내역은 담당자 본인이 직접 남길 수 있어야 하므로 관리자로만 제한하지 않는다.
  function isAssigneeOf(item) {
    return !!currentMember && assigneesOf(item).includes(currentMember.username);
  }

  async function appendProgressLog(item, text) {
    if (!adminUnlocked && !isAssigneeOf(item)) { showNotice('담당자 또는 관리자만 작성할 수 있습니다.', true); return; }
    const stage = progressOf(item);
    if (!['조사 중', '보류'].includes(stage)) { showNotice('조사 중 단계에서만 조사내용을 기록할 수 있습니다.', true); return; }
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
      showNotice('조사내용이 기록되었습니다.');
    } catch (e) {
      showNotice('저장 실패: ' + e.message, true);
    }
  }

  // 현재 화면에 보이는 목록(검색·대분류 필터가 적용된 그대로)을 A4 가로 PDF로
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

    // 열이 많아 세로 폭에 다 안 들어가므로 가로로 강제한다. 여러 페이지에 걸쳐
    // 흐르는 건 그대로(달력처럼 한 페이지에 맞출 필요는 없음). @page는 선택자로
    // 조건부 지정이 안 되므로 덮어쓴다.
    const styleEl = document.createElement('style');
    styleEl.textContent = '@page { size: A4 landscape; margin: 10mm; }';
    document.head.appendChild(styleEl);

    const cleanup = () => {
      document.body.classList.remove('is-printing');
      portal.remove();
      styleEl.remove();
    };

    try {
      if (isElectron) {
        await new Promise(r => requestAnimationFrame(() => r())); // 렌더 안정화
        const r = await printDoc({ landscape: true, pageSize: 'A4', fileName: '업무별진행상황' });
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

  // 확대창(라이트박스)에 띄운 사진 한 장을 세로 A4로 인쇄 — 목록 PDF와 같은 방식
  // (숨겨둔 인쇄 전용 템플릿을 .print-portal로 복제해 그 부분만 출력)이지만
  // 가로가 아니라 세로로 찍는다.
  async function handlePrintPhoto() {
    if (printing || !lightbox) return;
    const src = photoPrintRef.current;
    if (!src) return;
    setPrinting(true);

    const portal = document.createElement('div');
    portal.className = 'print-portal';
    portal.appendChild(src.cloneNode(true));
    document.body.appendChild(portal);
    document.body.classList.add('is-printing');

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
        await new Promise(r => requestAnimationFrame(() => r()));
        const r = await printDoc({ landscape: false, pageSize: 'A4', fileName: '사용점_사진' });
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
  // 조치사항은 조치 중 단계에서만 쓴다(조사내용 기록은 반대로 조치 중이 되면
  // 잠긴다) — 조사 중 ➜ 조치 중은 관리자가 목록의 단계 선택으로 직접 넘긴다.
  async function saveActionTaken(item, action_taken) {
    if (!requireAdmin()) return;
    const stage = progressOf(item);
    if (stage !== '조치 중') { showNotice('조치 중 단계에서만 조치사항을 작성할 수 있습니다.', true); return; }
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

  // 조치사항까지 다 쓴 뒤, 관리자가 결론을 남기며 완료 또는 보류로 확정한다.
  async function finalizeProgress(item, finalStage, conclusion) {
    if (!requireAdmin()) return;
    if (progressOf(item) !== '조치 중') { showNotice('조치 중 단계에서만 완료·보류로 처리할 수 있습니다.', true); return; }
    try {
      const saved = await upsertUsagePoint({ ...item, progress: finalStage, conclusion: String(conclusion || '').trim() });
      setData(prev => prev.map(d => d.id === item.id ? saved : d));
      window.electronAPI?.notifyDataChanged?.();
      syncAfterChange();
      showNotice(finalStage === '완료' ? '완료 처리되었습니다.' : '보류 처리되었습니다.');
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
        <h1 className="text-2xl font-bold text-gray-800">업무별 진행상황</h1>
        <div className="flex items-center gap-2">
          {adminUnlocked && (
            <button onClick={openCatManager} className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-200">🏷️ 분류 관리</button>
          )}
          <button onClick={handlePrintPdf} disabled={printing}
            title="지금 화면에 보이는 목록(검색·분류 필터 적용)을 A4 가로 PDF로 만듭니다."
            className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-200 disabled:opacity-50">
            {printing ? '🖨 준비 중…' : '🖨 PDF 출력'}
          </button>
          <button onClick={handleSharePhotos} disabled={sharingPhotos}
            title="공유에 아직 올라가지 않은 사진의 원본을 올려, 다른 PC에서도 고화질로 볼 수 있게 합니다."
            className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-200 disabled:opacity-50">
            {sharingPhotos ? '📤 공유 중…' : '📤 사진 공유'}
          </button>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="검색 (제목·분류·작성자·작업자·담당자·실명·사용점번호 등)"
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm w-64" />
          <button onClick={openAdd} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">+ 추가</button>
        </div>
      </div>

      {/* PDF 출력 전용 표 — 화면에는 보이지 않고(부모가 display:none), 출력할 때만
          .print-portal로 복제되어 인쇄된다. 화면 표에 있는 버튼·사진·펼치기 같은
          요소를 빼고 순수 내용만 담아 인쇄물이 깔끔하게 나오게 한다. */}
      <div style={{ display: 'none' }} aria-hidden="true">
        <div ref={printRef} className="up-print">
          <h1>업무별 진행상황</h1>
          <p className="up-print-meta">
            출력일 {todayStr()} · 총 {sorted.length}건
            {majorFilter !== 'all' && ` · 대분류: ${majorFilter}`}
            {search.trim() && ` · 검색: "${search.trim()}"`}
          </p>
          <table>
            <colgroup>
              <col style={{ width: '3%' }} /><col style={{ width: '10%' }} /><col style={{ width: '6%' }} /><col style={{ width: '8%' }} />
              <col style={{ width: '7%' }} /><col style={{ width: '7%' }} /><col style={{ width: '6%' }} />
              <col style={{ width: '6%' }} /><col style={{ width: '10%' }} /><col style={{ width: '6%' }} />
              <col style={{ width: '8%' }} /><col style={{ width: '15%' }} /><col style={{ width: '6%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>번호</th><th>제목</th><th>대분류</th><th>소분류</th><th>작성일</th><th>작업일</th>
                <th>작성자</th><th>작업자</th><th>실명</th><th>실번호</th><th>사용점번호</th>
                <th>내용</th><th>비고</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((u, i) => (
                // 진행상황·조치사항은 열이 좁아 잘리기 쉬워서, 항목 아래에 한 줄로
                // 펼쳐 전체 폭을 쓰게 한다. 두 행이 페이지 경계에서 떨어지지 않도록
                // page-break-after/before로 서로 붙여둔다.
                <FragmentRow key={u.id}>
                  <tr style={{ pageBreakAfter: 'avoid', breakAfter: 'avoid' }}>
                    <td className="up-center">{i + 1}</td>
                    <td>{u.title || ''}</td>
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
                    <td>{u.note || ''}</td>
                  </tr>
                  <tr className="up-detail" style={{ pageBreakBefore: 'avoid', breakBefore: 'avoid' }}>
                    <td colSpan={13}>
                      <div>진행상황 : {progressOf(u)}</div>
                      <div>담당자 : {assigneesOf(u).join(', ')}{u.due_date ? ` (완료기한 ${u.due_date})` : ''}</div>
                      <div>조치사항 : {u.action_taken || ''}</div>
                      {u.conclusion && <div>결론 : {u.conclusion}</div>}
                      {photosOf(u).length > 0 && (
                        <div className="up-print-photos">
                          {photosOf(u).map(p => <img key={p.id} src={p.thumb} alt="" />)}
                        </div>
                      )}
                    </td>
                  </tr>
                </FragmentRow>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-gray-400 mr-1">상태</span>
        {[['all', '전체'], ['open', '미완료'], ...PROGRESS_OPTIONS.map(p => [p, p])].map(([v, label]) => {
          const count = v === 'all' ? data.length
            : v === 'open' ? data.filter(u => progressOf(u) !== '완료').length
            : data.filter(u => progressOf(u) === v).length;
          const activeCls = v === '완료' ? 'bg-emerald-600 text-white border-emerald-600'
            : v === 'open' ? 'bg-amber-500 text-white border-amber-500'
            : v === '보류' ? 'bg-red-500 text-white border-red-500'
            : 'bg-blue-600 text-white border-blue-600';
          return (
            <button key={v} onClick={() => setDoneFilter(v)}
              className={`px-3 py-1 rounded-full text-xs font-medium border ${doneFilter === v ? activeCls : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
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
        {/* width:100% + table-layout:fixed에서 col의 px 값은 절대폭이 아니라 서로의
            비율로 쓰인다 — 열 폭 합계와 무관하게 표는 항상 컨테이너 폭에 맞춰지므로
            칸을 조절해도 가로 스크롤이 생기지 않는다. */}
        <table className="text-sm" style={{ tableLayout: 'fixed', width: '100%' }}>
          <colgroup>{UP_COL_KEYS.map(k => <col key={k} style={{ width: colWidth(k) }} />)}</colgroup>
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {/* 펼치기 화살표(▶)는 별도 열 없이 No.와 한 열에서 번호 앞에 온다. */}
              <th className="relative px-2 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                No.
                <span onMouseDown={e => startColResize(e, 'no')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                진행상황
                <span onMouseDown={e => startColResize(e, 'progress')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                제목
                <span onMouseDown={e => startColResize(e, 'title')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                대분류
                <span onMouseDown={e => startColResize(e, 'major')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                소분류
                <span onMouseDown={e => startColResize(e, 'minor')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                작업일
                <span onMouseDown={e => startColResize(e, 'workDate')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                작성자
                <span onMouseDown={e => startColResize(e, 'author')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                작업자
                <span onMouseDown={e => startColResize(e, 'worker')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                실명
                <span onMouseDown={e => startColResize(e, 'room')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                실번호
                <span onMouseDown={e => startColResize(e, 'roomNo')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                사용점번호
                <span onMouseDown={e => startColResize(e, 'point')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                내용
                <span onMouseDown={e => startColResize(e, 'reason')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                사진
                <span onMouseDown={e => startColResize(e, 'photo')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                비고
                <span onMouseDown={e => startColResize(e, 'note')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                담당자
                <span onMouseDown={e => startColResize(e, 'assignee')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="relative px-3 py-3 text-gray-500 font-medium text-center border-r border-gray-200">
                완료기한
                <span onMouseDown={e => startColResize(e, 'dueDate')} draggable={false} onDragStart={e => e.preventDefault()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
              </th>
              <th className="px-3 py-3 text-gray-500 font-medium text-center">관리</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sorted.map((item, idx) => {
              const editable = canManage(item);
              // 담당자·완료기한은 접수 후부터 설정할 수 있다(신청 단계에서는 아직 배정 전).
              const canAssign = editable && progressOf(item) !== PROGRESS_OPTIONS[0];
              const isExp = expanded.has(item.id);
              return (
                <FragmentRow key={item.id}>
                  <tr className="hover:bg-gray-50">
                    <td className="px-2 py-2 text-center text-gray-500 text-xs whitespace-nowrap">
                      <button onClick={() => toggleExpand(item.id)} className={`inline-block mr-1 text-[10px] transition-transform ${isExp ? 'rotate-90 text-blue-500' : 'text-gray-300'}`} title="진행상황 메모">▶</button>
                      <span className="text-gray-400">{idx + 1}</span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {(() => {
                        const stage = progressOf(item);
                        // 진행상황은 고르는 게 아니라 눌러서 다음 단계로 넘어가는 방식이다.
                        // 조치 중부터는 완료/보류 갈림길이라 여기서 넘기지 않고, 펼치기의
                        // 결론 팝업으로 처리한다(그래서 배지만 보이고 눌러도 반응 없음).
                        const clickable = adminUnlocked && (stage === PROGRESS_OPTIONS[0] || stage === '접수' || stage === '조사 중');
                        const cls = `text-xs rounded-full px-2.5 py-1 font-medium text-center inline-block ${PROGRESS_COLOR[stage] || PROGRESS_COLOR[PROGRESS_OPTIONS[0]]}`;
                        if (!clickable) return <span className={cls}>{stage}</span>;
                        return (
                          <button onClick={() => advanceProgress(item)} className={`${cls} hover:brightness-95 cursor-pointer`}
                            title="눌러서 다음 단계로 넘어갑니다">
                            {stage}
                          </button>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2 text-center text-gray-800 text-xs max-w-[140px] truncate">
                      {/* 제목을 누르면 작성 팝업(상세보기)이 열린다 — 진행상황·조사내용·조치사항까지
                          함께 보이므로 펼치기 화살표 없이도 전체를 볼 수 있다. */}
                      <button onClick={() => openDetail(item)} className="hover:underline hover:text-blue-600 max-w-full truncate block mx-auto font-medium"
                        title={item.title || '눌러서 상세보기'}>
                        {item.title || '(제목 없음)'}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-center text-gray-600">{item.major_category || '—'}</td>
                    <td className="px-3 py-2 text-center text-gray-600">{item.minor_category || '—'}</td>
                    <td className="px-3 py-2 text-center text-gray-500 text-xs">{formatDate(item.created_date)}</td>
                    <td className="px-3 py-2 text-center text-gray-600">{item.author_name || '—'}</td>
                    <td className="px-3 py-2 text-center text-gray-600">{item.worker_name || '—'}</td>
                    <td className="px-3 py-2 text-center text-gray-600">{item.room_name || '—'}</td>
                    <td className="px-3 py-2 text-center text-gray-600">{item.room_number || '—'}</td>
                    <td className="px-3 py-2 text-center font-medium text-gray-800">{item.point_number || '—'}</td>
                    <td className="px-3 py-2 text-center text-gray-500 text-xs max-w-[160px] truncate" title={item.reason || ''}>
                      {item.reason || '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {(() => {
                        const photos = photosOf(item);
                        if (!photos.length) return <span className="text-gray-300 text-xs">—</span>;
                        return (
                          <div className="relative inline-block">
                            <img src={photos[0].thumb} onClick={() => setLightbox({ itemId: item.id, photos, index: 0 })} alt="사진"
                              className="w-12 h-12 object-cover rounded-lg cursor-pointer mx-auto border border-gray-200 hover:opacity-80" />
                            {photos.length > 1 && (
                              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[10px] font-bold leading-[18px] text-center shadow">
                                {photos.length}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2 text-center text-gray-500 text-xs max-w-[140px] truncate" title={item.note || ''}>{item.note || '—'}</td>
                    <td className="px-3 py-2 text-center text-gray-600 text-xs">
                      {canAssign ? (
                        <div className="relative inline-block assignee-dropdown">
                          <button type="button" onClick={() => setAssigneeDropdownId(id => id === item.id ? null : item.id)}
                            className="truncate max-w-[100px] block mx-auto hover:underline hover:text-blue-600">
                            {assigneesOf(item).join(', ') || '담당자 선택'}
                          </button>
                          {assigneeDropdownId === item.id && (
                            <div className="absolute z-30 top-full left-1/2 -translate-x-1/2 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 w-36 max-h-48 overflow-y-auto text-left">
                              {memberNames.length === 0 ? (
                                <span className="text-[11px] text-gray-300">등록된 계정 없음</span>
                              ) : memberNames.map(name => {
                                const list = assigneesOf(item);
                                return (
                                  <label key={name} className="flex items-center gap-1.5 text-xs text-gray-600 py-0.5 cursor-pointer select-none">
                                    <input type="checkbox" checked={list.includes(name)}
                                      onChange={() => quickPatch(item, { assignees: list.includes(name) ? list.filter(n => n !== name) : [...list, name] })} />
                                    {name}
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="truncate max-w-[100px] block mx-auto" title={assigneesOf(item).join(', ')}>{assigneesOf(item).join(', ') || '—'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {canAssign ? (
                        <div className="flex flex-col items-center gap-0.5">
                          <input type="date" value={item.due_date || ''} onChange={e => quickPatch(item, { due_date: e.target.value })}
                            className="text-xs border border-gray-200 rounded px-1 py-0.5 w-[112px]" />
                          {item.due_date && (() => { const d = dDayInfo(item.due_date); return d ? <div className={`font-semibold ${d.color}`}>{d.text}</div> : null; })()}
                        </div>
                      ) : item.due_date ? (() => {
                        const d = dDayInfo(item.due_date);
                        return (
                          <div className="leading-tight">
                            <div className="text-gray-500">{item.due_date}</div>
                            {d && <div className={`font-semibold ${d.color}`}>{d.text}</div>}
                          </div>
                        );
                      })() : <span className="text-gray-300">—</span>}
                    </td>
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
                          isAssignee={isAssigneeOf(item)}
                          onAppend={text => appendProgressLog(item, text)}
                          onSaveAction={text => saveActionTaken(item, text)}
                          onFinalize={(stage, conclusion) => finalizeProgress(item, stage, conclusion)} />
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

      {showForm && (() => {
        // 접수(신청 다음 단계)로 넘어간 뒤에는, 관리자라도 원래 작성 내용(제목·분류·
        // 작업일·작업자·실명·실번호·사용점번호·내용·비고·사진)을 더는 고칠 수 없다 —
        // 접수 이후의 흐름은 담당자 배정·조사내용·조치사항 패널로 넘어가므로, 처음
        // 신고된 내용 자체는 접수 시점에 확정되는 게 맞다. 그래서 이때는 "사용점 수정"
        // 이 아니라 "사용점 상세보기"로 보여준다(viewItem=읽기 전용과는 별개 개념 —
        // viewItem은 "이 사람이 이 항목을 관리할 권한이 아예 없음", contentLocked는
        // "권한은 있어도 접수 이후라 원본 내용만은 못 고침").
        const contentLocked = !!editingId && progressOf(form) !== PROGRESS_OPTIONS[0];
        return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            {!editingId && (
              <h2 className="font-bold text-gray-800">사용점 추가</h2>
            )}
            {viewItem && (
              <p className="text-xs text-amber-600 -mt-2">🔒 수정 권한이 없어 읽기 전용으로 보고 있습니다.</p>
            )}
            {!viewItem && contentLocked && (
              <p className="text-xs text-amber-600 -mt-2">🔒 접수된 이후에는 원래 작성한 내용을 수정할 수 없습니다.</p>
            )}
            {/* fieldset(display:contents)으로 grid 레이아웃은 그대로 두고, 읽기 전용이거나
                접수 이후일 때만 안의 입력칸을 한 번에 잠근다. */}
            <fieldset disabled={!!viewItem || contentLocked} className="contents">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-xs text-gray-500">제목</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="목록에서 이 항목을 대표하는 제목" />
              </div>
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
                {/* 데이터 필드 이름(reason)은 예전 그대로 두고 화면 표시만 "내용"으로 바꿨다
                    — 저장된 기존 데이터를 옮기지 않아도 되도록. */}
                <label className="text-xs text-gray-500">내용</label>
                <textarea className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" rows={2} value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-gray-500">비고</label>
                <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-gray-500">사진첨부 {form.photos.length > 0 && `(${form.photos.length}장)`}</label>
                {form.photos.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-1">
                    {form.photos.map((p, i) => (
                      <div key={p.id} className="relative">
                        <img src={p.thumb} alt="미리보기" onClick={() => setLightbox({ itemId: editingId, photos: form.photos, index: i })}
                          className="w-16 h-16 object-cover rounded-lg border border-gray-200 cursor-pointer hover:opacity-80" />
                        {!viewItem && !contentLocked && (
                          <>
                            <button type="button" onClick={() => removePhoto(p.id)}
                              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center hover:bg-red-600"
                              title="사진 삭제">✕</button>
                            {/* 다른 사진으로 통째로 바꾼다 — 미리보기와 실제 저장되는 원본이
                                항상 같은 사진이 되도록 buildPhotoEntry가 한 번에 처리한다. */}
                            <label className="absolute -bottom-1.5 -right-1.5 w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] leading-4 text-center hover:bg-blue-700 cursor-pointer"
                              title="이 사진 바꾸기">
                              🔄
                              <input type="file" accept="image/*" className="hidden" disabled={uploadingPhoto}
                                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) replacePhoto(p.id, f); }} />
                            </label>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-3 mt-1.5">
                  <input type="file" accept="image/*" multiple onChange={handlePhotoChange} disabled={uploadingPhoto}
                    className="text-xs text-gray-500 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-gray-100 file:text-gray-600 file:text-xs" />
                  {uploadingPhoto && <span className="text-xs text-gray-400">처리 중…</span>}
                </div>
              </div>
            </div>
            </fieldset>

            {/* 담당자 배정 — 신청 단계에서는 아직 배정 전이라 숨기고, 접수로 넘어간
                뒤부터(그 이후 단계 포함) 보여준다. 담당자·완료기한·검토의견을 모두
                채운 뒤 목록의 진행상황 배지를 눌러야 조사 중으로 넘어간다(자동 전환 아님). */}
            {progressOf(form) !== PROGRESS_OPTIONS[0] && (
              <div className="border-t border-gray-100 pt-3">
                <p className="text-xs font-semibold text-gray-500 mb-2">👤 담당자 배정</p>
                <div>
                  <label className="text-xs text-gray-500">담당자 (여러 명 선택 가능)</label>
                  <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-1 border rounded px-2 py-1.5">
                    {memberNames.length === 0 ? (
                      <span className="text-xs text-gray-300">등록된 계정이 없습니다.</span>
                    ) : memberNames.map(name => (
                      <label key={name} className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer select-none">
                        <input type="checkbox" checked={form.assignees.includes(name)}
                          disabled={!!viewItem}
                          onChange={() => setForm(f => ({
                            ...f,
                            assignees: f.assignees.includes(name) ? f.assignees.filter(n => n !== name) : [...f.assignees, name],
                          }))} />
                        {name}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="mt-3">
                  <label className="text-xs text-gray-500">완료기한</label>
                  <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.due_date || ''}
                    disabled={!!viewItem}
                    onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
                </div>
                <div className="mt-3">
                  <label className="text-xs text-gray-500">검토의견</label>
                  <textarea className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" rows={2} value={form.review_note || ''}
                    disabled={!!viewItem}
                    onChange={e => setForm(f => ({ ...f, review_note: e.target.value }))} placeholder="접수 검토 의견을 입력하세요" />
                </div>
                {progressOf(form) === '접수' && (
                  <p className="text-[11px] text-gray-400 mt-1.5">담당자(1명 이상)·완료기한·검토의견을 모두 입력하고 저장한 뒤, 목록의 진행상황 배지를 누르면 조사 중으로 넘어갑니다.</p>
                )}
              </div>
            )}

            {/* 진행상황·조치사항 — 목록의 펼치기 화살표와 같은 내용을 팝업 하단에도
                보여준다. 목록 칸이 좁아 다 안 보이던 것을 여기서 전부 확인할 수 있다.
                위 "담당자 배정" 헤더와 왼쪽선을 맞추기 위해, ProgressNotePanel 자체의
                가로 여백을 빼고(className="py-3") 이 바깥 div의 pt-3만으로 들여쓰기를
                맞춘다 — 예전에는 패널 안쪽에 별도 px-8이 있어 오른쪽으로 더 밀려 있었다. */}
            {editingId && (() => {
              const currentItem = data.find(d => d.id === editingId) || form;
              return (
                <div className="border-t border-gray-100 pt-3">
                  <ProgressNotePanel item={currentItem} adminUnlocked={adminUnlocked} currentMember={currentMember}
                    isAssignee={isAssigneeOf(currentItem)} className="py-3"
                    onAppend={text => appendProgressLog(currentItem, text)}
                    onSaveAction={text => saveActionTaken(currentItem, text)}
                    onFinalize={(stage, conclusion) => finalizeProgress(currentItem, stage, conclusion)} />
                </div>
              );
            })()}

            <div className="flex gap-2 pt-2">
              {viewItem ? (
                <button onClick={() => { setShowForm(false); setViewItem(null); }} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">닫기</button>
              ) : (
                <>
                  <button onClick={handleSave} disabled={saving} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                    {saving ? '저장 중…' : '저장'}
                  </button>
                  <button onClick={() => { setShowForm(false); setViewItem(null); }} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
                </>
              )}
            </div>
          </div>
        </div>
        );
      })()}

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
            {/* 인쇄 전용 캡션 — 화면에는 안 보이고, 인쇄 시에만 .print-portal로
                복제되어 사진과 함께 출력된다. */}
            <div style={{ display: 'none' }} aria-hidden="true">
              <div ref={photoPrintRef} className="up-photo-print">
                <h1>{lightboxItem?.title || '(제목 없음)'}</h1>
                <p className="up-photo-print-meta">
                  {[lightboxItem?.major_category, lightboxItem?.minor_category].filter(Boolean).join(' · ')}
                  {lightboxItem?.point_number && ` · 사용점번호 ${lightboxItem.point_number}`}
                  {lightboxItem?.created_date && ` · 작업일 ${lightboxItem.created_date}`}
                  {lightboxItem?.worker_name && ` · 작업자 ${lightboxItem.worker_name}`}
                  {lightbox.photos.length > 1 && ` · 사진 ${lightbox.index + 1}/${lightbox.photos.length}`}
                </p>
                <img src={hqUrl || lightboxPhoto?.thumb} alt="" />
              </div>
            </div>
            <div className="relative">
              <img src={hqUrl || lightboxPhoto?.thumb} alt="사진"
                onContextMenu={e => { e.preventDefault(); if (lightbox.photos.length > 1) gotoPhoto(1); }}
                className="w-full max-h-[70vh] object-contain rounded-lg" />
              {hqLoading && !hqUrl && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg">
                  <span className="text-white text-xs bg-black/50 px-3 py-1.5 rounded-full">⏳ 고화질 사진 받는 중…</span>
                </div>
              )}
              {/* 여러 장일 때만 좌우 이동 — 화살표 버튼, 우클릭(다음), 방향키로 넘길 수 있다. */}
              {lightbox.photos.length > 1 && (
                <>
                  <button onClick={() => gotoPhoto(-1)} title="이전 사진 (←)"
                    className="absolute left-1.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 hover:bg-black/60 text-white text-lg flex items-center justify-center">‹</button>
                  <button onClick={() => gotoPhoto(1)} title="다음 사진 (→ 또는 우클릭)"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 hover:bg-black/60 text-white text-lg flex items-center justify-center">›</button>
                  <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 text-[11px] bg-black/50 text-white px-2 py-0.5 rounded-full">
                    {lightbox.index + 1} / {lightbox.photos.length}
                  </span>
                </>
              )}
            </div>
            <p className="text-[11px] text-gray-400">
              {hqUrl ? '고화질 사진(최대 3000px)입니다.'
                : hqLoading ? ''
                : !lightboxPhoto?.gistKey
                  // 원본이 공유 Gist에 없으면 올린 PC에만 있어 다른 PC는 받을 수 없다.
                  ? '작게 압축된 미리보기입니다 — 원본이 아직 공유되지 않았습니다. 이 사진을 올린 PC에서 "📤 사진 공유"를 눌러주세요.'
                  : '작게 압축된 미리보기입니다.'}
            </p>
            <div className="flex justify-between items-center">
              <p className="text-xs text-gray-400 truncate">{lightboxPhoto?.fileName || ''}</p>
              <div className="flex gap-2">
                {(lightboxPhoto?.filePath || lightboxPhoto?.gistKey) && isElectron && (
                  <button onClick={() => revealCalibFile(lightboxPhoto.filePath, lightboxPhoto.gistKey, lightboxPhoto.fileName, 'usagepoints')}
                    className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-xs">📁 폴더 열기</button>
                )}
                <button onClick={handlePrintPhoto} disabled={printing}
                  className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-xs disabled:opacity-50">
                  {printing ? '인쇄 준비 중…' : '🖨 인쇄'}
                </button>
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
function ProgressNotePanel({ item, adminUnlocked, currentMember, isAssignee, onAppend, onSaveAction, onFinalize, className = 'px-8 py-3' }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState(item.action_taken || '');
  const [actionBusy, setActionBusy] = useState(false);
  const [finalizeModal, setFinalizeModal] = useState(null); // '완료' | '보류' | null
  const [conclusion, setConclusion] = useState('');
  const [finalizeBusy, setFinalizeBusy] = useState(false);
  const logs = Array.isArray(item.progress_logs) ? item.progress_logs : [];
  // 단계에 따라 어느 칸을 여는지 정한다 — 신청 ➜ 접수 ➜ 조사 중 ➜ 조치 중 ➜ 완료/보류.
  //  신청·접수     : 아직 배정 전이라 둘 다 잠김
  //  조사 중       : 담당자(or 관리자)가 조사내용을 기록하고, 관리자가 조치사항(지시)을
  //                  쓴다 — 둘 다 채워져야 목록에서 조치 중으로 넘어갈 수 있다
  //  조치 중       : 조사내용 기록은 잠기고, 조치사항은 계속 다듬을 수 있다. 저장되면
  //                  그 아래 완료/보류 버튼이 나타나고, 눌러 결론을 적으면 확정된다
  //  보류          : 조사 중으로 되돌아간 것처럼 조사내용은 계속 기록할 수 있다
  //  완료          : 모두 잠기고 남은 내역만 보인다
  const stage = progressOf(item);
  const isDone = stage === '완료';
  const isActing = stage === '조치 중';
  const isInvestigating = stage === '조사 중';
  const isHold = stage === '보류';
  const canWrite = (isInvestigating || isHold) && (adminUnlocked || isAssignee); // 조사내용 기록 입력
  const canWriteAction = adminUnlocked && (isInvestigating || isActing);         // 조치사항 입력
  // 조치사항은 조사 중부터 보이고(조치 중으로 넘어가기 위한 지시를 미리 써야 하므로),
  // 한 번 작성한 내용은 이후 단계에서도 계속 보인다.
  const showAction = isInvestigating || isActing || isDone || isHold || !!item.action_taken;
  const canFinalize = adminUnlocked && isActing && !!String(item.action_taken || '').trim();

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

  async function submitFinalize() {
    if (!conclusion.trim() || finalizeBusy) return;
    setFinalizeBusy(true);
    try {
      await onFinalize(finalizeModal, conclusion);
      setFinalizeModal(null);
      setConclusion('');
    } finally { setFinalizeBusy(false); }
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-gray-500">📝 조사내용 기록</span>
        <span className="text-[11px] text-gray-400">저장할 때마다 아래에 쌓이며, 지난 기록은 수정할 수 없습니다.</span>
      </div>

      {canWrite && (
        <div className="flex items-start gap-2 mb-2">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }}
            className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-xs"
            placeholder="조사내용을 입력하고 저장하세요 (Ctrl+Enter)" />
          <button disabled={!text.trim() || busy} onClick={submit}
            className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded font-semibold disabled:opacity-40 shrink-0">
            {busy ? '저장 중…' : '저장'}
          </button>
        </div>
      )}
      {(stage === '신청' || stage === '접수') && (
        <p className="text-[11px] text-gray-400 mb-2">담당자 배정 후 조사 중 단계부터 조사내용을 기록할 수 있습니다.</p>
      )}
      {adminUnlocked && isDone && (
        <p className="text-[11px] text-emerald-600 mb-2">
          ✓ 완료 처리된 건입니다 — 조사내용·조치사항 모두 더 이상 수정할 수 없고 내역만 남습니다.
          다시 작성하려면 위 진행상황을 완료가 아닌 단계로 되돌리세요.
        </p>
      )}
      {isInvestigating && (
        <p className="text-[11px] text-amber-600 mb-2">
          조사내용과 아래 조치사항(지시)을 모두 작성해야 진행상황 배지를 눌러 조치 중으로 넘어갈 수 있습니다.
        </p>
      )}
      {isActing && (
        <p className="text-[11px] text-amber-600 mb-2">
          조치 중 단계입니다 — 조사내용 기록은 잠기고, 조치사항은 계속 다듬을 수 있습니다.
        </p>
      )}
      {!adminUnlocked && isInvestigating && !isAssignee && (
        <p className="text-[11px] text-gray-400 mb-2">담당자({assigneesOf(item).join(', ') || '—'}) 또는 관리자만 작성할 수 있습니다.</p>
      )}

      {logs.length === 0 && !item.progress_note ? (
        <p className="text-xs text-gray-400">아직 작성된 조사내용이 없습니다.</p>
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

      {/* 조치사항 — 조사 중일 때 관리자가 지시로 미리 작성해야 조치 중으로 넘어갈 수
          있고, 조치 중에도 계속 다듬을 수 있다. 저장되면 그 아래에 완료/보류 버튼이
          나타나고, 눌러서 결론을 적으면 그 단계로 확정된다. */}
      {showAction && (
      <div className="mt-3 pt-3 border-t border-gray-200">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-semibold text-emerald-700">✅ 조치사항</span>
          <span className="text-[11px] text-gray-400">
            {isDone ? '완료되어 확정된 내용입니다'
              : isHold ? '보류 처리되어 확정된 내용입니다'
              : isActing ? '저장 후 아래에서 완료 또는 보류로 처리하세요'
              : isInvestigating ? '관리자의 조치사항 지시 — 조사내용과 함께 입력해야 조치 중으로 넘어갈 수 있습니다'
              : '조사 중 단계부터 작성할 수 있습니다'}
          </span>
        </div>
        {canWriteAction ? (
          <div className="flex items-start gap-2">
            <textarea value={action} onChange={e => setAction(e.target.value)} rows={2}
              className="flex-1 border border-emerald-200 rounded px-2 py-1.5 text-xs"
              placeholder="어떤 조치를 지시하는지 입력하세요" />
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

        {canFinalize && (
          <div className="flex gap-2 mt-2">
            <button onClick={() => { setConclusion(''); setFinalizeModal('완료'); }}
              className="flex-1 py-1.5 bg-emerald-600 text-white rounded text-xs font-semibold hover:bg-emerald-700">완료</button>
            <button onClick={() => { setConclusion(''); setFinalizeModal('보류'); }}
              className="flex-1 py-1.5 bg-red-500 text-white rounded text-xs font-semibold hover:bg-red-600">보류</button>
          </div>
        )}

        {item.conclusion && (isDone || isHold) && (
          <div className="mt-3 pt-3 border-t border-gray-200">
            <p className="text-xs font-semibold text-gray-700 mb-1">🏁 결론</p>
            <p className="text-xs text-gray-600 whitespace-pre-wrap">{item.conclusion}</p>
          </div>
        )}
      </div>
      )}

      {finalizeModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[500] p-4" onClick={() => setFinalizeModal(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-gray-800">{finalizeModal === '완료' ? '완료 처리' : '보류 처리'}</h3>
            <div>
              <label className="text-xs text-gray-500">결론</label>
              <textarea value={conclusion} onChange={e => setConclusion(e.target.value)} rows={3}
                className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" placeholder="최종 결론을 입력하세요" />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={submitFinalize} disabled={!conclusion.trim() || finalizeBusy}
                className={`flex-1 py-2 rounded text-sm font-medium text-white disabled:opacity-40 ${finalizeModal === '완료' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-500 hover:bg-red-600'}`}>
                {finalizeBusy ? '처리 중…' : `${finalizeModal} 처리`}
              </button>
              <button onClick={() => setFinalizeModal(null)} className="flex-1 py-2 border border-gray-200 rounded text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
