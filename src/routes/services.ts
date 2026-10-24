import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  tenants,
  users,
  memberships,
  serviceDevices,
  services,
} from "../db/schema.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  isLockedDown,
  toHsUsername,
  tenantLoginServer,
} from "./helpers.js";
import { logAudit } from "./audit.js";

export const servicesRouter = Router();

// ── Service device registration ────────────────────────────────────

const serviceDeviceBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

servicesRouter.get(
  "/api/tenants/:tenantId/service-devices",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const rows = await db
      .select({
        id: serviceDevices.id,
        name: serviceDevices.name,
        description: serviceDevices.description,
        status: serviceDevices.status,
        ownerHandle: users.handle,
        ownerDisplayName: users.displayName,
        ownerId: serviceDevices.ownerId,
        createdAt: serviceDevices.createdAt,
        reviewedAt: serviceDevices.reviewedAt,
      })
      .from(serviceDevices)
      .innerJoin(users, eq(serviceDevices.ownerId, users.id))
      .where(eq(serviceDevices.tenantId, tenantId))
      .orderBy(desc(serviceDevices.createdAt));

    res.json(rows);
  },
);

servicesRouter.post(
  "/api/tenants/:tenantId/service-devices",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = req.session.userId!;

    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_services")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const parsed = serviceDeviceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const needsApproval = result.tenant.requireServiceDeviceApproval && !result.membership.isOriginator;

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const hsUsername = result.membership.isOriginator ? "owner" : toHsUsername(user.handle);

    if (needsApproval) {
      const [created] = await db
        .insert(serviceDevices)
        .values({
          tenantId,
          ownerId: userId,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          status: "pending",
          hsUsername,
        })
        .returning();

      logAudit({
        tenantId,
        actorUserId: userId,
        action: "service_device_requested",
        targetType: "service_device",
        targetId: created.id,
        metadata: { name: parsed.data.name },
      });

      res.status(202).json({ id: created.id, status: "pending" });
      return;
    }

    try {
      const client = new HeadscaleApiClient(
        result.tenant.port,
        result.tenant.apiKey,
      );

      try {
        await client.createUser(hsUsername);
      } catch {
        // user may already exist
      }

      const authKey = await client.createPreAuthKey(hsUsername);
      const loginServer = tenantLoginServer(result.tenant.slug);
      const command = `tailscale up --login-server ${loginServer} --authkey ${authKey.key}`;

      const [created] = await db
        .insert(serviceDevices)
        .values({
          tenantId,
          ownerId: userId,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          status: "approved",
          hsUsername,
          preAuthKey: authKey.key,
          command,
          reviewedById: userId,
          reviewedAt: new Date(),
        })
        .returning();

      logAudit({
        tenantId,
        actorUserId: userId,
        action: "service_device_requested",
        targetType: "service_device",
        targetId: created.id,
        metadata: { name: parsed.data.name, autoApproved: true },
      });

      res.status(201).json({
        id: created.id,
        status: "approved",
        preAuthKey: authKey.key,
        command,
      });
    } catch (err) {
      console.error("Failed to create service device auth key:", err);
      res.status(502).json({ error: "Failed to generate auth key" });
    }
  },
);

servicesRouter.post(
  "/api/tenants/:tenantId/service-devices/:deviceId/approve",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const deviceId = param(req, "deviceId");

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "approve_services")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const [device] = await db
      .select()
      .from(serviceDevices)
      .where(
        and(
          eq(serviceDevices.id, deviceId),
          eq(serviceDevices.tenantId, tenantId),
          eq(serviceDevices.status, "pending"),
        ),
      );

    if (!device) {
      res.status(404).json({ error: "Pending service device not found" });
      return;
    }

    try {
      const client = new HeadscaleApiClient(
        result.tenant.port,
        result.tenant.apiKey,
      );

      const hsUsername = device.hsUsername!;
      try {
        await client.createUser(hsUsername);
      } catch {
        // user may already exist
      }

      const authKey = await client.createPreAuthKey(hsUsername);
      const loginServer = tenantLoginServer(result.tenant.slug);
      const command = `tailscale up --login-server ${loginServer} --authkey ${authKey.key}`;

      await db
        .update(serviceDevices)
        .set({
          status: "approved",
          preAuthKey: authKey.key,
          command,
          reviewedById: req.session.userId!,
          reviewedAt: new Date(),
        })
        .where(eq(serviceDevices.id, deviceId));

      logAudit({
        tenantId,
        actorUserId: req.session.userId!,
        action: "service_device_approved",
        targetType: "service_device",
        targetId: deviceId,
        metadata: { name: device.name, ownerId: device.ownerId },
      });

      res.json({ status: "approved", preAuthKey: authKey.key, command });
    } catch (err) {
      console.error("Failed to approve service device:", err);
      res.status(502).json({ error: "Failed to generate auth key" });
    }
  },
);

