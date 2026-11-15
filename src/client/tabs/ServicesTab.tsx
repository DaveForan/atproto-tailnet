import { useCallback, useEffect, useState } from "react";
import { servicesService } from "../services/services";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { StatusBadge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { relativeTime } from "../lib/utils";
import type { ServiceDevice, Service } from "../lib/types";

export function ServicesTab() {
  const { currentTenant, hasPerm, reload } = useApp();
  const { toastError } = useToast();
  const { mutate, busy } = useTenantMutation();

  const [serviceDevices, setServiceDevices] = useState<ServiceDevice[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);

  const [sdName, setSdName] = useState("");
  const [sdDesc, setSdDesc] = useState("");
  const [svcName, setSvcName] = useState("");
  const [svcUrl, setSvcUrl] = useState("");
  const [svcDesc, setSvcDesc] = useState("");
  const [svcDeviceId, setSvcDeviceId] = useState("");

  const loadData = useCallback(async () => {
    if (!currentTenant) return;
    try {
      const { devices, services: svc } = await servicesService.getAll(currentTenant.id);
      setServiceDevices(devices);
      setServices(svc);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to load services");
    }
  }, [currentTenant?.id]);

  useEffect(() => {
    setLoading(true);
    loadData().finally(() => setLoading(false));
  }, [loadData]);

  const approvedDevices = serviceDevices.filter((d) => d.status === "approved");

  const reloadAll = useCallback(async () => {
    await loadData();
    await reload();
  }, [loadData, reload]);

  const registerDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await mutate(
      "/service-devices",
      { method: "POST", body: JSON.stringify({ name: sdName, description: sdDesc }) },
      { successMsg: "Service device registered", reload: reloadAll },
    );
    if (ok) {
      setSdName("");
      setSdDesc("");
    }
  };

  const approveDevice = async (id: string) => {
    await mutate(
      `/service-devices/${id}/approve`,
      { method: "POST" },
      { successMsg: "Service device approved", reload: loadData },
    );
  };

  const rejectDevice = async (id: string) => {
    await mutate(
      `/service-devices/${id}/reject`,
      { method: "POST" },
      { successMsg: "Service device rejected", reload: loadData },
    );
  };

  const removeDevice = async (id: string) => {
    if (!confirm("Remove this service device? This cannot be undone.")) return;
    await mutate(
      `/service-devices/${id}`,
      { method: "DELETE" },
      { successMsg: "Service device removed", reload: loadData },
    );
  };

  const registerService = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await mutate(
      "/services",
      {
        method: "POST",
        body: JSON.stringify({
          name: svcName,
          url: svcUrl,
          description: svcDesc,
          serviceDeviceId: svcDeviceId,
        }),
      },
      { successMsg: "Service registered", reload: reloadAll },
    );
    if (ok) {
      setSvcName("");
      setSvcUrl("");
      setSvcDesc("");
      setSvcDeviceId("");
    }
  };

  const approveService = async (id: string) => {
    await mutate(
      `/services/${id}/approve`,
      { method: "POST" },
      { successMsg: "Service approved", reload: loadData },
    );
  };

  const rejectService = async (id: string) => {
    await mutate(
      `/services/${id}/reject`,
      { method: "POST" },
      { successMsg: "Service rejected", reload: loadData },
    );
  };

  const removeService = async (id: string) => {
    if (!confirm("Remove this service? This cannot be undone.")) return;
    await mutate(
      `/services/${id}`,
      { method: "DELETE" },
      { successMsg: "Service removed", reload: loadData },
    );
  };

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="tab-content">
      <Card title="Service Devices">
        {serviceDevices.length > 0 ? (
          <ul className="item-list">
            {serviceDevices.map((sd) => (
              <li key={sd.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">{sd.name}</span>
                  {sd.description && (
                    <span className="item-detail">{sd.description}</span>
                  )}
                  <span className="item-meta">{relativeTime(sd.createdAt)}</span>
                </div>
                <div className="item-actions">
                  <StatusBadge status={sd.status} />
                  {sd.status === "pending" && hasPerm("approve_services") && (
                    <>
                      <button
                        className="btn-sm btn-primary"
                        onClick={() => approveDevice(sd.id)}
                        disabled={busy}
                      >
                        Approve
                      </button>
                      <button
                        className="btn-sm btn-danger"
                        onClick={() => rejectDevice(sd.id)}
                        disabled={busy}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {hasPerm("manage_services") && (
                    <button
                      className="btn-sm btn-danger"
                      onClick={() => removeDevice(sd.id)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No service devices registered.</EmptyState>
        )}

        {hasPerm("manage_services") && (
          <form className="inline-form" onSubmit={registerDevice}>
            <input
              type="text"
              placeholder="Device name"
              value={sdName}
              onChange={(e) => setSdName(e.target.value)}
              required
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={sdDesc}
              onChange={(e) => setSdDesc(e.target.value)}
            />
            <button type="submit" className="btn-primary" disabled={busy}>
              Register Device
            </button>
          </form>
        )}
      </Card>

      <Card title="Services">
        {services.length > 0 ? (
          <ul className="item-list">
            {services.map((svc) => {
              const deviceName =
                serviceDevices.find((d) => d.id === svc.serviceDeviceId)?.name ??
                "Unknown device";
              return (
                <li key={svc.id} className="item-row">
                  <div className="item-info">
                    <span className="item-name">{svc.name}</span>
                    <span className="item-detail">{svc.url}</span>
                    {svc.description && (
                      <span className="item-detail">{svc.description}</span>
                    )}
                    <span className="item-meta">
                      Device: {deviceName} &middot; {relativeTime(svc.createdAt)}
                    </span>
                  </div>
                  <div className="item-actions">
                    <StatusBadge status={svc.status} />
                    {svc.status === "pending" && hasPerm("approve_services") && (
                      <>
                        <button
                          className="btn-sm btn-primary"
                          onClick={() => approveService(svc.id)}
                          disabled={busy}
                        >
                          Approve
                        </button>
                        <button
                          className="btn-sm btn-danger"
                          onClick={() => rejectService(svc.id)}
                          disabled={busy}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {hasPerm("manage_services") && (
                      <button
                        className="btn-sm btn-danger"
                        onClick={() => removeService(svc.id)}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState>No services registered.</EmptyState>
        )}

        {hasPerm("manage_services") && (
          <form className="inline-form" onSubmit={registerService}>
            <input
              type="text"
              placeholder="Service name"
              value={svcName}
              onChange={(e) => setSvcName(e.target.value)}
              required
            />
            <input
              type="url"
              placeholder="Service URL"
              value={svcUrl}
              onChange={(e) => setSvcUrl(e.target.value)}
              required
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={svcDesc}
              onChange={(e) => setSvcDesc(e.target.value)}
            />
            <select
              value={svcDeviceId}
              onChange={(e) => setSvcDeviceId(e.target.value)}
              required
            >
              <option value="">Select a device...</option>
              {approvedDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-primary" disabled={busy}>
              Register Service
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}
