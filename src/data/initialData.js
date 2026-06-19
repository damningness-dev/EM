// 교정 장비 초기 데이터 (엑셀 교정 시트 기반)
export const INITIAL_CALIBRATION = [
  { id: 1, no: 'QI-185', sn: '101788', certNo: '', calibDate: '2025-06-11', nextCalibDate: '2026-06-11', name: 'MAS100-NT', note: '' },
  { id: 2, no: 'QI-273', sn: '109193', certNo: '', calibDate: '2025-06-11', nextCalibDate: '2026-06-11', name: '', note: '' },
  { id: 3, no: 'QI-274', sn: '109194', certNo: '미사용', calibDate: '2025-03-10', nextCalibDate: '미사용', name: '', note: '미사용' },
  { id: 4, no: 'QI-300', sn: '110747', certNo: '', calibDate: '2025-03-10', nextCalibDate: '2026-03-06', name: '', note: '' },
  { id: 5, no: 'QI-301', sn: '110752', certNo: '', calibDate: '2025-03-10', nextCalibDate: '2026-03-06', name: '', note: '' },
  { id: 6, no: 'QI-302', sn: '110769', certNo: '', calibDate: '2025-03-10', nextCalibDate: '2026-03-06', name: '', note: '' },
  { id: 7, no: 'QI-303', sn: '110792', certNo: '', calibDate: '2025-03-10', nextCalibDate: '2026-03-06', name: '', note: '' },
  { id: 8, no: 'QI-408', sn: '102151', certNo: '', calibDate: '2025-06-11', nextCalibDate: '2026-06-11', name: '', note: '' },
  { id: 9, no: 'QI-409', sn: '102152', certNo: '', calibDate: '2025-03-10', nextCalibDate: '2026-03-06', name: '', note: '' },
  { id: 10, no: 'QI-427', sn: '113093', certNo: '', calibDate: '2025-03-10', nextCalibDate: '2026-03-06', name: '', note: '' },
  { id: 11, no: 'QI-556', sn: '0325023', certNo: 'RC-25-0025', calibDate: '2026-05-10', nextCalibDate: '2027-05-10', name: '압축가스미생물포집기', note: '' },
  { id: 12, no: 'QI-562', sn: '2025016', certNo: '205/25', calibDate: '2025-05-19', nextCalibDate: '2026-05-19', name: 'triobas', note: '' },
  { id: 13, no: 'QI-563', sn: '2025017', certNo: '206/25', calibDate: '2025-05-19', nextCalibDate: '2026-05-19', name: '', note: '' },
  { id: 14, no: 'QI-564', sn: '2025018', certNo: '207/25', calibDate: '2025-05-19', nextCalibDate: '2026-05-19', name: '', note: '' },
  { id: 15, no: 'QI-566', sn: '3925020', certNo: '404/25', calibDate: '2025-10-10', nextCalibDate: '2026-10-10', name: '', note: '' },
  { id: 16, no: 'QI-567', sn: '3925021', certNo: '405/25', calibDate: '2025-10-10', nextCalibDate: '2026-10-10', name: '', note: '' },
  { id: 17, no: 'QI-568', sn: '3925022', certNo: '406/25', calibDate: '2025-10-10', nextCalibDate: '2026-10-10', name: '', note: '' },
  { id: 18, no: 'QI-569', sn: '3925023', certNo: '407/25', calibDate: '2025-10-10', nextCalibDate: '2026-10-10', name: '', note: '' },
  { id: 19, no: 'QI-411', sn: '39088952', certNo: 'SC2506-17953-1', calibDate: '2025-06-09', nextCalibDate: '2026-06-09', name: '조도계', note: '' },
  { id: 20, no: 'QI-467', sn: '000006129', certNo: 'SC2506-17953-2', calibDate: '2025-06-10', nextCalibDate: '2026-06-10', name: '소음계', note: '' },
  { id: 21, no: 'QI-424', sn: '1910538023', certNo: '', calibDate: '2025-12-17', nextCalibDate: '2026-12-17', name: '부유입자측정기(구형)', note: '' },
  { id: 22, no: 'QI-533', sn: '2023410362', certNo: '', calibDate: '2025-03-18', nextCalibDate: '2026-03-18', name: '부유입자측정기(신형)', note: '' },
  { id: 23, no: 'QI-534', sn: '2023410363', certNo: '', calibDate: '2025-03-18', nextCalibDate: '2026-03-18', name: '', note: '' },
  { id: 24, no: 'QI-535', sn: '2023410364', certNo: '', calibDate: '2025-03-18', nextCalibDate: '2026-03-18', name: '', note: '' },
  { id: 25, no: 'QI-358', sn: '60369308', certNo: 'KI2506-03153-1', calibDate: '2025-06-11', nextCalibDate: '2026-06-11', name: '디지털 온·습도계', note: '' },
  { id: 26, no: 'QI-262', sn: '6527151', certNo: 'ARFH-9031', calibDate: '2025-05-16', nextCalibDate: '2026-05-16', name: '유수분측정기', note: '' },
];

// AHU 목록 (연간계획 시트)
export const AHU_LIST = [
  'AHU-01', 'AHU-02', 'AHU-15', 'AHU-16', 'AHU-19',
  'AHU-31', 'AHU-32', 'AHU-33', 'AHU-34', 'AHU-42', 'AHU-43'
];

