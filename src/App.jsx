import { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import Calibration from './components/Calibration';
import UsagePoints from './components/UsagePoints';
import WeeklyDuty from './components/WeeklyDuty';
import AnnualPlan from './components/AnnualPlan';
import ZoneStatus from './components/ZoneStatus';
import ZoneGantt from './components/ZoneGantt';
import TodoToday from './components/TodoToday';
import CalendarView from './components/CalendarView';
import UpdateNotifier from './components/UpdateNotifier';
import SyncChangeNotifier from './components/SyncChangeNotifier';
import SyncControl from './components/SyncControl';
import Login from './components/Login';
import MemberManager from './components/MemberManager';
import ChangePasswordModal from './components/ChangePasswordModal';
import { seedInitialData, fetchScheduleConfig, getAutoStart, setAutoStart, adminIsUnlocked, setCurrentMemberOnMain, fetchGuestAccess, memberChangePassword, fetchMembers } from './lib/api';
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
  { id: 'usagepoints', label: '업무별 진행상황', icon: '📍' },
  { id: 'weeklyduty', label: '주간근무', icon: '🗓️' },
];

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const [ready, setReady] = useState(false);
  const [autoStart, setAutoStartState] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [showMemberChangePassword, setShowMemberChangePassword] = useState(false);
  const [scheduleJumpTarget, setScheduleJumpTarget] = useState(null); // {date, zoneId, num} — 구역별 현황 등에서 특정 일정으로 이동

  // 로그인(선택 사항) — 로그인하지 않으면 "권한 설정"에서 정한 게스트 메뉴(또는
  // 전체 메뉴)가 보인다. 로그인하면 그 계정에 허용한 탭만 보이도록 사이드바 메뉴가
  // 좁혀지고, 계정에 관리자 권한(isAdmin)이 있으면 로그인 자체로 편집 권한도 함께
  // 열린다 — 예전의 별도 "관리자 잠금 해제"는 로그인 하나로 합쳐졌다.
  // "이 PC에서 자동 로그인"을 체크했을 때만 localStorage에 남겨 다음 실행 때도 유지한다.
  const [currentMember, setCurrentMember] = useState(() => {
    try { return JSON.parse(localStorage.getItem('em-current-member')) || null; } catch { return null; }
  });
  const [showLogin, setShowLogin] = useState(false);
  const [showMemberManager, setShowMemberManager] = useState(false);

  // 로그인하지 않았을 때 보이는 메뉴 제한(관리자가 "권한 설정"에서 지정) — null이면
  // 제한 없음(지금까지처럼 전체 메뉴).
  const [guestAllowedTabs, setGuestAllowedTabs] = useState(null);
  function reloadGuestAccess() {
    fetchGuestAccess().then(c => setGuestAllowedTabs(c?.allowedTabs || null)).catch(() => {});
  }
  useEffect(() => { reloadGuestAccess(); }, []);

  const visibleMenu = currentMember
    ? MENU.filter(m => (currentMember.allowedTabs || []).includes(m.id))
    : (guestAllowedTabs ? MENU.filter(m => guestAllowedTabs.includes(m.id)) : MENU);

  function handleLoggedIn(member, remember) {
    setCurrentMember(member);
    try {
      if (remember) localStorage.setItem('em-current-member', JSON.stringify(member));
      else localStorage.removeItem('em-current-member');
    } catch { /* ignore */ }
    setShowLogin(false);
    if (!(member.allowedTabs || []).includes(page)) setPage((member.allowedTabs || [])[0] || 'dashboard');
  }
  function handleLogout() {
    setCurrentMember(null);
    try { localStorage.removeItem('em-current-member'); } catch { /* ignore */ }
  }

  // 권한 설정에서 지금 로그인한 계정 자신의 allowedTabs/isAdmin을 바꿔도, 로그인할
  // 때 저장해둔 currentMember는 자동으로 갱신되지 않아 메뉴가 그대로였다 —
  // "권한 설정" 창을 닫을 때마다 서버 최신 값으로 다시 맞춰준다.
  function refreshCurrentMember() {
    if (!currentMember) return;
    fetchMembers().then(list => {
      const fresh = (list || []).find(m => m.id === currentMember.id);
      if (!fresh) { handleLogout(); return; } // 계정이 삭제된 경우
      const updated = { id: fresh.id, username: fresh.username, allowedTabs: fresh.allowedTabs || [], isAdmin: !!fresh.isAdmin };
      setCurrentMember(updated);
      try {
        if (localStorage.getItem('em-current-member')) localStorage.setItem('em-current-member', JSON.stringify(updated));
      } catch { /* ignore */ }
    }).catch(() => {});
  }

  // 지금 보이는 메뉴(로그인 계정 권한 또는 비로그인 시 게스트 제한)에 현재 페이지가
  // 없으면 허용된 첫 메뉴로 보정한다 — 앱 시작 시 재수화, 로그인·로그아웃, 관리자가
  // 게스트 제한을 방금 켠 경우 등 모두 여기서 한 번에 처리된다.
  useEffect(() => {
    const allowed = currentMember ? (currentMember.allowedTabs || []) : guestAllowedTabs;
    if (allowed && !allowed.includes(page)) setPage(allowed[0] || 'dashboard');
  }, [currentMember, guestAllowedTabs]);

  // 로그인 상태가 바뀔 때마다(로그인·로그아웃·앱 시작 시 재수화 포함) main
  // 프로세스에 알려준다 — 관리자가 이 계정에 발급해 둔 토큰이 있으면 이 PC의
  // 공유 업로드에 자동으로 쓰인다.
  useEffect(() => {
    setCurrentMemberOnMain(currentMember?.id).catch(() => {});
  }, [currentMember]);

  // 구역별 현황 등 다른 화면에서 특정 측정일을 클릭하면 월별 모니터링 일정으로
  // 이동해 그 날짜를 선택하고 깜빡여 보여준다. 로그인 계정에 그 메뉴가 허용되지
  // 않았다면(구역별 현황만 허용된 계정 등) 이동하지 않는다.
  function jumpToSchedule(date, zoneId, num) {
    if (currentMember && !(currentMember.allowedTabs || []).includes('calendar')) return;
    if (!currentMember && guestAllowedTabs && !guestAllowedTabs.includes('calendar')) return;
    setScheduleJumpTarget({ date, zoneId, num });
    setPage('calendar');
  }

  useEffect(() => {
    if (window.electronAPI) getAutoStart().then(setAutoStartState).catch(() => {});
  }, []);

  useEffect(() => {
    adminIsUnlocked().then(setAdminUnlocked).catch(() => {});
    if (window.electronAPI?.onAdminUnlockChanged) {
      return window.electronAPI.onAdminUnlockChanged(setAdminUnlocked);
    }
  }, []);

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
          {visibleMenu.map(item => (
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

        {/* 로그인 — 관리자 계정으로 로그인하면 그 자체로 편집 권한(관리자 잠금)도 함께 열린다. */}
        <div className="px-4 pt-1.5 pb-3">
          {currentMember ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-xs text-gray-300 truncate">
                {currentMember.isAdmin ? '👑' : '👤'} {currentMember.username}
              </span>
              <button onClick={() => setShowMemberChangePassword(true)} title="비밀번호 변경"
                className="text-[11px] px-1.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300">🔑</button>
              <button onClick={handleLogout} className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300">로그아웃</button>
            </div>
          ) : (
            <button onClick={() => setShowLogin(true)}
              className="w-full py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300">
              🔒 로그인
            </button>
          )}
        </div>

        {adminUnlocked && (
          <div className="px-4 py-3 border-t border-gray-700 space-y-1.5">
            <button onClick={() => setShowMemberManager(true)}
              className="w-full py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300">
              🔐 권한 설정
            </button>
          </div>
        )}

        {window.electronAPI && (
          <label className="mx-4 mb-2 flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
            <input type="checkbox" checked={autoStart} onChange={e => toggleAutoStart(e.target.checked)} />
            부팅 시 자동 시작 (백그라운드 알람)
          </label>
        )}

        <SyncControl adminUnlocked={adminUnlocked} />
      </aside>

      {showLogin && <Login onClose={() => setShowLogin(false)} onLoggedIn={handleLoggedIn} />}

      {showMemberManager && adminUnlocked && (
        <MemberManager menu={MENU} onClose={() => { setShowMemberManager(false); reloadGuestAccess(); refreshCurrentMember(); }} />
      )}

      {showMemberChangePassword && currentMember && (
        <ChangePasswordModal
          title={`${currentMember.username} 비밀번호 변경`}
          onSubmit={(oldPassword, newPassword) => memberChangePassword(currentMember.id, oldPassword, newPassword)}
          onClose={ok => { setShowMemberChangePassword(false); if (ok) alert('비밀번호가 변경되었습니다.'); }}
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
          {page === 'todo' && <TodoToday currentMember={currentMember} />}
          {page === 'calendar' && (
            <CalendarView year={year} onYearChange={setYear} adminUnlocked={adminUnlocked}
              currentMember={currentMember}
              jumpTarget={scheduleJumpTarget} onJumpTargetConsumed={() => setScheduleJumpTarget(null)} />
          )}
          {page === 'status' && <ZoneStatus year={year} onYearChange={setYear} onJumpToSchedule={jumpToSchedule} />}
          {page === 'gantt'  && <ZoneGantt  year={year} onYearChange={setYear} />}
          {page === 'annual' && <AnnualPlan year={year} onYearChange={setYear} />}
          {page === 'calibration' && <Calibration adminUnlocked={adminUnlocked} />}
          {page === 'usagepoints' && <UsagePoints adminUnlocked={adminUnlocked} currentMember={currentMember} />}
          {page === 'weeklyduty' && <WeeklyDuty adminUnlocked={adminUnlocked} />}
        </main>
      </div>
    </div>
  );
}
