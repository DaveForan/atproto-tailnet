import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useToast } from "./Toast";
import { tabRegistry } from "./registry";
import { notificationService } from "../services/notifications";
import { errorMessage, relativeTime } from "../lib/utils";
import type { AppNotification, TabId } from "../lib/types";

const POLL_MS = 30_000;

const TYPE_TABS: Record<string, TabId> = {
  device_approval_requested: "security",
  join_request: "security",
  service_device_approval_requested: "board",
  service_approval_requested: "board",
  device_limit_reached: "usage",
};

function isTabId(v: string): v is TabId {
  return tabRegistry.some((e) => e.id === v);
}

function targetTab(n: AppNotification): TabId | null {
  if (n.link) {
    const raw = n.link.includes("#") ? n.link.slice(n.link.indexOf("#") + 1) : n.link.replace(/^\/+/, "");
    if (isTabId(raw)) return raw;
  }
  return TYPE_TABS[n.type] ?? null;
}

export function NotificationBell() {
  const { currentTenant, setTab } = useApp();
  const { toastError } = useToast();
  const tid = currentTenant?.id;
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tidRef = useRef(tid);
  tidRef.current = tid;
  const panelId = useId();

  const refreshCount = useCallback(async () => {
    const t = tidRef.current;
    if (!t) return;
    try {
      const n = await notificationService.unreadCount(t);
      if (t === tidRef.current) setUnread(n);
    } catch { /* transient; next poll retries */ }
  }, []);

  useEffect(() => {
    setUnread(0);
    setItems([]);
    setOpen(false);
    if (!tid) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void refreshCount();
      timer = setInterval(() => { void refreshCount(); }, POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tid, refreshCount]);

  const loadList = useCallback(async () => {
    const t = tidRef.current;
    if (!t) return;
    setLoadingList(true);
    try {
      const res = await notificationService.list(t, { limit: 50 });
      if (res && t === tidRef.current) {
        setItems(res.notifications);
        setUnread(res.unreadCount);
      }
    } catch (e) {
      toastError(errorMessage(e, "Failed to load notifications"));
    } finally {
      setLoadingList(false);
    }
  }, [toastError]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadList();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open, loadList, close]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const markAll = async () => {
    if (!tid) return;
    try {
      const res = await notificationService.markAllRead(tid);
      const now = new Date().toISOString();
      setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
      setUnread(res?.unreadCount ?? 0);
    } catch (e) {
      toastError(errorMessage(e, "Failed to mark notifications read"));
    }
  };

  const openItem = async (n: AppNotification) => {
    if (!tid) return;
    if (!n.readAt) {
      const now = new Date().toISOString();
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: now } : x)));
      setUnread((c) => Math.max(0, c - 1));
      notificationService
        .markRead(tid, [n.id])
        .then((res) => { if (res && tid === tidRef.current) setUnread(res.unreadCount); })
        .catch(() => { void refreshCount(); });
    }
    const tab = targetTab(n);
    if (tab) {
      setTab(tab);
      close(false);
    }
  };

  if (!tid) return null;

  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <div ref={wrapRef} className="notif">
      <button
        ref={buttonRef}
        type="button"
        className="btn-sm btn-ghost notif-button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="true"
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="notif-count" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="region"
          aria-label="Notifications"
          tabIndex={-1}
          className="notif-panel"
        >
          <div className="notif-panel-head">
            <strong>Notifications</strong>
            <button
              type="button"
              className="btn-sm btn-ghost"
              onClick={markAll}
              disabled={unread === 0}
            >
              Mark all read
            </button>
          </div>
          {loadingList && items.length === 0 ? (
            <p className="text-dim text-sm notif-empty" role="status">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-dim text-sm notif-empty">No notifications.</p>
          ) : (
            <ul className="notif-list">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`notif-item${n.readAt ? " read" : ""}`}
                    onClick={() => openItem(n)}
                  >
                    <span className="notif-item-head">
                      <span className="notif-item-title">
                        {!n.readAt && <span className="sr-only">Unread: </span>}
                        {n.title}
                      </span>
                      <span className="text-dim text-xs">{relativeTime(n.createdAt)}</span>
                    </span>
                    {n.body && <span className="text-dim text-sm notif-item-body">{n.body}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
