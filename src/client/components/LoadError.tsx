/** Shown where a tab's data failed to load, so a failure never looks like an empty list. */
export function LoadError({ error, onRetry }: { error: string | null | undefined; onRetry?: () => unknown }) {
  if (!error) return null;
  return (
    <div className="load-error" role="alert">
      <span>{error}</span>
      {onRetry && (
        <button type="button" className="btn-sm" onClick={() => { void onRetry(); }}>
          Retry
        </button>
      )}
    </div>
  );
}
