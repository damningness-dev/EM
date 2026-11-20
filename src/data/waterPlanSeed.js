// 용수모니터링 일정 기본 데이터 — 첨부된 '용수 모니터링 계획' 엑셀(주간용수(WFI,UF)·PW·PS 시트)에서 가져온 것.
// 처음 열 때 관리자가 한 번 저장되고, 이후에는 화면에서 추가·수정·삭제한다. id가 고정이라 여러 PC에서 동시에 불러와도 중복되지 않는다.
//   WFI: 첫 주 날짜 기준으로 매주 같은 요일에 반복(월·화·수), PW·PS: 엑셀에 적힌 날짜의 1회 일정.
export const WATER_PLAN_SEED = [
 {
  "id": "seed-wfi-001",
  "type": "WFI",
  "area": "1동 조제실",
  "points": "① 1533-WFI-01, 1534-WFI-01, 1539-WFI-01, 1540-WFI-01",
  "count": 4,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-002",
  "type": "WFI",
  "area": "1동 조제실",
  "points": "① 1541-WFI-01, 1542-WFI-01",
  "count": 2,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-003",
  "type": "WFI",
  "area": "1동 조제실",
  "points": "① 1545-WFI-01, 1546-WFI-01, 1547-WFI-01, 1431-WFI-01",
  "count": 4,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-004",
  "type": "WFI",
  "area": "1동 조제실",
  "points": "① 1431-WFI-02, 1431-WFI-03, 1431-WFI-04, 1431-WFI-05",
  "count": 4,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-005",
  "type": "WFI",
  "area": "1동 조제실",
  "points": "① 1543-WFI-01, 1544-WFI-01, 1431-WFI-06",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-006",
  "type": "WFI",
  "area": "생산5과",
  "points": "① 1427-WFI-01, 1462-WFI-01, 1462-WFI-02",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-wfi-007",
  "type": "WFI",
  "area": "생산5과",
  "points": "① 1425-WFI-01, 1434-WFI-01, 1435-WFI-01, 1436-WFI-01",
  "count": 4,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": "Phase.3"
 },
 {
  "id": "seed-wfi-008",
  "type": "WFI",
  "area": "생산5과",
  "points": "① 1438-WFI-01, 1439-WFI-01, 1440-WFI-01",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-wfi-009",
  "type": "WFI",
  "area": "생산5과",
  "points": "① 1452-WFI-01, 1453-WFI-01",
  "count": 2,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-wfi-010",
  "type": "WFI",
  "area": "생산5과",
  "points": "① 1454-WFI-01, 1454-WFI-02",
  "count": 2,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-wfi-011",
  "type": "WFI",
  "area": "2동 4층조제실",
  "points": "♨ 2434-WFI-01, 2434-WFI-02, 2459-WFI-01, 2459-WFI-02",
  "count": 4,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-012",
  "type": "WFI",
  "area": "2동 4층조제실",
  "points": "♨ 2434-WFI-03, 2459-WFI-03",
  "count": 2,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-013",
  "type": "WFI",
  "area": "2동 4층조제실",
  "points": "♨ 2461-WFI-01, 2461-WFI-02, 2461-WFI-03",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-014",
  "type": "WFI",
  "area": "2동 4층조제실",
  "points": "♨ 2460-WFI-01, 2460-WFI-02, 2460-WFI-03",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-015",
  "type": "WFI",
  "area": "2동 4층조제실",
  "points": "♨ 2438-WFI-01, 2438-WFI-02, 2438-WFI-03",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-016",
  "type": "WFI",
  "area": "생산 1과",
  "points": "♨ 2424-WFI-01, 2431-WFI-01, 2431-WFI-02, 2431-WFI-03",
  "count": 4,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-wfi-017",
  "type": "WFI",
  "area": "생산 1과",
  "points": "♨ 2436-WFI-01, 2439-WFI-01",
  "count": 2,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-wfi-018",
  "type": "WFI",
  "area": "생산 1과",
  "points": "♨ 2464-WFI-01, 2435-WFI-01, 2435-WFI-02,2457-WFI-01, 2457-WFI-02",
  "count": 5,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-wfi-019",
  "type": "WFI",
  "area": "생산 1과",
  "points": "▩ 2423-WFI-02, 2460-WFI-04",
  "count": 2,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-wfi-020",
  "type": "WFI",
  "area": "2동 1,3층 조제실",
  "points": "♨ 2334-WFI-01, 2334-WFI-02, 2334-WFI-03",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-09",
  "note": ""
 },
 {
  "id": "seed-wfi-021",
  "type": "WFI",
  "area": "2동 1,3층 조제실",
  "points": "▩ 2141-WFI-01, 2140-WFI-01, 2140-WFI-02, 2140-WFI-03",
  "count": 4,
  "repeat": "weekly",
  "date": "2026-12-09",
  "note": ""
 },
 {
  "id": "seed-wfi-022",
  "type": "WFI",
  "area": "2동 1,3층 조제실",
  "points": "▩ 2140-WFI-04, 2140-WFI-05, 2326-WFI-01",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-09",
  "note": ""
 },
 {
  "id": "seed-wfi-023",
  "type": "WFI",
  "area": "2동 1,3층 조제실",
  "points": "▩ 2140-WFI-06, 2140-WFI-07, 2140-WFI-08, 2140-WFI-09",
  "count": 4,
  "repeat": "weekly",
  "date": "2026-12-09",
  "note": ""
 },
 {
  "id": "seed-wfi-024",
  "type": "WFI",
  "area": "2동 1,3층 조제실",
  "points": "▩ 2157-WFI-02, 2132-WFI-01, 2139-WFI-01",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-09",
  "note": ""
 },
 {
  "id": "seed-wfi-025",
  "type": "WFI",
  "area": "생산3과",
  "points": "♨ 2341-WFI-02, 2341-WFI-03 2337-WFI-02",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-09",
  "note": ""
 },
 {
  "id": "seed-wfi-026",
  "type": "WFI",
  "area": "생산3과",
  "points": "▩ 2316-WFI-01, 2316-WFI-02, 2337-WFI-01",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-09",
  "note": ""
 },
 {
  "id": "seed-wfi-027",
  "type": "WFI",
  "area": "생산3과",
  "points": "▩ 2341-WFI-01, 2321-WFI-01, 2334-WFI-04",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-09",
  "note": ""
 },
 {
  "id": "seed-wfi-028",
  "type": "WFI",
  "area": "1동 3층 신설",
  "points": "① 1330-WFI-01, 1339-WFI-02, 1345-WFI-01",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-wfi-029",
  "type": "WFI",
  "area": "1동 3층 신설",
  "points": "① 1331-WFI-01, 1332-WFI-01~~~~~~1346-WFI-01(10개)",
  "count": 10,
  "repeat": "weekly",
  "date": "2026-12-09",
  "note": ""
 },
 {
  "id": "seed-wfi-030",
  "type": "WFI",
  "area": "QA",
  "points": "♨ 2144-WFI-01",
  "count": 1,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-031",
  "type": "WFI",
  "area": "QA",
  "points": "▩ 2144-WFI-03",
  "count": 1,
  "repeat": "weekly",
  "date": "2026-12-07",
  "note": ""
 },
 {
  "id": "seed-wfi-032",
  "type": "WFI",
  "area": "QA",
  "points": "2162-WFI-01~04(03-X) (PH)",
  "count": 3,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-wfi-033",
  "type": "WFI",
  "area": "QA",
  "points": "① 1549-WFI-02",
  "count": 1,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-wfi-034",
  "type": "WFI",
  "area": "QA",
  "points": "D WFI-01,02",
  "count": 2,
  "repeat": "weekly",
  "date": "2026-12-08",
  "note": ""
 },
 {
  "id": "seed-pw-035",
  "type": "PW",
  "area": "1동조제실",
  "points": "1533-PW-01,1534-PW-01,1539-PW-01,1540-PW-01",
  "count": 4,
  "repeat": "once",
  "date": "2026-12-03",
  "note": "22.03~25.02"
 },
 {
  "id": "seed-pw-036",
  "type": "PW",
  "area": "1동조제실",
  "points": "1541-PW-01,1542-PW-01",
  "count": 2,
  "repeat": "once",
  "date": "2026-12-03",
  "note": "22.03~25.02"
 },
 {
  "id": "seed-pw-037",
  "type": "PW",
  "area": "1동조제실",
  "points": "1545-PW-01,1546-PW-01,1547-PW-01,1431-PW-01",
  "count": 4,
  "repeat": "once",
  "date": "2026-12-03",
  "note": "22.03~25.02"
 },
 {
  "id": "seed-pw-038",
  "type": "PW",
  "area": "1동조제실",
  "points": "1431-PW-02,1431-PW-03,1431-PW-04,1431-PW-05",
  "count": 4,
  "repeat": "once",
  "date": "2026-12-03",
  "note": "22.03~25.02"
 },
 {
  "id": "seed-pw-039",
  "type": "PW",
  "area": "5과",
  "points": "1438-PW-01,1439-PW-01,1440-PW-01,1434-PW-01",
  "count": 4,
  "repeat": "once",
  "date": "2026-12-03",
  "note": "22.04~25.03"
 },
 {
  "id": "seed-pw-040",
  "type": "PW",
  "area": "5과",
  "points": "1452-PW-01,1453-PW-01,1462-PW-01,1462-PW-02",
  "count": 4,
  "repeat": "once",
  "date": "2026-12-03",
  "note": ""
 },
 {
  "id": "seed-pw-041",
  "type": "PW",
  "area": "1과",
  "points": "2439-PW-01,2435-PW-01,2435-PW-02,2434-PW-01",
  "count": 4,
  "repeat": "once",
  "date": "2026-12-03",
  "note": ""
 },
 {
  "id": "seed-pw-042",
  "type": "PW",
  "area": "1과",
  "points": "2460-PW-01,2457-PW-01,2457-PW-02",
  "count": 3,
  "repeat": "once",
  "date": "2026-12-03",
  "note": "22.04~25.03"
 },
 {
  "id": "seed-pw-043",
  "type": "PW",
  "area": "1과",
  "points": "2461-PW-01,2438-PW-01,2459-PW-01",
  "count": 3,
  "repeat": "once",
  "date": "2026-12-03",
  "note": ""
 },
 {
  "id": "seed-pw-044",
  "type": "PW",
  "area": "2동 1,3층 조제실",
  "points": "2140-PW-02,2140-PW-03,2140-PW-04,2140-PW-05",
  "count": 4,
  "repeat": "once",
  "date": "2026-12-04",
  "note": ""
 },
 {
  "id": "seed-pw-045",
  "type": "PW",
  "area": "2동 1,3층 조제실",
  "points": "2139-PW-01,2141-PW-01,2140-PW-01",
  "count": 3,
  "repeat": "once",
  "date": "2026-12-04",
  "note": ""
 },
 {
  "id": "seed-pw-046",
  "type": "PW",
  "area": "2동 1,3층 조제실",
  "points": "2140-PW-06,2140-PW-07,2140-PW-08,2140-PW-09",
  "count": 4,
  "repeat": "once",
  "date": "2026-12-04",
  "note": ""
 },
 {
  "id": "seed-pw-047",
  "type": "PW",
  "area": "생산3과",
  "points": "2334-PW-01, 2326-PW-01, 2337-PW-01,2341-PW-01, 2341-PW-02",
  "count": 5,
  "repeat": "once",
  "date": "2026-12-04",
  "note": ""
 },
 {
  "id": "seed-pw-048",
  "type": "PW",
  "area": "1동3층",
  "points": "1543-PW-01, 1544-PW-01, 1431-PW-06",
  "count": 3,
  "repeat": "once",
  "date": "2026-12-04",
  "note": ""
 },
 {
  "id": "seed-pw-049",
  "type": "PW",
  "area": "1동3층",
  "points": "1331-PW-01,1332-PW-01~~~~1346-PW-01(10개)",
  "count": 10,
  "repeat": "once",
  "date": "2026-12-04",
  "note": ""
 },
 {
  "id": "seed-pw-050",
  "type": "PW",
  "area": "QA",
  "points": "1549-PW-01 D PW-01",
  "count": 2,
  "repeat": "once",
  "date": "2026-12-03",
  "note": "22.03~25.02"
 },
 {
  "id": "seed-pw-051",
  "type": "PW",
  "area": "QA",
  "points": "2510-PW-01 2516-PW-01 2144-PW-01",
  "count": 3,
  "repeat": "once",
  "date": "2026-12-24",
  "note": ""
 },
 {
  "id": "seed-pw-052",
  "type": "PW",
  "area": "QA",
  "points": "1122-PW-01 02 03 04 05 06 07 08 09 10 11-유지관리(PH)",
  "count": 11,
  "repeat": "once",
  "date": "2026-12-24",
  "note": ""
 },
 {
  "id": "seed-pw-053",
  "type": "PW",
  "area": "QA",
  "points": "공업용수 R/O (PH)",
  "count": 2,
  "repeat": "once",
  "date": "2026-12-24",
  "note": ""
 },
 {
  "id": "seed-pw-054",
  "type": "PW",
  "area": "QA",
  "points": "2510-QCWFI-01 2518-QCWFI-01 2516-QCWFI-01",
  "count": 3,
  "repeat": "once",
  "date": "2026-12-24",
  "note": ""
 },
 {
  "id": "seed-ps-055",
  "type": "PS",
  "area": "PS",
  "points": "1549-PS-01, 1539-PS-01, 1540-PS-01, 1541-PS-01, 1542-PS-01, 1545-PS-01, 1546-PS-01, 1547-PS-01",
  "count": 8,
  "repeat": "once",
  "date": "2026-12-10",
  "note": ""
 },
 {
  "id": "seed-ps-056",
  "type": "PS",
  "area": "PS",
  "points": "1427-PS-01, 1428-PS-02, 1431-PS-01, 1431-PS-02, 1431-PS-03, 1431-PS-04, 1431-PS-05, 1434-PS-01, 1462-PS-01, 1462-PS-02",
  "count": 10,
  "repeat": "once",
  "date": "2026-12-11",
  "note": ""
 },
 {
  "id": "seed-ps-057",
  "type": "PS",
  "area": "PS",
  "points": "D PS-01",
  "count": 1,
  "repeat": "once",
  "date": "2026-12-11",
  "note": ""
 },
 {
  "id": "seed-ps-058",
  "type": "PS",
  "area": "PS",
  "points": "1543-PS-01, 1544-PS-01, 1431-PS-06",
  "count": 3,
  "repeat": "once",
  "date": "2026-12-11",
  "note": ""
 },
 {
  "id": "seed-ps-059",
  "type": "PS",
  "area": "PS",
  "points": "2316-PS-01, 2316-PS-02, 2341-PS-01, 2341-PS-02, 2337-PS-01, 2334-PS-01",
  "count": 6,
  "repeat": "once",
  "date": "2026-12-10",
  "note": ""
 },
 {
  "id": "seed-ps-060",
  "type": "PS",
  "area": "PS",
  "points": "2464-PS-01, 2436-PS-01, 2434-PS-01, 2434-PS-02",
  "count": 4,
  "repeat": "once",
  "date": "2026-12-24",
  "note": ""
 },
 {
  "id": "seed-ps-061",
  "type": "PS",
  "area": "PS",
  "points": "2438-PS-01, 2438-PS-02, 2438-PS-03, 2460-PS-01, 2460-PS-02, 2461-PS-01, 2461-PS-02, 2461-PS-03",
  "count": 8,
  "repeat": "once",
  "date": "2026-12-17",
  "note": ""
 },
 {
  "id": "seed-ps-062",
  "type": "PS",
  "area": "PS",
  "points": "2457-PS-01, 2457-PS-02, 2435-PS-01, 2435-PS-02, 2459-PS-01, 2459-PS-02",
  "count": 6,
  "repeat": "once",
  "date": "2026-12-17",
  "note": ""
 },
 {
  "id": "seed-ps-063",
  "type": "PS",
  "area": "PS",
  "points": "2141-PS-01, 2140-PS-01, 2140-PS-02, 2140-PS-03, 2140-PS-04",
  "count": 5,
  "repeat": "once",
  "date": "2026-12-18",
  "note": ""
 },
 {
  "id": "seed-ps-064",
  "type": "PS",
  "area": "PS",
  "points": "2140-PS-05, 2140-PS-06, 2140-PS-07, 2140-PS-08",
  "count": 4,
  "repeat": "once",
  "date": "2026-12-18",
  "note": ""
 },
 {
  "id": "seed-ps-065",
  "type": "PS",
  "area": "PS",
  "points": "2434-PS-03, 2459-PS-03",
  "count": 2,
  "repeat": "once",
  "date": "2026-12-18",
  "note": ""
 }
];
