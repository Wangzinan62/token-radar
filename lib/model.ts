// The radar's model: one sealed snapshot in, one ranked board of pre-token protocols out.
//
// Nothing on the board is priced by hand. The snapshot itself carries the evidence: the protocols
// whose tokens already trade show, category by category, what the market pays for a dollar of TVL.
// A pre-token protocol's implied value is its own TVL priced at that category multiple, then
// adjusted by three factors that also come from its own record and nothing else:
//
//   implied = tvl_usd x category_multiple x momentum x maturity x size_factor
//
//   category_multiple  the median market-cap/TVL ratio of the category's already-tokenized
//                      protocols (each ratio winsorized to [0.002, 10] first, so one mispriced
//                      microcap cannot move a category), shrunk toward the global median with
//                      weight comps / (comps + 6), and finally clamped to [0.02, 2.5]. A category
//                      with no tokenized comparable uses the global median outright.
//   momentum           1 + 0.35 x clamp(change_7d, -50, +100) / 100, so a protocol whose TVL grew
//                      100% in a week is priced 1.35x and one that halved is priced 0.825x. An
//                      unreported change is neutral (factor 1).
//   maturity           0.75 + 0.5 x min(age_days, 1460) / 1460: four years of operating history
//                      without a token earns up to +25% over a brand-new listing, which is
//                      discounted to 0.75x until it has a record. Unknown listing date: 365 days.
//   size_factor        1.0 at $10M of TVL or more, easing to 0.925 at the snapshot's $5M edge:
//                      the smallest protocols are the least likely to support a liquid token.
//
// A protocol is pre-token when its record carries no token at all (no market cap, no CoinGecko id,
// no symbol). Tokenized protocols are never board rows: they are the comparables the multiples are
// read from, and the dashboard shows them as exactly that. Board rows below the watchlist floor
// must pass the same product tests the watchlist itself states (not a bridge, liquid-staking,
// restaking or exchange category; no version marker or wrapped/staked word in the name; no
// exchange name first), because a wrapped or bridged product of a token that already trades is not
// a launch still to come. No protocol name is special-cased anywhere in this file.

/** One protocol record: exactly the ten fields the sealed snapshot carries. */
export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The snapshot document as the model reads it. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** Every constant of the model, named so the dashboard can state them verbatim. */
export interface ModelParams {
  ratio_floor: number;
  ratio_cap: number;
  shrink_weight: number;
  multiple_floor: number;
  multiple_cap: number;
  momentum_weight: number;
  momentum_floor_pct: number;
  momentum_cap_pct: number;
  maturity_base: number;
  maturity_span: number;
  maturity_days: number;
  unknown_age_days: number;
  size_full_usd: number;
  size_min_factor: number;
  early_take: number;
}

export const MODEL: ModelParams = {
  ratio_floor: 0.002,
  ratio_cap: 10,
  shrink_weight: 6,
  multiple_floor: 0.02,
  multiple_cap: 2.5,
  momentum_weight: 0.35,
  momentum_floor_pct: -50,
  momentum_cap_pct: 100,
  maturity_base: 0.75,
  maturity_span: 0.5,
  maturity_days: 1460,
  unknown_age_days: 365,
  size_full_usd: 10_000_000,
  size_min_factor: 0.925,
  early_take: 150,
};

/** The model's version label: the dashboard names it, the board's rows are scored under it. */
export const MODEL_VERSION = 'comparables-1';

/** Why a snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Whole days from the listing date to the snapshot's as-of date; null when either is unusable. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token when all three token fields are absent. */
export function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Categories whose products are claims on another protocol's asset, not launches of their own. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** DefiLlama's version-marker shape: a name that ends in a release is a pool of another protocol. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * The watchlist's own product tests, applied to below-floor candidates: a row must be a protocol
 * still waiting on a launch of its own, not a wrapped, staked, bridged or versioned product of one
 * whose token already trades.
 */
export function passesProductTests(p: Protocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The median of a non-empty list, taken on a sorted copy so callers keep their order. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One category's evidence: how many tokenized comparables, their median ratio, the multiple used. */
export interface CategoryMultiple {
  category: string;
  comps: number;
  median_ratio: number | null;
  multiple: number;
}

/** The multiples the snapshot supports: one global figure and one blended figure per category. */
export interface Multiples {
  global: number;
  comparable_count: number;
  byCategory: Map<string, CategoryMultiple>;
}

/**
 * Read the multiples off the snapshot: every protocol with a recorded market cap is a comparable,
 * its market-cap/TVL ratio winsorized before any statistic touches it.
 */
export function categoryMultiples(snapshot: Snapshot, model: ModelParams = MODEL): Multiples {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = clamp(p.mcap_usd / p.tvl_usd, model.ratio_floor, model.ratio_cap);
    all.push(ratio);
    const key = p.category ?? '(uncategorized)';
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  const global = all.length > 0 ? median(all) : 1;
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, ratios] of ratiosByCategory) {
    const med = median(ratios);
    const blended = (ratios.length * med + model.shrink_weight * global) / (ratios.length + model.shrink_weight);
    byCategory.set(category, {
      category,
      comps: ratios.length,
      median_ratio: round4(med),
      multiple: round4(clamp(blended, model.multiple_floor, model.multiple_cap)),
    });
  }
  return { global: round4(global), comparable_count: all.length, byCategory };
}

