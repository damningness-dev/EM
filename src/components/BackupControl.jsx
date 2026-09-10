import { useState } from 'react';
import { backupExport, backupImport, restartApp } from '../lib/api';

// 사이드바 하단의 로컬 백업 컨트롤 — 구역/그룹/모니터링/완료/계정/할일 등
// 이 프로그램의 모든 데이터를 파일 하나로 내보내거나, 그 파일로 되돌린다.
// 공유동기화 설정(Gist ID·GitHub 토큰)은 자격정보라 백업에 포함되지 않는다.
// 내보내기는 읽기 전용이라 누구나 쓸 수 있지만, 복원은 현재 데이터를 통째로
// 덮어쓰는 되돌릴 수 없는 작업이라 관리자 잠금 해제 상태에서만 허용한다.
export default function BackupControl({ adminUnlocked }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restored, setRestored] = useState(false);

  if (!window.electronAPI) return null; // 웹에서는 미표시

  async function doExport() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await backupExport();
      if (r?.canceled) { setMsg(null); return; }
      setMsg(r?.ok
        ? { ok: true, text: `백업 저장 완료: ${r.filePath}` }
        : { ok: false, text: '백업 실패: ' + (r?.error || '') });
    } catch (e) {
      setMsg({ ok: false, text: '백업 실패: ' + e.message });
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    setConfirmRestore(false);
    setBusy(true);
    setMsg(null);
    try {
      const r = await backupImport();
      if (r?.canceled) { setMsg(null); return; }
      if (r?.ok) {
        setMsg({ ok: true, text: `복원 완료 (백업 시각: ${r.exportedAt ? new Date(r.exportedAt).toLocaleString('ko-KR') : '알 수 없음'}). 재시작해야 모든 화면에 반영됩니다.` });
        setRestored(true);
      } else {
        setMsg({ ok: false, text: '복원 실패: ' + (r?.error || '') });
      }
    } catch (e) {
      setMsg({ ok: false, text: '복원 실패: ' + e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-3 border-t border-gray-700 text-xs">
      <div className="text-gray-400 mb-1.5">💾 로컬 백업</div>
      <div className="flex gap-1.5">
        <button onClick={doExport} disabled={busy}
          className="flex-1 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed">
          백업 저장
        </button>
        <button onClick={() => setConfirmRestore(true)} disabled={busy || !adminUnlocked}
          title={adminUnlocked ? '백업 파일로 현재 데이터를 되돌립니다' : '관리자 잠금 해제가 필요합니다'}
          className="flex-1 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed">
          {adminUnlocked ? '백업 복원' : '🔒 백업 복원'}
        </button>
      </div>

      {msg && (
        <div className={`mt-1.5 break-all ${msg.ok ? 'text-blue-400' : 'text-red-400'}`}>{msg.text}</div>
      )}
      {restored && (
        <button onClick={() => restartApp()}
          className="mt-1.5 w-full py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white font-medium">
          지금 재시작
        </button>
      )}

      {confirmRestore && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[310] p-4" onClick={() => setConfirmRestore(false)}>
          <div className="bg-white text-gray-800 rounded-xl shadow-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold mb-1.5">백업 파일로 복원할까요?</p>
            <p className="text-xs text-gray-500 mb-4">
              현재 이 프로그램에 저장된 모든 데이터(구역·모니터링·완료·계정·할일 등)가
              선택한 백업 파일 내용으로 통째로 덮어써집니다. 되돌릴 수 없으니,
              필요하면 먼저 "백업 저장"으로 현재 상태를 저장해 두세요.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmRestore(false)} className="px-3 py-1.5 border border-gray-300 rounded text-xs text-gray-600 hover:bg-gray-50">취소</button>
              <button onClick={doImport} className="px-3 py-1.5 bg-red-500 text-white rounded text-xs font-semibold hover:bg-red-600">
                파일 선택 후 복원
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
