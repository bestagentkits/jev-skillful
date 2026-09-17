/**
 * Stability: does the router give the same answer twice?
 *
 * Jev is not deterministic. Repeated identical input was measured to move `noneP` by about
 * ±0.03, and an older note recorded option distributions shifting from 53/47 to 61/39. A
 * single run therefore cannot separate signal from noise, and a threshold sitting in a noisy
 * band will flip decisions between runs. Agreement across repeats is what makes a reported
 * accuracy number meaningful rather than lucky.
 *
 * A limitation worth stating plainly: under `--replay` this metric measures the stability of
 * the *recorded* responses, so it is only as informative as the recording is honest. Live
 * runs are what give it meaning.
 */

export interface FixtureStability {
  fixtureId: string;
  /** One signature per repeat, in run order. */
  signatures: string[];
}

export interface StabilityMetrics {
  repeat: number;
  fixtureCount: number;
  /** Fixtures whose signature was identical across every repeat. */
  unanimous: number;
  /** Share of fixtures that never changed their answer. */
  agreementRate: number;
  /** Fixtures that varied, so a report can show which ones move. */
  unstable: { fixtureId: string; signatures: string[] }[];
}

export function stabilityMetrics(
  perFixture: readonly FixtureStability[],
  repeat: number,
): StabilityMetrics {
  if (perFixture.length === 0) {
    return { repeat, fixtureCount: 0, unanimous: 0, agreementRate: 0, unstable: [] };
  }

  const unstable: { fixtureId: string; signatures: string[] }[] = [];
  let unanimous = 0;

  for (const entry of perFixture) {
    const distinct = new Set(entry.signatures);
    if (distinct.size <= 1) {
      unanimous += 1;
    } else {
      unstable.push({ fixtureId: entry.fixtureId, signatures: [...entry.signatures] });
    }
  }

  // Unstable fixtures are the actionable output, so they are sorted by how many distinct
  // answers the router produced rather than alphabetically.
  unstable.sort((a, b) => new Set(b.signatures).size - new Set(a.signatures).size);

  return {
    repeat,
    fixtureCount: perFixture.length,
    unanimous,
    agreementRate: unanimous / perFixture.length,
    unstable,
  };
}
