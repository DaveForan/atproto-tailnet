/**
 * Public service board page (/board/:slug). Plain DOM, no framework; served
 * as a static bundle so it runs under the CSP (no inline script or handlers).
 */

interface BoardPost {
  title: string;
  description?: string | null;
  serviceName: string;
  serviceUrl?: string | null;
  serviceDescription?: string | null;
  authorHandle: string;
  authorDisplayName?: string | null;
  createdAt: string;
}

interface BoardData {
  tenant: { name: string; slug: string };
  posts: BoardPost[];
}

function esc(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(url: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") return esc(url);
  } catch {
    /* not a URL */
  }
  return "";
}

const app = document.getElementById("board-app")!;
const slug = window.location.pathname.split("/board/")[1] ?? "";

function renderBoard(data: BoardData): void {
  let html = `<h1>${esc(data.tenant.name)}</h1><p class="subtitle">Public service board</p>`;
  if (data.posts.length === 0) {
    html += '<div class="empty">No posts yet.</div>';
  } else {
    html += data.posts
      .map(
        (p) =>
          `<div class="post-card" data-url="${esc(p.serviceUrl)}" data-service-desc="${esc(p.serviceDescription || "")}">` +
          `<div class="post-title">${esc(p.title)}</div>` +
          (p.description ? `<div class="post-desc">${esc(p.description)}</div>` : "") +
          '<div class="post-meta">' +
          `<span class="service-tag">${esc(p.serviceName)}</span>` +
          `<span>by ${esc(p.authorDisplayName || p.authorHandle)}</span>` +
          `<span>${esc(new Date(p.createdAt).toLocaleDateString())}</span>` +
          "</div></div>",
      )
      .join("");
  }
  html += '<a class="back-link" href="/">Go to dashboard</a>';
  app.innerHTML = html;
}

function toggleService(card: HTMLElement): void {
  const existing = card.querySelector(".service-detail");
  if (existing) {
    existing.remove();
    return;
  }
  const url = card.getAttribute("data-url");
  const desc = card.getAttribute("data-service-desc");
  const safe = safeUrl(url);
  const detail = document.createElement("div");
  detail.className = "service-detail";
  detail.innerHTML =
    (desc ? `<p class="service-desc">${esc(desc)}</p>` : "") +
    (safe
      ? `<p>Service URL: <a href="${safe}" target="_blank" rel="noopener">${safe}</a></p>`
      : `<p>Service URL: ${esc(url)}</p>`);
  card.appendChild(detail);
}

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest(".service-detail a")) return; // let links open
  const card = target.closest<HTMLElement>(".post-card");
  if (card) toggleService(card);
});

async function init(): Promise<void> {
  try {
    const res = await fetch(`/api/tenants/by-slug/${encodeURIComponent(slug)}/board`);
    if (!res.ok) {
      app.innerHTML =
        '<div class="empty"><h1>Board not available</h1><p>This tailnet does not have a public board.</p><a class="back-link" href="/">Go to dashboard</a></div>';
      return;
    }
    renderBoard((await res.json()) as BoardData);
  } catch {
    app.innerHTML = '<div class="empty">Failed to load board.</div>';
  }
}

void init();
