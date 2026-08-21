import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  fetchSops, upsertSop, deleteSop, fetchSopTags, addSopTagIfMissing,
  saveCalibFile, uploadCalibAttachment, revealCalibFile, resolveCalibImage,
  syncGetConfig, syncUpload,
} from '../lib/api';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

// 사진 크기 제한 — 사용점 관리와 동일한 기준(최대 3000px, 목록용 작은 썸네일 별도).
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

function emptyForm(currentMember) {
  return {
    title: '', tags: [], content: '',
    author_id: currentMember?.id || '', author_name: currentMember?.username || '',
    photos: [],
  };
}

function fmtDateTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export default function Sop({ adminUnlocked, currentMember }) {
  const [posts, setPosts] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('all');
  const [viewingId, setViewingId] = useState(null); // 목록 → 상세 화면 전환
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(() => emptyForm(currentMember));
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [lightbox, setLightbox] = useState(null); // { photos, index } | null
  const [hqUrl, setHqUrl] = useState(null);
  const [hqLoading, setHqLoading] = useState(false);

  const reload = useCallback(() => {
    return Promise.all([fetchSops(), fetchSopTags()])
      .then(([list, tg]) => { setPosts(list || []); setTags(tg || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // 공유 동기화로 새 글이 들어오면 목록을 바로 최신화한다.
  useEffect(() => {
    if (!window.electronAPI?.onDataChanged) return;
    return window.electronAPI.onDataChanged(() => { reload(); });
  }, [reload]);

  function showNotice(text, isError) {
    setNotice({ text, isError });
    setTimeout(() => setNotice(null), 3500);
  }

  async function syncAfterChange() {
    try {
      const cfg = await syncGetConfig();
      if (!cfg?.gistId || !cfg?.hasToken) return;
      await syncUpload();
    } catch { /* 조용히 건너뜀 — 로컬 저장은 이미 성공했으므로 */ }
  }

  // 작성자 본인 또는 관리자만 수정·삭제할 수 있다.
  function canManage(post) {
    if (adminUnlocked) return true;
    if (!currentMember) return false;
    return post.author_id ? post.author_id === currentMember.id : (!!post.author_name && post.author_name === currentMember.username);
  }

  const filtered = useMemo(() => {
    let list = posts;
    if (tagFilter !== 'all') list = list.filter(p => (p.tags || []).includes(tagFilter));
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(p => [p.title, p.content, p.author_name, ...(p.tags || [])]
        .some(v => String(v || '').toLowerCase().includes(q)));
    }
    return list;
  }, [posts, search, tagFilter]);

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    [filtered],
  );

  const viewingPost = viewingId ? posts.find(p => p.id === viewingId) : null;

  function openList() { setViewingId(null); }
  function openView(id) { setViewingId(id); }

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm(currentMember));
    setNewTag('');
    setShowForm(true);
  }
  function openEdit(post) {
    if (!canManage(post)) { showNotice('수정 권한이 없습니다.', true); return; }
    setEditingId(post.id);
    setForm({ ...emptyForm(currentMember), ...post });
    setNewTag('');
    setShowForm(true);
  }

  function toggleTag(tag) {
    setForm(f => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter(t => t !== tag) : [...f.tags, tag],
    }));
  }

  async function addNewTag() {
    const name = newTag.trim();
    if (!name) return;
    setNewTag('');
    if (!tags.includes(name)) {
      try { setTags(await addSopTagIfMissing(name)); } catch { /* ignore */ }
    }
    setForm(f => f.tags.includes(name) ? f : { ...f, tags: [...f.tags, name] });
  }

  // 사진 한 장을 끝까지 처리한다(썸네일+원본 저장+공유 업로드). 실패하면 null —
  // 실패해도 미리보기만 먼저 바뀌는 일이 없도록 전부 끝난 뒤에만 반영한다.
  async function buildPhotoEntry(file) {
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
      const desired = `sop_${id}_${baseName}.jpg`;
      const r = await saveCalibFile(desired, b64, 'sop');
      if (!r?.ok) {
        showNotice(`"${file.name}" 저장 실패: ` + (r?.error || ''), true);
        return null;
      }
      let gistKey = '';
      try {
        const cfg = await syncGetConfig();
        if (cfg?.hasToken) {
          gistKey = `attach_sop_${id}.jpg.b64`;
          const ur = await uploadCalibAttachment(gistKey, b64);
          if (!ur?.ok) { gistKey = ''; showNotice('사진은 저장됐지만 공유 업로드 실패: ' + (ur?.error || ''), true); }
        }
      } catch { /* 공유 설정 없으면 로컬 저장만 유지 */ }
      entry = { ...entry, fileName: r.name, filePath: r.path, gistKey };
    }
    return entry;
  }

  async function handlePhotoChange(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setUploadingPhoto(true);
    try {
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        const entry = await buildPhotoEntry(file);
        if (entry) setForm(f => ({ ...f, photos: [...f.photos, entry] }));
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

  async function replacePhoto(photoId, file) {
    setUploadingPhoto(true);
    try {
      const entry = await buildPhotoEntry(file);
      if (entry) setForm(f => ({ ...f, photos: f.photos.map(p => p.id === photoId ? { ...entry, id: photoId } : p) }));
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleSave() {
    if (editingId) {
      const existing = posts.find(p => p.id === editingId);
      if (existing && !canManage(existing)) { showNotice('수정 권한이 없습니다.', true); return; }
    }
    if (!form.title.trim()) { showNotice('제목을 입력하세요.', true); return; }
    setSaving(true);
    try {
      const item = { ...form, ...(editingId ? { id: editingId } : {}) };
      const saved = await upsertSop(item);
      setPosts(prev => editingId ? prev.map(p => p.id === editingId ? saved : p) : [saved, ...prev]);
      window.electronAPI?.notifyDataChanged?.();
      syncAfterChange();
      setShowForm(false);
      if (!editingId) openView(saved.id);
      showNotice('저장되었습니다.');
    } catch (e) {
      showNotice('저장 실패: ' + e.message, true);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    const existing = posts.find(p => p.id === id);
    if (existing && !canManage(existing)) { showNotice('삭제 권한이 없습니다.', true); setConfirmDeleteId(null); return; }
    setConfirmDeleteId(null);
    try {
      await deleteSop(id);
      setPosts(prev => prev.filter(p => p.id !== id));
      if (viewingId === id) openList();
      window.electronAPI?.notifyDataChanged?.();
      syncAfterChange();
    } catch (e) {
      showNotice('삭제 실패: ' + e.message, true);
    }
  }

  function gotoPhoto(delta) {
    setLightbox(l => {
      if (!l || l.photos.length <= 1) return l;
      const n = l.photos.length;
      return { ...l, index: (l.index + delta + n) % n };
    });
  }
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

  const lightboxPhoto = lightbox ? lightbox.photos[lightbox.index] : null;
  useEffect(() => {
    setHqUrl(null);
    if (!lightboxPhoto || !isElectron) return;
    if (!lightboxPhoto.filePath && !lightboxPhoto.gistKey) return;
    setHqLoading(true);
    resolveCalibImage(lightboxPhoto.filePath, lightboxPhoto.gistKey, lightboxPhoto.fileName, 'sop')
      .then(r => {
        if (r?.ok) setHqUrl(r.dataUrl);
        else showNotice('고화질 사진을 불러오지 못했습니다: ' + (r?.error || ''), true);
      })
      .catch(e => showNotice('고화질 사진을 불러오지 못했습니다: ' + e.message, true))
      .finally(() => setHqLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox?.itemId, lightbox?.index]);

  if (loading) {
    return <div className="p-6 text-sm text-gray-400">불러오는 중...</div>;
  }

  // ── 상세 보기 화면 ──
  if (viewingPost) {
    const editable = canManage(viewingPost);
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <button onClick={openList} className="text-sm text-gray-500 hover:text-blue-600">← 목록으로</button>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-xl font-bold text-gray-800 break-words">{viewingPost.title}</h1>
            {editable && (
              <div className="flex gap-1 shrink-0">
                <button onClick={() => openEdit(viewingPost)} className="px-2 py-1 text-blue-600 hover:bg-blue-50 rounded text-xs">수정</button>
                <button onClick={() => setConfirmDeleteId(viewingPost.id)} className="px-2 py-1 text-red-500 hover:bg-red-50 rounded text-xs">삭제</button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
            <span>✍️ {viewingPost.author_name || '—'}</span>
            <span>·</span>
            <span>{fmtDateTime(viewingPost.createdAt)}</span>
            {viewingPost.updatedAt && viewingPost.updatedAt !== viewingPost.createdAt && (
              <span className="text-gray-300">(수정됨 {fmtDateTime(viewingPost.updatedAt)})</span>
            )}
          </div>
          {(viewingPost.tags || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {viewingPost.tags.map(t => (
                <span key={t} className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium">#{t}</span>
              ))}
            </div>
          )}
          <p className="text-sm text-gray-700 whitespace-pre-wrap break-words leading-relaxed border-t border-gray-100 pt-4">
            {viewingPost.content || ''}
          </p>
          {(viewingPost.photos || []).length > 0 && (
            <PhotoCanvas photos={viewingPost.photos} editable={false}
              onOpen={i => setLightbox({ itemId: viewingPost.id, photos: viewingPost.photos, index: i })} />
          )}
        </div>

        {renderForm()}
        {renderLightbox()}
        {renderConfirmDelete()}
        {renderNotice()}
      </div>
    );
  }

  // ── 목록 화면 ──
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-gray-800">📘 SOP</h1>
        <div className="flex items-center gap-2">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="검색 (제목·내용·작성자·태그)"
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm w-64" />
          {currentMember && (
            <button onClick={openAdd} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">+ 새 글쓰기</button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-gray-400 mr-1">태그</span>
        {['all', ...tags].map(t => (
          <button key={t} onClick={() => setTagFilter(t)}
            className={`px-3 py-1 rounded-full text-xs font-medium border ${tagFilter === t ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            {t === 'all' ? '전체' : `#${t}`}
          </button>
        ))}
      </div>

      {sorted.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 py-16 text-center text-sm text-gray-400">
          {search.trim() || tagFilter !== 'all' ? '검색 결과가 없습니다.' : '아직 작성된 글이 없습니다.'}
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map(post => (
            <button key={post.id} onClick={() => openView(post.id)}
              className="w-full text-left bg-white rounded-xl shadow-sm border border-gray-100 p-4 hover:border-blue-200 hover:shadow-md transition-all">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-semibold text-gray-800 truncate">{post.title}</h2>
                {(post.photos || []).length > 0 && (
                  <img src={post.photos[0].thumb} alt="" className="w-10 h-10 object-cover rounded-lg border border-gray-200 shrink-0" />
                )}
              </div>
              <p className="text-xs text-gray-400 mt-1 line-clamp-2 whitespace-pre-wrap break-words">{post.content || ''}</p>
              <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px] text-gray-400">
                <span>{post.author_name || '—'}</span>
                <span>·</span>
                <span>{fmtDateTime(post.createdAt)}</span>
                {(post.tags || []).map(t => (
                  <span key={t} className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium">#{t}</span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}

      {renderForm()}
      {renderLightbox()}
      {renderConfirmDelete()}
      {renderNotice()}
    </div>
  );

  // 글쓰기/수정 팝업 — 상세 화면(수정 버튼)과 목록 화면(새 글쓰기) 양쪽에서 쓴다.
  // 예전에는 목록 화면 return문 안에만 있어서, 상세 화면에서 "수정"을 눌러도
  // showForm이 true가 돼도 이 블록 자체가 렌더링되지 않아 아무 반응이 없었다.
  function renderForm() {
    if (!showForm) return null;
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-6 space-y-3 max-h-[90vh] overflow-y-auto">
          <h2 className="font-bold text-gray-800">{editingId ? '글 수정' : '새 글쓰기'}</h2>
          <div>
            <label className="text-xs text-gray-500">제목</label>
            <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="예: 청구서 작성방법" />
          </div>
          <div>
            <label className="text-xs text-gray-500">태그</label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {tags.map(t => (
                <button key={t} type="button" onClick={() => toggleTag(t)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border ${form.tags.includes(t) ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                  #{t}
                </button>
              ))}
              <div className="flex items-center gap-1">
                <input value={newTag} onChange={e => setNewTag(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addNewTag(); } }}
                  placeholder="+ 새 태그" className="w-20 border border-dashed border-gray-300 rounded-full px-2 py-1 text-xs" />
                {newTag.trim() && (
                  <button type="button" onClick={addNewTag} className="text-xs text-blue-600 hover:underline">추가</button>
                )}
              </div>
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500">내용</label>
            <textarea className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" rows={10} value={form.content}
              onChange={e => setForm(f => ({ ...f, content: e.target.value }))} placeholder="본문을 입력하세요" />
          </div>
          <div>
            <label className="text-xs text-gray-500">사진첨부 {form.photos.length > 0 && `(${form.photos.length}장)`}</label>
            {form.photos.length > 0 && (
              <p className="text-[11px] text-gray-400 mt-0.5 mb-1">사진을 드래그해서 옮기고, 오른쪽 아래 모서리를 끌어 크기를 조절하세요.</p>
            )}
            <PhotoCanvas photos={form.photos} editable
              onChange={photos => setForm(f => ({ ...f, photos }))}
              onRemove={removePhoto} onReplace={replacePhoto} uploadingPhoto={uploadingPhoto} />
            <div className="flex items-center gap-3 mt-1.5">
              <input type="file" accept="image/*" multiple onChange={handlePhotoChange} disabled={uploadingPhoto}
                className="text-xs text-gray-500 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-gray-100 file:text-gray-600 file:text-xs" />
              {uploadingPhoto && <span className="text-xs text-gray-400">처리 중…</span>}
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
    );
  }

  function renderLightbox() {
    if (!lightbox) return null;
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[300] p-6" onClick={() => setLightbox(null)}>
        <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-4 space-y-3" onClick={e => e.stopPropagation()}>
          <div className="relative">
            <img src={hqUrl || lightboxPhoto?.thumb} alt="사진"
              onContextMenu={e => { e.preventDefault(); if (lightbox.photos.length > 1) gotoPhoto(1); }}
              className="w-full max-h-[70vh] object-contain rounded-lg" />
            {hqLoading && !hqUrl && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg">
                <span className="text-white text-xs bg-black/50 px-3 py-1.5 rounded-full">⏳ 고화질 사진 받는 중…</span>
              </div>
            )}
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
                ? '작게 압축된 미리보기입니다 — 원본이 아직 공유되지 않았습니다.'
                : '작게 압축된 미리보기입니다.'}
          </p>
          <div className="flex justify-between items-center">
            <p className="text-xs text-gray-400 truncate">{lightboxPhoto?.fileName || ''}</p>
            <div className="flex gap-2">
              {(lightboxPhoto?.filePath || lightboxPhoto?.gistKey) && isElectron && (
                <button onClick={() => revealCalibFile(lightboxPhoto.filePath, lightboxPhoto.gistKey, lightboxPhoto.fileName, 'sop')}
                  className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-xs">📁 폴더 열기</button>
              )}
              <button onClick={() => setLightbox(null)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50">닫기</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderConfirmDelete() {
    if (confirmDeleteId === null) return null;
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl shadow-xl w-full max-w-xs p-5 space-y-4">
          <p className="text-sm text-gray-700">삭제하시겠습니까?</p>
          <div className="flex gap-2">
            <button onClick={() => handleDelete(confirmDeleteId)} className="flex-1 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">삭제</button>
            <button onClick={() => setConfirmDeleteId(null)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
          </div>
        </div>
      </div>
    );
  }

  function renderNotice() {
    if (!notice) return null;
    return (
      <div className="fixed top-4 right-4 z-[400] flex flex-col gap-2 max-w-sm">
        <div className={`px-4 py-3 rounded-xl shadow-xl flex items-start gap-3 ${notice.isError ? 'bg-red-500 text-white' : 'bg-green-600 text-white'}`}>
          <span className="text-sm font-medium flex-1 leading-snug">{notice.text}</span>
          <button onClick={() => setNotice(null)} className={`text-lg leading-none shrink-0 ${notice.isError ? 'text-red-200 hover:text-white' : 'text-green-200 hover:text-white'}`}>✕</button>
        </div>
      </div>
    );
  }
}

// 사진을 정해진 격자가 아니라 자유로운 위치·크기로 배치한다. 좌표(x,y)와
// 크기(w,h)는 캔버스 크기에 대한 %로 저장해, 화면 폭이 달라져도 배치가
// 그대로 유지되게 한다. editable=false(상세 화면)에서는 저장된 배치 그대로
// 보여주기만 하고, editable=true(글쓰기 폼)에서는 드래그 이동·모서리로 크기
// 조절이 가능하다.
const PHOTO_CANVAS_H = 340; // px — 배치 캔버스의 세로 크기(고정)
const PHOTO_MIN_PCT = 8;    // 사진 최소 크기(캔버스 대비 %) — 너무 작아져 다루기 어려워지는 것 방지

function ensurePhotoLayout(photos) {
  // 아직 배치 값이 없는(막 추가된) 사진에 기본 격자 위치를 채워 넣는다.
  return photos.map((p, i) => {
    if (p.x != null && p.y != null && p.w != null && p.h != null) return p;
    const col = i % 3, row = Math.floor(i / 3);
    return { ...p, x: p.x ?? col * 34, y: p.y ?? row * 34, w: p.w ?? 30, h: p.h ?? 30 };
  });
}

function PhotoCanvas({ photos, editable, onChange, onOpen, onRemove, onReplace, uploadingPhoto }) {
  const containerRef = useRef(null);
  const laidOut = ensurePhotoLayout(photos);
  if (!laidOut.length) return null;

  function startDrag(e, photo) {
    if (!editable) return;
    e.preventDefault(); e.stopPropagation();
    const rect = containerRef.current.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startXPct = photo.x, startYPct = photo.y;
    const maxX = Math.max(0, 100 - photo.w), maxY = Math.max(0, 100 - photo.h);
    const onMove = ev => {
      const nx = Math.min(Math.max(0, startXPct + (ev.clientX - startX) / rect.width * 100), maxX);
      const ny = Math.min(Math.max(0, startYPct + (ev.clientY - startY) / rect.height * 100), maxY);
      onChange(laidOut.map(p => p.id === photo.id ? { ...p, x: nx, y: ny } : p));
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }

  function startResize(e, photo) {
    if (!editable) return;
    e.preventDefault(); e.stopPropagation();
    const rect = containerRef.current.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startW = photo.w, startH = photo.h;
    const maxW = 100 - photo.x, maxH = 100 - photo.y;
    const onMove = ev => {
      const nw = Math.min(Math.max(PHOTO_MIN_PCT, startW + (ev.clientX - startX) / rect.width * 100), maxW);
      const nh = Math.min(Math.max(PHOTO_MIN_PCT, startH + (ev.clientY - startY) / rect.height * 100), maxH);
      onChange(laidOut.map(p => p.id === photo.id ? { ...p, w: nw, h: nh } : p));
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }

  return (
    <div ref={containerRef}
      className={`relative w-full rounded-lg overflow-hidden ${editable ? 'border border-dashed border-gray-300 bg-gray-50' : ''}`}
      style={{ height: PHOTO_CANVAS_H }}>
      {laidOut.map(p => (
        <div key={p.id}
          onMouseDown={e => startDrag(e, p)}
          onClick={() => { if (!editable) onOpen?.(laidOut.findIndex(x => x.id === p.id)); }}
          className={`absolute rounded-lg overflow-hidden border border-gray-200 bg-white shadow-sm ${editable ? 'cursor-move' : 'cursor-pointer hover:opacity-90'}`}
          style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.w}%`, height: `${p.h}%` }}
        >
          <img src={p.thumb} alt="사진" draggable={false} className="w-full h-full object-cover pointer-events-none" />
          {editable && (
            <>
              <button type="button" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRemove(p.id); }}
                className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-500 text-white text-[11px] leading-5 text-center hover:bg-red-600" title="사진 삭제">✕</button>
              <label onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
                className="absolute top-1 right-7 w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] leading-5 text-center hover:bg-blue-700 cursor-pointer" title="이 사진 바꾸기">
                🔄
                <input type="file" accept="image/*" className="hidden" disabled={uploadingPhoto}
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onReplace(p.id, f); }} />
              </label>
              <div onMouseDown={e => startResize(e, p)}
                className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize bg-gray-400/70 hover:bg-blue-500"
                style={{ clipPath: 'polygon(100% 0, 0 100%, 100% 100%)' }} title="드래그해서 크기 조절" />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
