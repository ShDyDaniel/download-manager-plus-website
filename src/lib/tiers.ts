/**
 * Subscription TIERS — the single source of truth for the plan hierarchy.
 *
 * The app is moving from a binary Pro/free entitlement to four ORDERED,
 * CUMULATIVE tiers: Free ⊂ Basic ⊂ Pro ⊂ Ultra. A higher tier includes
 * everything below it, so gating is a simple rank comparison
 * (`tierAtLeast(userTier, requiredTier)`), never a per-tier allowlist.
 *
 * This module is intentionally tiny and dependency-free so the SAME file can
 * be mirrored verbatim on the website (frontend + server) — the way
 * hasProAccess/isUserPro are already hand-mirrored. Keep the two copies in sync.
 *
 * IMPORTANT: `FEATURE_MIN_TIER` + `TIER_QUOTAS` below are the ONE place the
 * product matrix lives. The values here are a DRAFT — Daniel is finalizing the
 * real matrix; when it lands, only this file changes. During the open beta
 * (betaMode) every user resolves to `ultra`, so these gates don't bite yet.
 */

export type Tier = "free" | "basic" | "pro" | "ultra";

/** Low → high. Index = rank. */
export const TIER_ORDER: readonly Tier[] = ["free", "basic", "pro", "ultra"];

export function tierRank(t: Tier): number {
  const i = TIER_ORDER.indexOf(t);
  return i < 0 ? 0 : i;
}

/** Cumulative gate: does `userTier` include everything `min` requires? */
export function tierAtLeast(userTier: Tier, min: Tier): boolean {
  return tierRank(userTier) >= tierRank(min);
}

/** The higher of two tiers (for OR-combining entitlement signals). */
export function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/** Coerce any stored/legacy value into a valid Tier. Legacy data used
 *  `subscription: "free"|"pro"` and `productKeys.tier: "pro"`; both map
 *  straight through. Unknown / absent → "free" (fail-closed). A boolean
 *  `true` (old "isPro") maps to "pro" for safety. */
export function normalizeTier(v: unknown): Tier {
  if (v === true) return "pro";
  const s = String(v ?? "").toLowerCase();
  return (TIER_ORDER as readonly string[]).includes(s) ? (s as Tier) : "free";
}

/** Which tier a 7-day trial grants. PLACEHOLDER — Daniel decides later
 *  ("נתייחס לזה בהמשך"). "pro" preserves today's behavior (trial === Pro). */
export const TRIAL_TIER: Tier = "pro";

/** Which tier `betaMode` maps everyone to. Ultra keeps the open beta fully
 *  unlocked so nothing breaks while tiers are wired in. */
export const BETA_TIER: Tier = "ultra";

/**
 * ON/OFF feature gates + the MINIMUM tier each needs. Encodes Daniel's
 * matrix. Anything NOT listed is available to everyone (Free) — e.g. basic
 * download management, file downloads (YouTube/Drive), and the quote generator
 * (the quote generator is available to Free but capped monthly — see
 * `quotesPerMonth`, a quota not a gate).
 *
 * From the matrix:
 *   Basic+ : compress, revisions, deliveries, time-tracking, routing/sort
 *            rules, "open folder after routing" (autoReveal).
 *   Pro+   : auto-sync, auto-editor (AI), AI-creator.
 *   TBD    : transcriptionAdvanced / advancedAudio / editorAgent aren't broken
 *            out in the matrix — kept at Pro (today's behavior) pending Daniel.
 */
export type TierFeature =
  | "autoReveal" // "פתיחת תיקייה אחרי העברה"
  | "compress" // "כיווץ וידאו" in Convert
  | "revisions" // client revision rounds
  | "deliveries" // client delivery links
  | "timeTracking" // work-time tracking
  | "routingRules" // download sort/routing rules editor
  | "sync" // auto audio-sync
  | "transcriptionAdvanced" // diarization / accurate / glossary / history / source-file (TBD)
  | "advancedAudio" // advanced audio classifier modes (TBD, not in matrix)
  | "editorAgent" // auto-launch external editor (TBD, not in matrix)
  | "autoEditor" // "העורך האוטומטי" (AI, token-heavy)
  | "aiCreator"; // "AI יוצר"

export const FEATURE_MIN_TIER: Record<TierFeature, Tier> = {
  autoReveal: "basic",
  compress: "basic",
  revisions: "basic",
  deliveries: "basic",
  timeTracking: "basic",
  routingRules: "basic",
  sync: "pro",
  transcriptionAdvanced: "pro",
  advancedAudio: "pro",
  editorAgent: "pro",
  autoEditor: "pro",
  aiCreator: "pro",
};

/**
 * Per-tier NUMERIC limits (Daniel's matrix). `null` = unlimited, `0` = none.
 * Storage is a single pool SHARED between revisions + deliveries; the two
 * concurrent-project caps are counted SEPARATELY against that shared pool.
 */
export interface TierQuotas {
  /** Price-quote generations per calendar month; null = unlimited. */
  quotesPerMonth: number | null;
  /** Max concurrent download projects/groups; null = unlimited. */
  maxDownloadProjects: number | null;
  /** Transcription seconds per calendar month; null = unlimited. */
  transcriptionMonthlySec: number | null;
  /** Shared revisions+deliveries storage pool, in GB. */
  storageGb: number;
  /** Max concurrent revision projects (0 = feature not available). */
  maxRevisionProjects: number;
  /** Max concurrent delivery projects (0 = feature not available). */
  maxDeliveryProjects: number;
  /** Monthly AI (auto-editor + AI-creator) token budget. 0 = none.
   *  PLACEHOLDER counts — Daniel: "מספר טוקנים שנחליט בהמשך". */
  aiMonthlyTokens: number;
}

