/**
 * @module federation/route-engine
 * Route exchange, loop prevention, and convergence (ADR-0014 section 4).
 */

import type { RouteAnnouncement, RouteUpdate } from "./protocol.js";

export interface InstalledRoute {
  prefix: string;
  originDid: string;
  pathVector: string[];
  communityTags: string[];
  preference: number;
  receivedFrom: string; // session ID
  installedAt: Date;
}

export class RouteTable {
  private routes = new Map<string, InstalledRoute>();
  private localDid: string;

  constructor(localDid: string) {
    this.localDid = localDid;
  }

  processUpdate(
    update: RouteUpdate,
    agreedCidrs: string[],
  ): { installed: string[]; rejected: string[]; withdrawn: string[] } {
    const installed: string[] = [];
    const rejected: string[] = [];
    const withdrawn: string[] = [];

    for (const withdrawal of update.withdrawals) {
      if (this.routes.has(withdrawal)) {
        this.routes.delete(withdrawal);
        withdrawn.push(withdrawal);
      }
    }

    for (const ann of update.announcements) {
      if (ann.pathVector.includes(this.localDid)) {
        rejected.push(ann.prefix);
        continue;
      }

      if (!this.prefixWithinScope(ann.prefix, agreedCidrs)) {
        rejected.push(ann.prefix);
        continue;
      }

      const existing = this.routes.get(ann.prefix);
      if (existing && existing.preference >= ann.preference) {
        continue;
      }

      this.routes.set(ann.prefix, {
        prefix: ann.prefix,
        originDid: ann.originDid,
        pathVector: ann.pathVector,
        communityTags: ann.communityTags ?? [],
        preference: ann.preference,
        receivedFrom: update.sessionId,
        installedAt: new Date(),
      });
      installed.push(ann.prefix);
    }

    return { installed, rejected, withdrawn };
  }

  getExportableRoutes(
    sessionId: string,
    exportCidrs: string[],
  ): RouteAnnouncement[] {
    const exported: RouteAnnouncement[] = [];

    for (const [, route] of this.routes) {
      if (route.receivedFrom === sessionId) continue;
      if (!this.prefixWithinScope(route.prefix, exportCidrs)) continue;

      exported.push({
        prefix: route.prefix,
        originDid: route.originDid,
        pathVector: [...route.pathVector, this.localDid],
        communityTags: route.communityTags,
        preference: route.preference,
        originSignature: "",
      });
    }

    return exported;
  }

  withdrawSessionRoutes(sessionId: string): string[] {
    const withdrawn: string[] = [];
    for (const [prefix, route] of this.routes) {
      if (route.receivedFrom === sessionId) {
        this.routes.delete(prefix);
        withdrawn.push(prefix);
      }
    }
    return withdrawn;
  }

  getAllRoutes(): InstalledRoute[] {
    return Array.from(this.routes.values());
  }

  getRoute(prefix: string): InstalledRoute | undefined {
    return this.routes.get(prefix);
  }

  size(): number {
    return this.routes.size;
  }

  private prefixWithinScope(prefix: string, allowedCidrs: string[]): boolean {
    if (allowedCidrs.length === 0) return true;
    return allowedCidrs.some((cidr) => this.cidrContainsPrefix(cidr, prefix));
  }

  private cidrContainsPrefix(scope: string, prefix: string): boolean {
    const [scopeNet, scopeMaskStr] = scope.split("/");
    const [prefNet, prefMaskStr] = prefix.split("/");
    if (!scopeMaskStr || !prefMaskStr) return scope === prefix;

    const scopeMask = parseInt(scopeMaskStr, 10);
    const prefMask = parseInt(prefMaskStr, 10);
    if (prefMask < scopeMask) return false;

    const scopeParts = scopeNet.split(".").map(Number);
    const prefParts = prefNet.split(".").map(Number);
    if (scopeParts.length !== 4 || prefParts.length !== 4) return false;

    const scopeInt =
      (scopeParts[0] << 24) | (scopeParts[1] << 16) | (scopeParts[2] << 8) | scopeParts[3];
    const prefInt =
      (prefParts[0] << 24) | (prefParts[1] << 16) | (prefParts[2] << 8) | prefParts[3];
    const mask = scopeMask === 0 ? 0 : ~0 << (32 - scopeMask);

    return (scopeInt & mask) === (prefInt & mask);
  }
}
