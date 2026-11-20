/** Runs an operator action: busy guard, success toast, reload; false when it failed. */
export type RunAction = (
  fn: () => Promise<unknown>,
  success: string,
  opts?: { reloadApp?: boolean },
) => Promise<boolean>;