/** The multiple one protocol is priced at: its category's blend, or the global median outright. */
function multipleFor(p: Protocol, multiples: Multiples, model: ModelParams): { multiple: number; comps: number } {
  const entry = multiples.byCategory.get(p.category ?? '(uncategorized)');
  if (entry === undefined) return { multiple: multiples.global, comps: 0 };
  return { multiple: entry.multiple, comps: entry.comps };
}

/** The full arithmetic of one protocol's implied value, kept so the dashboard can show its work. */
export interface Breakdown {
  category_multiple: number;
  category_comps: number;
  momentum_factor: number;
  maturity_factor: number;
  size_factor: number;
  implied_value_usd: number;
}

/** Score one pre-token protocol from its own record and the snapshot's multiples. */
export function scoreProtocol(p: Protocol, asOf: string, multiples: Multiples, model: ModelParams = MODEL): Breakdown {
  const { multiple, comps } = multipleFor(p, multiples, model);
  const change = p.change_7d === null ? 0 : clamp(p.change_7d, model.momentum_floor_pct, model.momentum_cap_pct);
  const momentum = 1 + model.momentum_weight * (change / 100);
  const age = ageInDays(asOf, p.listed_at);
  const ageForModel = age ?? model.unknown_age_days;
  const maturity = model.maturity_base + model.maturity_span * (clamp(ageForModel, 0, model.maturity_days) / model.maturity_days);
  const size = p.tvl_usd >= model.size_full_usd
    ? 1
    : model.size_min_factor + (1 - model.size_min_factor) * (p.tvl_usd / model.size_full_usd);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * maturity * size));
  return {
    category_multiple: multiple,
    category_comps: comps,
    momentum_factor: round4(momentum),
    maturity_factor: round4(maturity),
    size_factor: round4(size),
    implied_value_usd: implied,
  };
}

/** One row of the board: the protocol's record, its rank, and the model's arithmetic for it. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  model: Breakdown;
  farm_steps: string[];
}

/** Everything the dashboard renders: the board, the multiples table, and the model's statement. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: ModelParams;
  stats: {
    protocols: number;
    pre_token: number;
    comparables: number;
    watchlist: number;
    board: number;
    early: number;
  };
  global_multiple: number;
  categories: CategoryMultiple[];
  rows: BoardRow[];
}

/**
 * Build the board: every watchlist protocol, plus the strongest below-floor pre-token protocols
 * that pass the product tests, all scored by the one function and ranked by implied value.
 */
export function buildBoard(snapshot: Snapshot, model: ModelParams = MODEL): { board: BoardRow[]; data: RadarData } {
  const multiples = categoryMultiples(snapshot, model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = new Set(snapshot.watchlist);

  const chosen = new Map<string, Protocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const earlyPool = snapshot.protocols.filter(
    (p) => !chosen.has(p.slug) && isPreToken(p) && p.tvl_usd < snapshot.floor_usd && passesProductTests(p),
  );
  const scoredEarly = earlyPool
    .map((p) => ({ p, score: scoreProtocol(p, snapshot.as_of, multiples, model) }))
    .sort((a, b) => b.score.implied_value_usd - a.score.implied_value_usd || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, model.early_take);
  for (const { p } of scoredEarly) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({
    p,
    breakdown: scoreProtocol(p, snapshot.as_of, multiples, model),
  }));
  scored.sort(
    (a, b) =>
      b.breakdown.implied_value_usd - a.breakdown.implied_value_usd ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: ageInDays(snapshot.as_of, s.p.listed_at),
    watchlist: watchlist.has(s.p.slug),
    implied_value_usd: s.breakdown.implied_value_usd,
    model: s.breakdown,
    farm_steps: farmSteps(s.p, ageInDays(snapshot.as_of, s.p.listed_at)),
  }));

  const categories = [...multiples.byCategory.values()].sort((a, b) => b.comps - a.comps || (a.category < b.category ? -1 : 1));
  const data: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model,
    stats: {
      protocols: snapshot.protocols.length,
      pre_token: snapshot.protocols.filter(isPreToken).length,
      comparables: multiples.comparable_count,
      watchlist: snapshot.watchlist.length,
      board: board.length,
      early: board.filter((r) => !r.watchlist).length,
    },
    global_multiple: multiples.global,
    categories,
    rows: board,
  };
  return { board, data };
}

