// TEST 업무 배치판의 로테이션 계산 — 특정 주기마다 업무 담당이 다른 인원에게 자동으로 넘어간다.
// 저장된 상태를 바꿔 가며 옮기지 않고, "시작일·주기·방식"만으로 어느 주기에 누가 담당인지 항상 같은 결과를
// 계산한다. 그래서 어느 PC에서 열어도(그리고 며칠 만에 열어도) 같은 사람이 나오고, 무작위도 같은 순서를 쓴다.
//
// task.rotation = {
//   on: boolean,
//   unit: 'day' | 'week' | 'month', every: number,   // 예: 1주마다, 2주마다, 1개월마다
//   mode: 'sequential' | 'random',                     // 순차(직원 순서대로) / 무작위(바로 앞 사람 제외)
//   start: 'yyyy-MM-dd',                               // 1주기가 시작하는 날
//   first: '<직원>',                                   // 1주기 담당(순차는 여기서부터 순서대로)
//   pool: ['<직원>', ...],                             // 돌아가며 맡을 인원(비면 전체 직원)
//   seed: number,                                      // 무작위 순서를 고정하는 값
//   overrides: { '<주기 번호>': '<직원>' },            // 그 주기만 수동으로 바꾼 담당
// }

export const ROTATION_UNITS = [['day', '일'], ['week', '주'], ['month', '개월']];

const pad = (n) => String(n).padStart(2, '0');
export const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => new Date(`${s}T00:00:00`);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => {
  const day = d.getDate(); const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(day, last)); return x;
};

export function rotationPool(task, staff) {
  const r = task?.rotation || {};
  const own = (Array.isArray(r.pool) ? r.pool : []).filter(w => staff.includes(w));
  return own.length > 0 ? own : staff;
}

// 어느 주기(0부터)에 오늘이 속하는지와 그 주기의 시작·끝날짜
export function rotationPeriod(r, today) {
  const every = Math.max(1, parseInt(r.every) || 1);
  const start = parse(r.start || fmtDate(today));
  const t = parse(fmtDate(today));
  let k = 0;
  if (t >= start) {
    if (r.unit === 'month') {
      let m = (t.getFullYear() - start.getFullYear()) * 12 + (t.getMonth() - start.getMonth());
      if (addMonths(start, m) > t) m -= 1;
      k = Math.floor(Math.max(0, m) / every);
    } else {
      const days = Math.round((t - start) / 86400000);
      k = Math.floor(days / (r.unit === 'week' ? 7 * every : every));
    }
  }
  return { k, ...periodBounds(r, k) };
}

export function periodBounds(r, k) {
  const every = Math.max(1, parseInt(r.every) || 1);
  const start = parse(r.start || fmtDate(new Date()));
  let s, e;
  if (r.unit === 'month') { s = addMonths(start, k * every); e = addDays(addMonths(start, (k + 1) * every), -1); }
  else { const len = r.unit === 'week' ? 7 * every : every; s = addDays(start, k * len); e = addDays(s, len - 1); }
  return { startDate: fmtDate(s), endDate: fmtDate(e) };
}

