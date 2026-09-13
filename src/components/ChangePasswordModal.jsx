import { useState } from 'react';

// 재사용 가능한 "비밀번호 변경" 모달 — 관리자 비밀번호·계정(멤버) 비밀번호 둘 다
// 이 컴포넌트를 쓴다. 실제 변경 로직은 onSubmit(oldPassword, newPassword)에 맡긴다.
export default function ChangePasswordModal({ title, onSubmit, onClose }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 바꾸긴 했지만 다른 PC와 공유되지 않은 경우 — 그냥 닫아버리면 사용자는 성공한
  // 줄 알고 넘어가는데 실제로는 이 PC에만 남아, 다른 PC에서 로그인이 안 된다.
  const [shareWarning, setShareWarning] = useState('');

  async function submit() {
    setError('');
    if (!oldPassword) { setError('현재 비밀번호를 입력하세요.'); return; }
    if (!newPassword || newPassword.length < 4) { setError('새 비밀번호를 4자 이상 입력하세요.'); return; }
    if (newPassword !== confirm) { setError('새 비밀번호가 일치하지 않습니다.'); return; }
    setBusy(true);
    try {
      const r = await onSubmit(oldPassword, newPassword);
      if (!r?.ok) { setError(r?.error || '변경 실패'); return; }
      if (r.shareWarning) setShareWarning(r.shareWarning);
      else onClose(true);
    } catch (e) {
      setError('오류: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  if (shareWarning) {
    return (
      <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
          <div className="text-center mb-4">
            <div className="text-3xl mb-2">⚠️</div>
            <h2 className="text-base font-bold text-gray-900">이 PC에만 저장되었습니다</h2>
          </div>
          <p className="text-xs text-gray-600 leading-relaxed mb-5">{shareWarning}</p>
          <button onClick={() => onClose(true)}
            className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700">
            확인
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50" onClick={() => onClose(false)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <div className="text-center mb-5">
          <div className="text-3xl mb-2">🔑</div>
          <h2 className="text-base font-bold text-gray-900">{title}</h2>
        </div>

        <label className="block text-xs font-medium text-gray-600 mb-1">현재 비밀번호</label>
        <input autoFocus type="password" value={oldPassword} onChange={e => setOldPassword(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-blue-500" />

        <label className="block text-xs font-medium text-gray-600 mb-1">새 비밀번호</label>
        <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-blue-500" />

        <label className="block text-xs font-medium text-gray-600 mb-1">새 비밀번호 확인</label>
        <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-blue-500" />

        {error && <p className="text-xs text-red-500 mb-3">{error}</p>}

        <div className="flex gap-2">
          <button onClick={submit} disabled={busy}
            className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
            {busy ? '변경 중…' : '변경'}
          </button>
          <button onClick={() => onClose(false)} className="px-4 py-2.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">취소</button>
        </div>
      </div>
    </div>
  );
}
