import { useState, useEffect } from 'react';

// 할일 알람 인앱 팝업 — 메인 프로세스의 'todo:alarm' 이벤트를 받아 표시한다.
// 윈도우 네이티브 알림이 차단되어도 확실히 보이도록 하는 폴백.
export default function AlarmPopup() {
  const [alarms, setAlarms] = useState([]); // 표시중인 알람 목록

  useEffect(() => {
    if (!window.electronAPI?.onTodoAlarm) return;
    return window.electronAPI.onTodoAlarm((todo) => {
      setAlarms(prev => prev.some(a => a.id === todo.id) ? prev : [...prev, todo]);
      // 짧은 비프음 (가능한 환경에서만)
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          const o = ctx.createOscillator(); const g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.frequency.value = 880; g.gain.value = 0.08;
          o.start(); o.stop(ctx.currentTime + 0.35);
        }
      } catch { /* ignore */ }
    });
  }, []);

  if (alarms.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/40 pointer-events-none">
      <div className="flex flex-col gap-3 pointer-events-auto">
        {alarms.map(a => (
          <div key={a.id} className="bg-white rounded-2xl shadow-2xl border-2 border-orange-400 w-80 p-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-2xl">⏰</span>
              <span className="text-sm font-bold text-orange-600">할일 알람 {a.time && `· ${a.time}`}</span>
            </div>
            <p className="text-base font-semibold text-gray-900 break-words">{a.title}</p>
            {a.note && <p className="text-sm text-gray-500 mt-1 break-words">{a.note}</p>}
            <button
              onClick={() => setAlarms(prev => prev.filter(x => x.id !== a.id))}
              className="mt-4 w-full py-2 bg-orange-500 text-white rounded-lg text-sm font-semibold hover:bg-orange-600"
            >확인</button>
          </div>
        ))}
      </div>
    </div>
  );
}
