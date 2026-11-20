import { useState, useEffect, useRef } from 'react';
import { fetchWaterPlan, saveWaterPlanItem, deleteWaterPlanItem, seedWaterPlan, syncAfterChange } from '../lib/api';
import { WATER_PLAN_SEED } from '../data/waterPlanSeed';
import { WATER_TYPES, WATER_TYPE_KEYS, WATER_REPEATS, DOW_KR, fmt, occursOn, itemsOn, groupItems, repeatLabel, monthWeeks } from '../lib/waterPlan';

// 용수모니터링 일정 — 첨부된 '용수 모니터링 계획' 엑셀(주간용수 WFI·UF / PW / PS / 용수 달력)을 달력으로 옮긴 화면.
// 날짜 칸에 그 날 채취할 구역(종류별 색)과 개수가 보이고, 날짜를 누르면 사용점 번호까지 자세히 나온다.
// 일정은 관리자만 추가·수정·삭제한다(매주 / 매월 같은 요일·주차 / 한 번).
export default function WaterPlan({ adminUnlocked }) {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const now = new Date();
  const todayStr = fmt(now);
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });
  const [sel, setSel] = useState(todayStr);
  const [typeFilter, setTypeFilter] = useState('all');
  const [dlg, setDlg] = useState(null); // { id|null, draft }
  const [confirmDlg, setConfirmDlg] = useState(null);
  const [notice, setNotice] = useState(null);
  const seeding = useRef(false);
  const monthSet = useRef(false);
  const weekStartMon = (() => { try { return localStorage.getItem('em-week-start') === 'mon'; } catch { return false; } })();

  function flash(text, isError) { setNotice({ text, isError }); setTimeout(() => setNotice(null), 2500); }

  function load() {
    fetchWaterPlan().then(r => {
      const list = Array.isArray(r?.items) ? r.items : [];
      // 처음 열었는데 일정이 하나도 없으면(관리자) 첨부 엑셀에서 만든 기본 일정을 한 번 불러온다
      if (adminUnlocked && !r?.seeded && list.length === 0 && !seeding.current) {
        seeding.current = true;
        seedWaterPlan(WATER_PLAN_SEED).then(() => { syncAfterChange().catch(() => {}); load(); }).catch(() => {});
        return;
      }
      setItems(list);
      setLoaded(true);
      // 오늘이 속한 달에 일정이 없으면(예: 엑셀 일정이 다음 달부터) 가장 이른 일정의 달을 먼저 보여준다
      if (!monthSet.current && list.length > 0) {
        monthSet.current = true;
        const y = now.getFullYear(), m = now.getMonth() + 1;
        const days = Array.from({ length: new Date(y, m, 0).getDate() }, (_, i) => `${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`);
        if (!days.some(d => list.some(it => occursOn(it, d)))) {
          const first = list.map(it => it.date).sort()[0];
          setYm({ y: parseInt(first.slice(0, 4)), m: parseInt(first.slice(5, 7)) });
          setSel(first);
        }
      }
    }).catch(() => setLoaded(true));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!window.electronAPI?.onDataChanged) return;
    return window.electronAPI.onDataChanged(() => load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = typeFilter === 'all' ? items : items.filter(it => it.type === typeFilter);
  const weeks = monthWeeks(ym.y, ym.m, weekStartMon);
  const dowHead = weekStartMon ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const shiftMonth = (n) => { const d = new Date(ym.y, ym.m - 1 + n, 1); setYm({ y: d.getFullYear(), m: d.getMonth() + 1 }); };
  const goToday = () => { setYm({ y: now.getFullYear(), m: now.getMonth() + 1 }); setSel(todayStr); };

  // ── 일정 추가·수정·삭제(관리자) ──
  function openDlg(it, date) {
    if (!adminUnlocked) return;
    setDlg(it
      ? { id: it.id, draft: { type: it.type, area: it.area || '', points: it.points || '', count: String(it.count ?? ''), repeat: it.repeat || 'once', date: it.date, note: it.note || '' } }
      : { id: null, draft: { type: 'WFI', area: '', points: '', count: '', repeat: 'weekly', date: date || sel, note: '' } });
  }
  async function saveDlg() {
    const { id, draft } = dlg;
    if (!draft.date || (!draft.area.trim() && !draft.points.trim())) { flash('날짜와 구역(또는 사용점)을 입력하세요.', true); return; }
    // 개수를 비워 두면 사용점 번호를 세어 채운다(쉼표·공백으로 구분)
    const auto = draft.points.split(/[,\s]+/).filter(Boolean).length;
    const count = draft.count === '' ? auto : parseInt(draft.count) || 0;
    setDlg(null);
    try {
      const r = await saveWaterPlanItem({ id, ...draft, count });
      if (!r?.ok) { flash(r?.error || '저장하지 못했습니다', true); return; }
      load(); syncAfterChange().catch(() => {});
      flash(id ? '일정을 수정했습니다.' : '일정을 추가했습니다.');
    } catch { flash('저장하지 못했습니다', true); }
  }
  function removeItem(it) {
    setConfirmDlg({
      message: `"${it.area || it.points.slice(0, 20)}" 일정을 삭제할까요?\n${it.repeat === 'once' ? '' : '반복 일정이라 모든 날짜에서 사라집니다.'}`,
      onYes: async () => {
        try {
          const r = await deleteWaterPlanItem(it.id);
          if (!r?.ok) { flash(r?.error || '삭제하지 못했습니다', true); return; }
          setItems(list => list.filter(x => x.id !== it.id)); syncAfterChange().catch(() => {});
        } catch { flash('삭제하지 못했습니다', true); }
      },
    });
  }

  // ── 화면 ──
  const selList = itemsOn(shown, sel);
  const selGroups = groupItems(selList);
  const selDate = new Date(`${sel}T00:00:00`);
  const monthTotal = weeks.flat().filter(d => d.startsWith(`${ym.y}-${String(ym.m).padStart(2, '0')}`)).reduce((n, d) => n + itemsOn(shown, d).reduce((s, it) => s + (Number(it.count) || 0), 0), 0);

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-800">💧 용수모니터링 일정</h1>
        {adminUnlocked && <button type="button" onClick={() => openDlg(null, sel)} className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">+ 일정 추가</button>}
        {!adminUnlocked && <span className="text-xs text-gray-400">🔒 보기 전용 — 관리자로 로그인하면 일정을 수정할 수 있습니다</span>}
        {notice && <span className={`text-xs font-medium ${notice.isError ? 'text-red-500' : 'text-green-600'}`}>{notice.text}</span>}
      </div>

      <div className="flex items-center gap-2 flex-wrap my-3">
        <div className="inline-flex items-center gap-1">
          <button type="button" onClick={() => shiftMonth(-1)} className="w-8 h-8 rounded-full border border-gray-300 bg-white text-lg leading-none text-gray-600 hover:bg-gray-50" title="이전 달">‹</button>
          <span className="px-3 text-lg font-bold text-gray-800 tabular-nums">{ym.y}년 {ym.m}월</span>
          <button type="button" onClick={() => shiftMonth(1)} className="w-8 h-8 rounded-full border border-gray-300 bg-white text-lg leading-none text-gray-600 hover:bg-gray-50" title="다음 달">›</button>
          <button type="button" onClick={goToday} className="ml-1 px-2.5 py-1 text-xs rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50">오늘</button>
        </div>
        <span className="text-xs text-gray-400">이 달 채취 {monthTotal}개</span>
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          {['all', ...WATER_TYPE_KEYS].map(t => (
            <button key={t} type="button" onClick={() => setTypeFilter(t)}
              className={`px-3 py-1 rounded-full text-xs font-medium border ${typeFilter === t ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50 bg-white'}`}>
              {t === 'all' ? '전체' : t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-4 items-start">
        {/* 달력 */}
        <div className="flex-1 min-w-0 bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="grid grid-cols-7 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-center">
            {dowHead.map(d => <div key={d} className={`py-2 ${d === 0 ? 'text-red-500' : d === 6 ? 'text-blue-500' : 'text-gray-600'}`}>{DOW_KR[d]}</div>)}
          </div>
          {weeks.map((wk, wi) => (
            <div key={wi} className="grid grid-cols-7 border-b border-gray-100 last:border-b-0">
              {wk.map(ds => {
                const inMonth = ds.startsWith(`${ym.y}-${String(ym.m).padStart(2, '0')}`);
                const list = itemsOn(shown, ds);
                const groups = groupItems(list);
                const total = list.reduce((n, it) => n + (Number(it.count) || 0), 0);
                const dow = new Date(`${ds}T00:00:00`).getDay();
                const isSel = ds === sel;
                return (
                  <div key={ds} onClick={() => setSel(ds)}
                    className={`min-h-[7.5rem] p-1.5 border-r border-gray-100 last:border-r-0 cursor-pointer transition-colors ${isSel ? 'bg-blue-50 ring-2 ring-inset ring-blue-400' : 'hover:bg-gray-50'} ${inMonth ? '' : 'opacity-40'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-semibold ${ds === todayStr ? 'bg-blue-600 text-white rounded-full w-5 h-5 inline-flex items-center justify-center' : dow === 0 ? 'text-red-500' : dow === 6 ? 'text-blue-500' : 'text-gray-700'}`}>{parseInt(ds.slice(8))}</span>
                      {total > 0 && <span className="text-[10px] font-semibold text-gray-500 tabular-nums" title="이 날 채취 개수">{total}개</span>}
                    </div>
                    <div className="space-y-0.5">
                      {groups.slice(0, 5).map(g => (
                        <div key={g.key} title={`${g.type} ${g.area} ${g.count}개`}
                          className={`flex items-center justify-between gap-1 px-1 py-0.5 rounded border text-[10px] leading-tight ${WATER_TYPES[g.type]?.chip || WATER_TYPES['기타'].chip}`}>
                          <span className="truncate"><b>{g.type}</b> {g.area}</span>
                          <span className="shrink-0 font-semibold tabular-nums">{g.count}</span>
                        </div>
                      ))}
                      {groups.length > 5 && <div className="text-[10px] text-gray-400 px-1">+{groups.length - 5}건 더</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* 선택한 날짜 자세히 */}
        <div className="w-80 shrink-0 bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 bg-sky-700 text-white flex items-start justify-between gap-2">
            <div>
              <p className="text-xs text-sky-100">{selDate.getFullYear()}년 {selDate.getMonth() + 1}월 · {DOW_KR[selDate.getDay()]}요일</p>
              <p className="text-lg font-bold">{selDate.getDate()}일 용수 채취</p>
              <p className="text-xs text-sky-100 mt-0.5">{selGroups.length}개 구역 · {selList.reduce((n, it) => n + (Number(it.count) || 0), 0)}개</p>
            </div>
            {adminUnlocked && <button type="button" onClick={() => openDlg(null, sel)} className="px-2.5 py-1 text-xs font-medium bg-white/20 hover:bg-white/30 rounded-lg whitespace-nowrap">+ 추가</button>}
          </div>
          <div className="max-h-[34rem] overflow-y-auto">
            {!loaded ? <p className="px-4 py-6 text-sm text-gray-400">불러오는 중...</p>
              : selList.length === 0 ? <p className="px-4 py-6 text-sm text-gray-300">이 날은 용수 채취 일정이 없습니다.</p>
              : selGroups.map(g => (
                <div key={g.key} className="border-b border-gray-100 last:border-b-0">
                  <div className="px-4 pt-2.5 pb-1 flex items-center gap-2">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${WATER_TYPES[g.type]?.chip || WATER_TYPES['기타'].chip}`}>{g.type}</span>
                    <span className="text-sm font-semibold text-gray-800">{g.area || '(구역 없음)'}</span>
                    <span className="ml-auto text-xs font-semibold text-gray-500 tabular-nums">{g.count}개</span>
                  </div>
                  <div className="px-4 pb-2.5 space-y-1.5">
                    {g.items.map(it => (
                      <div key={it.id} className="text-xs text-gray-600 bg-gray-50 rounded-md px-2 py-1.5">
                        <div className="flex items-start gap-1.5">
                          <span className="flex-1 break-words">{it.points || '—'}</span>
                          {adminUnlocked && (
                            <span className="shrink-0 flex gap-1">
                              <button type="button" onClick={() => openDlg(it)} className="text-blue-600 hover:underline">수정</button>
                              <button type="button" onClick={() => removeItem(it)} className="text-red-500 hover:underline">삭제</button>
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[10px] text-gray-400">{it.count}개 · {repeatLabel(it)}{it.note ? ` · ${it.note}` : ''}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* 일정 추가/수정 창 */}
      {dlg && (() => {
        const d = dlg.draft; const set = (patch) => setDlg(p => ({ ...p, draft: { ...p.draft, ...patch } }));
        const wd = d.date ? DOW_KR[new Date(`${d.date}T00:00:00`).getDay()] : '';
        return (
          <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40" onClick={() => setDlg(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-[30rem] max-w-[95vw] max-h-[92vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-bold text-gray-900 mb-3">💧 {dlg.id ? '일정 수정' : '일정 추가'}</h3>
              <div className="flex gap-3 mb-3">
                <div className="w-28">
                  <label className="block text-xs text-gray-500 mb-1">종류</label>
                  <select value={d.type} onChange={e => set({ type: e.target.value })} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm">
                    {WATER_TYPE_KEYS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-gray-500 mb-1">구역</label>
                  <input autoFocus value={d.area} onChange={e => set({ area: e.target.value })} placeholder="예: 1동 조제실" spellCheck={false}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                </div>
              </div>
              <label className="block text-xs text-gray-500 mb-1">사용점 번호</label>
              <textarea value={d.points} rows={3} onChange={e => set({ points: e.target.value })} placeholder="예: 1533-WFI-01, 1534-WFI-01, 1539-WFI-01" spellCheck={false}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 mb-3" />
              <div className="flex gap-3 mb-3">
                <div className="w-24">
                  <label className="block text-xs text-gray-500 mb-1">개수</label>
                  <input type="number" min="0" value={d.count} onChange={e => set({ count: e.target.value })} placeholder="자동"
                    className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-gray-500 mb-1">반복</label>
                  <select value={d.repeat} onChange={e => set({ repeat: e.target.value })} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm">
                    {WATER_REPEATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-gray-500 mb-1">{d.repeat === 'once' ? '날짜' : '시작일'} {wd && <span className="text-gray-400">({wd})</span>}</label>
                  <input type="date" value={d.date} onChange={e => set({ date: e.target.value })} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" />
                </div>
              </div>
              {d.repeat !== 'once' && d.date && <p className="text-[11px] text-gray-400 -mt-1 mb-3">{d.repeat === 'weekly' ? `시작일부터 매주 ${wd}요일` : `시작일부터 매월 ${Math.ceil(parseInt(d.date.slice(8)) / 7)}번째 ${wd}요일`}에 나옵니다.</p>}
              <label className="block text-xs text-gray-500 mb-1">메모</label>
              <input value={d.note} onChange={e => set({ note: e.target.value })} placeholder="선택 (예: Phase.3, 유효기간)" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              <div className="flex gap-2 justify-end mt-4">
                {dlg.id && <button type="button" onClick={() => { const it = items.find(x => x.id === dlg.id); setDlg(null); if (it) removeItem(it); }} className="mr-auto px-3 py-2 text-sm text-red-600 bg-red-50 rounded-lg hover:bg-red-100">삭제</button>}
                <button type="button" onClick={() => setDlg(null)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">취소</button>
                <button type="button" onClick={saveDlg} className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700">저장</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 확인 창(기본 confirm()은 Electron에서 입력칸이 먹통이 되는 일이 있어 화면 안 창을 쓴다) */}
      {confirmDlg && (
        <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/40" onClick={() => setConfirmDlg(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[24rem] max-w-[95vw] p-5" onClick={e => e.stopPropagation()}>
            <p className="text-sm text-gray-800 whitespace-pre-line mb-4">{confirmDlg.message}</p>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setConfirmDlg(null)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">취소</button>
              <button type="button" autoFocus onClick={() => { const f = confirmDlg.onYes; setConfirmDlg(null); f(); }} className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700">확인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
