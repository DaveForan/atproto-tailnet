# AWS Deployment — Agent Instructions

Machine-readable deployment guide for atproto-tailnet on AWS.
Coordinator mode with Route53 DNS-01 wildcard TLS.

## Overview

- EC2 instance (t3.medium) + Route53 DNS, coordinator mode
- TLS strategy: `route53` (DNS-01 wildcard certs via AWS API — instance role or access keys)
- Compose file: `docker-compose.coordinator.yml` (Rust coordinator, no Docker socket needed)
- Cost: ~$30-50/month (EC2 + containerized Postgres; add ~$15 for optional RDS)

## Prerequisites

- AWS CLI configured (`aws configure`)
- IAM user or role with permissions for: EC2, Route53, VPC (optionally RDS)
- A Route53 hosted zone for the domain (or create one)
- An EC2 key pair in the target region
- A VPC with at least one public subnet

## Required Inputs

| Variable | Source | Description |
|----------|--------|-------------|
| `AWS_REGION` | Your choice | AWS region (e.g. `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | IAM user or omit if using instance role | Route53 API access |
| `AWS_SECRET_ACCESS_KEY` | IAM user or omit if using instance role | Route53 API secret |
| `DOMAIN` | Your domain | e.g. `yourdomain.com` |
| `APP_DOMAIN` | Derived | e.g. `tailnets.yourdomain.com` |
| `BASE_DOMAIN` | Derived | e.g. `ts.yourdomain.com` |
| `KEY_PAIR_NAME` | EC2 console | Name of your EC2 key pair |
| `VPC_ID` | VPC console | VPC with public subnet |
| `SUBNET_ID` | VPC console | Public subnet ID |
| `INSTANCE_TYPE` | Your choice | Default: `t3.medium` |
| `REPO_URL` | Git remote | Repository URL to clone |
| `BRANCH` | Your choice | Default: `main` |

### Secrets to Generate

```sh
SESSION_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
COORDINATOR_API_KEY=$(openssl rand -hex 32)
FEDERATION_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

## Deployment Steps

### Path A: Minimal (EC2 + SQLite/Containerized Postgres, no RDS)

#### 1. Create Security Group

```sh
SG_ID=$(aws ec2 create-security-group \
  --group-name atproto-tailnet-sg \
  --description "atproto-tailnet coordinator" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 22 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol udp --port 443 --cidr 0.0.0.0/0
```

#### 2. Launch EC2 Instance

Use Ubuntu 22.04 LTS AMI. Find the current AMI for your region:

```sh
AMI_ID=$(aws ec2 describe-images \
  --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
             "Name=state,Values=available" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
  --output text)

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "${INSTANCE_TYPE:-t3.medium}" \
  --key-name "$KEY_PAIR_NAME" \
  --security-group-ids "$SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=atproto-tailnet}]' \
  --query 'Instances[0].InstanceId' --output text)

aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
```

#### 3. Allocate and Associate Elastic IP

```sh
ALLOC_ID=$(aws ec2 allocate-address --domain vpc --query 'AllocationId' --output text)
EIP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC_ID" --query 'Addresses[0].PublicIp' --output text)

aws ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID"
```

#### 4. Create DNS Records in Route53

```sh
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name "$DOMAIN" \
  --query 'HostedZones[0].Id' --output text | sed 's|/hostedzone/||')

aws route53 change-resource-record-sets \
  --hosted-zone-id "$HOSTED_ZONE_ID" \
  --change-batch '{
    "Changes": [
      {
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "'"$APP_DOMAIN"'",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'"$EIP"'"}]
        }
      },
      {
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "*.'"$BASE_DOMAIN"'",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'"$EIP"'"}]
        }
      }
    ]
  }'
```

#### 5. SSH In and Run Bootstrap

Pipe the bootstrap script over SSH (the repo isn't cloned yet, so the script must come from your local machine):

```sh
ssh -i ~/.ssh/"$KEY_PAIR_NAME".pem ubuntu@"$EIP" \
  "sudo REPO_URL='$REPO_URL' BRANCH='${BRANCH:-main}' bash -s" \
  < deploy/aws/user-data.sh
```

#### 6. Configure .env

The bootstrap creates a placeholder `.env` and exits. Write the real `.env` over SSH before starting services.

Generate all secrets locally first (see [Required Inputs](#required-inputs)), then write the file:

```sh
ssh -i ~/.ssh/"$KEY_PAIR_NAME".pem ubuntu@"$EIP" "sudo tee /opt/atproto-tailnet/.env > /dev/null" <<ENVEOF
POSTGRES_USER=atproto_tailnet
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=atproto_tailnet
DATABASE_URL=postgresql://atproto_tailnet:${POSTGRES_PASSWORD}@postgres:5432/atproto_tailnet
SESSION_SECRET=${SESSION_SECRET}
PORT=3000
PUBLIC_URL=https://${APP_DOMAIN}
BASE_DOMAIN=${BASE_DOMAIN}
APP_DOMAIN=${APP_DOMAIN}
LOG_LEVEL=info
COORDINATOR_URL=http://coordinator:9443
COORDINATOR_API_KEY=${COORDINATOR_API_KEY}
FEDERATION_KEY_ENCRYPTION_KEY=${FEDERATION_KEY_ENCRYPTION_KEY}
TLS_STRATEGY=route53
CADDY_DNS_PLUGINS=github.com/caddy-dns/route53
AWS_REGION=${AWS_REGION}
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-}
ENVEOF
```

If using an EC2 instance role instead of access keys, leave `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` empty.

#### 7. Start Services

```sh
cd /opt/atproto-tailnet
sudo docker compose -f docker-compose.coordinator.yml up -d
```

#### 8. Verify

```sh
curl -s https://${APP_DOMAIN}/health
# Expected: {"status":"ok",...}

sudo docker compose -f docker-compose.coordinator.yml logs caddy | tail -20
# Look for: "certificate obtained successfully"
```

### Path B: CloudFormation (EC2 + RDS)

Uses the existing `cloudformation.yaml` template. Pass `TLS_STRATEGY=route53` and AWS credentials instead of Cloudflare token.

```sh
aws cloudformation create-stack \
  --stack-name atproto-tailnet \
  --template-body file://deploy/aws/cloudformation.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=KeyPairName,ParameterValue="$KEY_PAIR_NAME" \
    ParameterKey=VpcId,ParameterValue="$VPC_ID" \
    ParameterKey=SubnetId,ParameterValue="$SUBNET_ID" \
    ParameterKey=PrivateSubnetId1,ParameterValue="$PRIVATE_SUBNET_1" \
    ParameterKey=PrivateSubnetId2,ParameterValue="$PRIVATE_SUBNET_2" \
    ParameterKey=DBPassword,ParameterValue="$POSTGRES_PASSWORD" \
    ParameterKey=SessionSecret,ParameterValue="$SESSION_SECRET" \
    ParameterKey=PublicUrl,ParameterValue="https://${APP_DOMAIN}" \
    ParameterKey=BaseDomain,ParameterValue="$BASE_DOMAIN"

aws cloudformation wait stack-create-complete --stack-name atproto-tailnet
```

After stack creation, SSH in and update `.env` to set TLS strategy variables:

```sh
EIP=$(aws cloudformation describe-stacks --stack-name atproto-tailnet \
  --query 'Stacks[0].Outputs[?OutputKey==`ElasticIP`].OutputValue' --output text)

ssh -i ~/.ssh/"$KEY_PAIR_NAME".pem ubuntu@"$EIP"

# Append TLS strategy config
cd /opt/atproto-tailnet
sudo tee -a .env > /dev/null <<EOF
TLS_STRATEGY=route53
CADDY_DNS_PLUGINS=github.com/caddy-dns/route53
AWS_REGION=$AWS_REGION
AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
EOF

# Rebuild Caddy with Route53 plugin and restart
sudo docker compose -f docker-compose.coordinator.yml build caddy
sudo docker compose -f docker-compose.coordinator.yml up -d
```

## IAM Policy for Route53 TLS

The EC2 instance (or IAM user) needs these Route53 permissions for Caddy DNS-01 challenges.

Minimal IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "route53:GetChange",
        "route53:ListHostedZonesByName"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "route53:ChangeResourceRecordSets",
        "route53:ListResourceRecordSets"
      ],
      "Resource": "arn:aws:route53:::hostedzone/HOSTED_ZONE_ID"
    }
  ]
}
```

Replace `HOSTED_ZONE_ID` with the actual hosted zone ID.

To attach via instance role (preferred over access keys):

```sh
# Create the policy
POLICY_ARN=$(aws iam create-policy \
  --policy-name atproto-tailnet-route53-tls \
  --policy-document file://route53-tls-policy.json \
  --query 'Policy.Arn' --output text)

