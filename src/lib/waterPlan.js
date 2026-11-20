// 용수모니터링 일정 계산 — 항목 하나 = { id, type, area, points, count, repeat, date, note }
//   repeat: 'weekly'(date부터 매주 같은 요일) / 'monthly'(date부터 매월 같은 요일·같은 주차) / 'once'(그 날 하루)
export const WATER_TYPES = {
  WFI: { label: 'WFI', chip: 'bg-sky-100 text-sky-800 border-sky-300', dot: 'bg-sky-500' },
  UF: { label: 'UF', chip: 'bg-violet-100 text-violet-800 border-violet-300', dot: 'bg-violet-500' },
  PW: { label: 'PW', chip: 'bg-emerald-100 text-emerald-800 border-emerald-300', dot: 'bg-emerald-500' },
  PS: { label: 'PS', chip: 'bg-amber-100 text-amber-800 border-amber-300', dot: 'bg-amber-500' },
  기타: { label: '기타', chip: 'bg-gray-100 text-gray-700 border-gray-300', dot: 'bg-gray-400' },
  // 월별 모니터링 일정에서 옮겨 온 용수 구역(구역별 측정 주기로 계산되는 일정)
  구역: { label: '용수구역', chip: 'bg-teal-100 text-teal-800 border-teal-300', dot: 'bg-teal-500' },
};
export const WATER_TYPE_KEYS = ['WFI', 'UF', 'PW', 'PS', '기타']; // 직접 입력하는 일정의 종류
export const WATER_FILTER_KEYS = [...WATER_TYPE_KEYS, '구역'];
export const WATER_REPEATS = [['weekly', '매주'], ['monthly', '매월(같은 요일·주차)'], ['once', '한 번']];
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
