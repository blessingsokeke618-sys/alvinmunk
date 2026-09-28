/**
 * Shared contract-event reader. `constellation`, `feed`, `leaderboard` and `badges` all need
 * the same RPC `getEvents` window + ScVal decode — this is the one place that knows how to
 * pull and decode them, so the durable-indexer swap (Blue/Black, belts/00-strategy) is a
 * one-file change. RPC-direct for the MVP; degrades to [] on any failure.
 */
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import { EVENTS } from '@alvinmunk/shared';
import { server, config } from './stellar';
import { shareInFlight } from './utils';

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
 * newest events. Concurrent callers (feed, constellation, badges mounting together) share
 * one scan.
 */
export async function fetchReputationEvents(): Promise<RepEvent[]> {
  return fetchContractEvents(config.contracts.reputation, ['*', '*'], PAGE_SIZE * MAX_PAGES);
}

/**
 * `tipped` events SENT by `from` (topics ('tipped', from, to) · data amount), oldest-first.
 * RPC topic filters only match events with exactly as many topics as segments, so the
 * 2-segment wildcard above never sees these 3-topic events; filtering on the sender here
 * also keeps the read to one wallet's tips instead of the whole rewards contract.
 */
export async function fetchTipsSent(from: string, limit = 1): Promise<RepEvent[]> {
  let sender: string;
  try {
    sender = new Address(from).toScVal().toXDR('base64');
  } catch {
    return []; // not a valid G…/C… address
  }
  const tipped = xdr.ScVal.scvSymbol(EVENTS.TIPPED).toXDR('base64');
  return fetchContractEvents(config.contracts.rewards, [tipped, sender, '*'], limit);
}

const pendingScans = new Map<string, Promise<RepEvent[]>>();

function fetchContractEvents(contractId: string, topics: string[], limit: number): Promise<RepEvent[]> {
  if (!contractId) return Promise.resolve([]);
  return shareInFlight(pendingScans, `${contractId}|${topics.join(',')}|${limit}`, () =>
    scanContractEvents(contractId, topics, limit),
  );
}

async function scanContractEvents(contractId: string, topics: string[], limit: number): Promise<RepEvent[]> {
  let startLedger: number;
  try {
    const latest = await server.getLatestLedger();
    startLedger = Math.max(1, latest.sequence - EVENT_LEDGER_WINDOW);
  } catch {
    return [];
  }

  const filters: Parameters<typeof server.getEvents>[0]['filters'] = [
    { type: 'contract', contractIds: [contractId], topics: [topics] },
  ];
  const pageSize = Math.min(PAGE_SIZE, limit);

  const out: RepEvent[] = [];
  try {
    let req: Parameters<typeof server.getEvents>[0] = { startLedger, filters, limit: pageSize };
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await server.getEvents(req);
      for (const ev of res.events) {
        out.push({
          topics: (ev.topic as Array<xdr.ScVal | string>).map(decodeScVal),
          data: decodeScVal(ev.value as xdr.ScVal | string),
          ledger: ev.ledger,
        });
      }
      if (res.events.length < pageSize || out.length >= limit) break;
      req = { cursor: res.cursor, filters, limit: pageSize };
    }
  } catch {
    return out; // return whatever we collected before the failure
  }
  return out;
}