// 같은 입력이면 항상 같은 0~1 값(무작위 순서를 모든 PC에서 똑같이 만들기 위한 의사난수)
function rand01(seed, i) {
  let t = (((seed | 0) + Math.imul(i + 1, 0x9E3779B9)) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// k번째 주기의 담당자
export function rotationWorkerAt(task, staff, k) {
  const r = task.rotation || {};
  const pool = rotationPool(task, staff);
  const n = pool.length;
  if (!n) return '';
  const ov = r.overrides || {};
  const valid = (w) => w && staff.includes(w);
  const first = pool.includes(r.first) ? r.first : pool[0];
  if (r.mode === 'random') {
    let prev = valid(ov[0]) ? ov[0] : first;
    for (let i = 1; i <= k; i++) {
      if (valid(ov[i])) { prev = ov[i]; continue; }
      const cand = pool.filter(w => w !== prev);
      prev = cand.length ? cand[Math.floor(rand01(r.seed || 1, i) * cand.length)] : prev;
    }
    return prev;
  }
  if (valid(ov[k])) return ov[k];
  return pool[(pool.indexOf(first) + k) % n];
}

// 오늘 기준 로테이션 상태: { k, startDate, endDate, worker, upcoming: [{ k, startDate, endDate, worker }] }
export function rotationState(task, staff, today = new Date(), upcomingCount = 4) {
  const r = task.rotation;
  if (!r || !r.on || staff.length === 0) return null;
  const p = rotationPeriod(r, today);
  const upcoming = [];
  for (let i = 1; i <= upcomingCount; i++) {
    upcoming.push({ k: p.k + i, ...periodBounds(r, p.k + i), worker: rotationWorkerAt(task, staff, p.k + i) });
  }
  return { ...p, worker: rotationWorkerAt(task, staff, p.k), upcoming };
}

export function rotationLabel(r) {
  const unit = { day: '일', week: '주', month: '개월' }[r.unit] || '주';
  const every = Math.max(1, parseInt(r.every) || 1);
  return `${every === 1 ? '매' : `${every}${unit}마다`}${every === 1 ? unit : ''} ${r.mode === 'random' ? '무작위' : '순차'}`.replace('매일 ', '매일 ').trim();
}

// ── 달력 연동 ──
// 근무자별 색 점(TEST 업무 배치판의 근무자 색과 같은 순서)
export const WORKER_DOTS = ['bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500', 'bg-rose-500', 'bg-cyan-500', 'bg-lime-500', 'bg-orange-500'];
export const workerDot = (staff, who) => WORKER_DOTS[Math.max(0, staff.indexOf(who)) % WORKER_DOTS.length];

// 어느 날짜에 해야 하는 TEST 업무인지: 주간근무 알림과 같은 규칙 — 매일(평일·공휴일 제외) / 주간(월요일) / 월간(매월 1일·말일).
// "직접 추가" 업무는 정해진 요일이 없으므로 기한(due)을 입력한 날에만 나온다. 기한이 그 날인 업무는 구분과 관계없이 나온다.
// 담당자는 그 날짜 기준(로테이션이면 그 주기의 담당). 담당자가 없는 업무는 건너뛴다.
// 반환: [{ id, name, kind, workers: [이름], due: boolean, status?: 'todo'|'doing'|'done' }]
export function boardTasksOn(board, staff, dateStr, isHoliday = false) {
  if (!board || !Array.isArray(board.tasks)) return [];
  const date = parse(dateStr);
  const dow = date.getDay();
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const dayOfMonth = date.getDate();
  const isScheduled = (t) => {
    if (t.kind === 'daily') return t.weekdaysOnly === false ? true : (dow >= 1 && dow <= 5 && !isHoliday);
    if (t.kind === 'weekly') return dow === (Number.isInteger(t.dow) ? t.dow : 1);
    if (t.kind === 'monthly') {
      if (t.monthDay === 'last') return dayOfMonth === lastDay;
      if (Number.isInteger(t.monthDay)) return dayOfMonth === Math.min(t.monthDay, lastDay);
      return dayOfMonth === 1 || dayOfMonth === lastDay;
    }
    return false;
  };
  const out = [];
  for (const t of board.tasks) {
    const rot = t.rotation?.on ? t.rotation : null;
    let period = null;
    let workers;
    if (rot) {
      if (dateStr < (rot.start || '')) continue; // 로테이션 시작 전
      period = rotationPeriod(rot, date).k;
      const w = staff.length ? rotationWorkerAt(t, staff, period) : '';
      workers = w ? [w] : [];
    } else {
      workers = Object.entries(board.assignments || {}).filter(([, ids]) => (ids || []).includes(t.id)).map(([w]) => w);
    }
    if (workers.length === 0) continue;
    let dueStatus = null;
    for (const w of workers) {
      const e = board.progress?.[w]?.[t.id];
      if (e && e.due === dateStr && (period == null || e.period === period)) { dueStatus = e.status || 'todo'; break; }
    }
    const isDue = dueStatus != null;
    if (!(isScheduled(t) || isDue)) continue;
    out.push({ id: t.id, name: t.name, kind: t.kind || '', time: t.alarmTime || '', workers, due: isDue, ...(isDue ? { status: dueStatus } : {}) });
  }
  return out;
}

// 업무의 주기를 사람이 읽는 말로: "매일 09:00 (평일)", "매주 화 10:30", "매월 15일 09:00", "매월 1일·말일"
const DOW_KR = ['일', '월', '화', '수', '목', '금', '토'];
export function scheduleLabel(t) {
  const time = t?.alarmTime ? ` ${t.alarmTime}` : '';
  if (t?.kind === 'daily') return `매일${time}${t.weekdaysOnly === false ? '' : ' (평일)'}`;
  if (t?.kind === 'weekly') return `매주 ${DOW_KR[Number.isInteger(t.dow) ? t.dow : 1]}${time}`;
  if (t?.kind === 'monthly') return `매월 ${t.monthDay === 'last' ? '말일' : Number.isInteger(t.monthDay) ? t.monthDay + '일' : '1일·말일'}${time}`;
  return time.trim() || '기한 입력 시';
}
