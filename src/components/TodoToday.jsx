import { useState, useEffect, useMemo, useRef } from 'react';
import { fetchCalibration, fetchZones, fetchMonitoringData, fetchAnnualPlan, fetchTodos, upsertTodo, deleteTodo, toggleTodoDone, fetchHolidays, getTodoReminderInterval, setTodoReminderInterval } from '../lib/api';
import { effectiveCalib } from '../utils/calibUtils';
import { buildHolidayMap } from '../lib/schedule';
import { parseISO, differenceInDays } from 'date-fns';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const MONTH_KR = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

const REPEAT_OPTIONS = [
  { value: 'none', label: '반복없음' },
  { value: 'daily', label: '매일' },
  { value: 'weekly', label: '매주' },
  { value: 'monthly', label: '매월' },
  { value: 'quarter', label: '분기' },
  { value: 'half', label: '반기' },
  { value: 'yearly', label: '매년' },
];
const REPEAT_LABEL = { none: '', daily: '매일', weekly: '매주', monthly: '매월', quarter: '분기', half: '반기', yearly: '매년' };
const NTH_LABEL = ['', '첫째', '둘째', '셋째', '넷째', '마지막'];
const REMINDER_OPTIONS = [
  { value: 0, label: '끄기 (알람 시각에 한 번만)' },
  { value: 5, label: '5분마다' },
  { value: 10, label: '10분마다' },
  { value: 15, label: '15분마다' },
  { value: 30, label: '30분마다' },
  { value: 60, label: '60분마다' },
];

function nthWeekdayOfMonth(year, month0, nth, dow) {
  const firstDow = new Date(year, month0, 1).getDay();
  let day = 1 + ((dow - firstDow + 7) % 7);
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  if (nth === 5) { while (day + 7 <= daysInMonth) day += 7; }
  else { day += (nth - 1) * 7; if (day > daysInMonth) return null; }
  return day;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayStr() { return fmtDate(new Date()); }
// 마감기한 D-day (날짜만 비교)
function dueDday(dueStr) {
  const due = new Date(dueStr + 'T00:00:00');
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((due - t) / 86400000);
}
// 뷰(일간/주간/월간)에 표시할 날짜 배열 (anchor 날짜를 기준으로 계산)
function rangeDates(view, anchor) {
  const t = new Date(anchor || new Date()); t.setHours(0, 0, 0, 0);
  if (view === 'week') {
    const dow = (t.getDay() + 6) % 7; // 월=0
    const start = new Date(t); start.setDate(t.getDate() - dow);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }
  if (view === 'month') {
    const y = t.getFullYear(), m = t.getMonth();
    const n = new Date(y, m + 1, 0).getDate();
    return Array.from({ length: n }, (_, i) => new Date(y, m, i + 1));
  }
  return [t]; // day
}

// todo가 특정 날짜에 발생하는지 (일정 반복 반영) — main.js와 동일 로직.
// 반복 없음 + 마감기한이면 마감까지 매일 표시.
function todoOccursOn(todo, dateStr) {
  if (!todo.date || dateStr < todo.date) return false;
  const repeat = todo.repeat || 'none';
  if (repeat === 'none') {
    if (todo.due) return dateStr <= todo.due;
    return dateStr === todo.date;
  }
  if (todo.due && dateStr > todo.due) return false;
  const base = new Date(todo.date + 'T00:00:00');
  const d = new Date(dateStr + 'T00:00:00');
  const interval = Math.max(1, todo.interval || 1);
  const dayDiff = Math.round((d - base) / 86400000);
  if (repeat === 'daily') return dayDiff >= 0 && dayDiff % interval === 0;
  if (repeat === 'weekly') return dayDiff >= 0 && dayDiff % (7 * interval) === 0;
  const per = repeat === 'monthly' ? 1 : repeat === 'quarter' ? 3 : repeat === 'half' ? 6 : repeat === 'yearly' ? 12 : 0;
  if (per > 0) {
    const step = per * interval;
    const months = (d.getFullYear() - base.getFullYear()) * 12 + (d.getMonth() - base.getMonth());
    if (months < 0 || months % step !== 0) return false;
    if (repeat === 'monthly' && todo.monthlyMode === 'nthWeekday') {
      const day = nthWeekdayOfMonth(d.getFullYear(), d.getMonth(), todo.nth || 1, todo.dow || 0);
      return day != null && d.getDate() === day;
    }
    const dom = (repeat === 'monthly' && todo.monthlyMode === 'day' && todo.monthlyDay) ? todo.monthlyDay : base.getDate();
    return d.getDate() === dom;
  }
  return false;
}

function repeatText(todo) {
  const r = todo.repeat || 'none';
  if (r === 'none') return todo.due ? '마감까지 매일' : '';
  const iv = todo.interval > 1 ? todo.interval : '';
  if (r === 'monthly' && todo.monthlyMode === 'nthWeekday') return `${iv}매월 ${NTH_LABEL[todo.nth || 1]} ${DOW[todo.dow || 0]}요일`;
  if (r === 'monthly' && todo.monthlyMode === 'day') return `${iv}매월 ${todo.monthlyDay || ''}일`;
  return iv + REPEAT_LABEL[r];
}
function alarmText(todo) {
  const a = todo.alarm || (todo.alarmEnabled && todo.time ? { enabled: true, mode: 'atTime', time: todo.time, base: 'each' } : null);
  if (!a || !a.enabled) return null;
  const baseKr = a.base === 'start' ? '시작일' : a.base === 'end' ? '종료일' : '일정마다';
  if (a.mode === 'minBefore') return `${baseKr} ${a.minBefore}분 전`;
  if (a.mode === 'dayBefore') return `${baseKr} ${a.dayBefore}일 전 ${a.time}`;
  return `${baseKr} ${a.time}`;
}

function dDay(dateStr) {
  if (!dateStr) return null;
  return differenceInDays(parseISO(dateStr), new Date());
}

function DayBadge({ days }) {
  if (days === null) return null;
  if (days < 0) return <span className="text-xs font-bold text-red-600">만료 {Math.abs(days)}일 경과</span>;
  if (days === 0) return <span className="text-xs font-bold text-red-600">D-Day</span>;
  return <span className={`text-xs font-bold ${days <= 7 ? 'text-orange-600' : days <= 30 ? 'text-yellow-600' : 'text-gray-400'}`}>D-{days}</span>;
}

// 포스트잇 메모 — 이 PC에만 저장되는 자유 메모장(할일과 무관, 색상 팔레트로 구분).
const NOTE_STORE_KEY = 'em-todo-notes';
const NOTE_COLORS = ['#fde68a', '#fbcfe8', '#bfdbfe', '#bbf7d0', '#e9d5ff', '#fed7aa', '#e5e7eb'];
function fmtNoteTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const NOTE_DEFAULT_W = 220;
const NOTE_DEFAULT_H = 240;

// 메모는 이 PC의 localStorage에만 저장되므로(공유 안 됨), 붙여넣은 이미지는
// 원본 그대로가 아니라 작게 압축한 dataURL로 저장해 용량을 억제한다.
function resizeImageFile(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다')); };
    img.src = url;
  });
}

