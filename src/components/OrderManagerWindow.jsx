import { useState, useEffect } from 'react';
import OrderGroupManager from './OrderGroupManager';
import { fetchZones, fetchGroups, fetchHolidays, fetchScheduleConfig, backfillZonePointsFromMonitoring } from '../lib/api';
import { setScheduleConfig } from '../lib/schedule';

/**
 * 별도 Electron 창(항상 위)에서 단독 렌더링되는 순서/그룹·측정주기 관리 화면.
 * main.jsx 에서 location.hash === '#order-manager' 일 때 사용.
 */
export default function OrderManagerWindow() {
  const [data, setData] = useState(null);

  useEffect(() => {
    const year = new Date().getFullYear();
    Promise.all([fetchZones(), fetchGroups(), fetchHolidays(), fetchScheduleConfig()])
      .then(async ([zns, grps, hols, cfg]) => {
        if (cfg) setScheduleConfig(cfg);
        // 월별 모니터링 측정포인트 backfill
        let zones = zns;
        try {
          const r = await backfillZonePointsFromMonitoring(zns, [year - 1, year, year + 1]);
          zones = r.zones;
        } catch { /* ignore */ }
        setData({ zones, groups: grps, holidayDefs: hols });
      })
      .catch(() => setData({ zones: [], groups: [], holidayDefs: [] }));
  }, []);

  function close() {
    if (window.electronAPI?.closeOrderManager) window.electronAPI.closeOrderManager();
    else window.close();
  }

  function handleSaved() {
    // 메인 창에 데이터 변경 알림 후 닫기
    if (window.electronAPI?.notifyDataChanged) window.electronAPI.notifyDataChanged();
    close();
  }

  if (!data) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-white">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-white overflow-hidden">
      <OrderGroupManager
        docked
        zones={data.zones}
        groups={data.groups}
        holidayDefs={data.holidayDefs}
        onClose={close}
        onSaved={handleSaved}
      />
    </div>
  );
}