/** The snapshot out of a file's text, refused unless it carries the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string' || o.source.length === 0) throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no positive whole-dollar floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const protocols: Protocol[] = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || num(p.tvl_usd) === null) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: num(p.tvl_usd)!,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate accepts, or null: coverage, ranks, value order, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows, outside 100..4000`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `${r.slug} carries rank ${r.rank} where rank ${i + 1} belongs`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `${r.slug} outranks the row above it on implied value`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row carries the same implied value: a board that ranks nothing by value is not a ranking';
  }
  return null;
}

/** The dashboard's data as one script: window.RADAR_DATA, no fetch and no network. */
export function dataScript(data: RadarData): string {
  return `window.RADAR_DATA=${JSON.stringify(data)};\n`;
}

// ---------------------------------------------------------------------------
// Farm plans. Every step is generated from the protocol's own record — its
// category chooses the core action, its first chain prices the funding step,
// its TVL sets the position size a small farmer would use, and its age sets
// the qualifying hold. A stable hash of the slug picks among phrasing
// variants, so two protocols in the same category do not read as one stencil.
// ---------------------------------------------------------------------------

/** A small stable hash of a slug, so phrasing variants are chosen deterministically. */
function slugHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

const pick = (slug: string, salt: number, variants: string[]): string => variants[(slugHash(slug) + salt) % variants.length]!;

/** How a chain is reached and what a transaction there costs a small farmer. */
interface ChainClass {
  kind: 'ethereum' | 'l2' | 'solana' | 'bitcoin' | 'evm' | 'other';
  fee: string;
  fund: string;
}

const L2_CHAINS = new Set([
  'Arbitrum', 'Base', 'Optimism', 'Linea', 'Scroll', 'zkSync Era', 'Mantle', 'Mode', 'Blast',
  'Unichain', 'Ink', 'Soneium', 'Taiko', 'Manta', 'Fraxtal', 'BOB', 'Berachain', 'Sonic', 'Monad',
]);

function chainClass(chain: string | undefined): ChainClass {
  if (chain === undefined) return { kind: 'other', fee: 'about $2', fund: 'use the network the protocol lists first' };
  if (chain === 'Ethereum') return { kind: 'ethereum', fee: 'about $12 in gas at ordinary congestion', fund: 'withdraw from an exchange directly to the wallet on mainnet' };
  if (chain === 'Solana') return { kind: 'solana', fee: 'well under $1 in fees', fund: 'withdraw from an exchange directly to the wallet' };
  if (chain === 'Bitcoin' || chain === 'Babylon Genesis' || chain === 'CORE') {
    return { kind: 'bitcoin', fee: 'about $2 in miner fees', fund: 'send from a Bitcoin wallet, bridging only where the protocol itself directs' };
  }
  if (L2_CHAINS.has(chain)) return { kind: 'l2', fee: 'about $1.50 in gas', fund: 'bridge from Ethereum through the canonical bridge (about $6 of mainnet gas, 10 minutes)' };
  return { kind: 'evm', fee: 'about $2 in gas', fund: 'use the bridge the protocol\'s own app offers' };
}

