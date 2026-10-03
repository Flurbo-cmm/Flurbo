import { useEffect, useRef, useState } from 'react';

type Summary = { scenario: string; model: string; initialMse: number; finalMse: number };
type Report = { schema: string; engine: string; input: string; changesExecutablePrices: boolean;
  generatedAt: string; binarySha256: string; outputSha256: string; sourceCommit: string | null;
  observations: number; summaries: Summary[] };
const scenarios = [
  ['stationary', 'Stable correlation'], ['regime_change', 'Changing conditions'], ['noisy', 'Noisy observations'],
  ['poison_recovery', 'Misleading observations'], ['higher_order', 'Higher-order dependence'],
];
const models = [['pairwise_all', 'Pairwise'], ['pairwise_singles', 'Singles only'], ['independent_all', 'Independent'], ['uniform', 'Untrained']];

export default function LearningComparison() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  async function load() {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch('/api/learning/comparison', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to view the comparison.' : 'Comparison is starting or unavailable. Try again shortly; trading is separate.');
      const value: Report = await response.json();
      if (value.schema !== 'flurbo.learning-comparison.v1' || value.input !== 'synthetic' || value.changesExecutablePrices !== false ||
          !Array.isArray(value.summaries) || value.summaries.length !== 20 || !Number.isFinite(Date.parse(value.generatedAt)) ||
          scenarios.some(([scenario]) => models.some(([model]) => {
            const rows = value.summaries.filter(row => row.scenario === scenario && row.model === model);
            return rows.length !== 1 || !Number.isFinite(rows[0].finalMse) || rows[0].finalMse < 0 || rows[0].finalMse > 1;
          }))) throw new Error('The comparison result could not be verified. Try again after the next deployment.');
      if (request.current === controller) setReport(value);
    } catch (reason) {
      if (request.current === controller) { setReport(null); setError(controller.signal.aborted ? 'The request timed out. Try loading the comparison again.' : reason instanceof Error ? reason.message : 'Comparison unavailable.'); }
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) setBusy(false);
    }
  }
  return <details className="workspace-funding learning-comparison">
    <summary>Learning comparison <span className="auth-help">Synthetic research</span></summary>
    <p>See how the Rust learning model responds to controlled observations. This experiment does not read your trades or change the public pool’s prices.</p>
    <button className="button button-dark" disabled={busy} onClick={() => void load()}>{busy ? 'Loading comparison...' : report ? 'Reload results' : 'View comparison'}</button>
    {error && <p role="status">{error}</p>}
    {report && <>
      <p>Mean squared probability error after 4,000 observations, averaged across three seeds and seven claims. Lower is better. All five scenarios are included.</p>
      <div className="comparison-table" role="region" aria-label="Synthetic learning results" tabIndex={0}>
        <table><caption>Three-event synthetic experiment</caption><thead><tr><th scope="col">Scenario</th>{models.map(([key, label]) => <th scope="col" key={key}>{label}</th>)}</tr></thead>
          <tbody>{scenarios.map(([scenario, label]) => <tr key={scenario}><th scope="row">{label}</th>{models.map(([model]) => <td key={model}>{report.summaries.find(row => row.scenario === scenario && row.model === model)!.finalMse.toExponential(2)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <p className="auth-help">Pairwise learns individual and pair parameters from combined observations. Singles only limits observations to individual events. Independent learns individual parameters only. Untrained keeps the initial uniform distribution. These are synthetic baselines, not venue performance or a statistical loss guarantee.</p>
      <details><summary>Runtime evidence</summary><p>{report.engine}, run at server startup on {new Date(report.generatedAt).toLocaleString()}. Validated {report.observations.toLocaleString()} measurement rows.</p>
        <p>Binary SHA-256: <code>{report.binarySha256}</code></p><p>Output SHA-256: <code>{report.outputSha256}</code></p>
        <p>Source commit: <code>{report.sourceCommit || 'Not supplied by this host'}</code></p>
        <p className="auth-help">Results are computed once per server start and shared across signed-in users. Reloading retrieves that result; it does not train on new data. This is not an exact reproduction of the paper’s historical experiments.</p>
      </details>
    </>}
  </details>;
}