// 클립보드에 이미지가 포함돼 있으면(스크린샷 복사 등) 붙여넣기 시 함께 담는다.
// 텍스트만 있으면 원래대로 textarea가 알아서 처리하도록 손대지 않는다.
async function extractPastedImages(clipboardData) {
  const items = Array.from(clipboardData?.items || []).filter(it => it.type.startsWith('image/'));
  if (!items.length) return [];
  const files = items.map(it => it.getAsFile()).filter(Boolean);
  const dataUrls = await Promise.all(files.map(f => resizeImageFile(f, 1000, 0.85).catch(() => null)));
  return dataUrls.filter(Boolean).map((dataUrl, i) => ({ id: `img${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`, dataUrl }));
}

const NOTE_SNAP_TOLERANCE = 6; // px — 이 이내로 가까우면 "크기가 같다"고 보고 보조선을 보여준다

function StickyNotesBoard() {
  const [notes, setNotes] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem(NOTE_STORE_KEY)); return Array.isArray(s) ? s : []; } catch { return []; }
  });
  const [openPaletteId, setOpenPaletteId] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [search, setSearch] = useState('');
  // 지금 크기 조절 중인 메모의 실시간 크기 — 다른 메모들과 폭/높이가 맞는지
  // 비교해 보조선(테두리 강조)을 보여주는 데 쓴다. 조절이 멈추면 null로 돌아간다.
  const [liveResize, setLiveResize] = useState(null); // { id, w, h } | null

  useEffect(() => {
    try { localStorage.setItem(NOTE_STORE_KEY, JSON.stringify(notes)); } catch { /* ignore */ }
  }, [notes]);

  function addNote() {
    const now = Date.now();
    setNotes(prev => [{ id: `n${now}`, title: '', text: '', color: NOTE_COLORS[0], createdAt: now, updatedAt: now, w: NOTE_DEFAULT_W, h: NOTE_DEFAULT_H }, ...prev]);
  }
  // silent=true면 작성/수정 시각을 갱신하지 않는다 (크기 조절처럼 내용 편집이 아닌 변경용).
  function updateNote(id, patch, silent) {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, ...patch, ...(silent ? {} : { updatedAt: Date.now() }) } : n));
  }
  function removeNote(id) {
    if (!confirm('이 메모를 삭제하시겠습니까?')) return;
    setNotes(prev => prev.filter(n => n.id !== id));
    setOpenPaletteId(p => p === id ? null : p);
  }
  // 드래그한 메모(fromId)를 놓은 자리(toId)로 옮긴다 — 그 사이 메모들은 자동으로 밀림.
  function reorderNotes(fromId, toId) {
    if (!fromId || fromId === toId) return;
    setNotes(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(n => n.id === fromId);
      const toIdx = arr.findIndex(n => n.id === toId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return arr;
    });
  }

  const q = search.trim().toLowerCase();
  const canDrag = !q; // 검색 중엔 필터된 목록과 실제 배열의 순서가 어긋나므로 드래그 순서변경을 막는다
  const filteredNotes = q
    ? notes.filter(n => (n.title || '').toLowerCase().includes(q) || (n.text || '').toLowerCase().includes(q)
        || (n.tags || []).some(t => t.toLowerCase().includes(q)))
    : notes;

  return (
    <div className="space-y-3 lg:sticky lg:top-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-700">📌 메모</h2>
        <button onClick={addNote} className="text-xs px-2.5 py-1 bg-gray-800 text-white rounded-lg hover:bg-gray-700 font-medium">+ 메모</button>
      </div>
      <div className="relative">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="제목·내용·태그 검색..." spellCheck={false}
          className="w-full border border-gray-200 rounded-lg pl-8 pr-7 py-1.5 text-sm outline-none focus:ring-1 focus:ring-blue-400" />
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-300 text-xs">🔍</span>
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600 text-xs">✕</button>
        )}
      </div>
      {notes.length === 0 ? (
        <p className="text-xs text-gray-300 py-6 text-center border border-dashed border-gray-200 rounded-xl leading-relaxed">
          아직 메모가 없습니다.<br />"+ 메모"로 포스트잇을 붙여보세요.
        </p>
      ) : filteredNotes.length === 0 ? (
        <p className="text-xs text-gray-300 py-6 text-center border border-dashed border-gray-200 rounded-xl leading-relaxed">
          검색 결과가 없습니다.
        </p>
      ) : (
        <div className="flex flex-wrap content-start gap-3 max-h-[calc(100vh-160px)] overflow-y-auto pr-0.5">
          {filteredNotes.map(note => {
            const matchW = liveResize && liveResize.id !== note.id && Math.abs((note.w || NOTE_DEFAULT_W) - liveResize.w) <= NOTE_SNAP_TOLERANCE;
            const matchH = liveResize && liveResize.id !== note.id && Math.abs((note.h || NOTE_DEFAULT_H) - liveResize.h) <= NOTE_SNAP_TOLERANCE;
            return (
              <NoteCard key={note.id} note={note} dragId={dragId} setDragId={setDragId} reorderNotes={canDrag ? reorderNotes : () => {}}
                canDrag={canDrag}
                openPaletteId={openPaletteId} setOpenPaletteId={setOpenPaletteId}
                updateNote={updateNote} removeNote={removeNote}
                isResizing={liveResize?.id === note.id} matchW={!!matchW} matchH={!!matchH}
                onLiveResize={(w, h) => setLiveResize(w == null ? null : { id: note.id, w, h })} />
            );
          })}
        </div>
      )}
    </div>
  );
}

