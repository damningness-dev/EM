import { useState, useEffect, useRef, useMemo } from 'react';
import { fetchWaterPlan, saveWaterPlanItem, deleteWaterPlanItem, seedWaterPlan, syncAfterChange, fetchZones, fetchHolidays, fetchBlockedDates, fetchScheduleConfig, fetchCompletions, setCompletion, deleteCompletion, upsertZone } from '../lib/api';
import { buildHolidayMap, setScheduleConfig, totalCount, calcEndDate, getDragBounds } from '../lib/schedule';
import WaterPlanManager from './WaterPlanManager';
import CalendarSettingsDialog from './CalendarSettingsDialog';
import { mergeScheduleConfig, buildZoneOrderRank, buildScheduleByDate, isWaterZone } from '../lib/monitoringDay';
import { WATER_PLAN_SEED } from '../data/waterPlanSeed';
import { WATER_TYPES, WATER_TYPE_KEYS, WATER_FILTER_KEYS, WATER_REPEATS, DOW_KR, fmt, occursOn, groupItems, buildOccurrenceMap, cycleWindow, repeatLabel, monthWeeks, normalizeWaterItem } from '../lib/waterPlan';

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
  // 월별 모니터링 일정에서 옮겨 온 용수 구역의 일정(구역별 측정 주기로 계산)과 완료 표시
  const [zoneEv, setZoneEv] = useState({ byDate: {}, done: new Set() });
  const [waterZones, setWaterZones] = useState([]); // [{ zone, end }] — 일정 관리 창의 '용수 구역' 탭용
  const [mgrOpen, setMgrOpen] = useState(false); // 일정 관리 창
  const [zoneList, setZoneList] = useState([]); // 용수 구역 원본(드래그로 회차를 옮길 때 저장용)
  const [blocked, setBlocked] = useState([]); // 일정비우기 날짜
  const [alertDlg, setAlertDlg] = useState(null); // { title, message } — 옮길 수 없을 때 알림창
  const [dragOver, setDragOver] = useState(null); // 드래그 중 마우스가 올라간 날짜
  const seeding = useRef(false);
  const monthSet = useRef(false);
  // 달력 설정(주 시작 요일·공휴일)은 월별 모니터링 일정과 같은 값을 쓴다
  const [weekStart, setWeekStart] = useState(() => { try { return localStorage.getItem('em-week-start') || 'sun'; } catch { return 'sun'; } });
  const weekStartMon = weekStart === 'mon';
  // 토·일 칸 폭을 절반으로 줄여 평일 칸을 넓게 보기 — 월별 모니터링 일정의 '주말폭'과 같은 설정을 쓴다
  const [narrowWeekend, setNarrowWeekend] = useState(() => { try { return localStorage.getItem('em-narrow-weekend') === '1'; } catch { return false; } });
  function toggleNarrowWeekend() { setNarrowWeekend(v => { const n = !v; try { localStorage.setItem('em-narrow-weekend', n ? '1' : '0'); } catch { /* 저장 못 해도 이번 화면에는 적용된다 */ } return n; }); }
  const [holidayDefs, setHolidayDefs] = useState([]);
  const [calSettingsOpen, setCalSettingsOpen] = useState(false);
  const holidays = useMemo(() => buildHolidayMap(holidayDefs, ym.y - 1, ym.y + 1), [holidayDefs, ym.y]);
  // 일정을 피할 날 = 공휴일 + 일정비우기 (월별 모니터링 일정과 같은 기준)
  const avoidMap = useMemo(() => { const m = { ...holidays }; blocked.forEach(d => { if (!m[d]) m[d] = '일정비우기'; }); return m; }, [holidays, blocked]);
  const weekCols = { gridTemplateColumns: narrowWeekend ? (weekStartMon ? 'repeat(5, minmax(0, 1fr)) repeat(2, minmax(0, 0.5fr))' : 'minmax(0, 0.5fr) repeat(5, minmax(0, 1fr)) minmax(0, 0.5fr)') : 'repeat(7, minmax(0, 1fr))' };
  function changeWeekStart(value) { setWeekStart(value); try { localStorage.setItem('em-week-start', value); } catch { /* 저장 못 해도 이번 화면에는 적용된다 */ } }

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
      // 예전에 저장된 일정의 ♨/▩ 기호는 종류(HWFI/WFI)로 바꾼다 — 관리자는 바뀐 항목을 한 번 저장해 둔다
      const fixed = list.map(normalizeWaterItem);
      if (adminUnlocked) {
        const changed = fixed.filter((x, i) => x !== list[i]);
        if (changed.length) Promise.all(changed.map(x => saveWaterPlanItem(x))).then(() => syncAfterChange().catch(() => {})).catch(() => {});
      }
      list.splice(0, list.length, ...fixed);
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
  function loadZones() {
    Promise.all([fetchZones(), fetchHolidays().catch(() => []), fetchBlockedDates().catch(() => []), fetchScheduleConfig().catch(() => null), fetchCompletions().catch(() => [])]).then(([zones, holDefs, blocked, cfg, comps]) => {
      setHolidayDefs(holDefs || []);
      setBlocked(blocked || []);
      setScheduleConfig(mergeScheduleConfig(cfg)); // 일정 계산 함수가 읽는 주기 설정
      const raw = (zones || []).filter(z => isWaterZone(z.category === '청정등급' ? { ...z, category: '공조' } : z));
      setZoneList(raw);
      const y = new Date().getFullYear();
      const avoid = { ...buildHolidayMap(holDefs || [], y - 1, y + 2) };
      (blocked || []).forEach(d => { if (!avoid[d]) avoid[d] = '일정비우기'; });
      // 옮겨 둔 회차가 나중에 공휴일·일정비우기가 되면 그 옮김은 무시하고 자동 배치(공휴일을 피한 날)로 계산한다
      const water = raw.map(z => {
        const zz = z.category === '청정등급' ? { ...z, category: '공조' } : z;
        const ov = Object.fromEntries(Object.entries(zz.schedule_overrides || {}).filter(([, d]) => !avoid[d]));
        return { ...zz, schedule_overrides: ov };
      });
      const fmtD = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '');
      setWaterZones(water.map(zone => { let end = ''; try { end = fmtD(calcEndDate(zone, avoid)); } catch { /* 종료일을 계산할 수 없으면 비워 둔다 */ } return { zone, end }; }));
      setZoneEv({ byDate: buildScheduleByDate(water, avoid, buildZoneOrderRank(water)), done: new Set((comps || []).map(c => `${c.zoneId}_${c.num}`)) });
    }).catch(() => {});
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); loadZones(); }, []);
  useEffect(() => {
    if (!window.electronAPI?.onDataChanged) return;
    return window.electronAPI.onDataChanged(() => { load(); loadZones(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = typeFilter === 'all' ? items : items.filter(it => it.type === typeFilter);
  // 그 날의 일정 = 직접 입력한 일정 + 월별 모니터링 일정에서 옮겨 온 용수 구역 일정
  const zoneItemsOn = (ds) => (zoneEv.byDate[ds] || []).map(({ zone, measurement }) => ({
    id: `z${zone.id}_${measurement.num}`, zoneId: zone.id, num: measurement.num, type: '구역', area: zone.name,
    points: `${zone.grade ? zone.grade + ' ' : ''}${measurement.num}/${totalCount(zone)}회차`,
    count: ((zone.points_float || 0) + (zone.points_fall || 0) + (zone.points_surface || 0) + (zone.points_particle || 0)) || 1,
    repeat: 'once', date: ds, done: zoneEv.done.has(`${zone.id}_${measurement.num}`), measurement,
  }));
  const dayItems = (ds) => [...(occMap[ds] || []), ...(typeFilter === 'all' || typeFilter === '구역' ? zoneItemsOn(ds) : [])];
  // 용수 구역 일정 완료/취소(월별 모니터링 일정의 완료 처리와 같은 기록)
  async function toggleZoneDone(it) {
    if (!adminUnlocked) { flash('관리자만 완료 표시를 할 수 있습니다.', true); return; }
    const key = `${it.zoneId}_${it.num}`;
    try {
      if (it.done) await deleteCompletion(it.zoneId, it.num); else await setCompletion(it.zoneId, it.num);
      setZoneEv(p => { const d = new Set(p.done); if (it.done) d.delete(key); else d.add(key); return { ...p, done: d }; });
      syncAfterChange().catch(() => {});
    } catch { flash('완료 표시를 저장하지 못했습니다', true); }
  }
  const weeks = monthWeeks(ym.y, ym.m, weekStartMon);
  // 화면에 보이는 기간의 실제 일정(옮긴 회차·공휴일 자동 이동 반영)
  const occMap = useMemo(() => buildOccurrenceMap(shown, weeks[0][0], weeks[weeks.length - 1][6], avoidMap),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, typeFilter, avoidMap, weeks[0][0], weeks.length]);

  // ── 드래그로 일정 옮기기(관리자) ──
  // 칩(같은 종류·구역 묶음) 또는 오른쪽 목록의 한 건을 다른 날짜로 끌어 놓는다.
  // 주기(매주=같은 주, 매월·한 번=같은 달, 용수 구역=측정주기 창)를 벗어나거나 공휴일·일정비우기면 막고 알림창을 띄운다.
  const md = (ds) => `${Number(ds.slice(5, 7))}/${Number(ds.slice(8, 10))}(${DOW_KR[new Date(`${ds}T00:00:00`).getDay()]})`;
  const dragPayload = (from, list) => JSON.stringify({ from, members: list.map(it => (it.zoneId ? { kind: 'zone', zoneId: it.zoneId, num: it.num } : { kind: 'item', id: it.id, base: it._base })) });
  function onDragStartItems(e, from, list) {
    if (!adminUnlocked) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragPayload(from, list));
  }
  async function handleDrop(target, raw) {
    setDragOver(null);
    if (!adminUnlocked) { flash('관리자만 일정을 옮길 수 있습니다.', true); return; }
    let data; try { data = JSON.parse(raw); } catch { return; }
    if (!data?.members?.length || data.from === target) return;
    if (avoidMap[target]) {
      setAlertDlg({ title: '일정을 옮길 수 없습니다', message: `${md(target)}은(는) ${avoidMap[target] === '일정비우기' ? '일정비우기로 지정된 날' : `공휴일(${avoidMap[target]})`}이라 일정을 잡을 수 없습니다.` });
      return;
    }
    const zoneLabel = (m) => (m.type === 'weekly' || m.type === 'biweekly') ? '같은 주(월~일)'
      : m.type === 'daily' ? '측정 주간' : m.spanMonths === 3 ? '같은 분기' : m.spanMonths === 6 ? '같은 반기' : m.spanMonths === 12 ? '같은 해' : '같은 달';
    const plan = [], bad = [];
    for (const mem of data.members) {
      if (mem.kind === 'item') {
        const it = items.find(x => x.id === mem.id);
        if (!it || !mem.base) continue;
        const win = cycleWindow(it, mem.base);
        const name = `${it.type} ${it.area || it.points?.slice(0, 15) || ''} (${repeatLabel(it)})`;
        if (target < win.min || target > win.max) bad.push(`• ${name}: ${win.label} ${md(win.min)} ~ ${md(win.max)}`);
        else plan.push({ kind: 'item', it, base: mem.base });
      } else {
        const ev = (zoneEv.byDate[data.from] || []).find(x => x.zone.id === mem.zoneId && x.measurement.num === mem.num);
        const zone = zoneList.find(z => z.id === mem.zoneId);
        if (!ev || !zone) continue;
        if (zoneEv.done.has(`${mem.zoneId}_${mem.num}`)) { bad.push(`• 용수구역 ${zone.name}[${zone.grade}] ${mem.num}회차: 완료된 회차는 옮길 수 없습니다`); continue; }
        const b = getDragBounds(ev.measurement, avoidMap);
        const min = fmt(b.min), max = fmt(b.max);
        const name = `용수구역 ${zone.name}[${zone.grade}] ${mem.num}회차`;
        // 앞 회차보다 앞선 날로는 옮길 수 없다(측정 순서 유지)
        let prevDs = null;
        Object.entries(zoneEv.byDate).forEach(([ds, arr]) => { if (arr.some(x => x.zone.id === mem.zoneId && x.measurement.num === mem.num - 1)) prevDs = ds; });
        if (target < min || target > max) bad.push(`• ${name}: ${zoneLabel(ev.measurement)} ${md(min)} ~ ${md(max)}`);
        else if (prevDs && target <= prevDs) bad.push(`• ${name}: 앞 회차(${md(prevDs)})보다 뒤로만 옮길 수 있습니다`);
        else plan.push({ kind: 'zone', zone, num: mem.num });
      }
    }
    if (bad.length) {
      setAlertDlg({ title: '주기에서 벗어난 날짜입니다', message: `${md(target)}(으)로는 옮길 수 없습니다. 아래 기간 안에서만 옮길 수 있습니다.\n\n${bad.join('\n')}` });
      return;
    }
    if (!plan.length) return;
    try {
      const saved = [];
      for (const p of plan) {
        if (p.kind === 'item') {
          const moves = { ...(p.it.moves || {}) };
          if (target === p.base) delete moves[p.base]; else moves[p.base] = target;
          const next = { ...p.it, moves };
          const r = await saveWaterPlanItem(next);
          if (r?.ok === false) throw new Error(r.error || '저장 실패');
          saved.push(next);
        } else {
          const ov = { ...(p.zone.schedule_overrides || {}) };
          ov[String(p.num)] = target;
          Object.keys(ov).forEach(k => { if (Number(k) > p.num) delete ov[k]; }); // 뒤 회차는 새 날짜 기준으로 다시 배치
          await upsertZone({ ...p.zone, schedule_overrides: ov });
        }
      }
      if (saved.length) setItems(list => list.map(x => saved.find(y => y.id === x.id) || x));
      if (plan.some(p => p.kind === 'zone')) loadZones();
      syncAfterChange().catch(() => {});
      flash(`${plan.length}건을 ${md(target)}(으)로 옮겼습니다.`);
    } catch (err) { flash(`옮기지 못했습니다: ${err.message || ''}`, true); }
  }
  const dowHead = weekStartMon ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const shiftMonth = (n) => { const d = new Date(ym.y, ym.m - 1 + n, 1); setYm({ y: d.getFullYear(), m: d.getMonth() + 1 }); };
  const goToday = () => { setYm({ y: now.getFullYear(), m: now.getMonth() + 1 }); setSel(todayStr); };

  // ── 일정 추가·수정·삭제(관리자) ──
  function openDlg(it, date, type) {
    if (!adminUnlocked) return;
    setDlg(it
      ? { id: it.id, draft: { type: it.type, area: it.area || '', points: it.points || '', count: String(it.count ?? ''), repeat: it.repeat || 'once', date: it.date, note: it.note || '' } }
      : { id: null, draft: { type: type || 'WFI', area: '', points: '', count: '', repeat: type === 'PW' || type === 'PS' ? 'once' : 'weekly', date: date || sel, note: '' } });
  }
  // 용수 구역(월별 모니터링에서 옮겨 온 구역)의 등급·시작일 수정 — 달력 일정이 이 값으로 다시 계산된다
  async function saveZone(zone, patch) {
    if (!adminUnlocked) return;
    try { await upsertZone({ ...zone, ...patch }); loadZones(); syncAfterChange().catch(() => {}); flash('용수 구역을 수정했습니다.'); } catch { flash('저장하지 못했습니다', true); }
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
  const selList = dayItems(sel);
  const selGroups = groupItems(selList);
  const selDate = new Date(`${sel}T00:00:00`);
  const monthTotal = weeks.flat().filter(d => d.startsWith(`${ym.y}-${String(ym.m).padStart(2, '0')}`)).reduce((n, d) => n + dayItems(d).reduce((s, it) => s + (Number(it.count) || 0), 0), 0);

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-800">💧 용수모니터링 일정</h1>
        {adminUnlocked && <button type="button" onClick={() => openDlg(null, sel)} className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">+ 일정 추가</button>}
        <button type="button" onClick={() => setMgrOpen(true)} className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50" title="용수 일정을 표로 보고 추가·수정·삭제합니다">⚙ 일정 관리</button>
        <button type="button" onClick={() => setCalSettingsOpen(true)} className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50" title="주 시작 요일·공휴일 (월별 모니터링 일정과 같은 설정)">🗓 달력 설정</button>
        {!adminUnlocked && <span className="text-xs text-gray-400">🔒 보기 전용 — 관리자로 로그인하면 일정을 수정할 수 있습니다</span>}
        {notice && <span className={`text-xs font-medium ${notice.isError ? 'text-red-500' : 'text-green-600'}`}>{notice.text}</span>}
      </div>

      <div className="flex items-center gap-2 flex-wrap my-3">
        <div className="inline-flex items-center gap-1">
          <button type="button" onClick={() => shiftMonth(-1)} className="w-8 h-8 rounded-full border border-gray-300 bg-white text-lg leading-none text-gray-600 hover:bg-gray-50" title="이전 달">‹</button>
          <span className="px-3 text-lg font-bold text-gray-800 tabular-nums">{ym.y}년 {ym.m}월</span>
          <button type="button" onClick={() => shiftMonth(1)} className="w-8 h-8 rounded-full border border-gray-300 bg-white text-lg leading-none text-gray-600 hover:bg-gray-50" title="다음 달">›</button>
          <button type="button" onClick={goToday} className="ml-1 px-2.5 py-1 text-xs rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50">오늘</button>
          <button type="button" onClick={toggleNarrowWeekend}
            title={narrowWeekend ? '주말(토·일) 칸이 평일의 절반 폭입니다 — 누르면 같은 폭으로' : '토·일 칸 폭을 절반으로 줄여 평일 칸을 넓게 봅니다'}
            className={`ml-1 whitespace-nowrap px-2.5 py-1 text-xs font-medium rounded border transition-colors ${narrowWeekend ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100' : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'}`}>↔ 주말폭</button>
        </div>
        <span className="text-xs text-gray-400">이 달 채취 {monthTotal}개</span>
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          {['all', ...WATER_FILTER_KEYS].map(t => (
            <button key={t} type="button" onClick={() => setTypeFilter(t)}
              className={`px-3 py-1 rounded-full text-xs font-medium border ${typeFilter === t ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50 bg-white'}`}>
              {t === 'all' ? '전체' : WATER_TYPES[t].label}
            </button>
          ))}
        </div>
      </div>

      {/* 색상 범례 */}
      <div className="mb-3">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-gray-500 font-semibold">색상</span>
          {['WFI', 'HWFI', 'PW', 'PS', 'UF'].map(t => (
            <span key={t} className={`px-2 py-0.5 rounded border font-medium ${WATER_TYPES[t].chip}`}>{t === 'PW' ? 'PW(정제수)' : t === 'PS' ? 'PS(순수증기)' : t} · {WATER_TYPES[t].pipe}</span>
          ))}
          <span className={`px-2 py-0.5 rounded border font-medium ${WATER_TYPES['구역'].chip}`}>용수구역 · 청록</span>
        </div>
      </div>

      <div className="flex gap-4 items-start">
        {/* 달력 */}
        <div className="flex-1 min-w-0 bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div style={weekCols} className="grid bg-gray-50 border-b border-gray-200 text-xs font-semibold text-center">
            {dowHead.map(d => <div key={d} className={`py-2 ${d === 0 ? 'text-red-500' : d === 6 ? 'text-blue-500' : 'text-gray-600'}`}>{DOW_KR[d]}</div>)}
          </div>
          {weeks.map((wk, wi) => (
            <div key={wi} style={weekCols} className="grid border-b border-gray-100 last:border-b-0">
              {wk.map(ds => {
                const inMonth = ds.startsWith(`${ym.y}-${String(ym.m).padStart(2, '0')}`);
                const list = dayItems(ds);
                const groups = groupItems(list);
                const total = list.reduce((n, it) => n + (Number(it.count) || 0), 0);
                const dow = new Date(`${ds}T00:00:00`).getDay();
                const isSel = ds === sel;
                const holName = inMonth ? holidays[ds] : '';
                return (
                  <div key={ds} onClick={() => setSel(ds)}
                    onDragOver={adminUnlocked ? (e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOver !== ds) setDragOver(ds); }) : undefined}
                    onDragLeave={adminUnlocked ? (e => { if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) setDragOver(null); }) : undefined}
                    onDrop={adminUnlocked ? (e => { e.preventDefault(); handleDrop(ds, e.dataTransfer.getData('text/plain')); }) : undefined}
                    className={`min-h-[7.5rem] p-1.5 border-r border-gray-100 last:border-r-0 cursor-pointer transition-colors ${dragOver === ds ? (avoidMap[ds] ? 'bg-red-100 ring-2 ring-inset ring-red-400' : 'bg-blue-100 ring-2 ring-inset ring-blue-500') : isSel ? 'bg-blue-50 ring-2 ring-inset ring-blue-400' : holName ? 'bg-red-50/60 hover:bg-red-50' : 'hover:bg-gray-50'} ${inMonth ? '' : 'opacity-40'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-semibold ${ds === todayStr ? 'bg-blue-600 text-white rounded-full w-5 h-5 inline-flex items-center justify-center' : (dow === 0 || holName) ? 'text-red-500' : dow === 6 ? 'text-blue-500' : 'text-gray-700'}`}>{parseInt(ds.slice(8))}</span>
                      {holName && <span className="mx-1 flex-1 min-w-0 truncate text-[9px] leading-none text-red-500" title={holName}>{holName}</span>}
                      {total > 0 && <span className="text-[10px] font-semibold text-gray-500 tabular-nums" title="이 날 채취 개수">{total}개</span>}
                    </div>
                    <div className="space-y-0.5">
                      {groups.slice(0, 5).map(g => {
                        const moved = g.items.some(it => it._moved || it._shifted);
                        const tip = [`${g.type} ${g.area} ${g.count}개`, ...g.items.filter(it => it._shifted || it._moved).map(it => (it._shifted ? `↪ ${it._shifted}이라 ${md(it.moves?.[it._base] || it._base)}에서 자동으로 옮김` : `↪ ${md(it._base)}에서 옮김`)), adminUnlocked ? '끌어서 다른 날짜로 옮길 수 있습니다(주기 안에서만)' : ''].filter(Boolean).join('\n');
                        return (
                        <div key={g.key} title={tip} draggable={adminUnlocked} onDragStart={e => onDragStartItems(e, ds, g.items)} onDragEnd={() => setDragOver(null)}
                          className={`flex items-center justify-between gap-1 px-1 py-0.5 rounded border text-[10px] leading-tight ${adminUnlocked ? 'cursor-grab active:cursor-grabbing' : ''} ${WATER_TYPES[g.type]?.chip || WATER_TYPES['기타'].chip}`}>
                          <span className="truncate"><b>{WATER_TYPES[g.type]?.label || g.type}</b> {g.area}{moved && <span className="ml-0.5 text-amber-600 font-bold">↪</span>}</span>
                          <span className="shrink-0 font-semibold tabular-nums">{g.count}</span>
                        </div>
                        );
                      })}
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
              {holidays[sel] && <p className="text-xs text-red-200 font-semibold mt-0.5">🎌 {holidays[sel]}</p>}
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
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${WATER_TYPES[g.type]?.chip || WATER_TYPES['기타'].chip}`}>{WATER_TYPES[g.type]?.label || g.type}</span>
                    <span className="text-sm font-semibold text-gray-800">{g.area || '(구역 없음)'}</span>
                    <span className="ml-auto text-xs font-semibold text-gray-500 tabular-nums">{g.count}개</span>
                  </div>
                  <div className="px-4 pb-2.5 space-y-1.5">
                    {g.items.map(it => it.zoneId ? (
                      // 월별 모니터링 일정에서 옮겨 온 용수 구역 일정 — 더블클릭으로 완료 표시(달력의 완료 처리와 같은 기록)
                      <div key={it.id} onDoubleClick={() => toggleZoneDone(it)} title={adminUnlocked ? '더블클릭: 완료 표시/취소 · 끌어서 달력의 다른 날짜로 옮기기' : ''}
                        draggable={adminUnlocked && !it.done} onDragStart={e => onDragStartItems(e, sel, [it])} onDragEnd={() => setDragOver(null)}
                        className={`text-xs rounded-md px-2 py-1.5 select-none flex items-center gap-1.5 ${it.done ? 'bg-green-100 text-green-800 line-through' : 'bg-gray-50 text-gray-600'} ${adminUnlocked ? 'cursor-pointer' : ''}`}>
                        <span className="flex-1">{it.points}</span>
                        {it.done && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-green-600 text-white no-underline">✓ 완료</span>}
                      </div>
                    ) : (
                      <div key={it.id} className={`text-xs text-gray-600 bg-gray-50 rounded-md px-2 py-1.5 ${adminUnlocked ? 'cursor-grab active:cursor-grabbing' : ''}`}
                        draggable={adminUnlocked} onDragStart={e => onDragStartItems(e, sel, [it])} onDragEnd={() => setDragOver(null)}
                        title={adminUnlocked ? '끌어서 달력의 다른 날짜로 옮길 수 있습니다(주기 안에서만)' : ''}>
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
                        {it._shifted && <div className="mt-0.5 text-[10px] font-semibold text-amber-600">↪ {it._shifted}이라 {md(it.moves?.[it._base] || it._base)}에서 자동으로 옮김</div>}
                        {!it._shifted && it._moved && (
                          <div className="mt-0.5 text-[10px] font-semibold text-amber-600 flex items-center gap-1">↪ {md(it._base)}에서 옮김
                            {adminUnlocked && <button type="button" onClick={() => handleDrop(it._base, dragPayload(sel, [it]))} className="text-blue-600 font-normal hover:underline">원래 날짜로</button>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {calSettingsOpen && (
        <CalendarSettingsDialog weekStart={weekStart} onChangeWeekStart={changeWeekStart} holidayDefs={holidayDefs} setHolidayDefs={setHolidayDefs}
          year={ym.y} onClose={() => setCalSettingsOpen(false)}
          onChanged={() => { loadZones(); syncAfterChange().catch(() => {}); }} />
      )}
      {mgrOpen && (
        <WaterPlanManager items={items} waterZones={waterZones} adminUnlocked={adminUnlocked}
          onAdd={(type) => openDlg(null, sel, type)} onEdit={(it) => openDlg(it)} onRemove={removeItem} onSaveZone={saveZone} onClose={() => setMgrOpen(false)} />
      )}

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

      {/* 알림창 — 주기를 벗어나거나 공휴일로 옮기려 할 때 */}
      {alertDlg && (
        <div className="fixed inset-0 z-[410] flex items-center justify-center bg-black/40" onClick={() => setAlertDlg(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[26rem] max-w-[95vw] p-5 border-t-4 border-amber-400" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-amber-700 mb-2">⚠ {alertDlg.title}</h3>
            <p className="text-sm text-gray-700 whitespace-pre-line mb-4">{alertDlg.message}</p>
            <div className="flex justify-end">
              <button type="button" autoFocus onClick={() => setAlertDlg(null)} className="px-4 py-2 text-sm font-semibold text-white bg-amber-500 rounded-lg hover:bg-amber-600">확인</button>
            </div>
          </div>
        </div>
      )}

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