# Create role and instance profile
aws iam create-role \
  --role-name atproto-tailnet-ec2 \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name atproto-tailnet-ec2 \
  --policy-arn "$POLICY_ARN"

aws iam create-instance-profile \
  --instance-profile-name atproto-tailnet-ec2

aws iam add-role-to-instance-profile \
  --instance-profile-name atproto-tailnet-ec2 \
  --role-name atproto-tailnet-ec2

# Associate with running instance
aws ec2 associate-iam-instance-profile \
  --instance-id "$INSTANCE_ID" \
  --iam-instance-profile Name=atproto-tailnet-ec2
```

## Verification

```sh
# Health check
curl -sf https://${APP_DOMAIN}/health

# TLS certificate check
echo | openssl s_client -servername "${APP_DOMAIN}" -connect "${EIP}:443" 2>/dev/null | openssl x509 -noout -subject -issuer -dates

# Coordinator health (from the instance)
sudo docker compose -f docker-compose.coordinator.yml exec coordinator wget -qO- http://localhost:9443/health

# Container status
sudo docker compose -f docker-compose.coordinator.yml ps

# Caddy logs (certificate issuance)
sudo docker compose -f docker-compose.coordinator.yml logs caddy --tail 50

# App logs
sudo docker compose -f docker-compose.coordinator.yml logs app --tail 50
```

## Teardown

### Path A (manual resources)

```sh
# Terminate instance
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID"

