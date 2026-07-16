import { useState, useEffect } from 'react';
import { adminHasPassword, adminSetPassword, adminUnlock } from '../lib/api';

// 관리자 비밀번호 입력(잠금 해제) / 최초 설정 모달.
// 비밀번호가 아직 없으면 최초 설정 화면, 있으면 잠금 해제 화면을 보여준다.
export default function AdminLock({ onUnlocked, onClose }) {
  const [hasPassword, setHasPassword] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { adminHasPassword().then(setHasPassword).catch(() => setHasPassword(false)); }, []);

  async function submit() {
    setError('');
    if (hasPassword) {
      if (!password) { setError('비밀번호를 입력하세요.'); return; }
      setBusy(true);
      try {
        const r = await adminUnlock(password);
        if (r?.ok) onUnlocked();
        else setError(r?.error || '잠금 해제 실패');
      } catch (err) { setError('오류: ' + err.message); }
      finally { setBusy(false); }
    } else {
      if (!password || password.length < 4) { setError('비밀번호를 4자 이상 입력하세요.'); return; }
      if (password !== confirm) { setError('비밀번호가 일치하지 않습니다.'); return; }
      setBusy(true);
      try {
        const r = await adminSetPassword(password);
        if (r?.ok) onUnlocked();
        else setError(r?.error || '설정 실패');
      } catch (err) { setError('오류: ' + err.message); }
      finally { setBusy(false); }
    }
  }

  if (hasPassword === null) {
    return (
      <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <div className="text-center mb-5">
          <div className="text-3xl mb-2">🔒</div>
          <h2 className="text-base font-bold text-gray-900">{hasPassword ? '관리자 잠금 해제' : '관리자 비밀번호 설정'}</h2>
          <p className="text-xs text-gray-500 mt-1">
            {hasPassword
              ? '일정 변경 및 일정 관리 권한을 사용하려면 비밀번호를 입력하세요.'
              : '최초 설정입니다. 일정 편집 권한을 보호할 관리자 비밀번호를 정하세요.'}
          </p>
        </div>

        <label className="block text-xs font-medium text-gray-600 mb-1">{hasPassword ? '비밀번호' : '새 비밀번호'}</label>
        <input
          autoFocus
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && hasPassword) submit(); }}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        {!hasPassword && (
          <>
            <label className="block text-xs font-medium text-gray-600 mb-1">비밀번호 확인</label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </>
        )}

        {error && <p className="text-xs text-red-500 mb-3">{error}</p>}

        <div className="flex gap-2">
          <button onClick={submit} disabled={busy}
            className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
            {busy ? '처리 중…' : hasPassword ? '잠금 해제' : '설정하고 시작'}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">취소</button>
        </div>
      </div>
    </div>
  );
}
