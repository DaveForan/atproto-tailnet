import { api, tenantApi } from "./api";

export interface MyDevice {
  id: string;
  name: string;
  address: string | null;
  online: boolean;
}

export interface PublicPost {
  id: string;
  title: string;
  description: string | null;
  name: string | null;
  proto: "tcp" | "udp";
  port: number;
  /** Served as https://<name>.<base domain> by the gateway. */
  web: boolean;
  author: { handle: string; displayName: string | null };
  isAuthor: boolean;
  address: string | null;
  /** The HTTPS address, when this is a web service that this viewer can open. */
  url: string | null;
  deviceOnline: boolean;
  /** Only members of some roles may connect. */
  restricted: boolean;
  /** False for a reviewer who sees a post that their role may not connect to. */
  canConnect: boolean;
  myConnectedDevices: string[];
  connectedDevices?: number;
}

export interface MyPost {
  id: string;
  board: "public" | "private";
  title: string;
  description: string | null;
  name: string | null;
  nodeId: string;
  proto: "tcp" | "udp";
  port: number;
  web: boolean;
  /** Roles that may connect. Empty = every member. */
  allowedRoleIds: string[];
  status: "pending" | "approved" | "rejected";
  rejectReason: string | null;
  device: MyDevice | null;
  connections?: Array<{ userId: string; handle: string; devices: number }>;
}

export interface PendingPost extends Omit<MyPost, "device" | "connections"> {
  authorHandle: string;
}

/** Public services of a child tailnet, as members of the parent see them: to read only. */
export interface ChildBoard {
  name: string;
  /** The public address of the child tailnet (its join page), or null. */
  address: string | null;
  posts: Array<{ id: string; title: string; description: string | null; proto: "tcp" | "udp"; port: number; web: boolean; author: { handle: string } }>;
}

export interface NewPost {
  board: "public" | "private";
  title: string;
  description?: string;
  nodeId: string;
  port: number;
  proto: "tcp" | "udp";
  name?: string;
  web?: boolean;
  /** Public board only: roles that may connect. Empty = every member. */
  roleIds?: string[];
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const boardsService = {
  myDevices: (tid: string) => tenantApi<{ devices: MyDevice[]; supported: boolean }>(tid, "/my-devices"),
  publicBoard: (tid: string) => tenantApi<{ posts: PublicPost[] }>(tid, "/boards/public"),
  myPosts: (tid: string) => tenantApi<{ baseDomain: string; httpsServices: boolean; serviceDomain: string | null; posts: MyPost[] }>(tid, "/boards/mine"),
  children: (tid: string) => tenantApi<{ tailnets: ChildBoard[] }>(tid, "/boards/children"),
  pending: (tid: string) => tenantApi<{ posts: PendingPost[] }>(tid, "/boards/pending"),
  create: (tid: string, post: NewPost) => tenantApi<MyPost>(tid, "/boards/posts", json("POST", post)),
  remove: (tid: string, postId: string) => tenantApi(tid, `/boards/posts/${postId}`, json("DELETE")),
  setRoles: (tid: string, postId: string, roleIds: string[]) => tenantApi<MyPost>(tid, `/boards/posts/${postId}`, json("PATCH", { roleIds })),
  approve: (tid: string, postId: string) => tenantApi(tid, `/boards/posts/${postId}/approve`, json("POST", {})),
  reject: (tid: string, postId: string, reason: string) =>
    tenantApi(tid, `/boards/posts/${postId}/reject`, json("POST", { reason })),
  setConnections: (tid: string, postId: string, nodeIds: string[]) =>
    tenantApi<{ connectedDevices: string[]; applied: boolean }>(
      tid,
      `/boards/posts/${postId}/connections`,
      json("PUT", { nodeIds }),
    ),
  disconnectMember: (tid: string, postId: string, userId: string) =>
    tenantApi(tid, `/boards/posts/${postId}/connections/${userId}`, json("DELETE")),

  accessMode: (tid: string) =>
    tenantApi<{ mode: "open" | "member"; supported: boolean; canEdit: boolean }>(tid, "/access-mode"),
  setAccessMode: (tid: string, mode: "open" | "member") => tenantApi(tid, "/access-mode", json("PUT", { mode })),

  controllerBoard: (tid: string) =>
    tenantApi<{ text: string; canEdit: boolean; address: string }>(tid, "/controller-board"),
  setControllerBoard: (tid: string, text: string) => tenantApi(tid, "/controller-board", json("PUT", { text })),
  landing: () => api<{ name: string | null; text: string }>("/api/public/landing"),
};
