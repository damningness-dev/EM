import { useState } from 'react';
import { syncFindGist, syncSetConfig, syncPull, fetchMembers } from '../lib/api';

// 처음 설치한 PC(공유 설정이 아직 없음)에서 한 번 보여주는 설정 창.
// 팀이 공유하는 GitHub 토큰을 입력하면 그 계정에서 공유 데이터(Gist)를 찾아 연결하고, 공유된
// 계정(로그인 정보)을 받아온 뒤 곧바로 로그인할 수 있게 한다. Gist ID를 아는 경우 직접 입력해도 된다.
export default function FirstRunSetup({ onDone, onSkip }) {
  const [token, setToken] = useState('');
  const [gistId, setGistId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState('');           // 진행 안내
  const [choices, setChoices] = useState(null);   // 후보가 여럿일 때 [{ id, updatedAt, description }]

  async function connect(id) {
    setStep('공유 데이터를 받아오는 중…');
    const c = await syncSetConfig({ token: token.trim(), gistId: id });
    if (c && c.ok === false) throw new Error(c.error || '설정을 저장하지 못했습니다');
    const r = await syncPull();
    if (!r?.ok) {
      // 받아오지 못했으면 잘못된 Gist를 가리킨 채 남지 않도록 연결을 되돌린다.
      await syncSetConfig({ gistId: '' }).catch(() => {});
      throw new Error(r?.error || '공유 데이터를 받아오지 못했습니다');
    }
    const members = await fetchMembers().catch(() => []);
    if (!members || members.length === 0) {
      await syncSetConfig({ gistId: '' }).catch(() => {});
      throw new Error('공유 데이터에 계정이 없습니다. 올바른 공유(Gist)인지 확인하세요.');
    }
    onDone(members.length);
  }

  async function start() {
    setError(''); setChoices(null);
    if (!token.trim()) { setError('토큰을 입력하세요.'); return; }
    setBusy(true);
    try {
      let id = gistId.trim();
      if (!id) {
        setStep('토큰으로 공유 데이터를 찾는 중…');
        const f = await syncFindGist(token.trim());
        if (!f?.ok) throw new Error(f?.error || '공유 데이터를 찾지 못했습니다');
        if (f.candidates.length === 0) throw new Error('이 토큰의 GitHub 계정에서 공유 데이터를 찾지 못했습니다. 팀에서 쓰는 토큰이 맞는지 확인하거나, 아래에 Gist ID를 직접 입력하세요.');
        if (f.candidates.length > 1) { setChoices(f.candidates); setStep(''); setBusy(false); return; }
        id = f.candidates[0].id;
      }
      await connect(id);
    } catch (e) {
      setError(e.message || String(e));
      setStep('');
      setBusy(false);
    }
  }

  async function pick(id) {
    setBusy(true); setError('');
    try { await connect(id); }
    catch (e) { setError(e.message || String(e)); setStep(''); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/60">
      <div className="bg-white rounded-2xl shadow-2xl w-[30rem] max-w-[95vw] p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-1">🔄 공유 동기화 설정</h2>
        <p className="text-sm text-gray-500 mb-4 leading-relaxed">
          처음 실행하셨습니다. 팀에서 쓰는 <b>GitHub 토큰</b>을 입력하면 공유 데이터에서 계정(로그인 정보)을 불러와 바로 로그인할 수 있습니다.
        </p>

        <label className="block text-xs font-medium text-gray-600 mb-1">GitHub 토큰 (gist 권한)</label>
        <input type="password" autoFocus value={token} onChange={e => setToken(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !busy) start(); }}
          placeholder="ghp_..." disabled={busy}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-400" />

        <label className="block text-xs font-medium text-gray-600 mb-1">Gist ID <span className="text-gray-400 font-normal">(선택 — 비워두면 토큰으로 자동으로 찾습니다)</span></label>
        <input value={gistId} onChange={e => setGistId(e.target.value)} disabled={busy}
          onKeyDown={e => { if (e.key === 'Enter' && !busy) start(); }}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 font-mono focus:outline-none focus:ring-2 focus:ring-blue-400" />

        {choices && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5">
            <p className="text-xs text-amber-800 mb-1.5">공유 데이터가 여러 개 있습니다. 팀에서 쓰는 것을 고르세요(최근 수정순).</p>
            <div className="space-y-1">
              {choices.map(c => (
                <button key={c.id} disabled={busy} onClick={() => pick(c.id)}
                  className="w-full text-left text-xs px-2 py-1.5 rounded border border-amber-200 bg-white hover:bg-amber-100 disabled:opacity-50">
                  <span className="font-mono">{c.id.slice(0, 10)}…</span>
                  <span className="text-gray-400 ml-2">{c.updatedAt ? c.updatedAt.slice(0, 16).replace('T', ' ') : ''}</span>
                  {c.description && <span className="text-gray-500 ml-2">{c.description}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {step && <p className="text-xs text-blue-600 mb-2">{step}</p>}
        {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3 break-words">{error}</p>}

        <div className="flex items-center gap-2">
          <button onClick={onSkip} disabled={busy} className="text-xs text-gray-400 hover:text-gray-600 underline disabled:opacity-50">나중에 설정</button>
          <button onClick={start} disabled={busy || !token.trim()}
            className="ml-auto px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
            {busy ? '불러오는 중…' : '불러오기'}
          </button>
        </div>
      </div>
    </div>
  );
}
