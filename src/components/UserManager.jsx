import { useState, useEffect } from 'react';
import { fetchUsers, upsertUser, deleteUser } from '../lib/api';

// 관리자 전용: 사용자 명부(이름·사번·권한) 관리. 명부는 공유 데이터에 저장되어
// 동기화되므로, 여기서 등록/권한변경하면 각 PC의 로그인에 반영된다.
export default function UserManager({ currentUser, onClose }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ empNo: '', name: '', role: 'member' });
  const [msg, setMsg] = useState('');

  useEffect(() => { fetchUsers().then(setUsers).catch(() => {}); }, []);

  async function add() {
    const empNo = form.empNo.trim(), name = form.name.trim();
    if (!empNo || !name) { setMsg('이름과 사번을 입력하세요.'); return; }
    const r = await upsertUser({ empNo, name, role: form.role });
    if (r?.ok) {
      setUsers(prev => {
        const i = prev.findIndex(u => String(u.empNo) === empNo);
        return i >= 0 ? prev.map(u => String(u.empNo) === empNo ? r.user : u) : [...prev, r.user];
      });
      window.electronAPI?.notifyDataChanged?.();
      setForm({ empNo: '', name: '', role: 'member' });
      setMsg('');
    } else setMsg(r?.error || '등록 실패');
  }

  async function changeRole(u, role) {
    const r = await upsertUser({ ...u, role });
    if (r?.ok) { setUsers(prev => prev.map(x => x.empNo === u.empNo ? r.user : x)); window.electronAPI?.notifyDataChanged?.(); }
  }

  async function remove(u) {
    if (String(u.empNo) === String(currentUser.empNo)) { setMsg('본인 계정은 삭제할 수 없습니다.'); return; }
    await deleteUser(u.empNo);
    setUsers(prev => prev.filter(x => x.empNo !== u.empNo));
    window.electronAPI?.notifyDataChanged?.();
  }

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[520px] max-w-[94vw] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h3 className="text-base font-bold text-gray-900">사용자 관리</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>

        {/* 추가 폼 */}
        <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-[11px] text-gray-500 mb-0.5">이름</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="border border-gray-300 rounded px-2 py-1 text-sm w-28" placeholder="이름" />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 mb-0.5">사번</label>
            <input value={form.empNo} onChange={e => setForm(f => ({ ...f, empNo: e.target.value }))}
              className="border border-gray-300 rounded px-2 py-1 text-sm w-28" placeholder="사번" />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 mb-0.5">권한</label>
            <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
              className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
              <option value="member">멤버</option>
              <option value="admin">관리자</option>
            </select>
          </div>
          <button onClick={add} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700">추가</button>
        </div>
        {msg && <p className="px-5 py-1.5 text-xs text-red-500">{msg}</p>}

        {/* 목록 */}
        <div className="flex-1 overflow-y-auto">
          {users.length === 0 ? (
            <p className="px-5 py-6 text-sm text-gray-400 text-center">등록된 사용자가 없습니다.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr><th className="text-left px-5 py-2">이름</th><th className="text-left px-3 py-2">사번</th><th className="px-3 py-2">권한</th><th className="px-3 py-2"></th></tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.empNo} className="border-t border-gray-100">
                    <td className="px-5 py-2 font-medium text-gray-800">{u.name}{String(u.empNo) === String(currentUser.empNo) && <span className="ml-1 text-[10px] text-blue-500">(나)</span>}</td>
                    <td className="px-3 py-2 text-gray-500">{u.empNo}</td>
                    <td className="px-3 py-2 text-center">
                      <select value={u.role} onChange={e => changeRole(u, e.target.value)}
                        className="border border-gray-200 rounded px-1.5 py-0.5 text-xs bg-white">
                        <option value="member">멤버</option>
                        <option value="admin">관리자</option>
                      </select>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button onClick={() => remove(u)} className="text-gray-300 hover:text-red-500 text-xs">삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-5 py-3 border-t border-gray-200 text-right">
          <button onClick={onClose} className="px-4 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">닫기</button>
        </div>
      </div>
    </div>
  );
}
