import { useState } from 'react';
import { WATER_TYPES, DOW_KR, repeatLabel } from '../lib/waterPlan';

// 용수모니터링 '일정 관리' 창 — 월별 모니터링 일정의 일정 관리 창처럼, 용수 일정을 표로 보면서 추가·수정·삭제한다.
// 탭은 첨부 엑셀의 시트 구성(주간용수 WFI·UF / PW / PS)을 따르고, 월별 모니터링에서 옮겨 온 '용수 구역'(구역별 주기로 계산되는
// 일정)은 시작일·등급을 여기서 고친다. 맨 위 요약은 엑셀의 '하루 ○개'처럼 요일·날짜별 채취 개수를 보여준다.
const TABS = [
  { key: 'WFI', label: 'WFI·HWFI·UF', types: ['WFI', 'HWFI', 'UF'], color: 'bg-sky-600' },
  { key: 'PW', label: 'PW (정제수)', types: ['PW'], color: 'bg-lime-600' },
  { key: 'PS', label: 'PS (순수증기)', types: ['PS'], color: 'bg-pink-500' },
  { key: 'ETC', label: '기타', types: ['기타'], color: 'bg-gray-500' },
  { key: 'ZONE', label: '용수 구역', types: [], color: 'bg-teal-600' },
];
const GRADES = ['P1', 'P2', 'P3', '유지관리'];

