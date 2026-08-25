import { useState, useEffect } from 'react';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

export default function UpdateNotifier() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!isElectron) return;
    const unsubscribe = window.electronAPI.onUpdateStatus(setStatus);
    return unsubscribe;
  }, []);

  if (!status || status.type === 'latest' || status.type === 'checking') return null;

  return (
    <div className={`mx-3 mb-3 rounded-lg text-xs overflow-hidden ${getBg(status.type)}`}>
      {status.type === 'downloading' && (
        <div className="p-3">
          <div className="font-semibold text-white mb-2">
            ⬇️ 다운로드 중... {status.percent}%
          </div>
          <div className="w-full bg-white/20 rounded-full h-1.5 mb-1">
            <div
              className="bg-white h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${status.percent}%` }}
            />
          </div>
          <div className="text-white/70">
            {status.transferred}MB / {status.total}MB
            &nbsp;({status.speed} KB/s)
          </div>
        </div>
      )}

      {status.type === 'downloaded' && (
        <div className="p-3">
          <div className="font-semibold text-white mb-1">
            ✅ v{status.version} 준비 완료
          </div>
          <div className="text-white/80 mb-2">재시작하면 업데이트됩니다.</div>
          <button
            onClick={() => window.electronAPI.invoke('update:install')}
            className="w-full py-1.5 bg-white text-green-700 rounded font-semibold hover:bg-green-50 transition-colors"
          >
            지금 재시작
          </button>
        </div>
      )}

      {status.type === 'error' && (
        <div className="p-3">
          <div className="font-semibold text-red-200 mb-1">⚠️ 업데이트 오류</div>
          <div className="text-red-200/80 text-xs break-all">{status.message}</div>
          <button
            onClick={() => { setStatus(null); window.electronAPI.invoke('update:check'); }}
            className="mt-2 w-full py-1 bg-white/20 text-white rounded hover:bg-white/30"
          >
            다시 확인
          </button>
        </div>
      )}
    </div>
  );
}

function getBg(type) {
  if (type === 'downloading') return 'bg-blue-700';
  if (type === 'downloaded') return 'bg-green-600';
  if (type === 'error') return 'bg-red-700';
  return 'bg-gray-700';
}
