import { useState } from 'react';
import { upsertHoliday, deleteHoliday } from '../lib/api';
import { lunarToSolar } from '../lib/lunar';

// 달력 설정 창 — 주 시작 요일 + 공휴일 관리. 월별 모니터링 일정과 용수모니터링 일정이 같은 창·같은 공휴일 데이터를 쓴다.
// 로그인(관리자 잠금) 없이도 누구나 열고 바꿀 수 있다(일정 자체가 아니라 달력 표시 기준이므로).
//   weekStart: 'sun' | 'mon', onChangeWeekStart(value), holidayDefs/setHolidayDefs: 공휴일 목록, year: 음력 변환 기준 연도
//   onChanged: 공휴일을 추가·수정·삭제한 뒤 호출(용수 일정처럼 공휴일로 일정이 다시 계산되는 화면에서 사용)
export default function CalendarSettingsDialog({ weekStart, onChangeWeekStart, holidayDefs, setHolidayDefs, year, onClose, onChanged }) {
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayName, setNewHolidayName] = useState('');
  const [newHolidayRepeat, setNewHolidayRepeat] = useState(false);
  const [newHolidaySubstitute, setNewHolidaySubstitute] = useState(false);
  const [newHolidayLunar, setNewHolidayLunar] = useState(false);
  const [newHolidayBridgeBefore, setNewHolidayBridgeBefore] = useState(0);
  const [newHolidayBridgeAfter, setNewHolidayBridgeAfter] = useState(0);
  const [newHolidayRepeatType, setNewHolidayRepeatType] = useState('yearly');
  const [newHolidayNth, setNewHolidayNth] = useState(1);
  const [newHolidayDow, setNewHolidayDow] = useState(1);
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40" onClick={() => onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-xl w-full mx-4 p-6 flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-bold text-gray-900 mb-1">🗓 달력 설정</h3>
        <p className="text-xs text-gray-400 mb-4">달력의 시작 요일 및 공휴일을 관리합니다.</p>
        <label className="block text-xs font-semibold text-gray-600 mb-2">주 시작 요일</label>
        <div className="grid grid-cols-2 gap-2 mb-5">
          {[['sun', '일요일 시작'], ['mon', '월요일 시작']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => onChangeWeekStart(val)}
              className={`py-2.5 text-sm font-medium rounded-lg border transition-colors ${
                weekStart === val
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >{label}</button>
          ))}
        </div>

        {/* 공휴일 관리 */}
        <div className="border-t border-gray-100 pt-4 flex flex-col min-h-0">
          <h4 className="text-sm font-semibold text-gray-700 mb-3">공휴일 관리</h4>
          {/* 추가 폼 */}
          <div className="space-y-2 shrink-0 mb-3">
            <div className="flex gap-2 items-start">
              <input type="date" value={newHolidayDate} onChange={e => setNewHolidayDate(e.target.value)}
                className="text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-32 shrink-0" />
              <input type="text" placeholder="공휴일 이름" value={newHolidayName} onChange={e => setNewHolidayName(e.target.value)}
                className="flex-1 text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <button
                onClick={async () => {
                  if (!newHolidayDate || !newHolidayName.trim()) return;
                  // 음력은 매년 반복만 의미가 있으므로 yearly로 고정
                  const repeat = newHolidayLunar
                    ? (newHolidayRepeat ? { type: 'yearly' } : null)
                    : (newHolidayRepeat
                        ? (newHolidayRepeatType === 'nth-weekday'
                            ? { type: 'nth-weekday', nth: newHolidayNth, dow: newHolidayDow }
                            : { type: newHolidayRepeatType })
                        : null);
                  const h = { date: newHolidayLunar ? 'L' + newHolidayDate : newHolidayDate, name: newHolidayName.trim(), repeat, substitute: newHolidaySubstitute, lunar: newHolidayLunar, bridgeBefore: Math.max(0, parseInt(newHolidayBridgeBefore) || 0), bridgeAfter: Math.max(0, parseInt(newHolidayBridgeAfter) || 0) };
                  const saved = await upsertHoliday(h); onChanged?.();
                  setHolidayDefs(prev => {
                    const idx = prev.findIndex(x => x.date === saved.date);
                    return idx >= 0 ? prev.map((x,i) => i === idx ? saved : x) : [...prev, saved];
                  });
                  setNewHolidayDate(''); setNewHolidayName(''); setNewHolidayRepeat(false); setNewHolidaySubstitute(false); setNewHolidayLunar(false); setNewHolidayBridgeBefore(0); setNewHolidayBridgeAfter(0);
                }}
                className="px-2.5 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 shrink-0"
              >추가</button>
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                <input type="checkbox" checked={newHolidayRepeat} onChange={e => setNewHolidayRepeat(e.target.checked)} className="rounded" />
                반복
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                <input type="checkbox" checked={newHolidayLunar} onChange={e => setNewHolidayLunar(e.target.checked)} className="rounded" />
                음력
                <span className="text-[10px] text-gray-400">(설날·추석 등)</span>
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                <input type="checkbox" checked={newHolidaySubstitute} onChange={e => setNewHolidaySubstitute(e.target.checked)} className="rounded" />
                대체공휴일
                <span className="text-[10px] text-gray-400">(주말이면 다음 평일 휴무)</span>
              </label>
            </div>
            {/* 연휴 (기준일 앞/뒤 포함 일수) */}
            <div className="flex items-center gap-2 flex-wrap text-xs text-gray-600">
              <span className="text-gray-500">연휴</span>
              <label className="flex items-center gap-1">앞
                <input type="number" min="0" max="10" value={newHolidayBridgeBefore}
                  onChange={e => setNewHolidayBridgeBefore(Math.max(0, parseInt(e.target.value) || 0))}
                  className="w-12 border border-gray-200 rounded px-1.5 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />일
              </label>
              <label className="flex items-center gap-1">뒤
                <input type="number" min="0" max="10" value={newHolidayBridgeAfter}
                  onChange={e => setNewHolidayBridgeAfter(Math.max(0, parseInt(e.target.value) || 0))}
                  className="w-12 border border-gray-200 rounded px-1.5 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />일
              </label>
              <span className="text-[10px] text-gray-400">기준일 앞/뒤를 "이름 연휴"로 포함 (앞뒤 모두 가능)</span>
            </div>
            {newHolidayLunar && newHolidayDate && (() => {
              const [, lmm, ldd] = newHolidayDate.split('-').map(Number);
              const sol = lunarToSolar(year, lmm, ldd);
              return (
                <div className="text-[10px] text-amber-600 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                  음력 {lmm}월 {ldd}일 → {year}년 양력 {sol ? `${sol.getMonth() + 1}월 ${sol.getDate()}일` : '변환 불가'}
                  {newHolidayRepeat ? ' (매년 음력 반복)' : ''}
                </div>
              );
            })()}
            {newHolidayRepeat && !newHolidayLunar && (
              <div className="flex items-center gap-2 flex-wrap">
                <select value={newHolidayRepeatType} onChange={e => setNewHolidayRepeatType(e.target.value)}
                  className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                  <option value="yearly">매년</option>
                  <option value="monthly">매월</option>
                  <option value="nth-weekday">N번째 요일</option>
                </select>
                {newHolidayRepeatType === 'nth-weekday' && (
                  <>
                    <select value={newHolidayNth} onChange={e => setNewHolidayNth(Number(e.target.value))}
                      className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value={1}>1번째</option>
                      <option value={2}>2번째</option>
                      <option value={3}>3번째</option>
                      <option value={4}>4번째</option>
                      <option value={5}>마지막</option>
                    </select>
                    <select value={newHolidayDow} onChange={e => setNewHolidayDow(Number(e.target.value))}
                      className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                      {['일','월','화','수','목','금','토'].map((d,i) => <option key={i} value={i}>{d}요일</option>)}
                    </select>
                  </>
                )}
                {newHolidayRepeatType === 'yearly' && newHolidayDate && (
                  <span className="text-[10px] text-gray-400">매년 {newHolidayDate.slice(5)} 반복</span>
                )}
                {newHolidayRepeatType === 'monthly' && newHolidayDate && (
                  <span className="text-[10px] text-gray-400">매월 {Number(newHolidayDate.slice(8))}일 반복</span>
                )}
              </div>
            )}
          </div>
          {/* 공휴일 목록 */}
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded-lg" style={{ maxHeight: 200 }}>
            {holidayDefs.length === 0 && (
              <p className="px-4 py-4 text-sm text-gray-400">등록된 공휴일이 없습니다.</p>
            )}
            {[...holidayDefs].sort((a,b) => a.date.localeCompare(b.date)).map(h => {
              const lraw = h.lunar ? h.date.replace(/^L/, '') : h.date;
              const lm = h.lunar ? Number(lraw.slice(5,7)) : 0;
              const ld = h.lunar ? Number(lraw.slice(8)) : 0;
              const repeatLabel = !h.repeat || h.repeat.type === 'none' ? null
                : h.lunar ? `매년 음력 ${lm}월 ${ld}일`
                : h.repeat.type === 'yearly' ? `매년 ${h.date.slice(5)}`
                : h.repeat.type === 'monthly' ? `매월 ${Number(h.date.slice(8))}일`
                : `매월 ${['','1번째','2번째','3번째','4번째','마지막'][h.repeat.nth]}${ ['일','월','화','수','목','금','토'][h.repeat.dow]}요일`;
              const lunarSol = h.lunar ? lunarToSolar(year, lm, ld, !!h.leapMonth) : null;
              const dateLabel = h.lunar ? `음력 ${lm}.${ld}` : h.date;
              return (
                <div key={h.date} className="flex items-center gap-2 px-3 py-2">
                  <span className="text-xs text-gray-500 w-24 shrink-0">
                    {dateLabel}
                    {lunarSol && <span className="block text-[10px] text-amber-600">→{year} {lunarSol.getMonth() + 1}.{lunarSol.getDate()}</span>}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-red-600 font-medium">{h.name}</span>
                    {h.lunar && <span className="ml-1.5 text-[10px] text-amber-600 bg-amber-50 px-1 py-0.5 rounded">음력</span>}
                    {repeatLabel && <span className="ml-1.5 text-[10px] text-blue-500 bg-blue-50 px-1 py-0.5 rounded">{repeatLabel}</span>}
                    {(h.bridgeBefore > 0 || h.bridgeAfter > 0) && <span className="ml-1.5 text-[10px] text-orange-600 bg-orange-50 px-1 py-0.5 rounded">연휴 {h.bridgeBefore > 0 ? `앞${h.bridgeBefore}` : ''}{h.bridgeBefore > 0 && h.bridgeAfter > 0 ? '·' : ''}{h.bridgeAfter > 0 ? `뒤${h.bridgeAfter}` : ''}</span>}
                    {h.substitute && <span className="ml-1.5 text-[10px] text-emerald-600 bg-emerald-50 px-1 py-0.5 rounded">대체공휴일</span>}
                  </div>
                  <label className="flex items-center gap-1 text-[10px] text-gray-500 cursor-pointer select-none shrink-0" title="주말이면 다음 평일을 대체공휴일로 지정">
                    <input type="checkbox" checked={!!h.substitute} onChange={async e => {
                      const updated = { ...h, substitute: e.target.checked };
                      await upsertHoliday(updated); onChanged?.();
                      setHolidayDefs(prev => prev.map(x => x.date === h.date ? updated : x));
                    }} className="rounded" />
                    대체
                  </label>
                  <button onClick={async () => {
                    await deleteHoliday(h.date); onChanged?.();
                    setHolidayDefs(prev => prev.filter(x => x.date !== h.date));
                  }} className="text-xs text-gray-400 hover:text-red-500 shrink-0">✕</button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end mt-4 shrink-0">
          <button onClick={() => onClose()}
            className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">닫기</button>
        </div>
      </div>
    </div>
  );
}