export default function WaterPlanManager({ items, waterZones, adminUnlocked, onAdd, onEdit, onRemove, onSaveZone, onClose }) {
  const [tab, setTab] = useState('WFI');
  const [q, setQ] = useState('');
  const cur = TABS.find(t => t.key === tab);
  const list = items.filter(it => cur.types.includes(it.type));
  const dowOf = (ds) => new Date(`${ds}T00:00:00`).getDay();
  // 정렬: 매주·매월은 요일 → 구역, 한 번은 날짜 → 구역
  const sorted = [...list].filter(it => !q.trim() || `${it.area} ${it.points} ${it.note}`.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => {
    const ka = a.repeat === 'once' ? `1${a.date}` : `0${dowOf(a.date)}`, kb = b.repeat === 'once' ? `1${b.date}` : `0${dowOf(b.date)}`;
    return ka.localeCompare(kb) || (a.area || '').localeCompare(b.area || '') || (a.points || '').localeCompare(b.points || '');
  });
  // 요일·날짜별 채취 개수
  const sums = [];
  const weekly = {}, once = {};
  list.forEach(it => { const n = Number(it.count) || 0; if (it.repeat === 'once') once[it.date] = (once[it.date] || 0) + n; else { const k = `${DOW_KR[dowOf(it.date)]}${it.repeat === 'monthly' ? '(월)' : ''}`; weekly[k] = (weekly[k] || 0) + n; } });
  Object.entries(weekly).forEach(([k, n]) => sums.push({ key: `w${k}`, label: `매주 ${k}`, n }));
  Object.entries(once).sort(([a], [b]) => a.localeCompare(b)).forEach(([d, n]) => sums.push({ key: `o${d}`, label: `${d.slice(5, 7)}/${d.slice(8, 10)}(${DOW_KR[dowOf(d)]})`, n }));
  const total = list.reduce((s, it) => s + (Number(it.count) || 0), 0);

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[72rem] max-w-[96vw] h-[86vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-gray-100 flex items-center gap-3">
          <h3 className="text-base font-bold text-gray-900">⚙ 용수모니터링 일정 관리</h3>
          <span className="text-xs text-gray-400">엑셀 시트(주간용수 WFI·UF / PW / PS) 구성으로 일정을 보고 고칩니다{adminUnlocked ? '' : ' · 보기 전용'}</span>
          <button type="button" onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-700 text-lg leading-none px-2" title="닫기">✕</button>
        </div>
        <div className="px-5 pt-3 flex items-center gap-1.5 flex-wrap">
          {TABS.map(t => {
            const n = t.key === 'ZONE' ? waterZones.length : items.filter(it => t.types.includes(it.type)).length;
            return (
              <button key={t.key} type="button" onClick={() => setTab(t.key)}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium border ${tab === t.key ? `${t.color} text-white border-transparent` : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                {t.label} <span className={`text-[11px] ${tab === t.key ? 'text-white/80' : 'text-gray-400'}`}>{n}</span>
              </button>
            );
          })}
          {tab !== 'ZONE' && (
            <div className="ml-auto flex items-center gap-2">
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="구역·사용점 검색" spellCheck={false} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-48" />
              {adminUnlocked && <button type="button" onClick={() => onAdd(cur.types[0])} className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">+ {cur.label} 일정 추가</button>}
            </div>
          )}
        </div>

        {tab !== 'ZONE' ? (
          <>
            <div className="px-5 py-2.5 flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-gray-500 font-semibold">채취 개수</span>
              {sums.length === 0 ? <span className="text-gray-300">일정 없음</span> : sums.map(s => (
                <span key={s.key} className={`px-2 py-0.5 rounded-full border ${WATER_TYPES[cur.types[0]]?.chip}`}>{s.label} <b className="tabular-nums">{s.n}개</b></span>
              ))}
              <span className="ml-auto text-gray-400">합계 {total}개 · {list.length}건</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4">
              <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                <thead className="bg-gray-50 text-xs text-gray-500 sticky top-0">
                  <tr>
                    <th className="text-left font-medium px-3 py-2 w-40">구역</th>
                    <th className="text-left font-medium px-3 py-2">사용점 번호</th>
                    <th className="font-medium px-2 py-2 w-16">개수</th>
                    <th className="text-left font-medium px-3 py-2 w-44">반복 · 날짜</th>
                    <th className="text-left font-medium px-3 py-2 w-40">메모</th>
                    {adminUnlocked && <th className="w-24" />}
                  </tr>
                </thead>
                <tbody>
                  {sorted.length === 0 && <tr><td colSpan={adminUnlocked ? 6 : 5} className="px-3 py-8 text-center text-gray-300">일정이 없습니다.</td></tr>}
                  {sorted.map((it, i) => {
                    const first = i === 0 || sorted[i - 1].area !== it.area || sorted[i - 1].date !== it.date || sorted[i - 1].repeat !== it.repeat;
                    return (
                      <tr key={it.id} className={`border-t border-gray-100 hover:bg-gray-50 ${first ? 'border-t-gray-200' : ''}`}>
                        <td className="px-3 py-1.5 align-top">{first && <span className="inline-flex items-center gap-1.5"><span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${WATER_TYPES[it.type]?.chip}`}>{it.type}</span><span className="font-medium text-gray-800">{it.area || '—'}</span></span>}</td>
                        <td className="px-3 py-1.5 text-gray-600 break-words">{it.points || '—'}</td>
                        <td className="px-2 py-1.5 text-center font-semibold tabular-nums">{it.count}</td>
                        <td className="px-3 py-1.5 text-xs text-gray-500">{repeatLabel(it)}{it.repeat !== 'once' ? ` · ${it.date.slice(5, 7)}/${it.date.slice(8, 10)}부터` : `${it.date ? ` · ${it.date.slice(5, 7)}/${it.date.slice(8, 10)}` : ''}`}</td>
                        <td className="px-3 py-1.5 text-xs text-gray-400">{it.note}</td>
                        {adminUnlocked && (
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">
                            <button type="button" onClick={() => onEdit(it)} className="text-xs text-blue-600 hover:underline mr-2">수정</button>
                            <button type="button" onClick={() => onRemove(it)} className="text-xs text-red-500 hover:underline">삭제</button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
            <p className="text-xs text-gray-400 mb-2">월별 모니터링 일정에서 옮겨 온 용수 구역입니다. 구역별 측정 주기(등급)와 시작일로 달력 일정이 계산됩니다.</p>
            <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr><th className="text-left font-medium px-3 py-2 w-24">분류</th><th className="text-left font-medium px-3 py-2">구역명</th><th className="font-medium px-2 py-2 w-32">등급</th><th className="font-medium px-2 py-2 w-40">시작일</th><th className="font-medium px-2 py-2 w-32">종료 예정일</th></tr>
              </thead>
              <tbody>
                {waterZones.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-300">용수 구역이 없습니다.</td></tr>}
                {waterZones.map(({ zone, end }) => (
                  <tr key={zone.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-1.5 text-gray-500 text-xs">{zone.category}</td>
                    <td className="px-3 py-1.5 font-medium text-gray-800">{zone.name}</td>
                    <td className="px-2 py-1.5 text-center">
                      <select value={zone.grade || ''} disabled={!adminUnlocked} onChange={e => onSaveZone(zone, { grade: e.target.value })} className="border border-gray-200 rounded px-1.5 py-1 text-sm disabled:bg-transparent disabled:border-transparent">
                        {!GRADES.includes(zone.grade) && <option value={zone.grade || ''}>{zone.grade || '—'}</option>}
                        {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <input type="date" defaultValue={zone.schedule_start || ''} disabled={!adminUnlocked} onBlur={e => { if (e.target.value && e.target.value !== zone.schedule_start) onSaveZone(zone, { schedule_start: e.target.value }); }}
                        className="border border-gray-200 rounded px-1.5 py-1 text-sm disabled:bg-transparent disabled:border-transparent" />
                    </td>
                    <td className="px-2 py-1.5 text-center text-xs text-gray-500 tabular-nums">{end || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
