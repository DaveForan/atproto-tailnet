#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# atproto-tailnet  --  AWS deploy & management
#
# Prerequisites:
#   - AWS CLI v2 installed and configured (aws configure)
#   - EC2 key pair created in target region
#   - VPC with public and private subnets
#
# Usage:
#   ./scripts/deploy-aws.sh deploy           # deploy CloudFormation stack
#   ./scripts/deploy-aws.sh status           # show stack + instance status
#   ./scripts/deploy-aws.sh ssh              # SSH into the EC2 instance
#   ./scripts/deploy-aws.sh logs             # tail app logs via SSH
#   ./scripts/deploy-aws.sh update           # pull latest & restart on EC2
#   ./scripts/deploy-aws.sh backup           # trigger RDS snapshot + app backup
#   ./scripts/deploy-aws.sh destroy          # delete CloudFormation stack
#   ./scripts/deploy-aws.sh outputs          # show stack outputs (IPs, endpoints)
# ---------------------------------------------------------------------------
set -euo pipefail

CMD="${1:-deploy}"

STACK_NAME="${AWS_STACK_NAME:-atproto-tailnet}"
REGION="${AWS_REGION:-us-east-1}"
TEMPLATE="deploy/aws/cloudformation.yaml"

check_cli() {
  if ! command -v aws &>/dev/null; then
    echo "ERROR: AWS CLI not found. Install from: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
  fi
}

get_instance_ip() {
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='AppPublicIP'].OutputValue" \
    --output text 2>/dev/null
}

get_instance_id() {
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='AppInstanceId'].OutputValue" \
    --output text 2>/dev/null
}

get_db_endpoint() {
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='DatabaseEndpoint'].OutputValue" \
    --output text 2>/dev/null
}

get_db_identifier() {
  aws rds describe-db-instances \
    --region "${REGION}" \
    --query "DBInstances[?DBInstanceIdentifier=='${STACK_NAME}-db'].DBInstanceIdentifier" \
    --output text 2>/dev/null
}

case "${CMD}" in
  deploy)
    check_cli

    if [ ! -f "${TEMPLATE}" ]; then
      echo "ERROR: CloudFormation template not found at ${TEMPLATE}"
      echo "       Run from the project root directory."
      exit 1
    fi

    echo "==> Deploying CloudFormation stack: ${STACK_NAME}"
    echo "    Region: ${REGION}"
    echo "    Template: ${TEMPLATE}"
    echo ""

    # Collect parameters interactively
    read -r -p "EC2 Key Pair name: " KEY_PAIR
    read -r -p "VPC ID: " VPC_ID
    read -r -p "Public Subnet ID: " PUBLIC_SUBNET
    read -r -p "Private Subnet ID 1: " PRIVATE_SUBNET_1
    read -r -p "Private Subnet ID 2: " PRIVATE_SUBNET_2
    read -r -p "Public URL (e.g. https://tailnets.example.com): " PUBLIC_URL
    read -r -p "Base domain (e.g. ts.example.com): " BASE_DOMAIN
    read -r -s -p "DB Password (>= 16 chars): " DB_PASSWORD
    echo ""
    read -r -s -p "Session Secret (>= 32 chars): " SESSION_SECRET
    echo ""

    aws cloudformation create-stack \
      --stack-name "${STACK_NAME}" \
      --region "${REGION}" \
      --template-body "file://${TEMPLATE}" \
      --capabilities CAPABILITY_NAMED_IAM \
      --parameters \
        "ParameterKey=KeyPairName,ParameterValue=${KEY_PAIR}" \
        "ParameterKey=VpcId,ParameterValue=${VPC_ID}" \
        "ParameterKey=SubnetId,ParameterValue=${PUBLIC_SUBNET}" \
        "ParameterKey=PrivateSubnetId1,ParameterValue=${PRIVATE_SUBNET_1}" \
        "ParameterKey=PrivateSubnetId2,ParameterValue=${PRIVATE_SUBNET_2}" \
        "ParameterKey=PublicUrl,ParameterValue=${PUBLIC_URL}" \
        "ParameterKey=BaseDomain,ParameterValue=${BASE_DOMAIN}" \
        "ParameterKey=DBPassword,ParameterValue=${DB_PASSWORD}" \
        "ParameterKey=SessionSecret,ParameterValue=${SESSION_SECRET}"

    echo ""
    echo "Stack creation initiated. Monitor with:"
    echo "  ./scripts/deploy-aws.sh status"
    echo "  aws cloudformation describe-stack-events --stack-name ${STACK_NAME} --region ${REGION}"
    echo ""
    echo "Full provisioning takes ~10-15 minutes (RDS is the bottleneck)."
    ;;

  status)
    check_cli
    echo "==> Stack status:"
    aws cloudformation describe-stacks \
      --stack-name "${STACK_NAME}" \
      --region "${REGION}" \
      --query "Stacks[0].{Name:StackName,Status:StackStatus,Created:CreationTime}" \
      --output table 2>/dev/null || echo "    Stack not found"

    echo ""
    echo "==> EC2 instance:"
    INSTANCE_ID="$(get_instance_id)"
    if [ -n "${INSTANCE_ID}" ] && [ "${INSTANCE_ID}" != "None" ]; then
      aws ec2 describe-instances \
        --instance-ids "${INSTANCE_ID}" \
        --region "${REGION}" \
        --query "Reservations[0].Instances[0].{ID:InstanceId,State:State.Name,Type:InstanceType,IP:PublicIpAddress}" \
        --output table
    else
      echo "    No instance found"
    fi

    echo ""
    echo "==> RDS database:"
    DB_ID="$(get_db_identifier)"
    if [ -n "${DB_ID}" ] && [ "${DB_ID}" != "None" ]; then
      aws rds describe-db-instances \
        --db-instance-identifier "${DB_ID}" \
        --region "${REGION}" \
        --query "DBInstances[0].{ID:DBInstanceIdentifier,Status:DBInstanceStatus,Endpoint:Endpoint.Address,Class:DBInstanceClass}" \
        --output table
    else
      echo "    No database found"
    fi
    ;;

  outputs)
    check_cli
    echo "==> Stack outputs:"
    aws cloudformation describe-stacks \
      --stack-name "${STACK_NAME}" \
      --region "${REGION}" \
      --query "Stacks[0].Outputs[]" \
      --output table
    ;;

  ssh)
    check_cli
    IP="$(get_instance_ip)"
    if [ -z "${IP}" ] || [ "${IP}" = "None" ]; then
      echo "ERROR: Could not find instance IP. Is the stack deployed?"
      exit 1
    fi
    echo "==> Connecting to ${IP}..."
    ssh "ubuntu@${IP}"
    ;;

  logs)
    check_cli
    IP="$(get_instance_ip)"
    if [ -z "${IP}" ] || [ "${IP}" = "None" ]; then
      echo "ERROR: Could not find instance IP."
      exit 1
    fi
    echo "==> Tailing logs on ${IP}..."
    ssh "ubuntu@${IP}" "cd /opt/atproto-tailnet && docker compose -f docker-compose.production.yml logs -f --tail=100 app"
    ;;

  update)
    check_cli
    IP="$(get_instance_ip)"
    if [ -z "${IP}" ] || [ "${IP}" = "None" ]; then
      echo "ERROR: Could not find instance IP."
      exit 1
    fi
    echo "==> Updating ${STACK_NAME} on ${IP}..."
    ssh "ubuntu@${IP}" bash -s <<'REMOTE'
      set -euo pipefail
      cd /opt/atproto-tailnet
      git pull origin main
      docker compose -f docker-compose.production.yml build app
      docker compose -f docker-compose.production.yml up -d app
      echo "Update complete."
      docker compose -f docker-compose.production.yml ps