# Release Elastic IP
aws ec2 release-address --allocation-id "$ALLOC_ID"

# Delete DNS records (reverse of creation — change Action to DELETE)
aws route53 change-resource-record-sets \
  --hosted-zone-id "$HOSTED_ZONE_ID" \
  --change-batch '{
    "Changes": [
      {
        "Action": "DELETE",
        "ResourceRecordSet": {
          "Name": "'"$APP_DOMAIN"'",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'"$EIP"'"}]
        }
      },
      {
        "Action": "DELETE",
        "ResourceRecordSet": {
          "Name": "*.'"$BASE_DOMAIN"'",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'"$EIP"'"}]
        }
      }
    ]
  }'

# Delete security group
aws ec2 delete-security-group --group-id "$SG_ID"

# Delete IAM resources (if created)
aws iam remove-role-from-instance-profile --instance-profile-name atproto-tailnet-ec2 --role-name atproto-tailnet-ec2
aws iam delete-instance-profile --instance-profile-name atproto-tailnet-ec2
aws iam detach-role-policy --role-name atproto-tailnet-ec2 --policy-arn "$POLICY_ARN"
aws iam delete-role --role-name atproto-tailnet-ec2
aws iam delete-policy --policy-arn "$POLICY_ARN"
```

### Path B (CloudFormation)

```sh
aws cloudformation delete-stack --stack-name atproto-tailnet
aws cloudformation wait stack-delete-complete --stack-name atproto-tailnet
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Caddy logs: `failed to solve challenge` | Missing Route53 IAM permissions | Attach the IAM policy above; verify with `aws route53 list-hosted-zones` from the instance |
| Caddy logs: `no credentials found` | No access keys and no instance role | Set `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in `.env` or attach an instance role |
| `curl: connection refused` on 443 | Security group missing 443/tcp rule | `aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 443 --cidr 0.0.0.0/0` |
| DNS not resolving | Records not created or still propagating | Wait 5 minutes; verify with `dig +short $APP_DOMAIN` |
| Health returns unhealthy | Postgres not ready or coordinator failed | Check `docker compose logs postgres coordinator` |
| Certificate shows staging issuer | Caddy defaulted to staging | Check `.env` has `TLS_STRATEGY=route53` and `CADDY_DNS_PLUGINS=github.com/caddy-dns/route53`; rebuild Caddy image |
| `AWS_REGION` required error | Missing region in `.env` | Add `AWS_REGION=us-east-1` (or your region) to `.env` |
