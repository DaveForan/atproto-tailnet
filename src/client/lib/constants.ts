/** Available billing plans. */
export const PLANS = ["free", "starter", "pro", "enterprise"] as const;

export type PlanName = (typeof PLANS)[number];
