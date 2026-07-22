// 교정 항목의 "대표" 교정정보 계산 — 연도별 교정내역(history)이 있으면 그 중 가장
// 최근(교정일 기준) 내역을 대표로 쓰고, 없으면 항목 자체의 상단 필드를 그대로 쓴다.
// Calibration.jsx(교정관리 화면)와 동일한 기준으로 계산해야 대시보드·오늘의 할일·
// 달력이 항상 최신 교정일을 보여준다 (연도별 내역만 갱신하고 상단 필드는 그대로
// 남아있는 옛 항목이 있으므로 상단 필드만 읽으면 오래된 값이 표시된다).
function pad2(n) { return String(n).padStart(2, '0'); }

// 차기교정일 = 교정일 +1년 -1일
export function nextCalibDate(calibStr) {
  if (!calibStr) return '';
  const d = new Date(calibStr + 'T00:00:00');
  d.setFullYear(d.getFullYear() + 1);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function latestCalibHistory(item) {
  const h = item?.history || [];
  if (!h.length) return null;
  return [...h].sort((a, b) => (b.calib_date || '').localeCompare(a.calib_date || '') || (b.year || 0) - (a.year || 0))[0];
}

export function effectiveCalib(item) {
  const lh = latestCalibHistory(item);
  if (!lh) return { cert_no: item?.cert_no, calib_date: item?.calib_date, next_calib_date: item?.next_calib_date };
  return {
    cert_no: lh.cert_no || item.cert_no,
    calib_date: lh.calib_date || item.calib_date,
    next_calib_date: lh.calib_date ? nextCalibDate(lh.calib_date) : (lh.next_calib_date || item.next_calib_date),
  };
}
