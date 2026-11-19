# Deploying atproto-tailnet on AWS

This guide gives two deployment approaches. Both use the legacy Headscale mode.
Headscale mode needs Docker socket access to manage the Headscale container of
each tenant.

The recommended mode is coordinator mode (`docker-compose.coordinator.yml`). It
does not need the Docker socket. For coordinator mode on EC2 with Route53, use
Path A in [AGENT.md](AGENT.md).

All deployments must also do these steps:

- Set `OPERATOR_DIDS` (comma-separated DIDs, for example `did:plc:...`) in `.env` before the first sign-in.
- Set `ATPROTO_PRIVATE_KEY` to a one-line ES256 JWK in single quotes. Production sign-in fails without it.
- Sign in first as the operator after the deploy.

Only operators, and the "tailnet creators" that an operator designates, get a
tailnet. All other users who sign in see a "no access" view. This view shows
their pending invitations and a "Request to join" button for the default
tailnet. The first tailnet that an operator creates becomes the default tailnet.

To find your DID, use this command:

```sh
curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=you.bsky.social"
```

## Option 1: EC2 + RDS via CloudFormation (recommended)

The CloudFormation template creates these resources:
- EC2 instance (t3.medium) with Docker pre-installed
- RDS PostgreSQL 17 (db.t3.micro, encrypted, 7-day backups). Note:
  `docker-compose.production.yml` sets `DATABASE_URL` to the `postgres`
  container, so the app does not use RDS.
- Encrypted EBS data volume for Headscale tenant data
- Security groups for HTTPS, SSH (open to `0.0.0.0/0`), and Headscale ports (10001-10100)
- Elastic IP for stable DNS
- IAM role with CloudWatch and SSM access

### Prerequisites

- AWS CLI configured (`aws configure`)
- An EC2 key pair in your target region
- A VPC with at least one public subnet and two private subnets
- Wildcard DNS ready to point at the Elastic IP

### Deploy

```sh
aws cloudformation create-stack \
  --stack-name atproto-tailnet \
  --template-body file://deploy/aws/cloudformation.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=KeyPairName,ParameterValue=my-keypair \
    ParameterKey=VpcId,ParameterValue=vpc-xxxxxxxx \
    ParameterKey=SubnetId,ParameterValue=subnet-public \
    ParameterKey=PrivateSubnetId1,ParameterValue=subnet-private-a \
    ParameterKey=PrivateSubnetId2,ParameterValue=subnet-private-b \
    ParameterKey=DBPassword,ParameterValue="$(openssl rand -hex 16)" \
    ParameterKey=SessionSecret,ParameterValue="$(openssl rand -hex 32)" \
    ParameterKey=PublicUrl,ParameterValue=https://tailnets.yourdomain.com \
    ParameterKey=BaseDomain,ParameterValue=ts.yourdomain.com \
    ParameterKey=CfApiToken,ParameterValue=your-cloudflare-token
```

### After deployment

```sh
# Get outputs
aws cloudformation describe-stacks --stack-name atproto-tailnet \
  --query 'Stacks[0].Outputs'

# SSH in
ssh ubuntu@<elastic-ip>

# Check logs
cd /opt/atproto-tailnet
docker compose -f docker-compose.production.yml logs -f app

# Health check
curl -f https://tailnets.yourdomain.com/health
```

The generated `.env` has no `APP_DOMAIN`, `OPERATOR_DIDS`, `ATPROTO_PRIVATE_KEY`,
or `TLS_STRATEGY`. Add them to `/opt/atproto-tailnet/.env`. Then restart with
`docker compose -f docker-compose.production.yml up -d`. To generate
`ATPROTO_PRIVATE_KEY`, run this command in `/opt/atproto-tailnet`:

```sh
docker compose -f docker-compose.production.yml run --rm --no-deps --entrypoint node app \
  --input-type=module -e "import {generateKeyPair,exportJWK} from 'jose'; const {privateKey}=await generateKeyPair('ES256',{extractable:true}); console.log(JSON.stringify({...await exportJWK(privateKey),alg:'ES256'}))"
```

Put the output in `.env` in single quotes: `ATPROTO_PRIVATE_KEY='{"kty":"EC",...}'`.

