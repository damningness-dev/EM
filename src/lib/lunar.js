// 음력 ↔ 양력 변환 (1900~2100)
// 표준 음력 데이터 테이블 기반. 각 연도를 16진수로 인코딩:
//  - bit 16    : 윤달이 있을 때 윤달이 30일(1)인지 29일(0)인지
//  - bit 4~15  : 1~12월이 각각 30일(1)/29일(0)인지
//  - bit 0~3   : 윤달 번호 (0이면 윤달 없음)
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520, // 2100
];

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

// 음력 연도의 윤달 번호 (0이면 없음)
function leapMonth(y) {
  return LUNAR_INFO[y - MIN_YEAR] & 0xf;
}
// 음력 연도 윤달의 일수 (윤달 없으면 0)
function leapDays(y) {
  if (leapMonth(y)) return (LUNAR_INFO[y - MIN_YEAR] & 0x10000) ? 30 : 29;
  return 0;
}
// 음력 연도 m월(평달)의 일수
function monthDays(y, m) {
  return (LUNAR_INFO[y - MIN_YEAR] & (0x10000 >> m)) ? 30 : 29;
}
// 음력 한 해의 총 일수
function lYearDays(y) {
  let sum = 348; // 12 * 29
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - MIN_YEAR] & i) ? 1 : 0;
  return sum + leapDays(y);
}

// 음력 1900-01-01 = 양력 1900-01-31 (앵커)
const BASE_UTC = Date.UTC(1900, 0, 31);

// 한국 음력(KASI) 보정 — 중국 기준 표와 하루 차이나는 날짜를 한국 기준으로 직접 지정.
// (신월이 자정 부근이면 KST(UTC+9)/CST(UTC+8) 시차로 달의 시작일이 하루 달라진다)
// key: `연-월-일` (윤달이면 뒤에 'L'), value: 'yyyy-MM-dd'(양력)
const KR_LUNAR_OVERRIDES = {
  '2027-1-1': '2027-02-07', // 설날 (중국표 2/6 → 한국 2/7)
};

/**
 * 음력 → 양력 변환
 * @param {number} y 음력 연도
 * @param {number} m 음력 월 (1~12)
 * @param {number} d 음력 일
 * @param {boolean} isLeap 윤달 여부
 * @returns {Date|null} 양력 날짜 (로컬 자정), 범위 밖이면 null
 */
export function lunarToSolar(y, m, d, isLeap = false) {
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  const ov = KR_LUNAR_OVERRIDES[`${y}-${m}-${d}${isLeap ? 'L' : ''}`];
  if (ov) { const [oy, om, od] = ov.split('-').map(Number); return new Date(oy, om - 1, od); }
  let offset = 0;
  for (let i = MIN_YEAR; i < y; i++) offset += lYearDays(i);
  const leap = leapMonth(y);
  for (let i = 1; i < m; i++) {
    offset += monthDays(y, i);
    if (leap === i) offset += leapDays(y); // i월 다음에 윤달이 끼는 경우
  }
  // 대상이 윤달 자체이면, 같은 번호의 평달이 윤달보다 먼저 오므로 더해줌
  if (isLeap && leap === m) offset += monthDays(y, m);
  offset += d - 1;
  const utc = new Date(BASE_UTC + offset * 86400000);
  // UTC 기준 날짜를 로컬 자정 Date로 변환
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

export const LUNAR_YEAR_RANGE = { min: MIN_YEAR, max: MAX_YEAR };
