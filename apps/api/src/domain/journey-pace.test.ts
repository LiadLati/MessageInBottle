import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { journeyDurationMs } from './routing.js';

// Product decision 15: the shipped route-based pace is intentional. These pin it, so a retune
// is a deliberate, visible change rather than a side effect.
describe('journey pace (product decision 15)', () => {
  it('keeps the shipped constants', () => {
    const config = loadConfig({});
    expect(config.msPerChartUnit).toBe(60 * 60 * 1000);
    expect(config.minJourneyMs).toBe(6 * 60 * 60 * 1000);
  });

  it('derives duration from the route length alone', () => {
    const { msPerChartUnit, minJourneyMs } = loadConfig({});
    expect(journeyDurationMs(10, msPerChartUnit, minJourneyMs)).toBe(10 * 60 * 60 * 1000);
    expect(journeyDurationMs(2, msPerChartUnit, minJourneyMs)).toBe(6 * 60 * 60 * 1000);
  });
});
