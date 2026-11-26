/**
 * @module mcp/tools
 * MCP tool catalogue: thin wrappers over REST endpoints, called with the user's token (see mcp/api-client.ts).
 * Permissions, validation and business rules stay in the route handlers.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ApiClient } from "./api-client.js";

type Shape = Record<string, z.ZodTypeAny>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  shape?: Shape;
  annotations: ToolAnnotations;
  /** Listed only for instance operators (the API enforces it regardless). */
  operator?: boolean;
  run(api: ApiClient, args: Record<string, unknown>): Promise<unknown>;
}

// Security: each id in a REST path is checked twice, by the tool's input schema and by seg().
// No format allows '.', '/', '%' or a backslash, so an argument cannot add, remove or climb path segments.
// api-client.ts also refuses a request whose normalized URL path differs from the constructed one.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Opaque control-plane ids: numeric node ids, `cp:<id>` / UUID auth key ids. */
export const SEGMENT_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;
/** Synthesized route id `<nodeId>-<base64url(prefix)>` (orchestrator/headscale-api routeId). */
const ROUTE_ID_RE = /^\d{1,20}-[A-Za-z0-9_-]{1,96}$/;
/** Readable route id `<nodeId>:<cidr>`; converted to the synthesized form before use. */
const READABLE_ROUTE_RE = /^(\d{1,20}):([0-9A-Fa-f.:]{2,45}\/\d{1,3})$/;

type SegKind = "uuid" | "id" | "route";

/** Validates one path-segment argument; throws (no HTTP call) when malformed. */
export function seg(value: unknown, kind: SegKind, name = "id"): string {
  if (typeof value !== "string") throw new Error(`Invalid ${name}`);
  if (kind === "uuid" && UUID_RE.test(value)) return value;
  if (kind === "id" && SEGMENT_ID_RE.test(value)) return value;
  if (kind === "route") {
    if (ROUTE_ID_RE.test(value)) return value;
    const m = READABLE_ROUTE_RE.exec(value);
    if (m) return `${m[1]}-${Buffer.from(m[2]).toString("base64url")}`;
  }
  throw new Error(`Invalid ${name}: must be ${kind === "uuid" ? "a UUID" : "an id from the matching list tool"}`);
}

const uuidArg = () => z.string().regex(UUID_RE, "must be a UUID");
const idArg = () => z.string().regex(SEGMENT_ID_RE, "must be an id from the matching list tool (letters, digits, _ : -)");
const routeArg = () =>
  z
    .string()
    .max(160)
    .refine((v) => ROUTE_ID_RE.test(v) || READABLE_ROUTE_RE.test(v), "must be a route id from list_routes");