servicesRouter.post(
  "/api/tenants/:tenantId/service-devices/:deviceId/reject",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const deviceId = param(req, "deviceId");

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "approve_services")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const [device] = await db
      .select()
      .from(serviceDevices)
      .where(
        and(
          eq(serviceDevices.id, deviceId),
          eq(serviceDevices.tenantId, tenantId),
          eq(serviceDevices.status, "pending"),
        ),
      );

    if (!device) {
      res.status(404).json({ error: "Pending service device not found" });
      return;
    }

    await db
      .update(serviceDevices)
      .set({
        status: "rejected",
        reviewedById: req.session.userId!,
        reviewedAt: new Date(),
      })
      .where(eq(serviceDevices.id, deviceId));

    logAudit({
      tenantId,
      actorUserId: req.session.userId!,
      action: "service_device_rejected",
      targetType: "service_device",
      targetId: deviceId,
      metadata: { name: device.name, ownerId: device.ownerId },
    });

    res.json({ status: "rejected" });
  },
);

servicesRouter.delete(
  "/api/tenants/:tenantId/service-devices/:deviceId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const deviceId = param(req, "deviceId");

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const [device] = await db
      .select()
      .from(serviceDevices)
      .where(
        and(
          eq(serviceDevices.id, deviceId),
          eq(serviceDevices.tenantId, tenantId),
        ),
      );

    if (!device) {
      res.status(404).json({ error: "Service device not found" });
      return;
    }

    const isOwner = device.ownerId === req.session.userId;
    if (!isOwner && !hasPermission(result.membership, result.role, "manage_services")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    await db.delete(serviceDevices).where(eq(serviceDevices.id, deviceId));

    logAudit({
      tenantId,
      actorUserId: req.session.userId!,
      action: "service_device_removed",
      targetType: "service_device",
      targetId: deviceId,
      metadata: { name: device.name },
    });

    res.json({ status: "deleted" });
  },
);

servicesRouter.get(
  "/api/tenants/:tenantId/service-devices/mine",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const rows = await db
      .select()
      .from(serviceDevices)
      .where(
        and(
          eq(serviceDevices.tenantId, tenantId),
          eq(serviceDevices.ownerId, req.session.userId!),
        ),
      )
      .orderBy(desc(serviceDevices.createdAt));

    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        status: r.status,
        createdAt: r.createdAt,
        reviewedAt: r.reviewedAt,
        preAuthKey: r.status === "approved" ? r.preAuthKey : undefined,
        command: r.status === "approved" ? r.command : undefined,
      })),
    );
  },
);

// ── Services ───────────────────────────────────────────────────────

const serviceBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  url: z.string().min(1).max(500),
  serviceDeviceId: z.string().uuid(),
});

servicesRouter.get(
  "/api/tenants/:tenantId/services",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const rows = await db
      .select({
        id: services.id,
        name: services.name,
        description: services.description,
        url: services.url,
        status: services.status,
        serviceDeviceId: services.serviceDeviceId,
        ownerHandle: users.handle,
        ownerDisplayName: users.displayName,
        ownerId: services.ownerId,
        deviceName: serviceDevices.name,
        createdAt: services.createdAt,
      })
      .from(services)
      .innerJoin(users, eq(services.ownerId, users.id))
      .innerJoin(serviceDevices, eq(services.serviceDeviceId, serviceDevices.id))
      .where(eq(services.tenantId, tenantId))
      .orderBy(desc(services.createdAt));

    res.json(rows);
  },
);

