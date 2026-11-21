import { useState } from "react";
import { Card } from "../../components/Card";
import { useToast } from "../../components/Toast";
import { useSession } from "../../hooks/session";
import { securityService } from "../../services/security";
import { errorMessage } from "../../lib/utils";

export function HibernationCard({
  days,
  onChange,
  busy,
  onSave,
}: {
  days: number;
  onChange: (days: number) => void;
  busy: boolean;
  onSave: (e: React.FormEvent) => void;
}) {
  return (
    <Card title="Hibernation">
      <form className="field" onSubmit={onSave}>
        <label htmlFor="hibernate-days">Hibernate after this many idle days</label>
        <div className="inline-form">
          <input
            id="hibernate-days"
            type="number"
            min={0}
            value={days}
            onChange={(e) => onChange(Number(e.target.value))}
            aria-describedby="hibernate-days-help"
          />
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="help-text" id="hibernate-days-help">0 turns hibernation off.</p>
      </form>
    </Card>
  );
}

export function BoardLimitsCard({
  maxPosts,
  setMaxPosts,
  maxPostsDisplayed,
  setMaxPostsDisplayed,
}: {
  maxPosts: number;
  setMaxPosts: (n: number) => void;
  maxPostsDisplayed: number;
  setMaxPostsDisplayed: (n: number) => void;
}) {
  const { currentTenant, reloadSettings } = useSession();
  const { toast, toastError } = useToast();
  const [busy, setBusy] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTenant || busy) return;
    setBusy(true);
    const errors: string[] = [];
    try {
      await securityService.updateSetting(currentTenant.id, "maxBoardPosts", maxPosts);
    } catch (e) {
      errors.push(`maxBoardPosts: ${errorMessage(e, "update failed")}`);
    }
    try {
      await securityService.updateSetting(currentTenant.id, "maxBoardPostsDisplayed", maxPostsDisplayed);
    } catch (e) {
      errors.push(`maxBoardPostsDisplayed: ${errorMessage(e, "update failed")}`);
    }
    setBusy(false);
    if (errors.length > 0) {
      toastError(`Failed to save board limits: ${errors.join("; ")}`);
      if (errors.length < 2) {
        // One setting was saved: show it
        await reloadSettings();
      }
    } else {
      toast("Board limits saved");
      await reloadSettings();
    }
  };

  return (
    <Card title="Board limits">
      <form className="form-stack" onSubmit={handleSave}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="max-posts">Max posts</label>
            <input
              id="max-posts"
              type="number"
              min={0}
              value={maxPosts}
              onChange={(e) => setMaxPosts(Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="max-posts-displayed">Max posts displayed</label>
            <input
              id="max-posts-displayed"
              type="number"
              min={0}
              value={maxPostsDisplayed}
              onChange={(e) => setMaxPostsDisplayed(Number(e.target.value))}
            />
          </div>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </Card>
  );
}
