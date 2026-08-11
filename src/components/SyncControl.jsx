import { useState, useEffect, useCallback } from 'react';
import { syncGetConfig, syncSetConfig, syncUpload, syncPull, syncDiscardLocalAndPull, syncCreateGist, syncPublishLocal } from '../lib/api';

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
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const reload = useCallback(() => { syncGetConfig().then(setCfg).catch(() => {}); }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!window.electronAPI?.onSyncStatus) return;
    return window.electronAPI.onSyncStatus((s) => {
      setStatus(s);
      if (s.type === 'updated' || s.type === 'uploaded' || s.type === 'idle') reload();
    });
  }, [reload]);

  // 데이터가 바뀌면 설정을 다시 읽어 "이 PC에만 저장된 변경" 경고를 즉시 띄운다 —
  // 토큰이 없어 공유에 못 올라간 경우를 사용자가 바로 알아채게 하기 위함.
  useEffect(() => {
    if (!window.electronAPI?.onDataChanged) return;
    return window.electronAPI.onDataChanged(() => reload());
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
    try {
      const r = await syncPull();
      if (!r?.ok && r?.error) setStatus({ type: 'error', message: r.error });
      // 일정 동기화와 함께 앱 자체의 새 버전(업데이트 내역)도 같이 확인한다 —
      // 그동안 자동 확인(3분 주기)을 기다리지 않아도 바로 알 수 있게.
      window.electronAPI?.invoke?.('update:check');
    }
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

  async function doDiscardLocal() {
    setConfirmDiscard(false);
    setBusy(true);
    try {
      const r = await syncDiscardLocalAndPull();
      if (!r?.ok && r?.error) setStatus({ type: 'error', message: r.error });
      reload();
    } finally { setBusy(false); }
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
          {/* 이 PC에만 있는 변경 — 공유되지 않은 상태라 다른 PC에서는 안 보인다.
              조용히 놔두면 자동 동기화가 덮어써 사라지므로 눈에 띄게 알린다. */}
          {cfg?.pendingLocal && (
            <div className="mb-1.5 rounded bg-amber-500/15 border border-amber-500/40 px-2 py-1.5 leading-tight">
              <div className="text-amber-300">⚠ 이 PC에만 저장된 변경이 있습니다</div>
              <div className="text-amber-200/70 mt-0.5">
                공유하려면 GitHub 토큰이 필요합니다. 해결 전까지 내려받기는 멈춥니다(덮어쓰기 방지).
              </div>
              <button onClick={() => setConfirmDiscard(true)} disabled={busy}
                className="mt-1 text-amber-300 hover:text-amber-100 underline disabled:opacity-50">
                이 PC 변경 버리고 내려받기
              </button>
            </div>
          )}
          <button onClick={doPull} disabled={busy || onCooldown}
            title={onCooldown ? `너무 자주 요청하지 않도록 잠시 후 다시 시도하세요 (${cooldownLeft}초)` : undefined}
            className="w-full py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed">
            {busy ? '동기화 중…' : onCooldown ? `수동 동기화 (${Math.floor(cooldownLeft / 60)}:${String(cooldownLeft % 60).padStart(2, '0')})` : '수동 동기화'}
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

      {confirmDiscard && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[300] p-4" onClick={() => setConfirmDiscard(false)}>
          <div className="bg-white text-gray-800 rounded-xl shadow-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold mb-1.5">이 PC의 변경을 버릴까요?</p>
            <p className="text-xs text-gray-500 mb-4">
              공유에 올리지 못한 이 PC의 변경 내용이 원격(다른 PC와 공유 중인) 데이터로 덮어써집니다.
              되돌릴 수 없습니다.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDiscard(false)} className="px-3 py-1.5 border border-gray-300 rounded text-xs text-gray-600 hover:bg-gray-50">취소</button>
              <button onClick={doDiscardLocal} className="px-3 py-1.5 bg-red-500 text-white rounded text-xs font-semibold hover:bg-red-600">버리고 내려받기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsModal({ cfg, onClose, onStatus }) {
  const [gistId, setGistId] = useState(cfg?.gistId || '');
  const [token, setToken] = useState('');
  const [autoSync, setAutoSync] = useState(cfg?.autoSync !== false);
  const [intervalMin, setIntervalMin] = useState(cfg?.intervalMin || 5);
  const [isBasePC, setIsBasePC] = useState(cfg?.role === 'admin');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'publish' | 'adopt' | 'create'

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
      await syncSetConfig({ gistId: safeGistId, token: token || undefined, autoSync, intervalMin, role: isBasePC ? 'admin' : 'member' });
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

  // action: 'upload'(평소 업로드 — 원격과 합쳐서 올림)
  //       | 'create'(새 공유 Gist 만들기) | 'publish'(이 PC 기준으로 통일)
  async function runUpload(action) {
    setBusy(true);
    setMsg(null);
    setConfirm(null);
    try {
      // 업로드 전 최신 설정(토큰/gist) 저장
      await syncSetConfig({ gistId: safeGistId, token: token || undefined, autoSync, intervalMin, role: isBasePC ? 'admin' : 'member' });
      const fn = action === 'create' ? syncCreateGist : action === 'publish' ? syncPublishLocal : syncUpload;
      const r = await fn();
      if (r?.ok) {
        setGistId(r.gistId);
        onStatus?.({ type: 'uploaded', lastSyncedAt: r.updatedAt });
        setMsg({
          ok: true,
          text: action === 'publish' ? `이 PC 데이터로 통일했습니다. Gist ID: ${r.gistId}`
            : action === 'create' ? `새 공유를 만들었습니다. 다른 PC에도 이 Gist ID를 똑같이 입력하세요 — ${r.gistId}`
            : r.merged ? `공유 완료. 다른 PC의 변경과 합쳐서 올렸습니다.` : `공유 완료. Gist ID: ${r.gistId}`,
        });
      } else {
        setMsg({ ok: false, text: '업로드 실패: ' + (r?.error || '') });
      }
    } catch (e) { setMsg({ ok: false, text: '업로드 실패: ' + e.message }); }
    finally { setBusy(false); }
  }

  async function adoptRemote() {
    setBusy(true);
    setMsg(null);
    setConfirm(null);
    try {
      await syncSetConfig({ gistId: safeGistId, token: token || undefined, autoSync, intervalMin, role: isBasePC ? 'admin' : 'member' });
      const r = await syncDiscardLocalAndPull();
      if (r?.ok) {
        onStatus?.({ type: 'updated', lastSyncedAt: r.updatedAt });
        setMsg({ ok: true, text: '공유 데이터로 이 PC를 맞췄습니다.' });
      } else {
        setMsg({ ok: false, text: '내려받기 실패: ' + (r?.error || '') });
      }
    } catch (e) { setMsg({ ok: false, text: '내려받기 실패: ' + e.message }); }
    finally { setBusy(false); }
  }

  async function clearToken() {
    await syncSetConfig({ clearToken: true });
    setToken('');
    setMsg({ ok: true, text: '토큰이 삭제되었습니다.' });
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      {/* 내용이 길어 화면 밖으로 잘리지 않도록, 높이를 화면에 맞추고 본문만 스크롤한다.
          제목과 아래 버튼줄은 스크롤과 무관하게 항상 보이게 고정한다. */}
      <div className="bg-white text-gray-800 rounded-2xl shadow-2xl w-[420px] max-w-[92vw] max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="shrink-0 px-6 pt-5 pb-3 border-b border-gray-100">
          <h3 className="text-base font-bold mb-1">공유 동기화 설정</h3>
          <p className="text-xs text-gray-500">일정 데이터를 GitHub Gist로 공유합니다. 읽기는 모든 PC 가능, 업로드는 관리자(토큰 보유)만.</p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">

        <label className="block text-xs font-medium text-gray-600 mb-1">Gist ID</label>
        <div className="flex gap-1.5 mb-1">
          <input value={gistId} onChange={e => setGistId(e.target.value.trim())} placeholder="예: 1a2b3c4d... (공유받은 ID 입력)"
            className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
          <button type="button" disabled={!safeGistId}
            onClick={() => { navigator.clipboard?.writeText(safeGistId); setMsg({ ok: true, text: 'Gist ID를 복사했습니다. 다른 PC에 똑같이 입력하세요.' }); }}
            className="px-2 border border-gray-300 rounded text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40">복사</button>
        </div>
        <p className="text-[11px] text-blue-600 mb-3">
          ℹ <b>모든 PC가 똑같은 Gist ID</b>를 써야 하나의 데이터로 관리됩니다. ID가 다르면 PC마다 별도 데이터가 됩니다.
          또한 Gist는 <b>만든 GitHub 계정만 수정</b>할 수 있으므로, 각 PC에 등록하는 토큰은 모두
          <b> 이 Gist를 만든 그 GitHub 계정</b>에서 발급한 것이어야 합니다.
        </p>
        {!safeGistId && (
          <p className="text-[11px] text-red-500 mb-3">
            ⚠ Gist ID가 비어 있습니다. 이미 다른 PC에서 공유 중이라면 그 ID를 받아 입력하세요.
            처음 시작하는 경우에만 아래 "새 공유 만들기"를 누르세요.
          </p>
        )}

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
        <p className="text-[11px] text-gray-400 mb-3">일정 편집 권한은 사이드바의 "로그인"에서 관리자 계정으로 로그인하면 함께 열립니다.</p>

        {/* 어떤 PC의 내용이 "기준"이 되는지 정한다. 사용점 관리는 모든 PC가 함께
            쓰지만, 나머지 자료는 기준 PC의 내용이 공유 기준이 된다. */}
        <div className="border border-gray-200 rounded-lg p-2.5 mb-3">
          <label className="flex items-start gap-1.5 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={isBasePC} onChange={e => setIsBasePC(e.target.checked)} className="mt-0.5" />
            <span>
              <b>이 PC를 기준(관리자) PC로 사용</b>
              <span className="block text-[11px] text-gray-500 mt-0.5 font-normal">
                월간모니터링·구역별현황·간트차트·연간계획·교정관리·주간근무·계정설정은
                <b> 기준 PC의 내용만 공유에 반영</b>됩니다. 기준 PC는 <b>한 대만</b> 지정하세요.
              </span>
            </span>
          </label>
          <p className="text-[11px] text-gray-400 mt-1.5 pl-5">
            {isBasePC
              ? '✓ 이 PC에서 수정한 모든 자료가 공유에 반영됩니다.'
              : '이 PC에서는 사용점 관리만 공유에 반영됩니다(다른 자료는 기준 PC 내용을 받아 봅니다). 할일·메모는 어느 PC에서든 공유되지 않습니다.'}
          </p>
        </div>

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

        {/* PC마다 데이터가 갈라졌을 때 하나로 맞추는 도구 — 되돌릴 수 없어 확인창을 거친다. */}
        <div className="mt-4 pt-3 border-t border-gray-200">
          <p className="text-xs font-semibold text-gray-600 mb-1">🔧 데이터 하나로 통일하기</p>
          <p className="text-[11px] text-gray-400 mb-2">
            PC마다 데이터가 달라졌을 때 사용합니다. 기준으로 삼을 PC 한 대에서 "이 PC 기준으로 통일"을
            누른 뒤, 나머지 PC에서 각각 "공유 데이터로 맞추기"를 누르세요.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setConfirm('publish')} disabled={busy || !safeGistId}
              className="px-2.5 py-1.5 border border-amber-300 text-amber-700 bg-amber-50 rounded text-[11px] font-medium hover:bg-amber-100 disabled:opacity-40">
              이 PC 기준으로 통일
            </button>
            <button onClick={() => setConfirm('adopt')} disabled={busy || !safeGistId}
              className="px-2.5 py-1.5 border border-blue-300 text-blue-700 bg-blue-50 rounded text-[11px] font-medium hover:bg-blue-100 disabled:opacity-40">
              공유 데이터로 맞추기
            </button>
            <button onClick={() => setConfirm('create')} disabled={busy}
              className="px-2.5 py-1.5 border border-gray-300 text-gray-600 rounded text-[11px] hover:bg-gray-50 disabled:opacity-40">
              새 공유 만들기
            </button>
          </div>
        </div>
        </div>

        {/* 스크롤과 무관하게 항상 보이는 버튼줄 */}
        <div className="shrink-0 border-t border-gray-100 px-6 py-3">
          {msg && <div className={`text-xs mb-2 ${msg.ok ? 'text-green-600' : 'text-red-500'} break-all`}>{msg.text}</div>}
          <div className="flex gap-2">
            <button onClick={() => runUpload('upload')} disabled={busy || !safeGistId}
              title={safeGistId ? '이 PC의 변경을 공유에 올립니다(다른 PC 변경과 합쳐서).' : 'Gist ID를 먼저 입력하세요'}
              className="flex-1 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
              {busy ? '처리 중…' : '업로드(공유)'}
            </button>
            <button onClick={save} disabled={busy}
              className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">저장</button>
            <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">닫기</button>
          </div>
        </div>

        {confirm && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[310] p-4" onClick={() => setConfirm(null)}>
            <div className="bg-white rounded-xl shadow-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
              <p className="text-sm font-semibold mb-1.5">
                {confirm === 'publish' ? '이 PC 데이터로 통일할까요?'
                  : confirm === 'adopt' ? '공유 데이터로 이 PC를 맞출까요?'
                  : '새 공유를 만들까요?'}
              </p>
              <p className="text-xs text-gray-500 mb-4">
                {confirm === 'publish' ? '공유 데이터가 이 PC의 내용으로 통째로 덮어써집니다. 다른 PC에만 있던 내용은 사라집니다. 되돌릴 수 없습니다.'
                  : confirm === 'adopt' ? '이 PC의 데이터가 공유 데이터로 통째로 덮어써집니다. 이 PC에만 있던 내용은 사라집니다. 되돌릴 수 없습니다.'
                  : '새 Gist를 만들어 이 PC 데이터로 공유를 시작합니다. 기존 공유와는 별개가 되므로, 이미 다른 PC에서 공유 중이라면 그 Gist ID를 입력해 쓰는 것이 맞습니다.'}
              </p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setConfirm(null)} className="px-3 py-1.5 border border-gray-300 rounded text-xs text-gray-600 hover:bg-gray-50">취소</button>
                <button
                  onClick={() => confirm === 'adopt' ? adoptRemote() : runUpload(confirm === 'publish' ? 'publish' : 'create')}
                  className="px-3 py-1.5 bg-red-500 text-white rounded text-xs font-semibold hover:bg-red-600">
                  진행
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
