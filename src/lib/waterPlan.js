// 용수모니터링 일정 계산 — 항목 하나 = { id, type, area, points, count, repeat, date, note }
//   repeat: 'weekly'(date부터 매주 같은 요일) / 'monthly'(date부터 매월 같은 요일·같은 주차) / 'once'(그 날 하루)
// 색은 배관 색상표를 따른다: WFI 하늘색, 정제수(PW) 연두색, 순수증기(PS) 분홍색 (UF는 색상표에 없어 청색으로 구분)
export const WATER_TYPES = {
  WFI: { label: 'WFI', pipe: '하늘색', chip: 'bg-sky-100 text-sky-800 border-sky-300', dot: 'bg-sky-400' },
  HWFI: { label: 'HWFI', pipe: '녹색', chip: 'bg-green-100 text-green-800 border-green-400', dot: 'bg-green-500' },
  UF: { label: 'UF', pipe: '청색', chip: 'bg-blue-100 text-blue-800 border-blue-400', dot: 'bg-blue-600' },
  PW: { label: 'PW', pipe: '연두색', chip: 'bg-lime-100 text-lime-800 border-lime-400', dot: 'bg-lime-400' },
  PS: { label: 'PS', pipe: '분홍색', chip: 'bg-pink-100 text-pink-800 border-pink-300', dot: 'bg-pink-400' },
  기타: { label: '기타', chip: 'bg-gray-100 text-gray-700 border-gray-300', dot: 'bg-gray-400' },
  // 월별 모니터링 일정에서 옮겨 온 용수 구역(구역별 측정 주기로 계산되는 일정)
  구역: { label: '용수구역', chip: 'bg-teal-100 text-teal-800 border-teal-300', dot: 'bg-teal-500' },
};
export const WATER_TYPE_KEYS = ['WFI', 'HWFI', 'UF', 'PW', 'PS', '기타']; // 직접 입력하는 일정의 종류
export const WATER_FILTER_KEYS = [...WATER_TYPE_KEYS, '구역'];
export const WATER_REPEATS = [['weekly', '매주'], ['monthly', '매월(같은 요일·주차)'], ['once', '한 번']];
// 엑셀에서 가져온 사용점 앞의 기호로 종류를 나눈다: ♨ = HWFI, ▩ = WFI. 기호는 떼고 종류(type)로 옮긴다.
export function normalizeWaterItem(it) {
  const m = /^\s*([♨▩])\s*/.exec(it?.points || '');
  if (!m) return it;
  return { ...it, type: m[1] === '♨' ? 'HWFI' : 'WFI', points: it.points.slice(m[0].length) };
}
export const DOW_KR = ['일', '월', '화', '수', '목', '금', '토'];

const parse = (ds) => new Date(`${ds}T00:00:00`);
export const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 그 날짜에 해야 하는 항목인가
export function occursOn(item, ds) {
  if (!item?.date || !/^\d{4}-\d{2}-\d{2}$/.test(ds)) return false;
  if (item.repeat === 'once') return item.date === ds;
  if (ds < item.date) return false;
  const a = parse(item.date), b = parse(ds);
  if (a.getDay() !== b.getDay()) return false;
  if (item.repeat === 'weekly') return true;
  if (item.repeat === 'monthly') return Math.ceil(a.getDate() / 7) === Math.ceil(b.getDate() / 7);
  return false;
}

export const itemsOn = (items, ds) => (items || []).filter(it => occursOn(it, ds));

// 같은 종류·구역끼리 묶어 개수를 합친다(달력 칸에 짧게 보여주기 위함)
export function groupItems(list) {
  const map = new Map();
  for (const it of list) {
    const key = `${it.type}|${it.area || ''}`;
    const g = map.get(key) || { key, type: it.type, area: it.area || '', count: 0, items: [] };
    g.count += Number(it.count) || 0; g.items.push(it); map.set(key, g);
  }
  return [...map.values()].sort((x, y) => WATER_FILTER_KEYS.indexOf(x.type) - WATER_FILTER_KEYS.indexOf(y.type));
}

export function repeatLabel(it) {
  if (it.repeat === 'once') return '한 번';
  const d = parse(it.date);
  if (it.repeat === 'weekly') return `매주 ${DOW_KR[d.getDay()]}`;
  return `매월 ${Math.ceil(d.getDate() / 7)}번째 ${DOW_KR[d.getDay()]}`;
}

// 달력 칸(주 단위). weekStartMon: 월요일 시작 여부
export function monthWeeks(year, month, weekStartMon = false) {
  const first = new Date(year, month - 1, 1);
  const lead = weekStartMon ? (first.getDay() + 6) % 7 : first.getDay();
  const start = new Date(year, month - 1, 1 - lead);
  const last = new Date(year, month, 0);
  const total = Math.ceil((lead + last.getDate()) / 7) * 7;
  const weeks = [];
  for (let i = 0; i < total; i += 7) weeks.push(Array.from({ length: 7 }, (_, k) => { const d = new Date(start); d.setDate(start.getDate() + i + k); return fmt(d); }));
  return weeks;
}
