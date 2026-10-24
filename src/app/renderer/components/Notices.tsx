import type { MonitoringSummary } from '../../../core/types.js';

/** Each notice is one collapsed line, so a long list of repo names can't push the queue off the screen. */
export function Notices({ monitoring }: { monitoring: MonitoringSummary | null }) {
  if (monitoring === null) return null;
  const { notMonitored, errors } = monitoring;
  if (notMonitored.length === 0 && errors.length === 0) return null;
  const one = notMonitored.length === 1;
  return (
    <div className="notices">
      {notMonitored.length > 0 && (
        <details>
          <summary>
            {one
              ? "1 repo isn't monitored: Dependabot alerts are turned off, so it has no data."
              : `${notMonitored.length} repos aren't monitored: Dependabot alerts are turned off, so they have no data.`}
          </summary>
          <ul>
            {notMonitored.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </details>
      )}
      {errors.length > 0 && (
        <details>
          <summary>{`${errors.length} ${errors.length === 1 ? 'repo' : 'repos'} couldn't be read in this Checkup:`}</summary>
          <ul>
            {errors.map((e) => (
              <li key={e.repo}>{`${e.repo}: ${e.message}`}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
