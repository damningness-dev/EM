import { supabase } from './supabase';

// ─── 교정 ────────────────────────────────────────────────────────────────────

export async function fetchCalibration() {
  const { data, error } = await supabase
    .from('calibration')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

export async function upsertCalibration(item) {
  const { data, error } = await supabase
    .from('calibration')
    .upsert(item, { onConflict: 'id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteCalibration(id) {
  const { error } = await supabase.from('calibration').delete().eq('id', id);
  if (error) throw error;
}

// ─── 모니터링 구역 ─────────────────────────────────────────────────────────────

export async function fetchZones() {
  const { data, error } = await supabase
    .from('monitoring_zones')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

export async function upsertZone(zone) {
  const { data, error } = await supabase
    .from('monitoring_zones')
    .upsert(zone, { onConflict: 'id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteZone(id) {
  const { error } = await supabase.from('monitoring_zones').delete().eq('id', id);
  if (error) throw error;
}

// ─── 월별 모니터링 데이터 ────────────────────────────────────────────────────────

export async function fetchMonitoringData(year, month) {
  const { data, error } = await supabase
    .from('monitoring_data')
    .select('*')
    .eq('year', year)
    .eq('month', month);
  if (error) throw error;
  // zoneId를 key로 변환해서 반환
  const map = {};
  for (const row of data) {
    map[row.zone_id] = row;
  }
  return map;
}

export async function fetchAllMonitoringData(year) {
  const { data, error } = await supabase
    .from('monitoring_data')
    .select('*')
    .eq('year', year);
  if (error) throw error;
  const map = {};
  for (const row of data) {
    map[`${row.zone_id}_${row.month}`] = row;
  }
  return map;
}

export async function upsertMonitoringEntry(entry) {
  const { data, error } = await supabase
    .from('monitoring_data')
    .upsert(entry, { onConflict: 'zone_id,year,month' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ─── 연간 계획 ─────────────────────────────────────────────────────────────────

export async function fetchAnnualPlan(year) {
  const { data, error } = await supabase
    .from('annual_plan')
    .select('*')
    .eq('year', year);
  if (error) throw error;
  // {ahuName_month: row} 맵으로 반환
  const map = {};
  for (const row of data) {
    map[`${row.ahu_name}_${row.month}`] = row;
  }
  return map;
}

export async function upsertAnnualPlan(entry) {
  const { data, error } = await supabase
    .from('annual_plan')
    .upsert(entry, { onConflict: 'ahu_name,year,month' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ─── 초기 데이터 시딩 ─────────────────────────────────────────────────────────────
export async function seedInitialData(calibrationData, zonesData) {
  // 이미 데이터가 있으면 건너뜀
  const { count: calibCount } = await supabase.from('calibration').select('id', { count: 'exact', head: true });
  if (calibCount === 0) {
    const { error } = await supabase.from('calibration').insert(
      calibrationData.map((c, i) => ({
        no: c.no, sn: c.sn, cert_no: c.certNo, calib_date: c.calibDate || null,
        next_calib_date: c.nextCalibDate || null, name: c.name, note: c.note, sort_order: i
      }))
    );
    if (error) console.error('calibration seed error:', error);
  }

  const { count: zoneCount } = await supabase.from('monitoring_zones').select('id', { count: 'exact', head: true });
  if (zoneCount === 0) {
    const { error } = await supabase.from('monitoring_zones').insert(
      zonesData.map((z, i) => ({
        name: z.name, grade: z.grade, category: z.category, sort_order: i
      }))
    );
    if (error) console.error('zones seed error:', error);
  }
}
