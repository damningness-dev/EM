import { useState, useEffect, useMemo, useCallback } from 'react';
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
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 pt-2">
              {viewingPost.photos.map((p, i) => (
                <img key={p.id} src={p.thumb} alt="사진" onClick={() => setLightbox({ itemId: viewingPost.id, photos: viewingPost.photos, index: i })}
                  className="w-full aspect-square object-cover rounded-lg cursor-pointer border border-gray-200 hover:opacity-80" />
              ))}
            </div>
          )}
        </div>

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

      {showForm && (
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
                <div className="flex flex-wrap gap-2 mt-1">
                  {form.photos.map(p => (
                    <div key={p.id} className="relative">
                      <img src={p.thumb} alt="미리보기" className="w-16 h-16 object-cover rounded-lg border border-gray-200" />
                      <button type="button" onClick={() => removePhoto(p.id)}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center hover:bg-red-600"
                        title="사진 삭제">✕</button>
                      <label className="absolute -bottom-1.5 -right-1.5 w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] leading-4 text-center hover:bg-blue-700 cursor-pointer"
                        title="이 사진 바꾸기">
                        🔄
                        <input type="file" accept="image/*" className="hidden" disabled={uploadingPhoto}
                          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) replacePhoto(p.id, f); }} />
                      </label>
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
            <div className="flex gap-2 pt-2">
              <button onClick={handleSave} disabled={saving} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {saving ? '저장 중…' : '저장'}
              </button>
              <button onClick={() => setShowForm(false)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}

      {renderLightbox()}
      {renderConfirmDelete()}
      {renderNotice()}
    </div>
  );

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
