import type { Scenario } from '../../shared/types.ts';

const LABELS: Record<Scenario, string> = {
  random: 'Realistic: 5–20s, 20% never return',
  match: 'Match after 6s',
  no_match: 'No match after 6s',
  slow: 'Slow: answers after 45s',
  never: 'Never returns',
};

/** Chooses how the simulated engine behaves, for testing. A real integration would not have it. */
export function ScenarioField({ value, onChange }: { value: Scenario; onChange: (s: Scenario) => void }) {
  return (
    <label className="simulation">
      <span>Simulation control · how the routing engine behaves</span>
      <select value={value} onChange={(e) => onChange(e.target.value as Scenario)}>
        {Object.entries(LABELS).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
