import { Loading } from "../components/Loading";
import { LoadError } from "../components/LoadError";
import { useFederation } from "./federation/useFederation";
import { RequestCard } from "./federation/RequestCard";
import { IncomingCard } from "./federation/IncomingCard";
import { ActiveLinksCard, HistoryCard, OutgoingCard } from "./federation/LinksCards";
import { PostureCard } from "./federation/PostureCard";
import { ScopeCard } from "./federation/ScopeCard";
import { BrokerCard, DidCard } from "./federation/IdentityCards";

export function FederationTab() {
  const fed = useFederation();

  if (fed.loading) return <Loading />;

  const { links } = fed;
  const outgoingPending = links.filter((l) => l.direction === "outgoing" && l.status === "pending");
  const incomingPending = links.filter((l) => l.direction === "incoming" && l.status === "pending");
  const active = links.filter((l) => l.status === "active");
  const history = links.filter((l) => l.status === "rejected" || l.status === "revoked");

  return (
    <div className="tab-content">
      <LoadError error={fed.loadError} onRetry={fed.loadAll} />
      <RequestCard fed={fed} />
      <IncomingCard fed={fed} links={incomingPending} />
      <OutgoingCard links={outgoingPending} />
      <ActiveLinksCard fed={fed} links={active} />
      <HistoryCard links={history} />
      <PostureCard fed={fed} />
      <ScopeCard fed={fed} />
      <DidCard fed={fed} />
      <BrokerCard broker={fed.broker} />
    </div>
  );
}
