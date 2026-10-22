import { Component } from 'react';

// 화면 하나에서 렌더링 오류가 나도 앱 전체(사이드바·업데이트 알림 포함)가 하얗게 사라지지
// 않도록 해당 화면만 오류 안내로 바꾼다. resetKey(현재 메뉴 id)가 바뀌면 다시 시도한다.
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('화면 렌더링 오류:', error, info?.componentStack);
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <div className="text-4xl mb-3">⚠️</div>
        <h2 className="text-lg font-bold text-gray-800 mb-1.5">이 화면을 표시하는 중 오류가 발생했습니다</h2>
        <p className="text-sm text-gray-500 mb-2 max-w-md leading-relaxed">
          다른 메뉴는 그대로 사용할 수 있습니다. 새 버전이 나오면 왼쪽 아래 업데이트 알림에서 재시작해 주세요.
        </p>
        <code className="text-xs text-red-600 bg-red-50 rounded px-2 py-1 mb-4 max-w-lg break-all">{String(error?.message || error)}</code>
        <button onClick={() => this.setState({ error: null })}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700">
          다시 시도
        </button>
      </div>
    );
  }
}
