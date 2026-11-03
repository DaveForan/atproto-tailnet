# Deploying atproto-tailnet on AWS

Two deployment approaches are provided. **EC2 is recommended** because
atproto-tailnet requires Docker socket access to manage per-tenant Headscale
containers.

## Option 1: EC2 + RDS via CloudFormation (recommended)

The CloudFormation template provisions:
- EC2 instance (t3.medium) with Docker pre-installed
- RDS PostgreSQL 17 (db.t3.micro, encrypted, 7-day backups)
- Encrypted EBS data volume for Headscale tenant data
- Security groups for HTTPS, SSH, and Headscale ports (10001-10100)
- Elastic IP for stable DNS
- IAM role with CloudWatch and SSM access

### Prerequisites

- AWS CLI configured (`aws configure`)
- An EC2 key pair in your target region
- A VPC with at least one public and two private subnets
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
curl https://tailnets.yourdomain.com/health
```

### DNS setup

Create these DNS records pointing to the Elastic IP from the stack outputs:

| Type | Name | Value |
|------|------|-------|
| A | `tailnets.yourdomain.com` | `<Elastic IP>` |
| A | `*.ts.yourdomain.com` | `<Elastic IP>` |

If using Cloudflare for DNS, the wildcard record can use orange-cloud (proxied)
or DNS-only. Caddy handles TLS via DNS-01 challenge with `CF_API_TOKEN`.

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

An ECS task definition is provided in `ecs-task-definition.json`, but it comes
with significant limitations.

### Limitations

- **No Docker socket**: Fargate tasks run in isolated microVMs. The app cannot
  create or manage Headscale containers. You must run Headscale on a separate
  EC2 instance and set `DOCKER_HOST` to point at it.
- **No host port binding**: Ports 10001-10100 cannot be exposed from Fargate.
  Headscale containers must run elsewhere with their own networking.
- **No persistent local storage**: Headscale data must be stored on EFS or the
  external host.

### When to use ECS

- You already have an ECS cluster and want the web tier managed by Fargate
- You are running Headscale on EC2 separately and connecting via remote Docker
- You want auto-scaling for the web tier (though a single instance is fine for
  most deployments)

### Setup

1. Create an ECR repository and push the image:

```sh
aws ecr create-repository --repository-name atproto-tailnet
docker build -t atproto-tailnet .
docker tag atproto-tailnet:latest ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/atproto-tailnet:latest
aws ecr get-login-password | docker login --username AWS --password-stdin ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com
docker push ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/atproto-tailnet:latest
```

2. Store secrets in Secrets Manager:

```sh
aws secretsmanager create-secret --name atproto-tailnet/database-url \
  --secret-string "postgresql://user:pass@host:5432/atproto_tailnet"
aws secretsmanager create-secret --name atproto-tailnet/session-secret \
  --secret-string "$(openssl rand -hex 32)"
```

3. Edit `ecs-task-definition.json`:
   - Replace `ACCOUNT_ID` and `REGION` placeholders
   - Update secret ARNs
   - Set environment variables

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

Plus the cost of any companion EC2 for Headscale (~$10-30/month).
