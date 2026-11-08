import { Agent } from "@atproto/api";
import { getOAuthClient } from "../auth/atproto.js";
import { logger } from "../logger.js";

const PRESENTATION_LXM = "app.tailnet.credential.present";

export interface ServiceAuthToken {
  token: string;
  issuerDid: string;
}

export async function obtainServiceAuthToken(
  accountDid: string,
  audienceDid: string,
): Promise<ServiceAuthToken | null> {
  try {
    const client = await getOAuthClient();
    const session = await client.restore(accountDid);
    const agent = new Agent(session);

    const exp = Math.floor(Date.now() / 1000) + 60;
    const aud = `${audienceDid}#tailnet_collective`;

    const res = await agent.com.atproto.server.getServiceAuth({
      aud,
      exp,
      lxm: PRESENTATION_LXM,
    });

    return { token: res.data.token, issuerDid: accountDid };
  } catch (err) {
    logger.warn({ accountDid, err }, "failed to obtain service-auth token");
    return null;
  }
}