// 모니터링 구역 목록 (현황 시트)
export const MONITORING_ZONES = [
  { id: 1, name: '1호기재', grade: '유지관리', category: '공조' },
  { id: 2, name: '1호기캡씰링기', grade: 'P2', category: '공조' },
  { id: 3, name: '1호기캡씰링기', grade: 'P3', category: '공조' },
  { id: 4, name: '1호기세척&투석액', grade: 'P2', category: '공조' },
  { id: 5, name: '1호기세척&투석액', grade: 'P3', category: '공조' },
  { id: 6, name: '1호기조제실', grade: 'P3', category: '공조' },
  { id: 7, name: '2호기재', grade: '유지관리', category: '공조' },
  { id: 8, name: '2호기2CB', grade: 'P2', category: '공조' },
  { id: 9, name: '2호기2CB', grade: 'P3', category: '공조' },
  { id: 10, name: '15호기(세척실)', grade: 'P1', category: '공조' },
  { id: 11, name: '15호기재', grade: 'P1', category: '공조' },
  { id: 12, name: '15호기재', grade: 'P2', category: '공조' },
  { id: 13, name: '16호기재', grade: 'P2', category: '공조' },
  { id: 14, name: '16호기재', grade: 'P3', category: '공조' },
  { id: 15, name: '19호기재', grade: 'P1', category: '공조' },
  { id: 16, name: '19호기재', grade: 'P2', category: '공조' },
  { id: 17, name: '31호기', grade: 'P2', category: '공조' },
  { id: 18, name: '31호기', grade: 'P3', category: '공조' },
  { id: 19, name: '32호기', grade: 'P1', category: '공조' },
  { id: 20, name: '32호기', grade: 'P2', category: '공조' },
  { id: 21, name: '32호기', grade: 'P3', category: '공조' },
  { id: 22, name: '33호기', grade: 'P3', category: '공조' },
  { id: 23, name: '34호기', grade: 'P3', category: '공조' },
  { id: 24, name: '42호기', grade: 'P1', category: '공조' },
  { id: 25, name: '42호기', grade: 'P2', category: '공조' },
  { id: 26, name: '42호기', grade: 'P3', category: '공조' },
  { id: 27, name: '43호기', grade: 'P1', category: '공조' },
  { id: 28, name: '43호기', grade: 'P2', category: '공조' },
  { id: 29, name: '43호기', grade: 'P3', category: '공조' },
  { id: 30, name: '50호기', grade: 'P1', category: '공조' },
  { id: 31, name: '50호기', grade: 'P2', category: '공조' },
  { id: 32, name: '조영제충전실', grade: 'P1', category: '공조' },
  { id: 33, name: '원료부스', grade: 'P3', category: '공조' },
  { id: 34, name: '자재부스', grade: 'P3', category: '공조' },
  { id: 35, name: '의료28(DNG2301)', grade: 'P3', category: '공조' },
  { id: 36, name: '지질2(2334-NG-04)', grade: 'P1', category: '공조' },
  { id: 37, name: '지질2(2334-NG-04)', grade: 'P2', category: '공조' },
  { id: 38, name: '4층(1427-NG-01,02,03,04)', grade: 'P3', category: '공조' },
  { id: 39, name: '4층(1436-NG-04,05)', grade: 'P3', category: '공조' },
  { id: 40, name: '1동(1336-NG-01,02/1337-NG-01,02/1543,1544-NG-01/1431-NG-06)', grade: 'P2', category: '질소가스' },
  { id: 41, name: '1동(1337,6-CA-01)', grade: 'P2', category: '압축공기' },
  { id: 42, name: '1동(1434,1435,1436-CA-01/1454-CA-01,02)', grade: 'P2', category: '압축공기' },
  { id: 43, name: '2동(2157-CA-01,02/2129-CA-01/2431-CA-01,02,03/2455-CA-01)', grade: 'P2', category: '압축공기' },
  { id: 44, name: '2동(2157-CA-01,02/2129-CA-01/2431-CA-01,02,03/2455-CA-01)', grade: 'P3', category: '압축공기' },
  { id: 45, name: '004-B-03-1(1동 4층)', grade: 'P2', category: '공조' },
  { id: 46, name: '004-B-03-2(1동 3층)', grade: 'P2', category: '공조' },
  { id: 47, name: '005-B-05-1(5층조제실1)', grade: 'P2', category: '공조' },
  { id: 48, name: '005-B-05-2(5층조제실2)', grade: 'P2', category: '공조' },
  { id: 49, name: '005-B-05-3(4층조제실)', grade: 'P2', category: '공조' },
  { id: 50, name: '005-B-05-4(4층시린지,조영제)', grade: 'P2', category: '공조' },
  { id: 51, name: '005-B-05-5(4층백충전실1,2)', grade: 'P2', category: '공조' },
  { id: 52, name: '005-B-05-6(4층백충전실3)', grade: 'P2', category: '공조' },
  { id: 53, name: '005-B-05-7(4층병충전실)', grade: 'P2', category: '공조' },
  { id: 54, name: '005-B-05-8(3층백충전실)', grade: 'P2', category: '공조' },
];

// 등급별 측정 횟수 기준
export const GRADE_TARGETS = {
  'P1': 7,
  'P2': 10,
  'P3': 12,
  'OQ': 1,
  '유지관리': 1,
};

// 등급별 색상
export const GRADE_COLORS = {
  'P1': 'bg-red-100 text-red-700',
  'P2': 'bg-blue-100 text-blue-700',
  'P3': 'bg-orange-100 text-orange-700',
  '유지관리': 'bg-indigo-100 text-indigo-900',
  'OQ': 'bg-purple-100 text-purple-800',
  'PQ': 'bg-pink-100 text-pink-800',
};

// 카테고리별 색상
export const CATEGORY_COLORS = {
  '공조': 'bg-green-100 text-green-800',
  '질소가스': 'bg-purple-100 text-purple-800',
  '압축공기': 'bg-yellow-100 text-yellow-800',
};

export const CATEGORY_SECTION = {
  '공조':   { bg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-800'  },
  '질소가스': { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-800' },
  '압축공기': { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-800' },
};
