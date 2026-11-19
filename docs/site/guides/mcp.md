---
title: Connect Claude (MCP)
---

# Connect Claude (MCP)

You can manage your tailnets from Claude. The instance has a remote MCP server. Claude signs in as you, with your Bluesky identity. Claude then has the same access as you have in the dashboard.

An instance operator can also give Claude the operator tools. This is an opt-in on the consent page. It is off by default.

## Connector URL

```
https://<APP_DOMAIN>/mcp
```

Use the public URL of your instance (`PUBLIC_URL`) and add `/mcp`. The dashboard shows the URL in **Account → Connect Claude**.

## Connect

1. In Claude, open **Settings → Connectors**.
2. Select **Add custom connector**.
3. Enter a name, for example `atproto-tailnet`.
4. Enter the connector URL. Do not enter a client ID or a secret. Claude registers itself.
5. Select **Connect**. A browser window opens.
6. If you are not signed in, enter your Bluesky handle and sign in.
7. Read the consent page. Make sure that you started this connection.
8. Select **Allow**. The window closes and Claude is connected.

### The consent page

The consent page shows these items:

- The question "Allow `<host>` to access your account?". The host is the host of the redirect URI of the application. For Claude, the host is `claude.ai`.
- The label **Unverified app**. The application chooses its own name, and the instance does not verify it. Trust the redirect host, not the name. A name that refers to Claude or Anthropic is refused unless all redirect URIs are on `claude.ai` or `claude.com`.
- Your handle.
- For operators only: the checkbox **Also allow instance operator actions**.

The operator checkbox is clear by default. Leave it clear if you do not need the operator tools in Claude. If you select it, Claude can delete tailnets, disable users, suspend tailnets and change the instance settings.

## Use

Ask Claude to do a task. For example, ask "list my tailnets" or "approve the pending device in my tailnet". Claude starts with `whoami` and `list_tailnets`.

Claude can use these tools:

| Area | Tools |
|------|-------|
| Account | `whoami`, `list_tailnets`, `create_tailnet`, `get_tailnet` |
| Devices | `list_devices`, `remove_device`, `list_device_approvals`, `approve_device`, `reject_device` |
| Members | `list_members`, `remove_member`, `invite`, `list_invitations`, `revoke_invitation` |
| Join requests | `list_join_requests`, `approve_join_request`, `reject_join_request` |
| Auth keys | `list_auth_keys`, `create_auth_key`, `revoke_auth_key` |
| Network | `get_acl`, `set_acl`, `list_routes`, `approve_route`, `unapprove_route` |
| Settings | `get_settings`, `update_settings`, `set_limits`, `list_notifications` |
| Operator (opt-in) | `instance_overview`, `get_instance_settings`, `update_instance_settings`, `list_tailnet_creators`, `add_tailnet_creator`, `remove_tailnet_creator`, `suspend_tailnet`, `unsuspend_tailnet`, `delete_tailnet`, `disable_user`, `enable_user` |

Each tool checks your permissions in the tailnet. A tool fails with the same error that the dashboard shows. `create_tailnet` works only if you can create a tailnet (operators and tailnet creators).

Some tools are destructive. For example, they remove devices or members, or revoke keys. Their descriptions say so. Claude asks you before it uses them.

## Revoke access

1. Open the dashboard.
2. Open **Account → Connect Claude**.
3. Find the connection in the list. A connection with the operator scope has the label "operator access".
4. Revoke the connection.

The tokens stop working immediately. You can also remove the connector in Claude.

## Security

- Claude gets your permissions. It never gets more.
- Operator tools need two conditions: the grant has the operator scope, and you are still an operator.
- An MCP token works only through the `/mcp` tools. The REST API refuses an MCP token from any other caller.
- Access tokens expire after 1 hour. Refresh tokens expire after 30 days. Each refresh gives a new refresh token. The old one stops working.
- If a client uses an old refresh token again, the instance revokes the full connection.
- The instance stores only hashes of tokens.
- If an operator disables your account, all your connections stop working.
- Each new connection from the same application replaces the previous one.
- The `/mcp` endpoint has rate limits for each IP address and for each user.

## For other MCP clients

Any MCP client that supports the MCP authorization specification can connect. It must support dynamic client registration and PKCE (S256). Redirect URIs must use `https`, or `http` on a loopback address.

The server is stateless. It accepts only `POST /mcp` (Streamable HTTP with JSON responses). `GET` and `DELETE` return 405.

Discovery documents:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
