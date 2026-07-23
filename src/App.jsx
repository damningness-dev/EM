import { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import Calibration from './components/Calibration';
import AnnualPlan from './components/AnnualPlan';
import ZoneStatus from './components/ZoneStatus';
import ZoneGantt from './components/ZoneGantt';
import TodoToday from './components/TodoToday';
import CalendarView from './components/CalendarView';
import UpdateNotifier from './components/UpdateNotifier';
import SyncChangeNotifier from './components/SyncChangeNotifier';
import SyncControl from './components/SyncControl';
import AdminLock from './components/AdminLock';
import { seedInitialData, fetchScheduleConfig, getAutoStart, setAutoStart, adminIsUnlocked, adminLock } from './lib/api';
import { setScheduleConfig } from './lib/schedule';
import { INITIAL_CALIBRATION, MONITORING_ZONES } from './data/initialData';

const MENU = [
  { id: 'dashboard', label: '대시보드', icon: '📊' },
  { id: 'todo', label: '오늘의 할일', icon: '✅' },
  { id: 'calendar', label: '월별 모니터링 일정', icon: '📆' },
  { id: 'status', label: '구역별 현황', icon: '📈' },
  { id: 'gantt',  label: '간트 차트',  icon: '📊' },
  { id: 'annual', label: '연간 계획 (AHU)', icon: '🔧' },
  { id: 'calibration', label: '교정 관리', icon: '⚙️' },
];

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const [ready, setReady] = useState(false);
  const [autoStart, setAutoStartState] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [showAdminLock, setShowAdminLock] = useState(false);

  useEffect(() => {
    if (window.electronAPI) getAutoStart().then(setAutoStartState).catch(() => {});
  }, []);

  useEffect(() => {
    adminIsUnlocked().then(setAdminUnlocked).catch(() => {});
    if (window.electronAPI?.onAdminUnlockChanged) {
      return window.electronAPI.onAdminUnlockChanged(setAdminUnlocked);
    }
  }, []);

  async function handleLockAdmin() {
    await adminLock();
  }

  async function toggleAutoStart(enabled) {
    setAutoStartState(enabled);
    try { await setAutoStart(enabled); } catch { /* ignore */ }
  }

  useEffect(() => {
    seedInitialData(INITIAL_CALIBRATION, MONITORING_ZONES)
      .then(() => fetchScheduleConfig())
      .then(cfg => { if (cfg) setScheduleConfig(cfg); })
      .then(() => setReady(true))
      .catch(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-400 text-sm">데이터 초기화 중...</p>
      </div>
    );
  }

  const currentMenu = MENU.find(m => m.id === page);

  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/40 z-20 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={`fixed lg:static inset-y-0 left-0 z-30 w-64 bg-gray-900 text-white flex flex-col transform transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="px-5 py-5 border-b border-gray-700">
          <div className="text-2xl mb-1">🧪</div>
          <h1 className="text-base font-bold text-white leading-tight">환경 모니터링</h1>
          <p className="text-xs text-gray-400 mt-0.5">EM Management System</p>
        </div>

        <nav className="flex-1 py-4 overflow-y-auto">
          {MENU.map(item => (
            <button
              key={item.id}
              onClick={() => { setPage(item.id); setSidebarOpen(false); }}
              className={`w-full text-left px-5 py-3 flex items-center gap-3 text-sm transition-colors ${
                page === item.id ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <UpdateNotifier />
        <SyncChangeNotifier />

        {/* 관리자 잠금 — 비밀번호를 입력해야 일정 변경/일정 관리가 가능 */}
        <div className="px-4 py-3 border-t border-gray-700">
          {adminUnlocked ? (
            <button onClick={handleLockAdmin}
              className="w-full py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-xs text-white font-medium">
              🔓 관리자 모드 (클릭하여 잠그기)
            </button>
          ) : (
            <button onClick={() => setShowAdminLock(true)}
              className="w-full py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300">
              🔒 관리자 잠금 해제
            </button>
          )}
        </div>

        {window.electronAPI && (
          <label className="mx-4 mb-2 flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
            <input type="checkbox" checked={autoStart} onChange={e => toggleAutoStart(e.target.checked)} />
            부팅 시 자동 시작 (백그라운드 알람)
          </label>
        )}

        <SyncControl adminUnlocked={adminUnlocked} />
      </aside>

      {showAdminLock && (
        <AdminLock
          onClose={() => setShowAdminLock(false)}
          onUnlocked={() => setShowAdminLock(false)}
        />
      )}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 lg:hidden">
          <button onClick={() => setSidebarOpen(true)} className="p-1.5 rounded-lg hover:bg-gray-100">
            <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="font-semibold text-gray-800">{currentMenu?.icon} {currentMenu?.label}</span>
        </header>

        <main className="flex-1 overflow-y-auto">
          {page === 'dashboard' && <Dashboard year={year} />}
          {page === 'todo' && <TodoToday />}
          {page === 'calendar' && <CalendarView year={year} onYearChange={setYear} adminUnlocked={adminUnlocked} />}
          {page === 'status' && <ZoneStatus year={year} onYearChange={setYear} />}
          {page === 'gantt'  && <ZoneGantt  year={year} onYearChange={setYear} />}
          {page === 'annual' && <AnnualPlan year={year} onYearChange={setYear} />}
          {page === 'calibration' && <Calibration />}
        </main>
      </div>
    </div>
  );
}
