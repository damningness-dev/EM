// 이 파일은 esbuild로 electron/xlsx-export.bundle.cjs 로 번들링되어 배포된다
// (npm run build:xlsx). exceljs와 그 의존성(jszip 등)을 하나의 파일로 합쳐서,
// 패키징된 설치본에서 node_modules 포함 여부와 무관하게 항상 동작하도록 한다.
const ExcelJS = require('exceljs');

// 일정 데이터를 "표 스타일 보통 N"(TableStyleMediumN) 서식이 적용된 엑셀 표로
// 만들어 바이너리 버퍼로 반환한다.
async function buildScheduleExcelBuffer({ sheetName, tableStyle, columns, rows }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet((sheetName || 'Sheet1').slice(0, 31));
  ws.addTable({
    name: 'ScheduleTable',
    ref: 'A1',
    headerRow: true,
    totalsRow: false,
    style: { theme: tableStyle || 'TableStyleMedium16', showRowStripes: true },
    columns: (columns || []).map(c => ({ name: c.label })),
    rows: rows || [],
  });
  (columns || []).forEach((c, i) => { ws.getColumn(i + 1).width = c.width || 14; });
  return wb.xlsx.writeBuffer();
}

module.exports = { buildScheduleExcelBuffer };
