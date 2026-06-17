import { useState, useEffect } from 'react';
import { fetchCalibration, fetchZones, fetchMonitoringData, fetchAnnualPlan } from '../lib/api';
import { parseISO, differenceInDays } from 'date-fns';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const MONTH_KR = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

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

export default function TodoToday() {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const dow = DOW[today.getDay()];

  const [calibration, setCalibration] = useState([]);
  const [zones, setZones] = useState([]);
  const [monitoring, setMonitoring] = useState({});
  const [annualPlan, setAnnualPlan] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchCalibration(),
      fetchZones(),
      fetchMonitoringData(year, month),
      fetchAnnualPlan(year),
    ]).then(([cal, zns, mon, plan]) => {
      setCalibration(cal);
      setZones(zns);
      setMonitoring(mon);
      setAnnualPlan(plan);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // 교정 항목 분류
  const overdueCalib = calibration
    .filter(c => c.next_calib_date && dDay(c.next_calib_date) < 0)
    .sort((a, b) => dDay(a.next_calib_date) - dDay(b.next_calib_date));

  const soonCalib = calibration
    .filter(c => c.next_calib_date && dDay(c.next_calib_date) >= 0 && dDay(c.next_calib_date) <= 60)
    .sort((a, b) => dDay(a.next_calib_date) - dDay(b.next_calib_date));

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
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      {/* 헤더 */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">오늘의 할일</h1>
        <p className="text-gray-500 text-sm mt-0.5">
          {year}년 {MONTH_KR[month - 1]} {today.getDate()}일 ({dow}요일)
        </p>
      </div>

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
                <p className="text-xs text-gray-400">S/N: {c.sn || '-'} · 교정번호: {c.cert_no || '-'}</p>
              </div>
              <div className="text-right shrink-0">
                <DayBadge days={dDay(c.next_calib_date)} />
                <p className="text-xs text-gray-400 mt-0.5">{c.next_calib_date}</p>
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
                <DayBadge days={dDay(c.next_calib_date)} />
                <p className="text-xs text-gray-400 mt-0.5">{c.next_calib_date}</p>
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
  );
}