const tailnetId = uuidArg().describe("Tailnet id (from list_tailnets)");
const t = (a: Record<string, unknown>) => `/api/tenants/${seg(a.tailnet_id, "uuid", "tailnet_id")}`;

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const DESTRUCTIVE_NOTE = " DESTRUCTIVE: this cannot be undone from here — confirm with the user first.";

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "whoami",
    title: "Who am I",
    description:
      "Show the signed-in user this connection acts as: id, DID, handle, isOperator, canCreateTailnet, access.",
    annotations: READ,
    run: (api) => api.call("GET", "/api/me"),
  },

  {
    name: "list_tailnets",
    title: "List tailnets",
    description: "List the tailnets you are a member of, with your role in each. Use the returned id as tailnet_id.",
    annotations: READ,
    run: (api) => api.call("GET", "/api/tenants"),
  },
  {
    name: "create_tailnet",
    title: "Create my tailnet",
    description:
      "Create your own top-level tailnet. Only works when whoami shows canCreateTailnet (operators and designated creators).",
    shape: { name: z.string().trim().min(1).max(100).optional().describe("Display name") },
    annotations: WRITE,
    run: (api, a) => api.call("POST", "/api/tenants/mine", a.name ? { name: a.name } : {}),
  },
  {
    name: "get_tailnet",
    title: "Get tailnet",
    description: "Get one tailnet's status, settings, and usage against its limits.",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: async (api, a) => {
      const tailnet = await api.call("GET", t(a));
      const [settings, usage] = await Promise.allSettled([
        api.call("GET", `${t(a)}/settings`),
        api.call("GET", `${t(a)}/usage`),
      ]);
      const val = (r: PromiseSettledResult<unknown>) =>
        r.status === "fulfilled" ? r.value : { error: (r.reason as Error).message };
      return { tailnet, settings: val(settings), usage: val(usage) };
    },
  },

  {
    name: "list_devices",
    title: "List devices",
    description: "List the devices (nodes) in a tailnet.",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/devices`),
  },
  {
    name: "remove_device",
    title: "Remove device",
    description: "Remove a device from a tailnet. It must re-register with a new key to rejoin." + DESTRUCTIVE_NOTE,
    shape: { tailnet_id: tailnetId, device_id: idArg().describe("Device/node id from list_devices") },
    annotations: DESTRUCTIVE,
    run: (api, a) => api.call("DELETE", `${t(a)}/devices/${seg(a.device_id, "id", "device_id")}`),
  },

  {
    name: "list_members",
    title: "List members",
    description: "List the members of a tailnet with their roles.",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/members`),
  },
  {
    name: "remove_member",
    title: "Remove member",
    description:
      "Remove a member from a tailnet. Their devices are deleted and their keys revoked." + DESTRUCTIVE_NOTE,
    shape: { tailnet_id: tailnetId, user_id: uuidArg().describe("Member user id from list_members") },
    annotations: DESTRUCTIVE,
    run: (api, a) => api.call("DELETE", `${t(a)}/members/${seg(a.user_id, "uuid", "user_id")}`),
  },

  {
    name: "invite",
    title: "Invite",
    description:
      "Invite someone to a tailnet by Bluesky handle or DID (give exactly one). Returns the invitation with an inviteUrl to send them.",
    shape: {
      tailnet_id: tailnetId,
      handle: z.string().min(1).max(253).optional().describe("Handle, e.g. alice.bsky.social"),
      did: z.string().startsWith("did:").max(2048).optional().describe("DID, e.g. did:plc:…"),
    },
    annotations: WRITE,
    run: (api, a) => {
      const hasHandle = typeof a.handle === "string" && a.handle.length > 0;
      const hasDid = typeof a.did === "string" && a.did.length > 0;
      if (hasHandle === hasDid) throw new Error("Give exactly one of handle or did");
      return api.call("POST", `${t(a)}/invitations`, hasHandle ? { handle: a.handle } : { did: a.did });
    },
  },
  {
    name: "list_invitations",
    title: "List invitations",
    description: "List a tailnet's invitations and their status (with inviteUrl).",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/invitations`),
  },
  {
    name: "revoke_invitation",
    title: "Revoke invitation",
    description: "Revoke a pending invitation so its link stops working." + DESTRUCTIVE_NOTE,
    shape: { tailnet_id: tailnetId, invitation_id: uuidArg() },
    annotations: DESTRUCTIVE,
    run: (api, a) => api.call("DELETE", `${t(a)}/invitations/${seg(a.invitation_id, "uuid", "invitation_id")}`),
  },

  {
    name: "list_join_requests",
    title: "List join requests",
    description: "List requests from people asking to join a tailnet.",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/join-requests`),
  },
  {
    name: "approve_join_request",
    title: "Approve join request",
    description: "Approve a join request; the requester becomes a member.",
    shape: { tailnet_id: tailnetId, request_id: uuidArg() },
    annotations: WRITE,
    run: (api, a) => api.call("POST", `${t(a)}/join-requests/${seg(a.request_id, "uuid", "request_id")}/approve`),
  },
  {
    name: "reject_join_request",
    title: "Reject join request",
    description: "Reject a join request.",
    shape: { tailnet_id: tailnetId, request_id: uuidArg() },
    annotations: WRITE,
    run: (api, a) => api.call("POST", `${t(a)}/join-requests/${seg(a.request_id, "uuid", "request_id")}/reject`),
  },

  {
    name: "list_device_approvals",
    title: "List device approvals",
    description: "List pending requests for a device key (Headscale mode only). In coordinator mode use list_waiting_devices.",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/device-approvals`),
  },
  {
    name: "approve_device",
    title: "Approve device",
    description: "Approve a device approval request; a key is issued for the requester.",
    shape: { tailnet_id: tailnetId, approval_id: uuidArg() },
    annotations: WRITE,
    run: (api, a) => api.call("POST", `${t(a)}/device-approvals/${seg(a.approval_id, "uuid", "approval_id")}/approve`),
  },
  {
    name: "reject_device",
    title: "Reject device",
    description: "Reject a device approval request.",
    shape: { tailnet_id: tailnetId, approval_id: uuidArg() },
    annotations: WRITE,
    run: (api, a) => api.call("POST", `${t(a)}/device-approvals/${seg(a.approval_id, "uuid", "approval_id")}/reject`),
  },

  {
    name: "list_waiting_devices",
    title: "List waiting devices",
    description:
      "List the devices that wait for admission: `mine` wait for you, `queue` wait for an approver. Every new device waits until its owner admits that exact machine in the dashboard (Overview). Nobody can admit a device through this connector.",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/devices/waiting`),
  },

  {
    name: "get_my_device_approval",
    title: "Get my device approval",
    description:
      "Show whether you approve each of your own new devices in this tailnet (`on`), whether the tailnet locks that on (`locked`), and whether another member must also admit your new devices (`needsApprover`). Only you can change it, in the dashboard under Devices → Access.",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/device-approval/mine`),
  },
  {
    name: "invalidate_member_devices",
    title: "Invalidate a member's devices and keys",
    description:
      "Remove every device of one member from a tailnet and revoke every auth key of that member. The member stays a member and adds devices again afterwards. You can do this for yourself; for another member you need manage_devices or to be the originator." +
      DESTRUCTIVE_NOTE,
    shape: { tailnet_id: tailnetId, user_id: uuidArg().describe("Member user id from list_members, or your own from whoami") },
    annotations: DESTRUCTIVE,
    run: (api, a) => api.call("POST", `${t(a)}/members/${seg(a.user_id, "uuid", "user_id")}/devices/invalidate`),
  },
  {
    name: "list_my_devices",
    title: "List my devices",
    description: "List the caller's own devices in a tailnet (id, name, address, online). A service runs on one of these.",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/my-devices`),
  },
  {
    name: "list_roles",
    title: "List roles",
    description: "List the roles of a tailnet (id, name, permissions).",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/roles`),
  },
  {
    name: "list_services",
    title: "List services",
    description:
      "List the services of a tailnet that the caller can see: the public board, the caller's own posts on both boards " +
      "(with status and connected members), and the public services of sub-collectives (read only).",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: async (api, a) => ({
      public_board: await api.call("GET", `${t(a)}/boards/public`),
      mine: await api.call("GET", `${t(a)}/boards/mine`),
      sub_collectives: await api.call("GET", `${t(a)}/boards/children`),
    }),
  },
  {
    name: "publish_service",
    title: "Publish a service",
    description:
      "Publish one port of one of the caller's devices as a service, for example \"publish food-app on port 3000 from my laptop\". " +
      "board \"private\": for the caller's own devices, needs a name. board \"public\": offered to members, who connect chosen devices; " +
      "it may need approval by the tailnet first. web: serve it at an https address inside the tailnet (needs a name and TCP; " +
      "the application must listen on the tailnet address of the device, not only on localhost). " +
      "role_ids: only members with these roles may connect (public board).",
    shape: {
      tailnet_id: tailnetId,
      device_id: idArg().describe("One of the caller's devices (from list_my_devices)"),
      port: z.number().int().min(1).max(65535),
      title: z.string().min(1).max(120),
      board: z.enum(["private", "public"]).optional().describe("Default private"),
      name: z.string().max(63).optional().describe("DNS label of the service, for example food-app"),
      description: z.string().max(1000).optional(),
      proto: z.enum(["tcp", "udp"]).optional().describe("Default tcp"),
      web: z.boolean().optional().describe("Give it an https web address"),
      role_ids: z.array(uuidArg()).max(20).optional().describe("Role ids from list_roles; public board only"),
    },
    annotations: WRITE,
    run: (api, a) => {
      const body: Record<string, unknown> = {
        board: a.board ?? "private",
        title: a.title,
        nodeId: seg(a.device_id, "id", "device_id"),
        port: a.port,
      };
      for (const [from, to] of [["name", "name"], ["description", "description"], ["proto", "proto"], ["web", "web"], ["role_ids", "roleIds"]] as const) {
        if (a[from] !== undefined) body[to] = a[from];
      }
      return api.call("POST", `${t(a)}/boards/posts`, body);
    },
  },
  {
    name: "remove_service",
    title: "Remove a service",
    description: "Remove one of the caller's service posts (or any public post, with the manage_board permission). Access through it ends at once." + DESTRUCTIVE_NOTE,
    shape: { tailnet_id: tailnetId, service_id: uuidArg().describe("Post id from list_services") },
    annotations: DESTRUCTIVE,
    run: (api, a) => api.call("DELETE", `${t(a)}/boards/posts/${seg(a.service_id, "uuid", "service_id")}`),
  },
  {
    name: "connect_to_service",
    title: "Connect devices to a service",
    description:
      "Set which of the caller's devices are connected to a public service. Each connected device can reach that one port of the service device. " +
      "An empty list disconnects.",
    shape: {
      tailnet_id: tailnetId,
      service_id: uuidArg().describe("Post id from list_services"),
      device_ids: z.array(idArg()).max(32).describe("The caller's devices (from list_my_devices); empty to disconnect"),
    },
    annotations: WRITE,
    run: (api, a) =>
      api.call("PUT", `${t(a)}/boards/posts/${seg(a.service_id, "uuid", "service_id")}/connections`, {
        nodeIds: (a.device_ids as unknown[]).map((id) => seg(id, "id", "device_ids")),
      }),
  },

  {
    name: "list_auth_keys",
    title: "List auth keys",
    description: "List issued pre-auth keys (all keys if you manage devices, otherwise your own).",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/auth-keys`),
  },
  {
    name: "create_auth_key",
    title: "Create auth key",
    description:
      "Create a pre-auth key for adding a device to the tailnet (tailscale up --auth-key=…). The key is shown once. " +
      "Only members who can manage devices may create reusable keys or keys lasting more than 24 hours.",
    shape: {
      tailnet_id: tailnetId,
      reusable: z.boolean().optional().describe("Allow the key to register several devices (device managers only)"),
      expires_in_hours: z
        .number()
        .int()
        .min(1)
        .max(720)
        .optional()
        .describe("Default 24; more than 24 needs device-manager permission"),
    },
    annotations: WRITE,
    run: (api, a) => {
      const body: Record<string, unknown> = {};
      if (a.reusable !== undefined) body.reusable = a.reusable;
      if (a.expires_in_hours !== undefined) body.expiresInHours = a.expires_in_hours;
      return api.call("POST", `${t(a)}/devices/auth-key`, body);
    },
  },
  {
    name: "revoke_auth_key",
    title: "Revoke auth key",
    description: "Revoke a pre-auth key so it can no longer register devices." + DESTRUCTIVE_NOTE,
    shape: { tailnet_id: tailnetId, key_id: idArg().describe("Key id from list_auth_keys") },
    annotations: DESTRUCTIVE,
    run: (api, a) => api.call("DELETE", `${t(a)}/auth-keys/${seg(a.key_id, "id", "key_id")}`),
  },

  {
    name: "get_acl",
    title: "Get ACL policy",
    description: "Get the tailnet's ACL policy (acls, groups, hosts, tagOwners, autoApprovers).",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/acl`),
  },
  {
    name: "set_acl",
    title: "Set ACL policy",
    description:
      "Replace the tailnet's whole ACL policy. Pass the full policy object, e.g. {\"acls\":[{\"action\":\"accept\",\"src\":[\"*\"],\"dst\":[\"*:*\"]}],\"groups\":{},\"hosts\":{},\"tagOwners\":{}}. A wrong policy can cut devices off — read get_acl first.",
    shape: {
      tailnet_id: tailnetId,
      policy: z.record(z.string(), z.unknown()).describe("Full ACL policy object"),
    },
    annotations: { ...WRITE, idempotentHint: true },
    run: (api, a) => api.call("PUT", `${t(a)}/acl`, a.policy),
  },

  {
    name: "list_routes",
    title: "List routes",
    description: "List exit nodes and subnet routes advertised in the tailnet, with approval state.",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/routes`),
  },
  {
    name: "approve_route",
    title: "Approve route",
    description: "Approve (enable) an advertised exit node or subnet route.",
    shape: { tailnet_id: tailnetId, route_id: routeArg().describe("Route id from list_routes") },
    annotations: { ...WRITE, idempotentHint: true },
    run: (api, a) => api.call("POST", `${t(a)}/routes/${seg(a.route_id, "route", "route_id")}/enable`),
  },
  {
    name: "unapprove_route",
    title: "Unapprove route",
    description: "Withdraw approval of an exit node or subnet route (disable it).",
    shape: { tailnet_id: tailnetId, route_id: routeArg().describe("Route id from list_routes") },
    annotations: { ...WRITE, idempotentHint: true },
    run: (api, a) => api.call("POST", `${t(a)}/routes/${seg(a.route_id, "route", "route_id")}/disable`),
  },

  {
    name: "get_settings",
    title: "Get settings",
    description: "Get the tailnet's settings (device approval, lockdown, join requests, agent tokens, …).",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/settings`),
  },
  {
    name: "update_settings",
    title: "Update settings",
    description: "Change one or more tailnet settings. Only the fields you pass change.",
    shape: {
      tailnet_id: tailnetId,
      requireDeviceApproval: z.boolean().optional().describe("While on, an approver must also admit each new device after its owner did"),
      lockdownMode: z.boolean().optional().describe("Blocks invitations, joins and new keys while on"),
      allowJoinRequests: z.boolean().optional(),
      boardEnabled: z.boolean().optional(),
      maxBoardPosts: z.number().int().min(1).max(200).optional(),
      maxBoardPostsDisplayed: z.number().int().min(1).max(200).optional(),
      requireServiceApproval: z.boolean().optional(),
      requireServiceDeviceApproval: z.boolean().optional(),
      allowAgentTokens: z.boolean().optional(),
      allowMemberAgentTokens: z.boolean().optional(),
      hibernateAfterDays: z.number().int().min(0).max(365).optional(),
      notificationWebhookUrl: z.string().max(2048).nullable().optional(),
    },
    annotations: { ...WRITE, idempotentHint: true },
    run: (api, a) => {
      const { tailnet_id: _id, ...rest } = a;
      const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      if (Object.keys(body).length === 0) throw new Error("Pass at least one setting to change");
      return api.call("PATCH", `${t(a)}/settings`, body);
    },
  },
  {
    name: "set_limits",
    title: "Set limits",
    description:
      "Set the tailnet's device and member caps (0 = unlimited), and after how many hours a device that waits for admission is removed (default 168). Originator only.",
    shape: {
      tailnet_id: tailnetId,
      maxDevices: z.number().int().min(0).optional(),
      maxMembers: z.number().int().min(0).optional(),
      waitingDeviceHours: z.number().int().min(1).max(8760).optional(),
    },
    annotations: { ...WRITE, idempotentHint: true },
    run: (api, a) => {
      const body: Record<string, unknown> = {};
      if (a.maxDevices !== undefined) body.maxDevices = a.maxDevices;
      if (a.maxMembers !== undefined) body.maxMembers = a.maxMembers;
      if (a.waitingDeviceHours !== undefined) body.waitingDeviceHours = a.waitingDeviceHours;
      return api.call("PUT", `${t(a)}/limits`, body);
    },
  },
  {
    name: "list_notifications",
    title: "List notifications",
    description: "List your notifications for a tailnet (approval requests, limit hits).",
    shape: { tailnet_id: tailnetId },
    annotations: READ,
    run: (api, a) => api.call("GET", `${t(a)}/notifications`),
  },

  {
    name: "instance_overview",
    title: "Instance overview",
    description: "Operator: all tailnets and users on this instance, plus instance settings.",
    annotations: READ,
    operator: true,
    run: (api) => api.call("GET", "/api/operator/overview"),
  },
  {
    name: "get_instance_settings",
    title: "Get instance settings",
    description: "Operator: get instance settings (singleTailnet, defaultTailnetId).",
    annotations: READ,
    operator: true,
    run: (api) => api.call("GET", "/api/operator/settings"),
  },
  {
    name: "update_instance_settings",
    title: "Update instance settings",
    description:
      "Operator: change instance settings. singleTailnet limits the instance to one top-level tailnet; defaultTailnetId (or null) is offered to users with no access.",
    shape: {
      singleTailnet: z.boolean().optional(),
      defaultTailnetId: uuidArg().nullable().optional(),
    },
    annotations: { ...WRITE, idempotentHint: true },
    operator: true,
    run: (api, a) => {
      const body: Record<string, unknown> = {};
      if (a.singleTailnet !== undefined) body.singleTailnet = a.singleTailnet;
      if (a.defaultTailnetId !== undefined) body.defaultTailnetId = a.defaultTailnetId;
      return api.call("PUT", "/api/operator/settings", body);
    },
  },
  {
    name: "list_tailnet_creators",
    title: "List tailnet creators",
    description: "Operator: list DIDs allowed to create their own tailnet.",
    annotations: READ,
    operator: true,
    run: (api) => api.call("GET", "/api/operator/tailnet-creators"),
  },
  {
    name: "add_tailnet_creator",
    title: "Add tailnet creator",
    description: "Operator: allow a DID or handle (give exactly one) to create their own tailnet.",
    shape: {
      did: z.string().startsWith("did:").max(2048).optional(),
      handle: z.string().min(1).max(253).optional(),
    },
    annotations: WRITE,
    operator: true,
    run: (api, a) => {
      const hasHandle = typeof a.handle === "string" && a.handle.length > 0;
      const hasDid = typeof a.did === "string" && a.did.length > 0;
      if (hasHandle === hasDid) throw new Error("Give exactly one of handle or did");
      return api.call("POST", "/api/operator/tailnet-creators", hasHandle ? { handle: a.handle } : { did: a.did });
    },
  },
  {
    name: "remove_tailnet_creator",
    title: "Remove tailnet creator",
    description:
      "Operator: remove a tailnet creator. Their existing tailnet is kept, but they cannot create a new one." +
      DESTRUCTIVE_NOTE,
    shape: { creator_id: uuidArg().describe("Creator id from list_tailnet_creators") },
    annotations: DESTRUCTIVE,
    operator: true,
    run: (api, a) => api.call("DELETE", `/api/operator/tailnet-creators/${seg(a.creator_id, "uuid", "creator_id")}`),
  },
  {
    name: "suspend_tailnet",
    title: "Suspend tailnet",
    description:
      "Operator: suspend a tailnet. Its devices lose the control plane and members lose dashboard access." +
      DESTRUCTIVE_NOTE,
    shape: { tailnet_id: tailnetId },
    annotations: DESTRUCTIVE,
    operator: true,
    run: (api, a) => api.call("POST", `/api/operator/tenants/${seg(a.tailnet_id, "uuid", "tailnet_id")}/suspend`),
  },
  {
    name: "unsuspend_tailnet",
    title: "Unsuspend tailnet",
    description: "Operator: lift a tailnet's suspension.",
    shape: { tailnet_id: tailnetId },
    annotations: { ...WRITE, idempotentHint: true },
    operator: true,
    run: (api, a) => api.call("POST", `/api/operator/tenants/${seg(a.tailnet_id, "uuid", "tailnet_id")}/unsuspend`),
  },
  {
    name: "delete_tailnet",
    title: "Delete tailnet",
    description: "Operator: permanently delete a tailnet and its control plane." + DESTRUCTIVE_NOTE,
    shape: { tailnet_id: tailnetId },
    annotations: DESTRUCTIVE,
    operator: true,
    run: (api, a) => api.call("DELETE", `/api/operator/tenants/${seg(a.tailnet_id, "uuid", "tailnet_id")}`),
  },
  {
    name: "disable_user",
    title: "Disable user",
    description:
      "Operator: disable a user. They cannot sign in or use tokens, and are removed from every tailnet (devices deleted, keys revoked)." +
      DESTRUCTIVE_NOTE,
    shape: { user_id: uuidArg().describe("User id from instance_overview") },
    annotations: DESTRUCTIVE,
    operator: true,
    run: (api, a) => api.call("POST", `/api/operator/users/${seg(a.user_id, "uuid", "user_id")}/disable`),
  },
  {
    name: "enable_user",
    title: "Enable user",
    description: "Operator: re-enable a disabled user (memberships are not restored).",
    shape: { user_id: uuidArg() },
    annotations: { ...WRITE, idempotentHint: true },
    operator: true,
    run: (api, a) => api.call("POST", `/api/operator/users/${seg(a.user_id, "uuid", "user_id")}/enable`),
  },
];

function textResult(data: unknown): CallToolResult {
  const text =
    data === null || data === undefined
      ? "OK"
      : typeof data === "string"
        ? data
        : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Registers the tools on `server`; operator tools only when `isOperator`. */
export function registerTools(server: McpServer, api: ApiClient, opts: { isOperator: boolean }): void {
  for (const def of TOOL_DEFS) {
    if (def.operator && !opts.isOperator) continue;
    const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        return textResult(await def.run(api, args ?? {}));
      } catch (err) {
        return errorResult(err);
      }
    };
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.shape ?? {},
        annotations: { title: def.title, ...def.annotations },
      },
      // Shapes vary per tool; arguments are validated by the SDK against inputSchema.
      handler as never,
    );
  }
}
