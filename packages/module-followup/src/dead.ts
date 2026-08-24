import type { TriageResult } from '../../core/src/triage.ts';

/**
 * Dead channels, aggregated.
 *
 * Gmail showed him every one of these bounces, individually, as they arrived —
 * and he missed all of them and kept writing to an address that rejects mail.
 * Detection was never the hard part. Aggregation and persistence are: one line
 * saying "seven emails, none arrived" carries the fact that six separate
 * delivery-failure notices did not.
 */
export interface DeadChannel {
  address: string;
  bounces: number;
  firstBounceAt: string;
  lastBounceAt: string;
  /** Messages sent to this address after the first bounce came back. */
  sentAfterFirstBounce: number;
  totalSent: number;
  bounceSignalIds: string[];
}

export function findDeadChannels(results: TriageResult[]): DeadChannel[] {
  const byAddress = new Map<string, DeadChannel>();

  for (const r of results) {
    if (r.classification.category !== 'bounce') continue;
    const address = r.extractions.find((e) => e.kind === 'dead_address')?.valueText;
    if (!address) continue;

    const at = r.signal.occurredAt;
    const existing = byAddress.get(address);
    if (existing) {
      existing.bounces++;
      existing.bounceSignalIds.push(r.signal.externalId);
      if (at < existing.firstBounceAt) existing.firstBounceAt = at;
      if (at > existing.lastBounceAt) existing.lastBounceAt = at;
    } else {
      byAddress.set(address, {
        address,
        bounces: 1,
        firstBounceAt: at,
        lastBounceAt: at,
        sentAfterFirstBounce: 0,
        totalSent: 0,
        bounceSignalIds: [r.signal.externalId],
      });
    }
  }

  // Count what he sent there, and — the number that actually stings — how much
  // of it he sent after the first rejection had already come back.
  for (const channel of byAddress.values()) {
    const sent = results.filter(
      (r) => r.signal.labels.includes('SENT') && r.signal.toAddrs.includes(channel.address),
    );
    channel.totalSent = sent.length;
    channel.sentAfterFirstBounce = sent.filter((r) => r.signal.occurredAt > channel.firstBounceAt).length;
  }

  return [...byAddress.values()].sort((a, b) => b.bounces - a.bounces);
}

/** address -> bounce count, for the thread state machine. */
export function deadAddressMap(channels: DeadChannel[]): Map<string, number> {
  return new Map(channels.map((c) => [c.address, c.bounces]));
}

export function describeDeadChannel(c: DeadChannel): string {
  const n = c.totalSent || c.bounces;
  const wasted = c.sentAfterFirstBounce;
  return (
    `${c.address} is a dead address. ` +
    `${n} email${n === 1 ? '' : 's'} went there and none arrived` +
    (wasted > 0
      ? `, ${wasted} of them after the first rejection had already come back.`
      : '.')
  );
}
