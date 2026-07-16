import { useState, useEffect, useCallback } from 'react';
import { syncGetConfig, syncSetConfig, syncUpload, syncPull } from '../lib/api';

// 사이드바 하단의 공유 동기화 컨트롤.
// 읽기(내려받기)는 모든 PC, 업로드(공유)는 토큰이 있는 관리자만.
export default function SyncControl() {
  const [cfg, setCfg] = useState(null);          // { gistId, hasToken, autoSync, intervalMin, lastSyncedAt }
  const [status, setStatus] = useState(null);    // { type, message, lastSyncedAt }
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => { syncGetConfig().then(setCfg).catch(() => {}); }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!window.electronAPI?.onSyncStatus) return;
    return window.electronAPI.onSyncStatus((s) => {
      setStatus(s);
      if (s.type === 'updated' || s.type === 'uploaded' || s.type === 'idle') reload();
    });
  }, [reload]);

  if (!window.electronAPI) return null; // 웹에서는 미표시

  const lastSynced = status?.lastSyncedAt || cfg?.lastSyncedAt;
  const lastText = lastSynced ? new Date(lastSynced).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '없음';

  const statusText = (() => {
    switch (status?.type) {
      case 'checking': return '확인 중…';
      case 'uploading': return '업로드 중…';
      case 'updated': return '최신 데이터 반영됨';
      case 'uploaded': return '공유 완료';
      case 'error': return `오류: ${status.message || ''}`;
      default: return null;
    }
  })();

  async function doPull() {
    setBusy(true);
    try { const r = await syncPull(); if (!r?.ok && r?.error) setStatus({ type: 'error', message: r.error }); }
    finally { setBusy(false); }
  }

  return (
    <div className="px-4 py-3 border-t border-gray-700 text-xs">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-gray-400">🔄 공유 동기화</span>
        <button onClick={() => setShowSettings(true)} className="text-gray-500 hover:text-gray-200" title="동기화 설정">⚙</button>
      </div>
      {cfg?.gistId ? (
        <>
          <div className="text-gray-500 mb-1.5 leading-tight">
            최근: {lastText}{cfg.autoSync ? ` · 자동 ${cfg.intervalMin}분` : ' · 자동 꺼짐'}
          </div>
          {statusText && <div className={`mb-1.5 ${status?.type === 'error' ? 'text-red-400' : 'text-blue-400'}`}>{statusText}</div>}
          <button onClick={doPull} disabled={busy}
            className="w-full py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50">
            {busy ? '동기화 중…' : '지금 동기화'}
          </button>
        </>
      ) : (
        <button onClick={() => setShowSettings(true)} className="w-full py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200">
          공유 설정하기
        </button>
      )}

      {showSettings && <SettingsModal cfg={cfg} onClose={() => { setShowSettings(false); reload(); }} onStatus={setStatus} />}
    </div>
  );
}

function SettingsModal({ cfg, onClose, onStatus }) {
  const [gistId, setGistId] = useState(cfg?.gistId || '');
  const [token, setToken] = useState('');
  const [autoSync, setAutoSync] = useState(cfg?.autoSync !== false);
  const [intervalMin, setIntervalMin] = useState(cfg?.intervalMin || 5);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function save() {
    setBusy(true);
    try {
      await syncSetConfig({ gistId, token: token || undefined, autoSync, intervalMin });
      setMsg({ ok: true, text: '저장되었습니다.' });
    } catch (e) { setMsg({ ok: false, text: '저장 실패: ' + e.message }); }
    finally { setBusy(false); }
  }

  async function upload() {
    setBusy(true);
    setMsg(null);
    try {
      // 업로드 전 최신 설정(토큰/gist) 저장
      await syncSetConfig({ gistId, token: token || undefined, autoSync, intervalMin });
      const r = await syncUpload();
      if (r?.ok) {
        setGistId(r.gistId);
        onStatus?.({ type: 'uploaded', lastSyncedAt: r.updatedAt });
        setMsg({ ok: true, text: `공유 완료. Gist ID: ${r.gistId}` });
      } else {
        setMsg({ ok: false, text: '업로드 실패: ' + (r?.error || '') });
      }
    } catch (e) { setMsg({ ok: false, text: '업로드 실패: ' + e.message }); }
    finally { setBusy(false); }
  }

  async function clearToken() {
    await syncSetConfig({ clearToken: true });
    setToken('');
    setMsg({ ok: true, text: '토큰이 삭제되었습니다.' });
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white text-gray-800 rounded-2xl shadow-2xl w-[420px] max-w-[92vw] p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-bold mb-1">공유 동기화 설정</h3>
        <p className="text-xs text-gray-500 mb-4">일정 데이터를 GitHub Gist로 공유합니다. 읽기는 모든 PC 가능, 업로드는 관리자(토큰 보유)만.</p>

        <label className="block text-xs font-medium text-gray-600 mb-1">Gist ID</label>
        <input value={gistId} onChange={e => setGistId(e.target.value.trim())} placeholder="예: 1a2b3c4d... (공유받은 ID 입력)"
          className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-blue-500" />

        <label className="block text-xs font-medium text-gray-600 mb-1">
          GitHub 토큰 (관리자만 · gist 권한)
          {cfg?.hasToken && <span className="ml-1 text-green-600">✓ 저장됨</span>}
        </label>
        <input type="password" value={token} onChange={e => setToken(e.target.value)}
          placeholder={cfg?.hasToken ? '변경 시에만 입력' : 'ghp_... (업로드하려면 필요)'}
          className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-1 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        {cfg?.hasToken && <button onClick={clearToken} className="text-[11px] text-red-500 hover:underline mb-3">토큰 삭제</button>}
        <p className="text-[11px] text-gray-400 mb-3">일정 편집 권한은 사이드바의 "관리자 잠금 해제"에서 비밀번호로 관리합니다.</p>

        <div className="flex items-center gap-3 mt-2 mb-4">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={autoSync} onChange={e => setAutoSync(e.target.checked)} /> 자동 동기화
          </label>
          <label className="flex items-center gap-1 text-sm text-gray-600">
            주기
            <input type="number" min="1" max="180" value={intervalMin} onChange={e => setIntervalMin(Math.max(1, parseInt(e.target.value) || 5))}
              className="w-14 border border-gray-300 rounded px-1.5 py-1 text-center text-sm" /> 분
          </label>
        </div>

        {msg && <div className={`text-xs mb-3 ${msg.ok ? 'text-green-600' : 'text-red-500'} break-all`}>{msg.text}</div>}

        <div className="flex gap-2">
          <button onClick={upload} disabled={busy}
            className="flex-1 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
            {busy ? '처리 중…' : '업로드(공유)'}
          </button>
          <button onClick={save} disabled={busy}
            className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">저장</button>
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">닫기</button>
        </div>
      </div>
    </div>
  );
}
