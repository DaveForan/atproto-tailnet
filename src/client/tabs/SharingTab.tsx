import { useTenantParallel, type TenantLoaders } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { Loading } from "../components/Loading";
import { LoadError } from "../components/LoadError";
import { boardsService, type MyDevice } from "../services/boards";
import { sharingService, type FriendsData, type Person, type Share } from "../services/sharing";
import { SharesCard, type SharingAct } from "./sharing/SharesCard";
import { RequestsCard } from "./sharing/RequestsCard";
import { FriendsCard } from "./sharing/FriendsCard";
import { NewShareForm } from "./sharing/NewShareForm";

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

  if (loading) return <Loading />;

  const act: SharingAct = (action, done) => { void mutate(action, { successMsg: done }); };
  const { friends } = data;
  const shares = data.shares.shares;

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      <RequestsCard incoming={friends.incoming} waiting={shares.filter((s) => s.awaitingMe)} act={act} busy={busy} />
      <SharesCard shares={shares.filter((s) => !s.awaitingMe)} act={act} busy={busy} />
      <Card title="Share a device">
        <NewShareForm friends={friends.friends} devices={data.devices.devices} onCreated={() => { void reload(); }} />
      </Card>
      <FriendsCard friends={friends} candidates={data.candidates.members} act={act} busy={busy} />
    </div>
  );
}