export const TIER_QUOTAS: Record<Tier, TierQuotas> = {
  free: {
    quotesPerMonth: 1,
    maxDownloadProjects: 2,
    transcriptionMonthlySec: 300, // 5 min / month
    storageGb: 0,
    maxRevisionProjects: 0,
    maxDeliveryProjects: 0,
    aiMonthlyTokens: 0,
  },
  basic: {
    quotesPerMonth: null,
    maxDownloadProjects: null,
    transcriptionMonthlySec: 3600, // 1 hour / month
    storageGb: 10,
    maxRevisionProjects: 1,
    maxDeliveryProjects: 1,
    aiMonthlyTokens: 0,
  },
  pro: {
    quotesPerMonth: null,
    maxDownloadProjects: null,
    transcriptionMonthlySec: null, // unlimited
    storageGb: 50,
    maxRevisionProjects: 10,
    maxDeliveryProjects: 10,
    aiMonthlyTokens: 1_000_000, // PLACEHOLDER
  },
  ultra: {
    quotesPerMonth: null,
    maxDownloadProjects: null,
    transcriptionMonthlySec: null,
    storageGb: 100,
    maxRevisionProjects: 10,
    maxDeliveryProjects: 10,
    aiMonthlyTokens: 5_000_000, // PLACEHOLDER
  },
};

/** Does a user on `userTier` get `feature`? */
export function tierAllows(userTier: Tier, feature: TierFeature): boolean {
  return tierAtLeast(userTier, FEATURE_MIN_TIER[feature]);
}

/** The numeric quotas for a tier (code defaults; admin panel overrides). */
export function tierQuotas(userTier: Tier): TierQuotas {
  return TIER_QUOTAS[userTier];
}

/**
 * ADMIN-EDITABLE per-tier config = quotas + prices. The admin panel is the
 * SOURCE OF TRUTH (stored in Firestore appConfig/tiers); the values here are
 * the code DEFAULTS/fallback, merged under the stored doc — exactly how the
 * single-product pricing + storage quotas already work. Prices are the regular
 * monthly/yearly amount (sale cycles handled separately in the PayPal layer);
 * 0 = not set yet (admin must fill in). Free has no price.
 */
export interface TierConfig extends TierQuotas {
  /** Regular monthly price in the store currency; 0 = unset / free. */
  priceMonthly: number;
  /** Sale (discounted) monthly price; 0 = no sale. Applied only when > 0 and
   *  strictly below the regular price. */
  priceMonthlySale: number;
  /** Regular yearly price; 0 = unset / free. */
  priceYearly: number;
  /** Sale yearly price; 0 = no sale. */
  priceYearlySale: number;
}

export const DEFAULT_TIER_CONFIG: Record<Tier, TierConfig> = {
  free: { ...TIER_QUOTAS.free, priceMonthly: 0, priceMonthlySale: 0, priceYearly: 0, priceYearlySale: 0 },
  basic: { ...TIER_QUOTAS.basic, priceMonthly: 0, priceMonthlySale: 0, priceYearly: 0, priceYearlySale: 0 },
  pro: { ...TIER_QUOTAS.pro, priceMonthly: 0, priceMonthlySale: 0, priceYearly: 0, priceYearlySale: 0 },
  ultra: { ...TIER_QUOTAS.ultra, priceMonthly: 0, priceMonthlySale: 0, priceYearly: 0, priceYearlySale: 0 },
};

/** Regular + effective (post-sale) price for a tier + cycle. sale wins only
 *  when it's a positive number strictly below the regular price. */
export function tierPrice(
  cfg: TierConfig,
  cycle: "monthly" | "yearly",
): { regular: number; sale: number | null; effective: number } {
  const regular = cycle === "monthly" ? cfg.priceMonthly : cfg.priceYearly;
  const saleRaw = cycle === "monthly" ? cfg.priceMonthlySale : cfg.priceYearlySale;
  const sale = saleRaw > 0 && saleRaw < regular ? saleRaw : null;
  return { regular, sale, effective: sale ?? regular };
}

/** Paid tiers only (Free is never purchased) — the tiers the buy page +
 *  PayPal plan sync iterate over, low → high. */
export const PAID_TIERS: readonly Exclude<Tier, "free">[] = ["basic", "pro", "ultra"];

/** Merge an admin-stored partial config over the code defaults, tier by tier
 *  and field by field, so a missing field always falls back safely. */
export function mergeTierConfig(
  stored: Partial<Record<Tier, Partial<TierConfig>>> | null | undefined,
): Record<Tier, TierConfig> {
  const out = {} as Record<Tier, TierConfig>;
  for (const t of TIER_ORDER) {
    out[t] = { ...DEFAULT_TIER_CONFIG[t], ...(stored?.[t] ?? {}) };
  }
  return out;
}

/** Hebrew display label per tier (for badges / upsell copy). */
export const TIER_LABEL: Record<Tier, string> = {
  free: "חינם",
  basic: "Basic",
  pro: "Pro",
  ultra: "Ultra",
};
