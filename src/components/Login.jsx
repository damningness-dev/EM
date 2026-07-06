import { useState, useEffect } from 'react';
import { fetchUsers, upsertUser } from '../lib/api';

// 로컬 로그인: 이름 + 사번으로 사용자 명부(관리자가 관리)와 대조해 권한을 정한다.
// 명부가 비어있으면 첫 사용자를 관리자로 등록(초기 설정).
export default function Login({ onLogin }) {
  const [users, setUsers] = useState(null);
  const [name, setName] = useState('');
  const [empNo, setEmpNo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { fetchUsers().then(setUsers).catch(() => setUsers([])); }, []);

  const isFirstSetup = users && users.length === 0;

  async function submit() {
    setError('');
    const n = name.trim(), e = empNo.trim();
    if (!n || !e) { setError('이름과 사번을 입력하세요.'); return; }
    setBusy(true);
    try {
      if (isFirstSetup) {
        // 첫 사용자 = 관리자 등록
        const r = await upsertUser({ empNo: e, name: n, role: 'admin' });
        if (r?.ok) { window.electronAPI?.notifyDataChanged?.(); onLogin(r.user); }
        else setError(r?.error || '등록 실패');
      } else {
        const match = users.find(u => String(u.empNo) === e && (u.name || '').trim() === n);
        if (match) onLogin({ empNo: match.empNo, name: match.name, role: match.role });
        else setError('등록되지 않은 사용자입니다. 관리자에게 문의하세요.');
      }
    } catch (err) { setError('오류: ' + err.message); }
    finally { setBusy(false); }
  }

  if (users === null) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-8">
        <div className="text-center mb-6">
          <div className="text-3xl mb-2">🧪</div>
          <h1 className="text-lg font-bold text-gray-900">환경 모니터링</h1>
          <p className="text-xs text-gray-500 mt-1">
            {isFirstSetup ? '초기 관리자 등록 (첫 사용자는 관리자로 등록됩니다)' : '이름과 사번으로 로그인'}
          </p>
        </div>

        <label className="block text-xs font-medium text-gray-600 mb-1">이름</label>
        <input autoFocus value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="예: 홍길동" />

        <label className="block text-xs font-medium text-gray-600 mb-1">사번</label>
        <input value={empNo} onChange={e => setEmpNo(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="예: 12345" />

        {error && <p className="text-xs text-red-500 mb-3">{error}</p>}

        <button onClick={submit} disabled={busy}
          className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
          {busy ? '처리 중…' : isFirstSetup ? '관리자로 시작' : '로그인'}
        </button>

        {!isFirstSetup && (
          <p className="text-[11px] text-gray-400 mt-3 text-center">
            목록에 없다면 관리자에게 사용자 등록을 요청하세요.
          </p>
        )}
      </div>
    </div>
  );
}
