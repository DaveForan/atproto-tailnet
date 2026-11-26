import { visibleSections, type PageSection } from "./registry";
import { useSession } from "../hooks/session";
import { useTabRoute } from "../hooks/useTabRoute";
import type { TabId } from "../lib/types";

/** The sections of a page this user may open, and the open one (the first when the route names none). */
export function useSections(tab: TabId, hidden: string[] = []): { sections: PageSection[]; open: PageSection | null } {
  const { hasPerm, settings, currentTenant, user } = useSession();
  const { section } = useTabRoute();
  const sections = visibleSections(tab, hasPerm, settings, currentTenant, user).filter((s) => !hidden.includes(s.id));
  return { sections, open: sections.find((s) => s.id === section) ?? sections[0] ?? null };
}

/** The menu of a page's sections. A page with one section shows no menu. */
export function SubNav({
  tab,
  label,
  sections,
  open,
  counts = {},
}: {
  tab: TabId;
  label: string;
  sections: PageSection[];
  open: PageSection | null;
  counts?: Record<string, number>;
}) {
  const { setTab } = useTabRoute();
  if (sections.length < 2) return null;
  return (
    <nav className="subnav" aria-label={label}>
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`subnav-item${s.id === open?.id ? " active" : ""}`}
          aria-current={s.id === open?.id ? "page" : undefined}
          onClick={() => setTab(tab, s.id)}
        >
          {s.label}
          {counts[s.id] > 0 && (
            <span className="nav-count">
              {counts[s.id]}
              <span className="sr-only"> waiting</span>
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}
