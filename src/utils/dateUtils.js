export function calcDDay(nextDateStr) {
  if (!nextDateStr || nextDateStr === '미사용') return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const next = new Date(nextDateStr);
  next.setHours(0, 0, 0, 0);
  return Math.ceil((next - today) / (1000 * 60 * 60 * 24));
}

export function formatDate(dateStr) {
  if (!dateStr || dateStr === '미사용') return dateStr || '';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getDDayLabel(days) {
  if (days === null) return '-';
  if (days < 0) return `D+${Math.abs(days)}`;
  if (days === 0) return 'D-Day';
  return `D-${days}`;
}

export function getDDayColor(days) {
  if (days === null) return 'text-gray-400';
  if (days < 0) return 'text-red-600 font-bold';
  if (days <= 30) return 'text-orange-500 font-semibold';
  if (days <= 60) return 'text-yellow-600';
  return 'text-green-600';
}

export function getMonthName(month) {
  return `${month}월`;
}

export function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

export function getFirstDayOfWeek(year, month) {
  return new Date(year, month - 1, 1).getDay();
}
