import { useState, useEffect } from 'react';

// 공유 동기화로 데이터가 갱신될 때마다 값이 1씩 올라간다.
// 데이터를 불러오는 useEffect의 의존성 배열에 이 값을 넣어두면, 그 화면을
// 열어둔 채로도 동기화된 최신 내용이 바로 반영된다(예전에는 다른 메뉴에
// 갔다 와야 반영됐다). 화면의 입력 상태는 그대로 유지된다.
export default function useDataVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!window.electronAPI?.onDataChanged) return;
    return window.electronAPI.onDataChanged(() => setVersion(v => v + 1));
  }, []);
  return version;
}
