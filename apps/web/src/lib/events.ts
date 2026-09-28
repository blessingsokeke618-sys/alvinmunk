/**
 * Shared reputation-event reader. `constellation`, `feed`, and `leaderboard` all need the
 * same RPC `getEvents` window + ScVal decode — this is the one place that knows how to pull
 * and decode them, so the durable-indexer swap (Blue/Black, belts/00-strategy) is a
 * one-file change instead of three. RPC-direct for the MVP; degrades to [] on any failure.
 */
import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { server, config } from './stellar';

/**
 * RPC event retention is ~24h; staying within ~9000 ledgers keeps `getEvents` returning
 * rows instead of an out-of-range error (≥16k returns 0 events).
 */
export const EVENT_LEDGER_WINDOW = 9000;

/** Events per RPC page. Kept small so each request stays well under the RPC size limit. */
export const PAGE_SIZE = 200;
/**
 * Maximum pages fetched per call. 10 × 200 = 2000 events maximum per fetch cycle.
 * Bounds the number of RPC round-trips so a hot window can't fan out unbounded.
 */
export const MAX_PAGES = 10;

/** A decoded contract event: topics + value already run through scValToNative. */
export interface RepEvent {
  topics: unknown[];
  data: unknown;
  ledger: number;
}

/**
 * Decode an XDR/base64 ScVal to its native JS value.
 * Returns null on malformed input so that contract-event callers (leaderboard,
 * feed, constellation) degrade gracefully instead of crashing on bad data.
 */
export function decodeScVal(v: xdr.ScVal | string): unknown {
  try {
    const sv = typeof v === 'string' ? xdr.ScVal.fromXDR(v, 'base64') : v;
    return scValToNative(sv);
  } catch {
    return null;
  }
}

/**
 * Recent reputation-contract events (decoded), in RPC order (oldest-first). Returns [] if
 * the contract isn't deployed or RPC is unavailable so every caller degrades gracefully.
 * Follows the RPC cursor up to MAX_PAGES pages so a busy window never silently drops the
 * newest events.
 */
export async function fetchReputationEvents(): Promise<RepEvent[]> {
  if (!config.contracts.reputation) return [];

  let startLedger: number;
  try {
    const latest = await server.getLatestLedger();
    startLedger = Math.max(1, latest.sequence - EVENT_LEDGER_WINDOW);
  } catch {
    return [];
  }

  const filters: Parameters<typeof server.getEvents>[0]['filters'] = [
    { type: 'contract', contractIds: [config.contracts.reputation], topics: [['*', '*']] },
  ];

  const out: RepEvent[] = [];
  try {
    let req: Parameters<typeof server.getEvents>[0] = { startLedger, filters, limit: PAGE_SIZE };
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await server.getEvents(req);
      for (const ev of res.events) {
        out.push({
          topics: (ev.topic as Array<xdr.ScVal | string>).map(decodeScVal),
          data: decodeScVal(ev.value as xdr.ScVal | string),
          ledger: ev.ledger,
        });
      }
      if (res.events.length < PAGE_SIZE) break;
      req = { cursor: res.cursor, filters, limit: PAGE_SIZE };
    }
  } catch {
    return out; // return whatever we collected before the failure
  }
  return out;
}
