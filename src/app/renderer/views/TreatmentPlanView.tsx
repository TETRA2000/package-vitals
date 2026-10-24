import { useEffect, useRef, useState } from 'react';
import type { TreatmentRow } from '../../../core/types.js';
import { ipcErrorMessage } from '../format';
import type { ViewProps } from './types';

export function TreatmentPlanView({ api, snapshotId }: ViewProps) {
  const [rows, setRows] = useState<TreatmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    const id = ++latestRequest.current;
    api.getTreatmentPlan(snapshotId).then(
      (r) => {
        if (id !== latestRequest.current) return;
        setRows(r);
        setError(null);
      },
      (err: unknown) => {
        if (id !== latestRequest.current) return;
        setError(ipcErrorMessage(err));
      },
    );
  }, [api, snapshotId]);

  return (
    <section>
      <h2>Treatment plan</h2>
      <p>Packages with an open critical alert, by how many repos an upgrade would clear.</p>
      {error !== null && <p role="alert">{`Couldn't load the treatment plan: ${error}`}</p>}
      {rows !== null &&
        (rows.length === 0 ? (
          <p>No open critical alerts.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Package</th>
                <th>Ecosystem</th>
                <th>Repos</th>
                <th>Patched in</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.ecosystem}/${r.packageName}`}>
                  <td>{r.packageName}</td>
                  <td>{r.ecosystem}</td>
                  <td>{r.repoCount}</td>
                  <td>{r.patchedVersions.length === 0 ? 'No patched version' : r.patchedVersions.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}
