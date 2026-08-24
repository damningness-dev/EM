import { useState } from 'react';
import { memberLogin } from '../lib/api';

// 사용자이름/비밀번호로 로그인하는 모달. 로그인은 필수가 아니며, 로그인하면
// 그 계정에 허용된 탭 메뉴만 사이드바에 보이게 된다. 계정에 관리자 권한(isAdmin)이
// 있으면 로그인 자체가 곧 관리자 권한(편집 권한)도 함께 연다 — 별도의 관리자
// 잠금 해제 절차가 없다.
export default function Login({ onClose, onLoggedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError('');
    if (!username.trim() || !password) { setError('사용자이름과 비밀번호를 입력하세요.'); return; }
    setBusy(true);
    try {
      const r = await memberLogin(username.trim(), password);
      if (r?.ok) onLoggedIn(r.member, remember);
      else if (r?.syncFailed) setError('최신 계정 정보를 확인하지 못했습니다(인터넷 연결 확인). 다른 PC에서 방금 바뀐 비밀번호라면 연결 후 다시 시도하세요. ' + (r?.error || ''));
      else setError(r?.error || '로그인 실패');
    } catch (err) { setError('오류: ' + err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <div className="text-center mb-5">
          <div className="text-3xl mb-2">🔒</div>
          <h2 className="text-base font-bold text-gray-900">로그인</h2>
          <p className="text-xs text-gray-500 mt-1">로그인하면 계정에 허용된 메뉴만 표시됩니다. 관리자 계정은 로그인만으로 편집 권한도 함께 열립니다.</p>
        </div>

        <label className="block text-xs font-medium text-gray-600 mb-1">사용자이름</label>
        <input
          autoFocus
          value={username}
          onChange={e => setUsername(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <label className="block text-xs font-medium text-gray-600 mb-1">비밀번호</label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <label className="flex items-center gap-1.5 text-xs text-gray-600 mb-3 cursor-pointer select-none">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          이 PC에서 자동 로그인 (다음에 앱을 열 때 다시 로그인하지 않아도 됩니다)
        </label>

        {error && <p className="text-xs text-red-500 mb-3">{error}</p>}

        <div className="flex gap-2">
          <button onClick={submit} disabled={busy}
            className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
            {busy ? '확인 중…' : '로그인'}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">취소</button>
        </div>
      </div>
    </div>
  );
}
