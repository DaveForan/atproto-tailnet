import { useCallback, useEffect, useState } from "react";
import { servicesService } from "../services/services";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { relativeTime } from "../lib/utils";
import type { BoardPost, Service } from "../lib/types";

export function BoardTab() {
  const { currentTenant, hasPerm } = useApp();
  const { toastError } = useToast();
  const { mutate, busy } = useTenantMutation();

  const [posts, setPosts] = useState<BoardPost[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [serviceId, setServiceId] = useState("");

  const loadData = useCallback(async () => {
    if (!currentTenant) return;
    try {
      const [p, svc] = await Promise.all([
        servicesService.getBoardPosts(currentTenant.id),
        servicesService.getServices(currentTenant.id),
      ]);
      setPosts(p ?? []);
      setServices(svc ?? []);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to load board");
    }
  }, [currentTenant?.id]);

  useEffect(() => {
    setLoading(true);
    loadData().finally(() => setLoading(false));
  }, [loadData]);

  const activeServices = services.filter((s) => s.status === "active");

  const createPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serviceId) return;
    const ok = await mutate(
      "/board-posts",
      {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          serviceId,
        }),
      },
      { successMsg: "Post created", reload: loadData },
    );
    if (ok) {
      setTitle("");
      setDescription("");
      setServiceId("");
    }
  };

  const removePost = async (id: string) => {
    await mutate(
      `/board-posts/${id}`,
      { method: "DELETE" },
      { successMsg: "Post removed", reload: loadData },
    );
  };

  if (loading) return <div className="loading">Loading...</div>;

  const slug = currentTenant?.slug;

  return (
    <div className="tab-content">
      <Card
        title="Board"
        actions={
          slug ? (
            <a
              href={`/board/${slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-sm btn-ghost"
            >
              Public Board
            </a>
          ) : null
        }
      >
        {hasPerm("create_posts") && (
          <form className="inline-form" onSubmit={createPost}>
            <input
              type="text"
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
            />
            <textarea
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={3}
            />
            <select
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              required
            >
              <option value="">
                {activeServices.length > 0 ? "Select a service" : "No active services"}
              </option>
              {activeServices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-primary" disabled={busy || !serviceId || !title.trim()}>
              Post
            </button>
          </form>
        )}

        {posts.length > 0 ? (
          <ul className="item-list">
            {posts.map((post) => (
              <li key={post.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">{post.title}</span>
                  {post.description && (
                    <span className="item-detail post-content">{post.description}</span>
                  )}
                  <span className="item-meta">
                    {post.authorDisplayName || post.authorHandle}
                    {post.serviceName && <> &middot; {post.serviceName}</>}
                    {" · "}
                    {relativeTime(post.createdAt)}
                  </span>
                </div>
                {hasPerm("manage_board") && (
                  <div className="item-actions">
                    <button
                      className="btn-sm btn-danger"
                      onClick={() => removePost(post.id)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No board posts yet.</EmptyState>
        )}
      </Card>
    </div>
  );
}