Do not set `FEDERATION_ENABLED`. Federation is off by default.

Docker-published ports (80, 443) bypass `ufw`. Use the security group to
control access. Limit SSH (22/tcp) to your IP address.

### DNS setup

Create these DNS records. Point them at the Elastic IP from the stack outputs:

| Type | Name | Value |
|------|------|-------|
| A | `tailnets.yourdomain.com` | `<Elastic IP>` |
| A | `*.ts.yourdomain.com` | `<Elastic IP>` |

If you use Cloudflare for DNS, use DNS-only records. To get a wildcard
certificate with a DNS-01 challenge, Caddy needs these values in `.env`:

- `TLS_STRATEGY=cloudflare`
- `CADDY_DNS_PLUGINS=github.com/caddy-dns/cloudflare`
- `CF_API_TOKEN` (the template writes the `CfApiToken` parameter here)

The template does not set `TLS_STRATEGY`. Without it, Caddy uses the
`on-demand` strategy.

### Updating

```sh
ssh ubuntu@<elastic-ip>
cd /opt/atproto-tailnet
git pull
docker compose -f docker-compose.production.yml build app
docker compose -f docker-compose.production.yml up -d app
```

### Cost estimate

| Resource | Monthly cost |
|----------|-------------|
| t3.medium EC2 | ~$30 |
| db.t3.micro RDS | ~$15 |
| 20 GB gp3 EBS | ~$2 |
| Elastic IP (attached) | $0 |
| **Total** | **~$47** |

---

## Option 2: ECS Fargate (limited)

The file `ecs-task-definition.json` contains an ECS task definition. This option
has significant limitations.

### Limitations

- **No Docker socket**: Fargate tasks run in isolated microVMs. The app cannot
  create or manage Headscale containers. A remote Docker host (`DOCKER_HOST`)
  is not sufficient. The app writes tenant configs to a local directory, and
  the Docker host must bind-mount that directory at the same path.
- **No coordinator mode**: The task definition does not include the Rust
  coordinator, Caddy, or `COORDINATOR_URL`.
- **No host port binding**: Fargate cannot expose ports 10001-10100.
  Headscale containers must run elsewhere with their own networking.
- **No persistent local storage**: You must store Headscale data on EFS or on
  the external host.

### When to use ECS

- You already have an ECS cluster and you want Fargate to manage the web tier
- You are ready to supply the control plane (coordinator or Headscale) yourself

The service runs as one app process. Do not scale it above one task. Tailnet
creation uses an in-process lock.

### Setup

1. Create an ECR repository and push the image:

```sh
aws ecr create-repository --repository-name atproto-tailnet
docker build -t atproto-tailnet .
docker tag atproto-tailnet:latest ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/atproto-tailnet:latest
aws ecr get-login-password | docker login --username AWS --password-stdin ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com
docker push ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/atproto-tailnet:latest
```

2. Store the secrets in Secrets Manager:

```sh
aws secretsmanager create-secret --name atproto-tailnet/database-url \
  --secret-string "postgresql://user:pass@host:5432/atproto_tailnet"
aws secretsmanager create-secret --name atproto-tailnet/session-secret \
  --secret-string "$(openssl rand -hex 32)"
```

3. Edit `ecs-task-definition.json`:
   - Replace the `ACCOUNT_ID` and `REGION` placeholders
   - Update the secret ARNs
   - Set the environment variables. Include `OPERATOR_DIDS`. Set
     `TRUST_PROXY=1` if one load balancer is in front of the task. Sign-in
     needs it for the secure session cookie.

4. Register the task and create a service:

```sh
aws ecs register-task-definition --cli-input-json file://deploy/aws/ecs-task-definition.json
aws ecs create-service \
  --cluster your-cluster \
  --service-name atproto-tailnet \
  --task-definition atproto-tailnet \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}"
```

### Cost estimate (ECS only, excludes companion EC2)

| Resource | Monthly cost |
|----------|-------------|
| 0.5 vCPU / 1 GB Fargate | ~$15 |
| RDS db.t3.micro | ~$15 |
| **Total** | **~$30** |

Add the cost of a separate host for the control plane (~$10-30/month).
