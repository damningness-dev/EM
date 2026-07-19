import { useState, useEffect, useRef } from 'react';
import { fetchZones } from '../lib/api';
import { diffZoneSchedules } from '../lib/schedule';

const CHANGE_HISTORY_KEY = 'em-schedule-change-history';
const CHANGE_HISTORY_MAX = 50;
const BASELINE_DEBOUNCE_MS = 400;

// 공유 동기화(Gist)로 다른 PC의 일정 변경이 도착하면(자동 주기 동기화 또는
// "지금 동기화" 버튼) 업데이트 알림과 같은 스타일로 사이드바 왼쪽 아래에
// 변경 내역을 담은 알람을 띄운다. 로컬에서 스스로 변경/저장한 내용은
// (app:dataChanged만 오고 sync:status:updated는 오지 않으므로) 다시 알리지 않는다.
export default function SyncChangeNotifier() {
  const [note, setNote] = useState(null); // { msgs: string[] }
  const zonesRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    fetchZones().then(zns => { zonesRef.current = zns; }).catch(() => {});

    // 로컬에서 발생한 데이터 변경(직접 저장, 별도 창의 일정 관리 저장 등)은
    // 잠시 후 기준선만 조용히 갱신해, 이후 진짜 원격 동기화가 왔을 때
    // 이미 알려준 로컬 변경까지 다시 잡아내지 않도록 한다.
    const refreshBaselineSilently = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        fetchZones().then(zns => { zonesRef.current = zns; }).catch(() => {});
      }, BASELINE_DEBOUNCE_MS);
    };

    const unsubData = window.electronAPI.onDataChanged?.(refreshBaselineSilently);

    const unsubSync = window.electronAPI.onSyncStatus?.((status) => {
      if (status?.type !== 'updated') return;
      // 원격 동기화가 확인되면 대기 중인 조용한 기준선 갱신은 취소하고, 이 동기화가
      // 직접 비교/기준선 갱신을 담당한다 (app:dataChanged가 먼저 도착했더라도 안전).
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      fetchZones().then(newZones => {
        const oldZones = zonesRef.current;
        zonesRef.current = newZones;
        if (!oldZones) return;
        const msgs = diffZoneSchedules(oldZones, newZones);
        if (!msgs.length) return;
        setNote({ msgs });
        try {
          const prev = JSON.parse(localStorage.getItem(CHANGE_HISTORY_KEY)) || [];
          const next = [{ ts: new Date().toISOString(), changes: msgs, source: 'sync' }, ...prev].slice(0, CHANGE_HISTORY_MAX);
          localStorage.setItem(CHANGE_HISTORY_KEY, JSON.stringify(next));
        } catch { /* ignore */ }
      }).catch(() => {});
    });

    return () => {
      unsubData?.();
      unsubSync?.();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  if (!note) return null;

  return (
    <div className="mx-3 mb-3 rounded-lg text-xs overflow-hidden bg-indigo-600">
      <div className="p-3">
        <div className="font-semibold text-white mb-1.5">🔔 일정이 동기화되었습니다</div>
        <ul className="text-white/90 space-y-1 mb-2 max-h-40 overflow-y-auto leading-snug">
          {note.msgs.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
        <button
          onClick={() => setNote(null)}
          className="w-full py-1.5 bg-white text-indigo-700 rounded font-semibold hover:bg-indigo-50 transition-colors"
        >
          확인
        </button>
      </div>
    </div>
  );
}
