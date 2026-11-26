import { SubNav, useSections } from "../components/SubNav";
import { MembersTab } from "./MembersTab";
import { InviteTab } from "./InviteTab";

export function PeopleTab() {
  const { sections, open } = useSections("people");
  return (
    <>
      <SubNav tab="people" label="People sections" sections={sections} open={open} />
      {open?.id === "invite" ? <InviteTab /> : <MembersTab />}
    </>
  );
}