servicesRouter.post(
  "/api/tenants/:tenantId/services",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = req.session.userId!;

    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_services")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const parsed = serviceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const [device] = await db
      .select()
      .from(serviceDevices)
      .where(
        and(
          eq(serviceDevices.id, parsed.data.serviceDeviceId),
          eq(serviceDevices.tenantId, tenantId),
          eq(serviceDevices.status, "approved"),
        ),
      );

    if (!device) {
      res.status(400).json({ error: "Service device not found or not approved" });
      return;
    }

    const needsApproval = result.tenant.requireServiceApproval && !result.membership.isOriginator;
    const status = needsApproval ? "pending" as const : "active" as const;

    const [created] = await db
      .insert(services)
      .values({
        tenantId,
        ownerId: userId,
        serviceDeviceId: parsed.data.serviceDeviceId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        url: parsed.data.url,
        status,
      })
      .returning();

    logAudit({
      tenantId,
      actorUserId: userId,
      action: "service_created",
      targetType: "service",
      targetId: created.id,
      metadata: { name: parsed.data.name, status },
    });

    res.status(201).json(created);
  },
);

servicesRouter.post(
  "/api/tenants/:tenantId/services/:serviceId/approve",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const serviceId = param(req, "serviceId");

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "approve_services")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const [service] = await db
      .select()
      .from(services)
      .where(
        and(
          eq(services.id, serviceId),
          eq(services.tenantId, tenantId),
          eq(services.status, "pending"),
        ),
      );

    if (!service) {
      res.status(404).json({ error: "Pending service not found" });
      return;
    }

    await db
      .update(services)
      .set({
        status: "active",
        reviewedById: req.session.userId!,
        updatedAt: new Date(),
      })
      .where(eq(services.id, serviceId));

    logAudit({
      tenantId,
      actorUserId: req.session.userId!,
      action: "service_approved",
      targetType: "service",
      targetId: serviceId,
      metadata: { name: service.name },
    });

    res.json({ status: "active" });
  },
);

servicesRouter.post(
  "/api/tenants/:tenantId/services/:serviceId/reject",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const serviceId = param(req, "serviceId");

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (!hasPermission(result.membership, result.role, "approve_services")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const [service] = await db
      .select()
      .from(services)
      .where(
        and(
          eq(services.id, serviceId),
          eq(services.tenantId, tenantId),
          eq(services.status, "pending"),
        ),
      );

    if (!service) {
      res.status(404).json({ error: "Pending service not found" });
      return;
    }

    await db
      .update(services)
      .set({
        status: "disabled",
        reviewedById: req.session.userId!,
        updatedAt: new Date(),
      })
      .where(eq(services.id, serviceId));

    logAudit({
      tenantId,
      actorUserId: req.session.userId!,
      action: "service_rejected",
      targetType: "service",
      targetId: serviceId,
      metadata: { name: service.name },
    });

    res.json({ status: "disabled" });
  },
);

servicesRouter.delete(
  "/api/tenants/:tenantId/services/:serviceId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const serviceId = param(req, "serviceId");

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const [service] = await db
      .select()
      .from(services)
      .where(
        and(
          eq(services.id, serviceId),
          eq(services.tenantId, tenantId),
        ),
      );

    if (!service) {
      res.status(404).json({ error: "Service not found" });
      return;
    }

    const isOwner = service.ownerId === req.session.userId;
    if (!isOwner && !hasPermission(result.membership, result.role, "manage_services")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    await db.delete(services).where(eq(services.id, serviceId));

    logAudit({
      tenantId,
      actorUserId: req.session.userId!,
      action: "service_removed",
      targetType: "service",
      targetId: serviceId,
      metadata: { name: service.name },
    });

    res.json({ status: "deleted" });
  },
);
