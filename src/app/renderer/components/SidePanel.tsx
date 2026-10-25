import { useEffect, useRef, useState } from 'react';
import { formatDate } from '../../../core/reports/markdown.js';
import type { FindingDetail, FindingKey, Severity } from '../../../core/types.js';
import type { VitalsApi } from '../../shared/api.js';
import { formatAge, ipcErrorMessage } from '../format';

const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const SCOPE_LABEL = { runtime: 'Runtime', development: 'Development' } as const;

export interface SidePanelProps {
  api: VitalsApi;
  findingKey: FindingKey | null;
  /** The snapshot's finish time. */
  now: string;
}

/** Every value is repo-derived text and renders as React text, never as markup. */
export function SidePanel({ api, findingKey, now }: SidePanelProps) {
  const [detail, setDetail] = useState<FindingDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const latestRequest = useRef(0);

  const snapshotId = findingKey?.snapshotId;
  const repoId = findingKey?.repoId;
  const number = findingKey?.number;

  useEffect(() => {
    const id = ++latestRequest.current;
    setDetail(null);
    setLoadError(null);
    setActionError(null);
    setCopied(false);
    if (snapshotId === undefined || repoId === undefined || number === undefined) return;
    api.getFinding({ snapshotId, repoId, number }).then(
      (d) => {
        if (id !== latestRequest.current) return;
        setDetail(d);
        if (d === null) setLoadError('Finding not found.');
      },
      (err: unknown) => {
        if (id !== latestRequest.current) return;
        setLoadError(ipcErrorMessage(err));
      },
    );
  }, [api, snapshotId, repoId, number]);

  async function run(action: (key: FindingKey) => Promise<void>, onDone?: () => void) {
    if (findingKey === null) return;
    setActionError(null);
    setCopied(false);
    try {
      await action(findingKey);
      onDone?.();
    } catch (err) {
      setActionError(ipcErrorMessage(err));
    }
  }

  if (findingKey === null) return <aside className="side-panel"><p>Select a finding to see its details.</p></aside>;

  return (
    <aside className="side-panel" aria-label="Finding details">
      {loadError !== null && <p role="alert">{`Couldn't load the finding: ${loadError}`}</p>}
      {detail !== null && (
        <>
          <h3>{detail.packageName}</h3>
          <p>
            <span>{detail.ecosystem}</span> in <span>{detail.fullName}</span>
          </p>
          <p>
            <span className={`severity severity-${detail.severity}`}>{SEVERITY_LABEL[detail.severity]}</span>
          </p>
          <p>{detail.summary}</p>
          <dl>
            <dt>Advisory</dt>
            <dd>
              <span>{detail.ghsaId}</span> (<span>{detail.cveId ?? 'No CVE'}</span>)
            </dd>
            <dt>Manifest</dt>
            <dd><code>{detail.manifestPath}</code></dd>
            <dt>Scope</dt>
            <dd>{detail.scope === null ? '—' : SCOPE_LABEL[detail.scope]}</dd>
            <dt>Vulnerable versions</dt>
            <dd>{detail.vulnerableRange ?? '—'}</dd>
            <dt>Patched in</dt>
            <dd>{detail.firstPatched ?? 'No patched version'}</dd>
            <dt>Open since</dt>
            <dd>{`${formatDate(detail.createdAt)} (${formatAge(detail.createdAt, now)})`}</dd>
            <dt>Triage</dt>
            <dd>Not triaged</dd>
          </dl>
          <div className="actions">
            <button type="button" onClick={() => void run((k) => api.copyFindingMarkdown(k), () => setCopied(true))}>Copy as Markdown</button>
            <button type="button" onClick={() => void run((k) => api.openFindingOnGitHub(k))}>Open on GitHub</button>
            {copied && <span role="status">Copied.</span>}
          </div>
          {actionError !== null && <p role="alert">{actionError}</p>}
        </>
      )}
    </aside>
  );
}
