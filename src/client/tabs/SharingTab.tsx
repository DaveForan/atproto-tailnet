import { useTenantParallel, type TenantLoaders } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { Loading } from "../components/Loading";
import { LoadError } from "../components/LoadError";
import { boardsService, type MyDevice } from "../services/boards";
import { sharingService, type FriendsData, type Person, type Share } from "../services/sharing";
import { useAttention } from "../hooks/useAttention";
import { useTabRoute } from "../hooks/useTabRoute";
import { SharesCard, type SharingAct } from "./sharing/SharesCard";
import { FriendsCard } from "./sharing/FriendsCard";
import { NewShareForm } from "./sharing/NewShareForm";
import { SubNav, useSections } from "../components/SubNav";

interface SharingData {
  friends: FriendsData;
  shares: { shares: Share[] };
  devices: { devices: MyDevice[] };
  candidates: { members: Person[] };
}

const FALLBACK: SharingData = {
  friends: { friends: [], incoming: [], outgoing: [], blocked: [] },
  shares: { shares: [] },
  devices: { devices: [] },
  candidates: { members: [] },
};

const LOADERS: TenantLoaders<SharingData> = {
  friends: (tid) => sharingService.friends(tid),
  shares: (tid) => sharingService.shares(tid),
  devices: (tid) => boardsService.myDevices(tid),
  candidates: (tid) => sharingService.candidates(tid),
};

export function SharingTab() {
  const { data, loading, error, reload } = useTenantParallel(LOADERS, FALLBACK, { keepPreviousOnReload: true });
  const { mutate, busy } = useTenantMutation({ onError: "That did not work", reload });
  const { sections, open } = useSections("sharing");

  if (loading) return <Loading />;

  const act: SharingAct = (action, done) => { void mutate(action, { successMsg: done }); };
  const { friends } = data;
  const shares = data.shares.shares;

  return (
    <>
      <SubNav tab="sharing" label="Sharing sections" sections={sections} open={open} />
      <div className="tab-content">
        <LoadError error={error} onRetry={reload} />
        <WaitingNotice count={friends.incoming.length + shares.filter((s) => s.awaitingMe).length} />
        {open?.id === "friends" ? (
          <FriendsCard friends={friends} candidates={data.candidates.members} act={act} busy={busy} />
        ) : (
          <>
            <SharesCard shares={shares.filter((s) => !s.awaitingMe)} devices={data.devices.devices} act={act} busy={busy} />
            <Card title="Share a device">
              <NewShareForm friends={friends.friends} devices={data.devices.devices} onCreated={() => { void reload(); }} />
            </Card>
          </>
        )}
      </div>
    </>
  );
}

/** Requests are answered on Overview; this page only says that some wait. */
export function WaitingNotice({ count }: { count: number }) {
  const { setTab } = useTabRoute();
  const { reload } = useAttention();
  if (count === 0) return null;
  return (
    <p className="notice notice-row" role="status">
      <span>{count === 1 ? "1 request waits" : `${count} requests wait`} for your answer.</span>
      <button type="button" className="btn-sm" onClick={() => { void reload(); setTab("overview"); }}>
        Open Overview
      </button>
    </p>
  );
}
