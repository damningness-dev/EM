import { useState, useEffect, useCallback } from 'react';
import { syncGetConfig, syncSetConfig, syncUpload, syncPull } from '../lib/api';

const PULL_COOLDOWN_MS = 3 * 60 * 1000; // "지금 동기화" 버튼 쿨타임 — 아래 설명 참고

// 사이드바 하단의 공유 동기화 컨트롤.
// 백그라운드 자동 동기화(주기적 내려받기)는 관리자 잠금과 무관하게 항상 동작한다.
// "지금 동기화"(수동 내려받기)는 읽기 전용 동작이라 관리자 잠금 없이 누구나 쓸 수
// 있지만, 여러 사람이 연달아 눌러 GitHub 비인증 요청 시간당 60회 한도를 금방
// 소진하지 않도록 3분 쿨타임을 둔다. 설정(⚙)·업로드처럼 Gist/토큰을 바꾸는
// 버튼은 계속 관리자 잠금 해제 상태에서만 활성화된다.
export default function SyncControl({ adminUnlocked }) {
  const [cfg, setCfg] = useState(null);          // { gistId, hasToken, autoSync, intervalMin, lastSyncedAt }
  const [status, setStatus] = useState(null);    // { type, message, lastSyncedAt }
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(() => { syncGetConfig().then(setCfg).catch(() => {}); }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!window.electronAPI?.onSyncStatus) return;
    return window.electronAPI.onSyncStatus((s) => {
      setStatus(s);
      if (s.type === 'updated' || s.type === 'uploaded' || s.type === 'idle') reload();
    });
  }, [reload]);

  // 쿨타임 표시용 1초 틱 — 쿨타임이 없을 땐 타이머를 돌리지 않는다.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cooldownUntil]);

  if (!window.electronAPI) return null; // 웹에서는 미표시

  const lastSynced = status?.lastSyncedAt || cfg?.lastSyncedAt;
  const lastText = lastSynced ? new Date(lastSynced).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '없음';
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const onCooldown = cooldownLeft > 0;

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
    if (busy || onCooldown) return;
    setBusy(true);
    try { const r = await syncPull(); if (!r?.ok && r?.error) setStatus({ type: 'error', message: r.error }); }
    finally {
      setBusy(false);
      setCooldownUntil(Date.now() + PULL_COOLDOWN_MS);
      setNow(Date.now());
    }
  }

  function openSettings() {
    if (!adminUnlocked) return;
    setShowSettings(true);
  }

  return (
    <div className="px-4 py-3 border-t border-gray-700 text-xs">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-gray-400">🔄 공유 동기화</span>
        <button onClick={openSettings} disabled={!adminUnlocked}
          className="text-gray-500 hover:text-gray-200 disabled:text-gray-700 disabled:cursor-not-allowed"
          title={adminUnlocked ? '동기화 설정' : '관리자 잠금 해제가 필요합니다'}>⚙</button>
      </div>
      {cfg?.gistId ? (
        <>
          <div className="text-gray-500 mb-1.5 leading-tight">
            최근: {lastText}{cfg.autoSync ? ` · 자동 ${cfg.intervalMin}분` : ' · 자동 꺼짐'}
          </div>
          {statusText && <div className={`mb-1.5 ${status?.type === 'error' ? 'text-red-400' : 'text-blue-400'}`}>{statusText}</div>}
          <button onClick={doPull} disabled={busy || onCooldown}
            title={onCooldown ? `너무 자주 요청하지 않도록 잠시 후 다시 시도하세요 (${cooldownLeft}초)` : undefined}
            className="w-full py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed">
            {busy ? '동기화 중…' : onCooldown ? `잠시 후 다시 (${Math.floor(cooldownLeft / 60)}:${String(cooldownLeft % 60).padStart(2, '0')})` : '지금 동기화'}
          </button>
        </>
      ) : (
        <button onClick={openSettings} disabled={!adminUnlocked}
          title={adminUnlocked ? undefined : '관리자 잠금 해제가 필요합니다'}
          className="w-full py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed">
          {adminUnlocked ? '공유 설정하기' : '🔒 공유 설정하기'}
        </button>
      )}

      {showSettings && adminUnlocked && <SettingsModal cfg={cfg} onClose={() => { setShowSettings(false); reload(); }} onStatus={setStatus} />}
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

  // 입력칸의 gistId가 비어있는데 이미 저장된 gistId(cfg)가 있다면, 설정창이 cfg
  // 로딩 완료 전에 열려 입력칸이 빈 채로 초기화된 경우다. 이때 그대로 저장하면
  // 서버(main 프로세스)가 "gistId 없음"으로 판단해 매번 새 Gist를 만들어 버려
  // 기존 공유 Gist ID가 계속 바뀌는 문제가 생긴다 — 항상 기존 값을 지켜준다.
  const safeGistId = gistId || cfg?.gistId || '';

  // cfg가 모달이 열린 뒤 뒤늦게 로딩되면(위 레이스), 입력칸도 빈 채로 남아있지
  // 않도록 실제 저장된 값을 따라가게 한다. 사용자가 이미 뭔가 입력해 놨다면
  // (gistId가 비어있지 않으면) 건드리지 않는다.
  useEffect(() => {
    if (!gistId && cfg?.gistId) setGistId(cfg.gistId);
  }, [cfg?.gistId]);

  async function save() {
    // 최초로 Gist ID를 설정하는 경우(이전엔 없었는데 새로 입력) 저장 직후
    // 바로 한 번 동기화(내려받기)까지 자동으로 진행해, 별도로 "지금 동기화"를
    // 다시 누르지 않아도 바로 일정이 반영되게 한다.
    const isFirstSetup = !cfg?.gistId && !!safeGistId;
    setBusy(true);
    try {
      await syncSetConfig({ gistId: safeGistId, token: token || undefined, autoSync, intervalMin });
      if (!isFirstSetup) {
        setMsg({ ok: true, text: '저장되었습니다.' });
        return;
      }
      setMsg({ ok: true, text: '저장되었습니다. 동기화하는 중...' });
      const r = await syncPull();
      if (r?.ok) {
        onStatus?.({ type: r.updated ? 'updated' : 'idle', lastSyncedAt: r.updatedAt || cfg?.lastSyncedAt });
        setMsg({ ok: true, text: r.updated ? '저장 및 동기화 완료. 일정이 반영되었습니다.' : '저장 및 동기화 완료.' });
      } else {
        setMsg({ ok: false, text: '저장은 되었지만 동기화 실패: ' + (r?.error || '') + ' — "지금 동기화"로 다시 시도하세요.' });
      }
    } catch (e) { setMsg({ ok: false, text: '저장 실패: ' + e.message }); }
    finally { setBusy(false); }
  }

  async function upload() {
    setBusy(true);
    setMsg(null);
    try {
      // 업로드 전 최신 설정(토큰/gist) 저장
      await syncSetConfig({ gistId: safeGistId, token: token || undefined, autoSync, intervalMin });
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
        <p className="text-[11px] text-amber-600 mb-1">
          ⚠ 반드시 <b>Classic 토큰</b>(ghp_로 시작, gist 권한 체크)을 사용하세요.
          Fine-grained 토큰은 Gist를 지원하지 않아 업로드 시 HTTP 403 오류가 납니다.
          (github.com → Settings → Developer settings → Personal access tokens → <b>Tokens (classic)</b>)
        </p>
        <p className="text-[11px] text-gray-400 mb-3">일정 편집 권한은 사이드바의 "관리자 잠금 해제"에서 비밀번호로 관리합니다.</p>

        <div className="flex items-center gap-3 mt-2 mb-1">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={autoSync} onChange={e => setAutoSync(e.target.checked)} /> 자동 동기화
          </label>
          <label className="flex items-center gap-1 text-sm text-gray-600">
            주기
            <input type="number" min="3" max="180" value={intervalMin} onChange={e => setIntervalMin(Math.max(3, parseInt(e.target.value) || 5))}
              className="w-14 border border-gray-300 rounded px-1.5 py-1 text-center text-sm" /> 분
          </label>
        </div>
        <p className="text-[11px] text-gray-400 mb-3">
          토큰 없이 읽기만 하는 PC는 같은 네트워크(IP)에서 시간당 60회로 GitHub 요청이 제한됩니다.
          읽는 PC가 여러 대면 주기를 5~10분 이상으로 넉넉히 설정하세요(1분처럼 너무 짧으면 여러 PC 합산 요청이
          한도를 넘어 "API rate limit exceeded" 오류가 날 수 있습니다).
        </p>

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