/** The position size a small farmer would run, scaled to the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 1000;
  if (tvl >= 250_000_000) return 500;
  if (tvl >= 50_000_000) return 250;
  if (tvl >= 10_000_000) return 100;
  return 50;
}

/** The qualifying hold: younger protocols ask for a longer window to count the activity. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 540) return 45;
  return 30;
}

/** The core action, chosen by the protocol's category and written for its first chain. */
function coreAction(p: Protocol, capital: number, chainName: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('risk curator') || c.includes('allocator') || c.includes('curator')) {
    return `Allocate $${capital} to one of ${n}'s curated vaults on ${chainName} and keep the vault shares in the same wallet; curator vaults score the wallets that stay allocated, not the ones that pass through.`;
  }
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC as collateral in ${n} on ${chainName}, then borrow about 40% of it back and re-supply the borrowed half once, so the wallet shows both sides of the market.`;
  }
  if (c.includes('dex') || c.includes('liquidity')) {
    return `Provide $${capital} split evenly across both sides of ${n}'s most-used pool on ${chainName} and leave the position in range; concentrated positions that fall out of range stop counting as activity.`;
  }
  if (c.includes('basis')) {
    return `Deposit $${capital} of USDC into ${n}'s basis vault on ${chainName} and hold the vault token; the position earns the funding spread while it stays deposited.`;
  }
  if (c.includes('restak') || c.includes('staking')) {
    return `Stake $${capital} of the chain's staking asset through ${n} on ${chainName} and keep the receipt token unsold, so the staking balance is visible in one wallet over time.`;
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('option')) {
    return `Deposit $${capital} of USDC as margin on ${n} and open one small hedged position (long and short legs of similar size) so the account shows real trading volume without directional risk.`;
  }
  if (c.includes('rwa')) {
    return `Subscribe $${capital} to ${n}'s tokenized real-world asset on ${chainName} and hold the issued token; if the app asks for an allowlist check first, complete it before funding the wallet.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${n} on ${chainName} for a position you actually hold, and keep the policy to its full term rather than cancelling early.`;
  }
  if (c.includes('chain')) {
    return `Bridge $${capital} to ${chainName} and use two of its native apps through ${n}'s ecosystem page, so the wallet builds a history on the chain itself, not only in one protocol.`;
  }
  if (c.includes('payment')) {
    return `Route about $${capital} of real payments or a held balance through ${n} over the month, in several separate transfers rather than one round trip.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${n} on ${chainName} and hold it in the wallet; minted balances held over time are the activity this category rewards.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${n} and take small positions in three different markets, sized so no single outcome can cost more than a fifth of the deposit.`;
  }
  if (c.includes('launchpad')) {
    return `Complete ${n}'s participation steps on ${chainName} and commit $${capital} to one launch round, keeping the allocation in the same wallet through distribution.`;
  }
  if (c.includes('governance')) {
    return `Deposit $${capital} into ${n}'s incentive program on ${chainName} and vote or claim on its published schedule rather than in one burst.`;
  }
  return `Deposit $${capital} of USDC into ${n}'s main product on ${chainName} and use its core action (supply, stake or swap, whichever the app leads with) so the position is a real one, not a parked balance.`;
}

/** The weekly qualifying action, flavoured by the same category as the core action. */
function weeklyAction(p: Protocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp')) return 'adjust the borrow or supply balance by a few dollars';
  if (c.includes('dex') || c.includes('liquidity')) return 'rebalance or top up the liquidity position';
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('option')) return 'roll the hedge or open one small additional trade';
  if (c.includes('prediction')) return 'take one small position in a newly opened market';
  return 'repeat the core action with a small top-up';
}

/**
 * One protocol's farm plan: six steps, each naming the action, its cost and its time. The plan is
 * derived from the protocol's record alone — category, chains, TVL and age — never from its name
 * beyond naming the protocol itself.
 */
export function farmSteps(p: Protocol, age: number | null): string[] {
  const chainName = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const cc = chainClass(p.chains.length > 0 ? p.chains[0] : undefined);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const walletWord = cc.kind === 'solana' ? 'Solana wallet (Phantom or Backpack)' : cc.kind === 'bitcoin' ? 'Bitcoin wallet' : 'fresh EVM wallet';
  const setup = pick(p.slug, 1, [
    `Set up a ${walletWord} used only for farming ${p.name}, fund it from an exchange rather than from your main wallet, and store its seed phrase offline. Cost: no fee beyond the first transfer. Time: 10 minutes.`,
    `Create a ${walletWord} dedicated to ${p.name} so its activity is clean to read, and keep its seed phrase on paper, never in a screenshot or a cloud note. Cost: nothing to create. Time: 10 minutes.`,
  ]);
  const fund = `Move about $${capital + 50} of working capital onto ${chainName}: ${cc.fund}, keeping $${capital} for the position itself and the rest for fees. Cost: ${cc.fee}. Time: 15 minutes including the wait for confirmations.`;
  const core = `${coreAction(p, capital, chainName)} Cost: the $${capital} position plus ${cc.fee} to open it. Time: 20 minutes to set up carefully.`;
  const weekly = `Once a week, ${weeklyAction(p)} on ${chainName} and claim any points or rewards the app shows for the wallet. Cost: ${cc.fee} a week. Time: 10 minutes a week for the ${hold}-day qualifying window.`;
  const holdStep = pick(p.slug, 2, [
    `Hold the position for at least ${hold} days without withdrawing, so the activity appears in more than one weekly snapshot of the protocol. Cost: the $${capital} stays committed for ${hold} days. Time: ${hold} days, checked weekly.`,
    `Leave the position untouched for at least ${hold} days; early exits are the pattern points programs most often disqualify. Cost: the $${capital} stays committed for ${hold} days. Time: ${hold} days, checked weekly.`,
  ]);
  const record = `Keep a farm log with the wallet address, every date, amount and transaction hash, and re-check the protocol's official announcements before any claim: never pay a fee to claim an airdrop, and only follow links the protocol itself publishes. Cost: nothing. Time: 5 minutes a week.`;
  return [setup, fund, core, weekly, holdStep, record];
}
