import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  DownloadSimpleIcon,
  TrashIcon,
  UploadSimpleIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'

import { type Transfer, useTransfers } from '../state/useTransfers'

interface Props {
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

function TransferRow({ transfer }: { transfer: Transfer }) {
  const { retry, remove } = useTransfers()
  const pct =
    transfer.bytesTotal && transfer.bytesTotal > 0
      ? Math.min(100, Math.round((transfer.bytesDone / transfer.bytesTotal) * 100))
      : null

  return (
    <li className={`transfer-row transfer-${transfer.status}`}>
      <span className="transfer-icon" aria-hidden>
        {transfer.direction === 'download' ? <DownloadSimpleIcon /> : <UploadSimpleIcon />}
      </span>

      <span className="transfer-info">
        <span className="transfer-label">{transfer.label}</span>
        <span className="transfer-meta">
          {transfer.status === 'failed' ? (
            <span className="transfer-error">{transfer.error}</span>
          ) : transfer.status === 'queued' ? (
            'Queued'
          ) : (
            <>
              {formatSize(transfer.bytesDone)}
              {transfer.bytesTotal !== null && ` / ${formatSize(transfer.bytesTotal)}`}
              {pct !== null && ` (${pct}%)`}
            </>
          )}
        </span>
        {transfer.status === 'active' && (
          <span className="transfer-bar">
            <span
              className="transfer-bar-fill"
              style={{ width: pct !== null ? `${pct}%` : '100%' }}
            />
          </span>
        )}
      </span>

      <span className="transfer-status-icon" aria-hidden>
        {transfer.status === 'active' && <CircleNotchIcon className="spin" />}
        {transfer.status === 'done' && <CheckCircleIcon weight="fill" className="ok" />}
        {transfer.status === 'failed' && <WarningCircleIcon weight="fill" className="err" />}
      </span>

      <span className="row-actions">
        {transfer.status === 'failed' && (
          <button
            className="btn-quiet"
            onClick={() => retry(transfer.id)}
            title={transfer.bytesDone > 0 ? 'Resume from where it stopped' : 'Try again'}
          >
            <ArrowClockwiseIcon />
            {transfer.bytesDone > 0 ? 'Resume' : 'Retry'}
          </button>
        )}
        {transfer.status !== 'active' && (
          <button className="btn-quiet" aria-label="Remove" onClick={() => remove(transfer.id)}>
            <TrashIcon />
          </button>
        )}
      </span>
    </li>
  )
}

/** Global panel — transfers queue across every session, not just the SFTP
 * pane that started them, so it isn't tied to any one session's overlay. */
export function TransferQueue({ onClose }: Props) {
  const { items, clearFinished } = useTransfers()
  const hasFinished = items.some((t) => t.status === 'done')

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        className="dialog transfer-queue"
        role="dialog"
        aria-modal="true"
        aria-label="Transfers"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>
          Transfers
          <button className="btn-quiet" aria-label="Close" onClick={onClose}>
            <XIcon />
          </button>
        </h2>

        {items.length === 0 ? (
          <div className="placeholder">
            <strong>No transfers yet</strong>
            <p>Uploads and downloads started from an SFTP pane show up here.</p>
          </div>
        ) : (
          <ul className="transfer-list">
            {items.map((t) => (
              <TransferRow key={t.id} transfer={t} />
            ))}
          </ul>
        )}

        {hasFinished && (
          <footer className="dialog-actions">
            <button className="btn-outline" onClick={clearFinished}>
              Clear finished
            </button>
          </footer>
        )}
      </div>
    </div>
  )
}
