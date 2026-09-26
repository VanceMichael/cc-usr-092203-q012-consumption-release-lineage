import { readFileSync } from 'node:fs';
import { EventStore } from '../src/events.js';

export function loadScenario() {
  const scenario = JSON.parse(readFileSync(new URL('../fixtures/scenario.json', import.meta.url), 'utf8'));
  const store = new EventStore(scenario.events);
  const correctionsById = Object.fromEntries(scenario.corrections.map((correction) => [correction.id, correction]));
  const pick = (ids) => ids.map((id) => correctionsById[id]);
  return { scenario, store, correctionsById, pick };
}
