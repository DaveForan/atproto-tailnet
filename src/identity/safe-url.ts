/** Returns `url` when it is an https URL of reasonable length, else null. */
export function safeUrl(url: string): string | null {
  if (url.length > 2048) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