// 카드 오른쪽 아래 모서리를 드래그해 크기를 조절할 수 있는(resize:both) 포스트잇 한 장.
// 조절하는 동안 폭·높이가 다른 메모와 맞으면 그 메모 테두리에 보조선(강조 테두리)이 뜬다.
function NoteCard({ note, dragId, setDragId, reorderNotes, canDrag, openPaletteId, setOpenPaletteId, updateNote, removeNote, isResizing, matchW, matchH, onLiveResize }) {
  const cardRef = useRef(null);
  const resizeTimer = useRef(null);
  const liveEndTimer = useRef(null);
  const [newTag, setNewTag] = useState('');
  const [zoomSrc, setZoomSrc] = useState(null);
  const [pasting, setPasting] = useState(false);
  const tags = note.tags || [];
  const images = note.images || [];

  function handlePaste(e) {
    // 이미지가 있는지는 동기적으로 먼저 확인해야 preventDefault가 늦지 않는다
    // (비동기로 넘어가면 그 사이 브라우저 기본 붙여넣기가 먼저 일어날 수 있다).
    const hasImage = Array.from(e.clipboardData?.items || []).some(it => it.type.startsWith('image/'));
    if (!hasImage) return; // 텍스트만 붙여넣은 경우 — textarea 기본 동작 그대로 둔다
    e.preventDefault();
    setPasting(true);
    extractPastedImages(e.clipboardData)
      .then(found => { if (found.length) updateNote(note.id, { images: [...images, ...found] }); })
      .finally(() => setPasting(false));
  }
  function removeImage(id) {
    updateNote(note.id, { images: images.filter(img => img.id !== id) });
  }

  function addTag() {
    const t = newTag.trim();
    if (!t || tags.includes(t)) { setNewTag(''); return; }
    updateNote(note.id, { tags: [...tags, t] });
    setNewTag('');
  }
  function removeTag(t) {
    updateNote(note.id, { tags: tags.filter(x => x !== t) });
  }

  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // offsetWidth/offsetHeight(테두리 상자)를 쓴다 — Tailwind preflight가 전역
    // box-sizing:border-box를 적용해 인라인 style.width/height도 테두리 상자
    // 기준인데, ResizeObserver의 contentRect는 항상 내용 상자(패딩 제외) 크기라
    // 그걸 그대로 저장하면 다시 렌더링될 때마다 패딩만큼 작아져서 "늘려도
    // 자꾸 줄어드는" 것처럼 보였다.
    const ro = new ResizeObserver(() => {
      const w = el.offsetWidth, h = el.offsetHeight;
      // 실시간 보조선 갱신 — 잠시(350ms) 크기 변화가 없으면 조절이 끝난 것으로 보고 끈다.
      onLiveResize(w, h);
      if (liveEndTimer.current) clearTimeout(liveEndTimer.current);
      liveEndTimer.current = setTimeout(() => onLiveResize(null, null), 350);

      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        updateNote(note.id, { w, h }, true);
      }, 250);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      if (liveEndTimer.current) clearTimeout(liveEndTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  const guideRing = (matchW || matchH) ? 'ring-2 ring-blue-500' : isResizing ? 'ring-2 ring-gray-400' : '';

  return (
    <div ref={cardRef}
      onDragOver={e => { if (dragId) e.preventDefault(); }}
      onDrop={e => { e.preventDefault(); reorderNotes(dragId, note.id); setDragId(null); }}
      className={`relative rounded-lg shadow-sm p-3 flex flex-col transition-opacity ${dragId === note.id ? 'opacity-40' : ''} ${guideRing}`}
      style={{
        backgroundColor: note.color,
        width: note.w || NOTE_DEFAULT_W, height: note.h || NOTE_DEFAULT_H,
        resize: 'both', overflow: 'auto',
      }}>
      {/* 폭이 맞으면 오른쪽 세로 보조선, 높이가 맞으면 아래쪽 가로 보조선 */}
      {matchW && <div className="absolute top-0 right-0 bottom-0 w-0.5 bg-blue-500 pointer-events-none" />}
      {matchH && <div className="absolute left-0 right-0 bottom-0 h-0.5 bg-blue-500 pointer-events-none" />}
      <div className="flex items-center justify-between mb-1.5 shrink-0">
        {canDrag ? (
          <span draggable
            onDragStart={e => { e.dataTransfer.setData('text/plain', note.id); e.dataTransfer.effectAllowed = 'move'; setDragId(note.id); }}
            onDragEnd={() => setDragId(null)}
            className="cursor-move text-black/40 hover:text-black/70 text-xs select-none" title="드래그해서 순서 변경">⠿</span>
        ) : <span className="text-black/15 text-xs select-none" title="검색 중에는 순서를 바꿀 수 없습니다">⠿</span>}
        <div className="flex items-center gap-2">
          <button onClick={() => setOpenPaletteId(p => p === note.id ? null : note.id)}
            className="text-xs opacity-60 hover:opacity-100" title="색상 변경">🎨</button>
          <button onClick={() => removeNote(note.id)} className="text-black/30 hover:text-black/60 text-xs leading-none" title="메모 삭제">✕</button>
        </div>
      </div>
      {openPaletteId === note.id && (
        <div className="flex items-center gap-1.5 mb-2 bg-white/60 rounded-lg p-1.5 flex-wrap shrink-0">
          {NOTE_COLORS.map(c => (
            <button key={c} onClick={() => { updateNote(note.id, { color: c }); setOpenPaletteId(null); }}
              className={`w-5 h-5 rounded-full border-2 ${note.color === c ? 'border-gray-700' : 'border-transparent'}`}
              style={{ backgroundColor: c }} title={c} />
          ))}
          <label className="w-5 h-5 rounded-full border-2 border-white shadow flex items-center justify-center cursor-pointer overflow-hidden"
            style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }} title="RGB로 직접 선택">
            <input type="color" value={note.color || '#ffffff'} onChange={e => updateNote(note.id, { color: e.target.value })}
              className="opacity-0 w-6 h-6 cursor-pointer" />
          </label>
        </div>
      )}
      <input
        value={note.title || ''}
        onChange={e => updateNote(note.id, { title: e.target.value })}
        placeholder="제목"
        className="w-full bg-transparent text-sm font-bold text-gray-800 outline-none shrink-0 placeholder:text-gray-500/50 placeholder:font-normal"
      />
      <div className="flex flex-wrap items-center gap-1 mt-1 shrink-0">
        {tags.map(t => (
          <span key={t} className="flex items-center gap-0.5 text-[10px] bg-white/50 text-gray-700 px-1.5 py-0.5 rounded-full">
            #{t}
            <button onClick={() => removeTag(t)} className="text-gray-400 hover:text-red-500 leading-none">✕</button>
          </span>
        ))}
        <input value={newTag} onChange={e => setNewTag(e.target.value)} placeholder="+태그" spellCheck={false}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
          onBlur={addTag}
          className="w-14 bg-transparent text-[10px] text-gray-600 outline-none placeholder:text-gray-500/50" />
      </div>
      <hr className="border-t border-black/10 my-1.5 shrink-0" />
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5 shrink-0">
          {images.map(img => (
            <div key={img.id} className="relative">
              <img src={img.dataUrl} onClick={() => setZoomSrc(img.dataUrl)} alt="붙여넣은 이미지"
                className="w-12 h-12 object-cover rounded border border-black/10 cursor-pointer hover:opacity-80" />
              <button onClick={() => removeImage(img.id)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center hover:bg-red-600"
                title="이미지 삭제">✕</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        value={note.text}
        onChange={e => updateNote(note.id, { text: e.target.value })}
        onPaste={handlePaste}
        placeholder={pasting ? '이미지 붙여넣는 중…' : '메모를 입력하세요... (이미지도 붙여넣기 가능)'}
        className="w-full flex-1 bg-transparent text-sm text-gray-800 resize-none outline-none placeholder:text-gray-500/60"
      />
      <p className="text-[10px] text-black/35 mt-1 text-right shrink-0">
        {note.updatedAt && note.updatedAt !== note.createdAt ? `수정 ${fmtNoteTime(note.updatedAt)}` : `작성 ${fmtNoteTime(note.createdAt)}`}
      </p>
      {zoomSrc && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[300] p-6" onClick={() => setZoomSrc(null)}>
          <img src={zoomSrc} alt="확대" className="max-w-full max-h-full rounded-lg shadow-2xl" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

function Section({ title, icon, count, countColor, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-100 bg-gray-50">
        <span className="text-base">{icon}</span>
        <span className="font-semibold text-gray-800 text-sm">{title}</span>
        {count !== undefined && (
          <span className={`ml-auto text-sm font-bold ${countColor || 'text-gray-600'}`}>{count}</span>
        )}
      </div>
      <div className="divide-y divide-gray-50">{children}</div>
    </div>
  );
}

export default function TodoToday({ currentMember }) {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const dow = DOW[today.getDay()];

  const [calibration, setCalibration] = useState([]);
  const [zones, setZones] = useState([]);
  const [monitoring, setMonitoring] = useState({});
  const [annualPlan, setAnnualPlan] = useState({});
  const [loading, setLoading] = useState(true);

  // 할일(반복 일정)
  const [todos, setTodos] = useState([]);
  const [holidayDefs, setHolidayDefs] = useState([]);
  const [showTodoForm, setShowTodoForm] = useState(false);
  const [editingTodo, setEditingTodo] = useState(null); // 편집중 todo id
  const [showReminderSettings, setShowReminderSettings] = useState(false);
  const [reminderIntervalMin, setReminderIntervalMin] = useState(10);
  const blankForm = {
    title: '', date: todayStr(), due: '', note: '',
    // 일정 반복
    repeat: 'none', interval: 1, monthlyMode: 'day', monthlyDay: new Date().getDate(), nth: 1, dow: new Date().getDay(),
    // 알람
    alarmEnabled: false, alarmMode: 'atTime', alarmTime: '09:00', alarmMinBefore: 30, alarmDayBefore: 1, alarmBase: 'each',
  };
  const [todoForm, setTodoForm] = useState(blankForm);
  const [todoView, setTodoView] = useState('day'); // day | week | month
  const [todoAnchor, setTodoAnchor] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  function shiftTodoAnchor(dir) {
    setTodoAnchor(prev => {
      const d = new Date(prev);
      if (todoView === 'week') d.setDate(d.getDate() + dir * 7);
      else if (todoView === 'month') d.setMonth(d.getMonth() + dir);
      else d.setDate(d.getDate() + dir);
      return d;
    });
  }
  function goTodoToday() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    setTodoAnchor(d);
  }
  const todoDates = rangeDates(todoView, todoAnchor); // 이 뷰에 표시할 날짜 목록
  const todoRangeSet = todoDates.map(d => fmtDate(d));
  const isTodayPeriod = todoRangeSet.includes(todayStr());
  let todoPeriodLabel;
  if (todoView === 'week') {
    const s = todoDates[0], e = todoDates[todoDates.length - 1];
    todoPeriodLabel = `${s.getMonth() + 1}/${s.getDate()} ~ ${e.getMonth() + 1}/${e.getDate()}`;
  } else if (todoView === 'month') {
    todoPeriodLabel = `${todoDates[0].getFullYear()}년 ${todoDates[0].getMonth() + 1}월`;
  } else {
    const d = todoDates[0];
    todoPeriodLabel = `${d.getMonth() + 1}/${d.getDate()} (${DOW[d.getDay()]})`;
  }
  let todoDateLine;
  if (todoView === 'week') {
    const s = todoDates[0], e = todoDates[todoDates.length - 1];
    todoDateLine = `${s.getFullYear()}년 ${MONTH_KR[s.getMonth()]} ${s.getDate()}일 ~ ${MONTH_KR[e.getMonth()]} ${e.getDate()}일`;
  } else if (todoView === 'month') {
    todoDateLine = `${todoDates[0].getFullYear()}년 ${MONTH_KR[todoDates[0].getMonth()]}`;
  } else {
    const d = todoDates[0];
    todoDateLine = `${d.getFullYear()}년 ${MONTH_KR[d.getMonth()]} ${d.getDate()}일 (${DOW[d.getDay()]}요일)`;
  }

  // 토요일=파란색, 일요일·공휴일=빨간색 + 공휴일 이름 표시용
  const anchorYear = todoAnchor.getFullYear();
  const holidays = useMemo(
    () => buildHolidayMap(holidayDefs, anchorYear - 1, anchorYear + 1),
    [holidayDefs, anchorYear]
  );
  function dateColorClass(dow, isHoliday) {
    if (dow === 0 || isHoliday) return 'text-red-500';
    if (dow === 6) return 'text-blue-500';
    return '';
  }
  // 일간 보기의 상단 날짜 표시용 (요일 색상 + 공휴일 이름)
  const todoDayHoliday = todoView === 'day' ? holidays[fmtDate(todoDates[0])] : null;
  const todoDateLineClass = todoView === 'day'
    ? (dateColorClass(todoDates[0].getDay(), !!todoDayHoliday) || 'text-gray-500')
    : 'text-gray-500';

  useEffect(() => {
    Promise.all([
      fetchCalibration(),
      fetchZones(),
      fetchMonitoringData(year, month),
      fetchAnnualPlan(year),
      fetchTodos().catch(() => []),
      fetchHolidays().catch(() => []),
    ]).then(([cal, zns, mon, plan, tds, hols]) => {
      setCalibration(cal);
      setZones(zns);
      setMonitoring(mon);
      setAnnualPlan(plan);
      setTodos(tds || []);
      setHolidayDefs(hols || []);
      setLoading(false);
    });
    if (window.electronAPI) {
      getTodoReminderInterval().then(r => setReminderIntervalMin(r?.intervalMin ?? 10)).catch(() => {});
    }
  }, []);

  async function saveReminderInterval(v) {
    setReminderIntervalMin(v);
    try { await setTodoReminderInterval(v); } catch { /* ignore */ }
  }

  async function saveTodo() {
    const title = todoForm.title.trim();
    if (!title) return;
    const f = todoForm;
    const alarm = f.alarmEnabled && f.alarmTime ? {
      enabled: true, mode: f.alarmMode || 'atTime', time: f.alarmTime,
      minBefore: Math.max(0, parseInt(f.alarmMinBefore) || 0),
      dayBefore: Math.max(0, parseInt(f.alarmDayBefore) || 0),
      base: f.alarmBase || 'each',
    } : { enabled: false };
    const payload = {
      ...(editingTodo ? { ...todos.find(t => t.id === editingTodo) } : {}),
      title,
      date: f.date || todayStr(),
      due: f.due || '',
      repeat: f.repeat || 'none',
      interval: Math.max(1, parseInt(f.interval) || 1),
      monthlyMode: f.monthlyMode || 'day',
      monthlyDay: Math.max(1, Math.min(31, parseInt(f.monthlyDay) || 1)),
      nth: f.nth || 1, dow: f.dow ?? 0,
      alarm,
      alarmEnabled: alarm.enabled, time: alarm.enabled ? alarm.time : '', // 구형 호환
      note: f.note || '',
    };
    const saved = await upsertTodo(payload);
    setTodos(prev => {
      const i = prev.findIndex(t => t.id === saved.id);
      return i >= 0 ? prev.map(t => t.id === saved.id ? saved : t) : [...prev, saved];
    });
    window.electronAPI?.notifyDataChanged?.();
    setShowTodoForm(false);
    setEditingTodo(null);
    setTodoForm(blankForm);
  }

  async function handleToggleTodo(id, dateStr) {
    const saved = await toggleTodoDone(id, dateStr || todayStr());
    if (saved) setTodos(prev => prev.map(t => t.id === id ? saved : t));
    window.electronAPI?.notifyDataChanged?.();
  }

  async function handleDeleteTodo(id) {
    await deleteTodo(id);
    setTodos(prev => prev.filter(t => t.id !== id));
    window.electronAPI?.notifyDataChanged?.();
  }

  function startEditTodo(t) {
    setEditingTodo(t.id);
    const a = t.alarm || (t.alarmEnabled && t.time ? { enabled: true, mode: 'atTime', time: t.time, base: 'each' } : null);
    setTodoForm({
      title: t.title, date: t.date || todayStr(), due: t.due || '', note: t.note || '',
      repeat: t.repeat || 'none', interval: t.interval || 1,
      monthlyMode: t.monthlyMode || 'day', monthlyDay: t.monthlyDay || new Date(t.date + 'T00:00:00').getDate() || 1,
      nth: t.nth || 1, dow: t.dow ?? (t.date ? new Date(t.date + 'T00:00:00').getDay() : 0),
      alarmEnabled: !!(a && a.enabled), alarmMode: a?.mode || 'atTime', alarmTime: a?.time || '09:00',
      alarmMinBefore: a?.minBefore ?? 30, alarmDayBefore: a?.dayBefore ?? 1, alarmBase: a?.base || 'each',
    });
    setShowTodoForm(true);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // 교정 항목 분류 — 연도별 교정내역이 있으면 최신 내역 기준(effectiveCalib)으로 판단
  const calibEff = calibration.map(c => ({ ...c, eff: effectiveCalib(c) }));

  const overdueCalib = calibEff
    .filter(c => c.eff.next_calib_date && c.eff.next_calib_date !== '미사용' && dDay(c.eff.next_calib_date) < 0)
    .sort((a, b) => dDay(a.eff.next_calib_date) - dDay(b.eff.next_calib_date));

  const soonCalib = calibEff
    .filter(c => c.eff.next_calib_date && c.eff.next_calib_date !== '미사용' && dDay(c.eff.next_calib_date) >= 0 && dDay(c.eff.next_calib_date) <= 60)
    .sort((a, b) => dDay(a.eff.next_calib_date) - dDay(b.eff.next_calib_date));

  // 모니터링 현황
  const completedZones = zones.filter(z => monitoring[z.id]);
  const pendingZones = zones.filter(z => !monitoring[z.id]);
  const monRate = zones.length ? Math.round(completedZones.length / zones.length * 100) : 0;

  // AHU 이번달 계획
  const ahuTasks = Object.entries(annualPlan)
    .filter(([key]) => {
      const parts = key.split('_');
      return parts[parts.length - 1] === String(month);
    })
    .map(([key, val]) => {
      const parts = key.split('_');
      parts.pop();
      return { ahuName: parts.join('_'), ...val };
    })
    .filter(t => t.planned)
    .sort((a, b) => a.ahuName.localeCompare(b.ahuName));

  const ahuDone = ahuTasks.filter(t => t.done).length;

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_720px] gap-6 items-start">
    <div className="space-y-5 min-w-0">
      {/* 헤더 */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">오늘의 할일</h1>
          <p className={`text-sm mt-0.5 ${todoDateLineClass}`}>
            {todoDateLine}
            {todoDayHoliday && ` · ${todoDayHoliday}`}
            {isTodayPeriod && <span className="text-blue-500 ml-1">· 지금</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 text-sm">
            <button onClick={() => shiftTodoAnchor(-1)} title="이전"
              className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-blue-600 hover:bg-gray-100 rounded text-xs">◀</button>
            <button onClick={goTodoToday} disabled={isTodayPeriod} title="오늘로 이동"
              className={`px-2 py-1 text-xs rounded whitespace-nowrap ${isTodayPeriod ? 'text-gray-300 cursor-not-allowed' : 'text-blue-600 hover:bg-blue-50'}`}>
              오늘로 이동
            </button>
            <button onClick={() => shiftTodoAnchor(1)} title="다음"
              className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-blue-600 hover:bg-gray-100 rounded text-xs">▶</button>
          </div>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
            {[['day', '일간'], ['week', '주간'], ['month', '월간']].map(([v, label]) => (
              <button key={v} onClick={() => setTodoView(v)}
                className={`px-2.5 py-1 ${todoView === v ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>{label}</button>
            ))}
          </div>
          {window.electronAPI && (
            <button onClick={() => setShowReminderSettings(true)} title="리마인드 알람 설정"
              className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-500 hover:bg-gray-50">⚙</button>
          )}
          <button
            onClick={() => { setEditingTodo(null); setTodoForm(blankForm); setShowTodoForm(v => !v); }}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
          >+ 할일 추가</button>
        </div>
      </div>

      {/* 리마인드 알람 설정 — 완료되지 않은 할일 알람을 몇 분마다 다시 울릴지 */}
      {showReminderSettings && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowReminderSettings(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xs p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h2 className="font-bold text-gray-800 text-sm">⏰ 리마인드 알람 설정</h2>
            <p className="text-xs text-gray-400">완료하지 않은 할일 알람을 얼마마다 다시 알릴지 정하세요.</p>
            <div className="space-y-1">
              {REMINDER_OPTIONS.map(o => (
                <label key={o.value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none px-2 py-1.5 rounded hover:bg-gray-50">
                  <input type="radio" name="reminderInterval" checked={reminderIntervalMin === o.value} onChange={() => saveReminderInterval(o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
            <button onClick={() => setShowReminderSettings(false)}
              className="w-full py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">닫기</button>
          </div>
        </div>
      )}

      {/* 할일 추가/편집 폼 */}
      {showTodoForm && (
        <div className="bg-white rounded-xl border border-blue-200 p-4 space-y-3">
          <input
            autoFocus
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="할일 제목"
            value={todoForm.title}
            onChange={e => setTodoForm(f => ({ ...f, title: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') saveTodo(); }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              시작일
              <input type="date" value={todoForm.date} onChange={e => setTodoForm(f => ({ ...f, date: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              마감기한
              <input type="date" value={todoForm.due} onChange={e => setTodoForm(f => ({ ...f, due: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm" />
            </label>
          </div>

          {/* 일정 반복 */}
          <div className="flex flex-wrap items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
            <span className="text-xs font-semibold text-gray-500">🔁 일정 반복</span>
            <select value={todoForm.repeat} onChange={e => setTodoForm(f => ({ ...f, repeat: e.target.value }))}
              className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
              {REPEAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {todoForm.repeat === 'none' && todoForm.due && <span className="text-[11px] text-gray-400">마감기한까지 매일 표시</span>}
            {todoForm.repeat !== 'none' && (
              <label className="flex items-center gap-1 text-xs text-gray-600">간격
                <input type="number" min="1" max="365" value={todoForm.interval}
                  onChange={e => setTodoForm(f => ({ ...f, interval: Math.max(1, parseInt(e.target.value) || 1) }))}
                  className="w-12 border border-gray-300 rounded px-1 py-1 text-sm text-center" />
                {todoForm.repeat === 'daily' ? '일' : todoForm.repeat === 'weekly' ? '주' : todoForm.repeat === 'monthly' ? '개월' : todoForm.repeat === 'quarter' ? '분기' : todoForm.repeat === 'half' ? '반기' : '년'}마다
              </label>
            )}
            {todoForm.repeat === 'monthly' && (
              <>
                <select value={todoForm.monthlyMode} onChange={e => setTodoForm(f => ({ ...f, monthlyMode: e.target.value }))}
                  className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
                  <option value="day">며칠</option>
                  <option value="nthWeekday">몇째 주 요일</option>
                </select>
                {todoForm.monthlyMode === 'day' ? (
                  <label className="flex items-center gap-1 text-xs text-gray-600">
                    <input type="number" min="1" max="31" value={todoForm.monthlyDay}
                      onChange={e => setTodoForm(f => ({ ...f, monthlyDay: Math.max(1, Math.min(31, parseInt(e.target.value) || 1)) }))}
                      className="w-12 border border-gray-300 rounded px-1 py-1 text-sm text-center" />일
                  </label>
                ) : (
                  <>
                    <select value={todoForm.nth} onChange={e => setTodoForm(f => ({ ...f, nth: parseInt(e.target.value) }))}
                      className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
                      {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{NTH_LABEL[n]}</option>)}
                    </select>
                    <select value={todoForm.dow} onChange={e => setTodoForm(f => ({ ...f, dow: parseInt(e.target.value) }))}
                      className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
                      {DOW.map((d, i) => <option key={i} value={i}>{d}요일</option>)}
                    </select>
                  </>
                )}
              </>
            )}
          </div>

          {/* 알람 (일정 반복과 별도) */}
          <div className="flex flex-wrap items-center gap-2 bg-orange-50 rounded-lg px-3 py-2">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600">
              <input type="checkbox" checked={todoForm.alarmEnabled} onChange={e => setTodoForm(f => ({ ...f, alarmEnabled: e.target.checked }))} />
              ⏰ 알람
            </label>
            {todoForm.alarmEnabled && (
              <>
                <select value={todoForm.alarmBase} onChange={e => setTodoForm(f => ({ ...f, alarmBase: e.target.value }))}
                  className="border border-gray-300 rounded px-2 py-1 text-sm bg-white" title="알람 기준">
                  <option value="each">일정마다</option>
                  <option value="start">시작일 기준</option>
                  <option value="end">종료일 기준</option>
                </select>
                <select value={todoForm.alarmMode} onChange={e => setTodoForm(f => ({ ...f, alarmMode: e.target.value }))}
                  className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
                  <option value="atTime">일정 시각에</option>
                  <option value="minBefore">몇 분 전</option>
                  <option value="dayBefore">며칠 전</option>
                </select>
                {todoForm.alarmMode === 'minBefore' && (
                  <label className="flex items-center gap-1 text-xs text-gray-600">
                    <input type="number" min="0" max="1440" value={todoForm.alarmMinBefore}
                      onChange={e => setTodoForm(f => ({ ...f, alarmMinBefore: Math.max(0, parseInt(e.target.value) || 0) }))}
                      className="w-14 border border-gray-300 rounded px-1 py-1 text-sm text-center" />분 전
                  </label>
                )}
                {todoForm.alarmMode === 'dayBefore' && (
                  <label className="flex items-center gap-1 text-xs text-gray-600">
                    <input type="number" min="0" max="60" value={todoForm.alarmDayBefore}
                      onChange={e => setTodoForm(f => ({ ...f, alarmDayBefore: Math.max(0, parseInt(e.target.value) || 0) }))}
                      className="w-12 border border-gray-300 rounded px-1 py-1 text-sm text-center" />일 전
                  </label>
                )}
                <label className="flex items-center gap-1 text-xs text-gray-600">시각
                  <input type="time" value={todoForm.alarmTime} onChange={e => setTodoForm(f => ({ ...f, alarmTime: e.target.value }))}
                    className="border border-gray-300 rounded px-2 py-1 text-sm" />
                </label>
              </>
            )}
          </div>
          <input
            className="w-full border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="메모 (선택)"
            value={todoForm.note}
            onChange={e => setTodoForm(f => ({ ...f, note: e.target.value }))}
          />
          <div className="flex gap-2 justify-end">
            <button onClick={saveTodo} disabled={!todoForm.title.trim()}
              className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40">
              {editingTodo ? '수정' : '추가'}
            </button>
            <button onClick={() => { setShowTodoForm(false); setEditingTodo(null); setTodoForm(blankForm); }}
              className="px-4 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">취소</button>
          </div>
        </div>
      )}

      {/* 할일 목록 — 일간/주간/월간 (더블클릭으로 완료) */}
      {(() => {
        // 주간근무에서 자동 등록된 할일(weeklyDutyAssignee)은 배정된 본인이
        // 로그인해 있을 때만 보이게 한다. 일반 할일은 그대로 전부 보인다.
        const visibleTodos = todos.filter(t => !t.weeklyDutyAssignee || t.weeklyDutyAssignee === currentMember?.username);
        // 날짜별 발생 할일 그룹
        const groups = todoDates.map(d => {
          const ds = fmtDate(d);
          const items = visibleTodos.filter(t => todoOccursOn(t, ds))
            .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
          return { ds, d, items };
        }).filter(g => g.items.length > 0);
        const totalCnt = groups.reduce((s, g) => s + g.items.length, 0);
        const doneCnt = groups.reduce((s, g) => s + g.items.filter(t => (t.completedDates || []).includes(g.ds)).length, 0);
        return (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-gray-50">
              <span className="text-base">📝</span>
              <span className="font-semibold text-gray-800 text-sm">할일</span>
              {totalCnt > 0 && <span className={`ml-auto text-sm font-bold ${doneCnt === totalCnt ? 'text-green-600' : 'text-blue-600'}`}>{doneCnt}/{totalCnt}</span>}
            </div>
            {groups.length === 0 ? (
              <div className="px-5 py-4 text-sm text-gray-400">{todoPeriodLabel} 예정된 할일이 없습니다. "+ 할일 추가"로 등록하세요.</div>
            ) : groups.map(g => (
              <div key={g.ds}>
                {todoView !== 'day' && (() => {
                  const gHoliday = holidays[g.ds];
                  const gColorClass = dateColorClass(g.d.getDay(), !!gHoliday) || 'text-gray-500';
                  return (
                    <div className={`px-5 py-1.5 bg-gray-50/70 text-xs font-semibold border-b border-gray-100 ${gColorClass}`}>
                      {g.d.getMonth() + 1}/{g.d.getDate()} ({DOW[g.d.getDay()]}){gHoliday && ` ${gHoliday}`} {g.ds === todayStr() && <span className="text-blue-500">· 오늘</span>}
                    </div>
                  );
                })()}
                {g.items.map(t => {
                  const done = (t.completedDates || []).includes(g.ds);
                  const dd = t.due ? dueDday(t.due) : null;
                  return (
                    <div key={`${t.id}_${g.ds}`}
                      onDoubleClick={() => handleToggleTodo(t.id, g.ds)}
                      className={`flex items-center px-5 py-2.5 gap-3 cursor-pointer select-none border-b border-gray-50 ${done ? 'bg-green-50/40' : 'hover:bg-blue-50/40'}`}
                      title="더블클릭으로 완료/취소">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-xs ${done ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'}`}>
                        {done ? '✓' : '○'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{t.title}</p>
                        {t.note && <p className="text-xs text-gray-400 truncate">{t.note}</p>}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {t.due && !done && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${dd < 0 ? 'bg-red-100 text-red-600' : dd === 0 ? 'bg-red-100 text-red-600' : dd <= 3 ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-500'}`}>
                            {dd < 0 ? `기한초과 ${-dd}일` : dd === 0 ? '오늘마감' : `D-${dd}`}
                          </span>
                        )}
                        {repeatText(t) && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded">🔁 {repeatText(t)}</span>
                        )}
                        {alarmText(t) && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-600 rounded">⏰ {alarmText(t)}</span>
                        )}
                        <button onClick={e => { e.stopPropagation(); startEditTodo(t); }} className="text-gray-300 hover:text-blue-500 text-xs px-1">✎</button>
                        <button onClick={e => { e.stopPropagation(); handleDeleteTodo(t.id); }} className="text-gray-300 hover:text-red-500 text-xs px-1">✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })()}

      {/* 요약 카드 */}
      <div className="grid grid-cols-3 gap-3">
        <div className={`rounded-xl p-4 border ${overdueCalib.length > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'}`}>
          <p className="text-xs text-gray-500">교정 만료</p>
          <p className={`text-3xl font-bold mt-1 ${overdueCalib.length > 0 ? 'text-red-600' : 'text-gray-300'}`}>{overdueCalib.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">건</p>
        </div>
        <div className={`rounded-xl p-4 border ${soonCalib.length > 0 ? 'bg-orange-50 border-orange-200' : 'bg-white border-gray-200'}`}>
          <p className="text-xs text-gray-500">교정 임박 (60일내)</p>
          <p className={`text-3xl font-bold mt-1 ${soonCalib.length > 0 ? 'text-orange-500' : 'text-gray-300'}`}>{soonCalib.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">건</p>
        </div>
        <div className="rounded-xl p-4 border bg-white border-gray-200">
          <p className="text-xs text-gray-500">이번달 모니터링</p>
          <p className={`text-3xl font-bold mt-1 ${monRate === 100 ? 'text-green-600' : monRate >= 50 ? 'text-blue-600' : 'text-gray-700'}`}>{monRate}%</p>
          <p className="text-xs text-gray-400 mt-0.5">{completedZones.length}/{zones.length} 구역</p>
        </div>
      </div>

      {/* 교정 만료 */}
      {overdueCalib.length > 0 && (
        <Section title="교정 만료 — 즉시 조치 필요" icon="🔴" count={`${overdueCalib.length}건`} countColor="text-red-600">
          {overdueCalib.map(c => (
            <div key={c.id} className="flex items-center px-5 py-3 gap-3 bg-red-50/50">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{c.name}</p>
                <p className="text-xs text-gray-400">S/N: {c.sn || '-'} · 교정번호: {c.eff.cert_no || '-'}</p>
              </div>
              <div className="text-right shrink-0">
                <DayBadge days={dDay(c.eff.next_calib_date)} />
                <p className="text-xs text-gray-400 mt-0.5">{c.eff.next_calib_date}</p>
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* 교정 임박 */}
      {soonCalib.length > 0 && (
        <Section title="교정 예정 (60일 이내)" icon="⚠️" count={`${soonCalib.length}건`} countColor="text-orange-500">
          {soonCalib.map(c => (
            <div key={c.id} className="flex items-center px-5 py-3 gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{c.name}</p>
                <p className="text-xs text-gray-400">S/N: {c.sn || '-'}</p>
              </div>
              <div className="text-right shrink-0">
                <DayBadge days={dDay(c.eff.next_calib_date)} />
                <p className="text-xs text-gray-400 mt-0.5">{c.eff.next_calib_date}</p>
              </div>
            </div>
          ))}
        </Section>
      )}

      {overdueCalib.length === 0 && soonCalib.length === 0 && (
        <Section title="교정 일정" icon="✅">
          <div className="px-5 py-4 text-sm text-gray-400">60일 이내 교정 예정 항목 없음</div>
        </Section>
      )}

      {/* 이번달 모니터링 */}
      <Section
        title={`${MONTH_KR[month - 1]} 모니터링 현황`}
        icon="📋"
        count={`${completedZones.length}/${zones.length}`}
        countColor={monRate === 100 ? 'text-green-600' : 'text-blue-600'}
      >
        {/* 진행률 바 */}
        <div className="px-5 py-3 border-b border-gray-50">
          <div className="flex items-center gap-3">
            <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
              <div
                className={`h-3 rounded-full transition-all ${monRate === 100 ? 'bg-green-500' : 'bg-blue-500'}`}
                style={{ width: `${monRate}%` }}
              />
            </div>
            <span className="text-sm font-bold text-gray-700 w-10 text-right">{monRate}%</span>
          </div>
        </div>

        {/* 미완료 구역 */}
        {pendingZones.length > 0 ? (
          <div className="px-5 py-3">
            <p className="text-xs font-medium text-gray-500 mb-2">미완료 구역 ({pendingZones.length}개)</p>
            <div className="flex flex-wrap gap-1.5">
              {pendingZones.map(z => (
                <span key={z.id} className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">
                  {z.name}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="px-5 py-4 text-sm text-green-600 font-medium">✅ 이번달 모든 구역 모니터링 완료</div>
        )}
      </Section>

      {/* AHU 계획 */}
      {ahuTasks.length > 0 && (
        <Section
          title={`${MONTH_KR[month - 1]} AHU 유지보수`}
          icon="🔧"
          count={`${ahuDone}/${ahuTasks.length} 완료`}
          countColor={ahuDone === ahuTasks.length ? 'text-green-600' : 'text-gray-600'}
        >
          {ahuTasks.map((t, i) => (
            <div key={i} className="flex items-center px-5 py-3 gap-3">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-xs ${t.done ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'}`}>
                {t.done ? '✓' : '○'}
              </div>
              <p className={`text-sm flex-1 ${t.done ? 'text-gray-400 line-through' : 'text-gray-800 font-medium'}`}>
                {t.ahuName}
              </p>
              {t.note && <p className="text-xs text-gray-400 truncate max-w-[200px]">{t.note}</p>}
              <span className={`text-xs px-2 py-0.5 rounded-full ${t.done ? 'bg-green-100 text-green-600' : 'bg-yellow-100 text-yellow-700'}`}>
                {t.done ? '완료' : '예정'}
              </span>
            </div>
          ))}
        </Section>
      )}

      {ahuTasks.length === 0 && (
        <Section title={`${MONTH_KR[month - 1]} AHU 유지보수`} icon="🔧">
          <div className="px-5 py-4 text-sm text-gray-400">이번달 예정된 AHU 유지보수 없음</div>
        </Section>
      )}
    </div>

    <StickyNotesBoard />
    </div>
    </div>
  );
}
