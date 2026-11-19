---
title: Connect Claude (MCP)
---

# Connect Claude (MCP)

You can manage your tailnets from Claude. The server has a remote MCP endpoint. Claude signs in as you, with your Bluesky identity. Claude then has the same access as you have in the dashboard. If you are an instance operator, Claude also gets the operator tools.

## Connector URL

```
https://<APP_DOMAIN>/mcp
```

Use the public URL of your instance (`PUBLIC_URL`) and add `/mcp`.

## Connect

1. In Claude, open **Settings → Connectors**.
2. Select **Add custom connector**.
3. Enter a name, for example `atproto-tailnet`.
4. Enter the connector URL. Do not enter a client ID or secret. Claude registers itself.
5. Select **Connect**. A browser window opens.
6. If you are not signed in, enter your Bluesky handle and sign in.
7. Read the consent page. It shows the application name and your handle.
8. Select **Allow**. The window closes and Claude is connected.

## Use

Ask Claude to do a task, for example "list my tailnets" or "approve the pending device in my tailnet". Claude starts with `whoami` and `list_tailnets`.

Some tools are destructive. For example, they remove devices or members, or revoke keys. Their descriptions say so. Claude asks you before it uses them.

## Revoke access

1. Open the dashboard.
2. Find the list of MCP connections.
3. Revoke the connection.

The tokens stop working immediately. You can also remove the connector in Claude.

## Security

- Claude gets your permissions. It never gets more.
- Access tokens expire after 1 hour. Refresh tokens expire after 30 days. Each refresh gives a new refresh token. The old one stops working.
- The server stores only hashes of tokens.
- If an operator disables your account, all your tokens stop working.
- Each new connection from the same application replaces the previous one.

## For other MCP clients

Any MCP client that supports the MCP authorization spec can connect. It must support dynamic client registration and PKCE (S256). Redirect URIs must use `https`, or `http` on a loopback address. Discovery documents:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