REMOTE
    ;;

  backup)
    check_cli
    echo "==> Creating RDS snapshot..."
    DB_ID="$(get_db_identifier)"
    if [ -n "${DB_ID}" ] && [ "${DB_ID}" != "None" ]; then
      SNAP_ID="${STACK_NAME}-manual-$(date +%Y%m%d-%H%M%S)"
      aws rds create-db-snapshot \
        --db-instance-identifier "${DB_ID}" \
        --db-snapshot-identifier "${SNAP_ID}" \
        --region "${REGION}"
      echo "    RDS snapshot initiated: ${SNAP_ID}"
      echo "    Check progress: aws rds describe-db-snapshots --db-snapshot-identifier ${SNAP_ID} --region ${REGION}"
    else
      echo "    No RDS instance found"
    fi

    echo ""
    echo "==> Running app-level backup on EC2..."
    IP="$(get_instance_ip)"
    if [ -n "${IP}" ] && [ "${IP}" != "None" ]; then
      ssh "ubuntu@${IP}" "cd /opt/atproto-tailnet && bash scripts/backup.sh /data/backups"
    else
      echo "    No instance found"
    fi
    ;;

  destroy)
    check_cli
    echo "WARNING: This will delete the entire CloudFormation stack: ${STACK_NAME}"
    echo "         RDS has deletion protection enabled -- you must disable it first"
    echo "         in the AWS console or via CLI before the stack can be fully deleted."
    echo ""
    read -r -p "Type '${STACK_NAME}' to confirm: " confirm
    if [ "${confirm}" != "${STACK_NAME}" ]; then
      echo "Aborted."
      exit 0
    fi

    echo "==> Deleting stack ${STACK_NAME}..."
    aws cloudformation delete-stack \
      --stack-name "${STACK_NAME}" \
      --region "${REGION}"

    echo "Stack deletion initiated. Monitor with:"
    echo "  aws cloudformation describe-stack-events --stack-name ${STACK_NAME} --region ${REGION}"
    ;;

  *)
    echo "Usage: $0 {deploy|status|ssh|logs|update|backup|destroy|outputs}"
    exit 1
    ;;
esac
