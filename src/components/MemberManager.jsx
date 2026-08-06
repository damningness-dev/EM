import { useState, useEffect } from 'react';
import { fetchMembers, upsertMember, deleteMember } from '../lib/api';

// 관리자 전용 — 로그인 계정(멤버)을 만들고, 계정마다 사이드바에 보일 탭 메뉴를
// 체크박스로 골라 지정한다. 관리자 잠금 해제 상태에서만 열 수 있다.
export default function MemberManager({ menu, onClose }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null); // null이면 새 계정 추가 폼 숨김, 'new'면 추가 폼
  const [form, setForm] = useState({ username: '', password: '', allowedTabs: [], token: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function reload() {
    setLoading(true);
    fetchMembers().then(m => { setMembers(m || []); setLoading(false); }).catch(() => setLoading(false));
  }
  useEffect(() => { reload(); }, []);

  function startAdd() {
    setEditingId('new');
    setForm({ username: '', password: '', allowedTabs: menu.map(m => m.id), token: '' });
    setError('');
  }
  function startEdit(m) {
    setEditingId(m.id);
    setForm({ username: m.username, password: '', allowedTabs: [...(m.allowedTabs || [])], token: '' });
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
      const payload = { username: form.username.trim(), allowedTabs: form.allowedTabs };
      if (form.password) payload.password = form.password;
      if (form.token) payload.token = form.token;
      if (editingId !== 'new') payload.id = editingId;
      const r = await upsertMember(payload);
      if (!r?.ok) { setError(r?.error || '저장 실패'); return; }
      setEditingId(null);
      reload();
    } catch (e) { setError('오류: ' + e.message); }
    finally { setBusy(false); }
  }

  async function remove(id) {
    if (!confirm('이 계정을 삭제하시겠습니까?')) return;
    await deleteMember(id);
    reload();
  }

  async function clearToken(id) {
    if (!confirm('이 계정의 토큰을 삭제하시겠습니까?')) return;
    setBusy(true);
    try { await upsertMember({ id, clearToken: true }); reload(); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <h2 className="text-base font-bold text-gray-900">👥 사용자 계정 관리</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <p className="text-xs text-gray-400 mb-3">
            계정을 만들어 사용자이름·비밀번호와 허용할 탭 메뉴를 지정하세요. 로그인은 필수가
            아니며, 로그인하지 않으면 지금처럼 전체 메뉴가 보입니다.
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
                          {m.username}
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
