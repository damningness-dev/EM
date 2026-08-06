import { useState, useMemo } from 'react';
import { exportScheduleExcelTable } from '../lib/api';
import { effectiveCalib, latestCalibHistory } from '../utils/calibUtils';
import { calcDDay, getDDayLabel } from '../utils/dateUtils';

// 교정관리 내역을 엑셀로 내보내는 팝업.
// - "최신 현황": 메인 표와 동일하게 구역별 최신(대표) 교정정보 한 줄씩.
// - "연도별 교정내역 선택": 모든 구역의 연도별 교정내역을 목록으로 펼쳐 보여주고,
//   관리번호·연도로 검색해 좁힌 뒤 체크박스로 원하는 것만 골라 내보낸다.
export default function CalibExport({ data, onClose, onNotice }) {
  const [mode, setMode] = useState('latest'); // 'latest' | 'history'
  const [filterNo, setFilterNo] = useState('');
  const [filterYear, setFilterYear] = useState('');
  const [checked, setChecked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const historyRows = useMemo(() => {
    const rows = [];
    data.forEach(item => {
      (item.history || []).forEach(h => {
        rows.push({
          key: `${item.id}_${h.id}`,
          no: item.no || '', sn: item.sn || '', name: item.name || '',
          year: h.year || '', cert_no: h.cert_no || '',
          calib_date: h.calib_date || '', next_calib_date: h.next_calib_date || '',
          note: h.note || '',
        });
      });
    });
    rows.sort((a, b) => (b.calib_date || '').localeCompare(a.calib_date || '') || String(a.no).localeCompare(String(b.no)));
    return rows;
  }, [data]);

  const filteredRows = useMemo(() => historyRows.filter(r =>
    (!filterNo || r.no.toLowerCase().includes(filterNo.toLowerCase())) &&
    (!filterYear || String(r.year).includes(filterYear.trim()))
  ), [historyRows, filterNo, filterYear]);

  const allFilteredChecked = filteredRows.length > 0 && filteredRows.every(r => checked.has(r.key));

  function toggleAll() {
    setChecked(prev => {
      const next = new Set(prev);
      filteredRows.forEach(r => allFilteredChecked ? next.delete(r.key) : next.add(r.key));
      return next;
    });
  }
  function toggleOne(key) {
    setChecked(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  async function doExport() {
    setBusy(true);
    try {
      let columns, rows, sheetName, defaultName;
      if (mode === 'latest') {
        columns = [
          { label: '관리번호', width: 14 }, { label: 'S/N', width: 12 }, { label: '장비명', width: 18 },
          { label: '성적서번호', width: 14 }, { label: '교정일', width: 12 }, { label: '차기교정일', width: 12 },
          { label: 'D-Day', width: 8 }, { label: '교정내역', width: 20 }, { label: '비고', width: 20 },
        ];
        rows = data.map(item => {
          const eff = effectiveCalib(item);
          const lh = latestCalibHistory(item);
          const dday = eff.next_calib_date && eff.next_calib_date !== '미사용' ? calcDDay(eff.next_calib_date) : null;
          return [
            item.no || '', item.sn || '', item.name || '', eff.cert_no || '', eff.calib_date || '',
            eff.next_calib_date || '', dday == null ? '' : getDDayLabel(dday), lh?.note || '', item.note || '',
          ];
        });
        sheetName = '최신 현황';
        defaultName = '교정관리_최신현황.xlsx';
      } else {
        const selected = filteredRows.filter(r => checked.has(r.key));
        if (!selected.length) { onNotice('선택된 항목이 없습니다.', true); setBusy(false); return; }
        columns = [
          { label: '관리번호', width: 14 }, { label: 'S/N', width: 12 }, { label: '장비명', width: 18 },
          { label: '연도', width: 8 }, { label: '성적서번호', width: 14 }, { label: '교정일', width: 12 },
          { label: '차기교정일', width: 12 }, { label: '교정내역', width: 20 },
        ];
        rows = selected.map(r => [r.no, r.sn, r.name, r.year, r.cert_no, r.calib_date, r.next_calib_date, r.note]);
        sheetName = '교정내역';
        defaultName = '교정관리_교정내역.xlsx';
      }
      const res = await exportScheduleExcelTable({ defaultName, sheetName, tableStyle: 'TableStyleMedium16', columns, rows });
      if (res?.ok) { onNotice(`엑셀 파일로 내보냈습니다: ${res.filePath}`); onClose(); }
      else if (!res?.canceled) onNotice('내보내기 실패: ' + (res?.error || ''), true);
    } catch (e) { onNotice('내보내기 실패: ' + e.message, true); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <h2 className="text-base font-bold text-gray-900">📊 교정관리 엑셀로 내보내기</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
        </div>

        <div className="px-6 pt-4 flex gap-2 shrink-0">
          <button onClick={() => setMode('latest')}
            className={`px-3 py-1.5 rounded-lg text-sm border ${mode === 'latest' ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            최신 현황만
          </button>
          <button onClick={() => setMode('history')}
            className={`px-3 py-1.5 rounded-lg text-sm border ${mode === 'history' ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            연도별 교정내역 선택
          </button>
        </div>

        {mode === 'latest' ? (
          <div className="px-6 py-6 text-sm text-gray-500">
            현재 등록된 구역별 최신(대표) 교정정보 {data.length}건을 표와 동일한 구성으로 내보냅니다.
          </div>
        ) : (
          <>
            <div className="px-6 pt-3 flex flex-wrap gap-2 items-center shrink-0">
              <input value={filterNo} onChange={e => setFilterNo(e.target.value)} placeholder="관리번호 검색..."
                className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm w-40" />
              <input value={filterYear} onChange={e => setFilterYear(e.target.value)} placeholder="연도 검색..."
                className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm w-28" />
              <label className="flex items-center gap-1.5 text-xs text-gray-600 ml-auto cursor-pointer select-none">
                <input type="checkbox" checked={allFilteredChecked} onChange={toggleAll} />
                전체 선택/해제 ({checked.size}건 선택됨)
              </label>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-3">
              {filteredRows.length === 0 ? (
                <p className="text-sm text-gray-400 py-6 text-center">해당하는 교정내역이 없습니다.</p>
              ) : (
                <div className="divide-y divide-gray-50 border border-gray-100 rounded-lg">
                  {filteredRows.map(r => (
                    <label key={r.key} className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-50 cursor-pointer select-none">
                      <input type="checkbox" checked={checked.has(r.key)} onChange={() => toggleOne(r.key)} />
                      <span className="font-medium text-gray-800 w-24 shrink-0 truncate">{r.no}</span>
                      <span className="text-gray-400 w-12 shrink-0">{r.year}</span>
                      <span className="text-gray-600 flex-1 truncate">{r.name}</span>
                      <span className="text-gray-400 w-24 shrink-0">{r.calib_date}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div className="px-6 py-4 border-t border-gray-100 flex gap-2 shrink-0">
          <button onClick={doExport} disabled={busy}
            className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
            {busy ? '내보내는 중…' : '엑셀로 내보내기'}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">취소</button>
        </div>
      </div>
    </div>
  );
}
