import { vaultApi } from '../lib/ipc'
import { useWorkspace } from '../state/useWorkspace'

/**
 * Không có accept-any: người dùng phải nhìn fingerprint rồi tự quyết định.
 * Trường hợp key *đổi* được hiển thị nặng hơn vì đó là dấu hiệu MITM.
 */
export function HostKeyPrompt() {
  const { hostKeyPrompt, dismissHostKeyPrompt, openSsh } = useWorkspace()
  if (!hostKeyPrompt) return null

  const { host, port, algo, fingerprint, previous, kind, hostId } = hostKeyPrompt
  const mismatch = kind === 'mismatch'

  const trust = async () => {
    await vaultApi.trustHostKey(host, port, algo, fingerprint)
    dismissHostKeyPrompt()
    await openSsh(hostId)
  }

  return (
    <div className="modal-backdrop">
      <div className={`modal ${mismatch ? 'danger' : ''}`}>
        <h2>{mismatch ? '⚠️ Host key đã THAY ĐỔI' : 'Host key chưa được tin cậy'}</h2>

        <p>
          {host}:{port}
        </p>

        {mismatch ? (
          <>
            <p className="error">
              Key trước đó khác với key server vừa trình ra. Có thể server được cài lại, hoặc
              có ai đó đang đứng giữa. Chỉ tin cậy nếu bạn biết chắc lý do key đổi.
            </p>
            <dl className="fingerprint">
              <dt>Đã lưu</dt>
              <dd>
                <code>{previous}</code>
              </dd>
              <dt>Server hiện tại</dt>
              <dd>
                <code>{fingerprint}</code>
              </dd>
            </dl>
          </>
        ) : (
          <dl className="fingerprint">
            <dt>Thuật toán</dt>
            <dd>
              <code>{algo}</code>
            </dd>
            <dt>Fingerprint</dt>
            <dd>
              <code>{fingerprint}</code>
            </dd>
          </dl>
        )}

        <p className="hint">
          Đối chiếu với output của <code>ssh-keyscan -t {algo} {host}</code> chạy từ một
          đường mạng bạn tin được.
        </p>

        <footer className="modal-foot">
          <button onClick={dismissHostKeyPrompt}>Huỷ kết nối</button>
          <button className={mismatch ? 'danger' : 'primary'} onClick={() => void trust()}>
            {mismatch ? 'Tôi hiểu rủi ro, tin cậy key mới' : 'Tin cậy và kết nối'}
          </button>
        </footer>
      </div>
    </div>
  )
}
