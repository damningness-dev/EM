import { useState, useEffect } from 'react';
import { fetchMembers, upsertMember, deleteMember, fetchGuestAccess, saveGuestAccess, fetchTeams, saveTeams, syncAfterChange, syncWarningText } from '../lib/api';

// 관리자 전용 권한 설정 화면 — (1) 로그인하지 않았을 때 보이는 메뉴를 제한하고,
// (2) 로그인 계정(멤버)을 만들어 계정마다 사이드바에 보일 탭 메뉴와 관리자 권한
// 여부를 지정한다. 로그인이 곧 관리자 권한을 겸하므로(isAdmin 계정으로 로그인하면
// 그 자체로 편집 권한이 열림) 이 화면 자체도 관리자로 로그인했을 때만 열 수 있다.
export default function MemberManager({ menu, onClose }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null); // null이면 새 계정 추가 폼 숨김, 'new'면 추가 폼
  const [form, setForm] = useState({ username: '', password: '', allowedTabs: [], token: '', isAdmin: false });
  const [teams, setTeams] = useState([]); // [{ id, name, share }]
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null); // { type: 'remove'|'clearToken', id }
  const [syncWarning, setSyncWarning] = useState('');

  function reload() {
    setLoading(true);
    fetchMembers().then(m => { setMembers(m || []); setLoading(false); }).catch(() => setLoading(false));
    fetchTeams().then(t => setTeams(t || [])).catch(() => {});
  }
  useEffect(() => { reload(); }, []);

  function startAdd() {
    setEditingId('new');
    setForm({ username: '', password: '', allowedTabs: menu.map(m => m.id), token: '', isAdmin: false });
    setError('');
  }
  function startEdit(m) {
    setEditingId(m.id);
    setForm({ username: m.username, password: '', allowedTabs: [...(m.allowedTabs || [])], token: '', isAdmin: !!m.isAdmin });
    setError('');
  }
  function toggleTab(tabId) {
    setForm(f => ({
      ...f,
      allowedTabs: f.allowedTabs.includes(tabId) ? f.allowedTabs.filter(t => t !== tabId) : [...f.allowedTabs, tabId],
    }));
  }

  async function save() {
    setError('');
    if (!form.username.trim()) { setError('사용자이름을 입력하세요.'); return; }
    if (editingId === 'new' && !form.password) { setError('비밀번호를 입력하세요.'); return; }
    setBusy(true);
    try {
      const payload = { username: form.username.trim(), allowedTabs: form.allowedTabs, isAdmin: form.isAdmin };
      if (form.password) payload.password = form.password;
      if (form.token) payload.token = form.token;
      if (editingId !== 'new') payload.id = editingId;
      const r = await upsertMember(payload);
      if (!r?.ok) { setError(r?.error || '저장 실패'); return; }
      setEditingId(null);
      reload();
      const s = await syncAfterChange();
      setSyncWarning(s.shared ? '' : syncWarningText(s));
    } catch (e) { setError('오류: ' + e.message); }
    finally { setBusy(false); }
  }

  function remove(id) {
    setConfirmAction({ type: 'remove', id });
  }

  function clearToken(id) {
    setConfirmAction({ type: 'clearToken', id });
  }

  async function runConfirmedAction() {
    if (!confirmAction) return;
    const { type, id } = confirmAction;
    setConfirmAction(null);
    setBusy(true);
    try {
      if (type === 'remove') {
        await deleteMember(id);
      } else if (type === 'clearToken') {
        await upsertMember({ id, clearToken: true });
      }
      reload();
      const s = await syncAfterChange();
      setSyncWarning(s.shared ? '' : syncWarningText(s));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <h2 className="text-base font-bold text-gray-900">🔐 권한 설정</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {syncWarning && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">⚠ {syncWarning}</p>
          )}
          <GuestAccessSection menu={menu} />

          <TeamSection teams={teams} members={members} onSaved={(list) => { setTeams(list); reload(); }} setSyncWarning={setSyncWarning} />

          <p className="text-sm font-semibold text-gray-700 mb-1">👥 계정별 권한</p>
          <p className="text-xs text-gray-400 mb-3">
            계정을 만들어 사용자이름·비밀번호와 허용할 탭 메뉴를 지정하세요. 로그인한 계정은
            여기서 허용한 탭만 보입니다.
          </p>
          <p className="text-[11px] text-amber-600 mb-3">
            ⚠ GitHub 토큰(선택)을 등록해두면 그 계정으로 로그인한 PC는 별도 설정 없이 자동으로
            공유 업로드에 씁니다. 단, 토큰은 계정 정보와 함께 공유 데이터에 저장되어 다른 PC로도
            동기화되니, 반드시 <b>gist 권한만 있는 Classic 토큰</b>을 발급해 등록하세요.
          </p>

          {loading ? (
            <p className="text-sm text-gray-400 py-6 text-center">불러오는 중…</p>
          ) : (
            <div className="space-y-2 mb-4">
              {members.length === 0 && editingId !== 'new' && (
                <p className="text-sm text-gray-400 py-4 text-center">등록된 계정이 없습니다.</p>
              )}
              {members.map(m => (
                <div key={m.id} className="border border-gray-200 rounded-lg">
                  {editingId === m.id ? (
                    <MemberForm menu={menu} form={form} setForm={setForm} onToggleTab={toggleTab}
                      onSave={save} onCancel={() => setEditingId(null)} busy={busy} error={error} isNew={false}
                      hasToken={m.hasToken} onClearToken={() => clearToken(m.id)} />
                  ) : (
                    <div className="flex items-center justify-between px-3 py-2.5">
                      <div>
                        <p className="text-sm font-medium text-gray-800">
                          {m.isAdmin ? '👑' : '👤'} {m.username}
                          {m.isAdmin && <span className="ml-1.5 text-[10px] font-normal text-amber-600">관리자</span>}
                          {m.hasToken && <span className="ml-1.5 text-[10px] font-normal text-green-600" title="GitHub 토큰이 등록되어 있습니다">🔑 토큰</span>}
                        </p>
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          {(m.allowedTabs || []).length === 0 ? '허용된 메뉴 없음'
                            : m.allowedTabs.map(t => menu.find(x => x.id === t)?.label || t).join(', ')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => startEdit(m)} className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded">수정</button>
                        <button onClick={() => remove(m.id)} className="text-xs px-2 py-1 text-red-500 hover:bg-red-50 rounded">삭제</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {editingId === 'new' && (
                <div className="border border-blue-200 rounded-lg">
                  <MemberForm menu={menu} form={form} setForm={setForm} onToggleTab={toggleTab}
                    onSave={save} onCancel={() => setEditingId(null)} busy={busy} error={error} isNew />
                </div>
              )}
            </div>
          )}

          {editingId === null && (
            <button onClick={startAdd} className="w-full py-2 border border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:border-blue-300 hover:text-blue-600">
              + 계정 추가
            </button>
          )}
        </div>
      </div>

      {confirmAction && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={e => e.stopPropagation()}>
          <div className="bg-white rounded-xl shadow-2xl p-5 max-w-sm w-full">
            <p className="text-sm text-gray-800 mb-4">
              {confirmAction.type === 'remove' ? '이 계정을 삭제하시겠습니까?' : '이 계정의 토큰을 삭제하시겠습니까?'}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmAction(null)} className="px-3 py-1.5 border border-gray-200 rounded text-xs text-gray-600 hover:bg-gray-50">취소</button>
              <button onClick={runConfirmedAction} className="px-3 py-1.5 bg-red-500 text-white rounded text-xs font-semibold hover:bg-red-600">삭제</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 팀 설정 — 팀을 만들고, 팀별로 인원을 추가하고, 팀원끼리 공유할 기록 종류(휴가·조출·연장·특근·내용)를
// 체크한다. 한 계정은 한 팀에만 속한다(다른 팀 인원을 추가하면 그 팀에서 옮겨 온다). 기록 원본은 각자
// PC에만 있고, 여기서 체크한 종류만 같은 팀원에게 공유된다(내용(메모)은 기본으로 공유하지 않음).
const TEAM_SHARE_OPTIONS = [
  ['leave', '휴가(연차·반차)'], ['early', '조출'], ['overtime', '연장'], ['special', '특근'], ['memo', '내용(메모) 포함'],
];
function TeamSection({ teams, members, onSaved, setSyncWarning }) {
  const [draft, setDraft] = useState(null); // null이면 보기 상태, 배열이면 편집 중 [{ id, name, share, memberIds }]
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const nameOf = (id) => members.find(m => m.id === id)?.username || '(삭제된 계정)';
  const viewList = teams.map(t => ({ ...t, memberIds: members.filter(m => m.teamId === t.id).map(m => m.id) }));
  const list = draft || viewList;

  function startEdit() { setDraft(viewList.map(t => ({ ...t, share: { ...t.share }, memberIds: [...t.memberIds] }))); setErr(''); }
  function addTeam() {
    const base = draft || viewList.map(t => ({ ...t, share: { ...t.share }, memberIds: [...t.memberIds] }));
    setDraft([...base, { id: '', name: '', share: { leave: true, early: false, overtime: false, special: false, memo: false }, memberIds: [] }]);
  }
  function patch(i, fn) { setDraft(d => d.map((t, k) => k === i ? fn(t) : t)); }
  // 인원 추가 — 다른 팀에 있던 계정이면 그 팀에서 빼고 이 팀으로 옮긴다.
  function addMember(i, memberId) {
    if (!memberId) return;
    setDraft(d => d.map((t, k) => k === i
      ? { ...t, memberIds: [...t.memberIds.filter(x => x !== memberId), memberId] }
      : { ...t, memberIds: t.memberIds.filter(x => x !== memberId) }));
  }
  const teamOfInDraft = (memberId) => draft?.findIndex(t => t.memberIds.includes(memberId));

  async function save() {
    if (draft.some(t => !t.name.trim())) { setErr('팀 이름을 입력하세요.'); return; }
    if (new Set(draft.map(t => t.name.trim())).size !== draft.length) { setErr('같은 이름의 팀이 있습니다.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await saveTeams(draft.map(t => ({ id: t.id, name: t.name.trim(), share: t.share })));
      if (!r?.ok) { setErr(r?.error || '저장 실패'); return; }
      // 저장된 팀은 입력한 순서 그대로 돌아온다(새 팀은 이때 id가 생긴다) — 계정별 소속 팀을 맞춘다.
      const want = new Map(); // memberId → teamId
      draft.forEach((t, i) => t.memberIds.forEach(id => want.set(id, r.teams[i].id)));
      for (const m of members) {
        const target = want.get(m.id) || '';
        if ((m.teamId || '') !== target) await upsertMember({ id: m.id, teamId: target });
      }
      setDraft(null);
      onSaved(r.teams);
      const s = await syncAfterChange();
      setSyncWarning(s.shared ? '' : syncWarningText(s));
    } catch (e) { setErr('오류: ' + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="border border-gray-200 rounded-lg p-3 mb-5">
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-semibold text-gray-700">🏷 팀 설정</p>
        {!draft && <button onClick={startEdit} className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded">{teams.length ? '수정' : '팀 만들기'}</button>}
      </div>
      <p className="text-[11px] text-gray-400 mb-2">
        팀을 만들어 인원을 추가하세요. 같은 팀 계정끼리 달력에서 서로의 휴가·근무 기록을 볼 수 있고,
        팀별로 어떤 내역을 공유할지 체크할 수 있습니다.
      </p>
      {list.length === 0 && <p className="text-xs text-gray-400 py-2">만든 팀이 없습니다.</p>}
      <div className="space-y-2">
        {list.map((t, i) => (
          <div key={t.id || `new${i}`} className="border border-gray-100 rounded-lg p-2.5 bg-gray-50/50">
            {draft ? (
              <div className="flex items-center gap-2 mb-1.5">
                <input value={t.name} onChange={e => patch(i, x => ({ ...x, name: e.target.value }))} placeholder="팀 이름"
                  className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm bg-white" />
                <button onClick={() => setDraft(d => d.filter((_, k) => k !== i))} className="text-xs text-red-500 hover:underline shrink-0">팀 삭제</button>
              </div>
            ) : (
              <p className="text-sm font-medium text-gray-800 mb-1">🏷 {t.name}</p>
            )}

            {/* 팀원 */}
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              <span className="text-[11px] text-gray-500 mr-0.5">팀원</span>
              {t.memberIds.length === 0 && <span className="text-[11px] text-gray-300">없음</span>}
              {t.memberIds.map(id => (
                <span key={id} className="inline-flex items-center gap-1 text-xs bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full pl-2 pr-1.5 py-0.5">
                  {nameOf(id)}
                  {draft && (
                    <button type="button" title="팀에서 빼기" onClick={() => patch(i, x => ({ ...x, memberIds: x.memberIds.filter(v => v !== id) }))}
                      className="text-indigo-400 hover:text-red-500 leading-none">✕</button>
                  )}
                </span>
              ))}
              {draft && (
                <select value="" onChange={e => addMember(i, e.target.value)}
                  className="text-xs border border-dashed border-gray-300 rounded px-1.5 py-0.5 bg-white text-gray-500">
                  <option value="">+ 인원 추가</option>
                  {members.filter(m => !t.memberIds.includes(m.id)).map(m => {
                    const other = teamOfInDraft(m.id);
                    return <option key={m.id} value={m.id}>{m.username}{other >= 0 ? ` (현재 ${draft[other].name || '다른 팀'})` : ''}</option>;
                  })}
                </select>
              )}
            </div>

            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <span className="text-[11px] text-gray-500">공유 내역</span>
              {TEAM_SHARE_OPTIONS.map(([k, label]) => (
                <label key={k} className={`flex items-center gap-1 text-xs select-none ${draft ? 'cursor-pointer text-gray-700' : 'text-gray-500'}`}>
                  <input type="checkbox" disabled={!draft} checked={!!t.share?.[k]}
                    onChange={e => patch(i, x => ({ ...x, share: { ...x.share, [k]: e.target.checked } }))} />
                  {label}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      {draft && (
        <div className="mt-2 space-y-2">
          <button onClick={addTeam} className="w-full py-1.5 border border-dashed border-gray-300 rounded text-xs text-gray-500 hover:border-blue-300 hover:text-blue-600">+ 팀 추가</button>
          {err && <p className="text-xs text-red-500">{err}</p>}
          <div className="flex gap-2">
            <button onClick={save} disabled={busy} className="flex-1 py-1.5 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700 disabled:opacity-50">{busy ? '저장 중…' : '저장'}</button>
            <button onClick={() => { setDraft(null); setErr(''); }} className="px-3 py-1.5 border border-gray-200 rounded text-xs text-gray-600 hover:bg-gray-50">취소</button>
          </div>
        </div>
      )}
      {!draft && teams.length > 0 && (
        <button onClick={addTeam} className="mt-2 text-xs text-gray-500 hover:text-blue-600">+ 팀 추가</button>
      )}
    </div>
  );
}

// 로그인하지 않았을 때(비로그인 상태) 보이는 메뉴를 제한한다. 끄면 지금까지처럼
// 전체 메뉴가 보인다(null 저장). 켜면 체크한 탭만 보이고, 나머지 메뉴를 쓰려면
// 로그인해야 한다.
function GuestAccessSection({ menu }) {
  const [loaded, setLoaded] = useState(false);
  const [restrict, setRestrict] = useState(false);
  const [tabs, setTabs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // SOP처럼 로그인해야만 보이는 메뉴는 여기 체크해도 의미가 없다(App.jsx가
  // 게스트에게는 항상 숨김) — 혼동을 막기 위해 목록에서 아예 뺀다.
  const guestMenu = menu.filter(m => !m.requiresLogin);

  useEffect(() => {
    fetchGuestAccess().then(c => {
      const allowed = c?.allowedTabs || null;
      setRestrict(Array.isArray(allowed));
      setTabs(allowed || guestMenu.map(m => m.id));
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleTab(id) {
    setTabs(t => t.includes(id) ? t.filter(x => x !== id) : [...t, id]);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await saveGuestAccess(restrict ? tabs : null);
      const s = await syncAfterChange();
      setMsg(s.shared ? { ok: true, text: '저장되었습니다.' } : { ok: false, text: syncWarningText(s) });
    } catch (e) {
      setMsg({ ok: false, text: '저장 실패: ' + e.message });
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-2 mb-5">
      <p className="text-sm font-semibold text-gray-700">🔓 로그인하지 않았을 때</p>
      <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
        <input type="checkbox" checked={restrict} onChange={e => setRestrict(e.target.checked)} />
        보이는 메뉴 제한하기 (끄면 지금처럼 전체 메뉴가 보입니다)
      </label>
      {restrict && (
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 pl-0.5 pt-0.5">
          {guestMenu.map(item => (
            <label key={item.id} className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer select-none">
              <input type="checkbox" checked={tabs.includes(item.id)} onChange={() => toggleTab(item.id)} />
              {item.icon} {item.label}
            </label>
          ))}
        </div>
      )}
      {msg && <p className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-500'}`}>{msg.text}</p>}
      <button onClick={save} disabled={busy}
        className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded font-semibold hover:bg-blue-700 disabled:opacity-50">
        {busy ? '저장 중…' : '저장'}
      </button>
    </div>
  );
}

function MemberForm({ menu, form, setForm, onToggleTab, onSave, onCancel, busy, error, isNew, hasToken, onClearToken }) {
  return (
    <div className="p-3 space-y-2.5">
      <div className="flex gap-2">
        <input placeholder="사용자이름" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
          className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm" />
        <input type="password" placeholder={isNew ? '비밀번호' : '변경 시에만 입력'} value={form.password}
          onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
          className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm" />
      </div>
      <label className="flex items-center gap-1.5 text-xs text-amber-700 cursor-pointer select-none">
        <input type="checkbox" checked={form.isAdmin} onChange={e => setForm(f => ({ ...f, isAdmin: e.target.checked }))} />
        👑 관리자 권한 (이 계정으로 로그인하면 편집 권한도 함께 열립니다)
      </label>
      <div>
        <label className="text-[11px] text-gray-500">
          GitHub 토큰 (gist 권한 · 이 계정으로 로그인한 PC가 자동으로 씁니다)
          {hasToken && <span className="ml-1 text-green-600">✓ 등록됨</span>}
        </label>
        <div className="flex gap-2 mt-0.5">
          <input type="password" placeholder={hasToken ? '변경 시에만 입력' : 'ghp_... (선택 사항)'} value={form.token}
            onChange={e => setForm(f => ({ ...f, token: e.target.value }))}
            className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm" />
          {hasToken && !isNew && (
            <button onClick={onClearToken} type="button" className="text-xs px-2 text-red-500 hover:underline shrink-0">삭제</button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {menu.map(item => (
          <label key={item.id} className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer select-none">
            <input type="checkbox" checked={form.allowedTabs.includes(item.id)} onChange={() => onToggleTab(item.id)} />
            {item.icon} {item.label}
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button onClick={onSave} disabled={busy} className="flex-1 py-1.5 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700 disabled:opacity-50">
          {busy ? '저장 중…' : '저장'}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 border border-gray-200 rounded text-xs text-gray-600 hover:bg-gray-50">취소</button>
      </div>
    </div>
  );
}
