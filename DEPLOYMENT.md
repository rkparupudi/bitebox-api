# Deploying BiteBridge to AWS

This covers both repos: the API (this repo) and the web app (`bitebridge-web`). Region: **Mumbai (ap-south-1)**, closest to Indian customers.

Prices are approximate on-demand list prices checked in November 2026. Some are US East rates; Mumbai is usually equal or a little higher. Always confirm in the [AWS Pricing Calculator](https://calculator.aws/) before you commit.

## Pick an option

| | **A. Single server** | **B. Production-ready (recommended)** |
|---|---|---|
| For | Demo, portfolio, first users | Real customers; scales out without redesign |
| Web | Caddy on the same server | S3 + CloudFront |
| API | Docker on one Lightsail instance | ECS Fargate (ARM), 2+ tasks behind a load balancer |
| Database | Postgres container on the same box | RDS PostgreSQL (managed, automated backups) |
| Redis | Valkey container | ElastiCache for Valkey |
| HTTPS | Caddy (automatic Let's Encrypt) | ACM certificates (free) |
| If the server dies | Site is down until you restore a snapshot | ECS replaces the task; the other one keeps serving |
| Cost per month | **about $12** | **about $80–90** |

A new AWS account comes with up to $200 in credits. That covers Option B for roughly two months.

### What I deliberately didn't choose

- **App Runner** is the simplest container service on AWS, but it doesn't support WebSockets, so live order tracking would break.
- **Lambda + API Gateway** would mean rewriting real-time updates for API Gateway's WebSocket model. Socket.IO needs long-lived connections to a server process.
- **ElastiCache Serverless** has a lower minimum price (about $6/month for Valkey), but it runs in cluster mode. A small node with cluster mode off works with the plain Redis client and the Socket.IO adapter, and costs only a few dollars more.
- **NAT Gateway** costs about $32/month before any traffic. This design avoids it: API tasks sit in public subnets with a public IP, and their security group only accepts traffic from the load balancer.

---

## Option A: everything on one Lightsail server (about $12/month)

1. **Create the server.** In Lightsail, pick Mumbai, Linux/Ubuntu, and the 2 GB plan (about $12/month). Then attach a static IP (free while attached).
2. **Point DNS** at the static IP with two A records, `app.yourdomain.com` and `api.yourdomain.com`.
3. **Open ports** 80 and 443 in the Lightsail networking tab.
4. **Install Docker** on the server with `curl -fsSL https://get.docker.com | sh`.
5. **Get the code onto the server:**
   ```bash
   git clone https://github.com/rkparupudi/bitebridge-api.git
   git clone https://github.com/rkparupudi/bitebridge-web.git
   cd bitebridge-web && docker run --rm -v "$PWD":/app -w /app -e VITE_API_URL=https://api.yourdomain.com node:22 sh -c "npm ci && npm run build"
   mkdir -p ../bitebridge-api/deploy/lightsail/web && cp -r dist/* ../bitebridge-api/deploy/lightsail/web/
   ```
6. **Configure and start:**
   ```bash
   cd ../bitebridge-api/deploy/lightsail
   cp .env.prod.example .env.prod   # fill in domains, passwords, Stripe keys
   docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
   ```
   Caddy fetches HTTPS certificates on first request.
7. **Backups:** turn on Lightsail automatic snapshots. For extra safety, add a nightly `pg_dump` to S3.

Caveats: one server means downtime during updates and if it fails, and the database shares memory with the app. Move to Option B when you have paying users.

---

## Option B: production-ready on ECS Fargate (about $80–90/month)

```
                 app.yourdomain.com                        api.yourdomain.com
 Browser ──▶ CloudFront ──▶ S3 (web build)    Browser ──▶ ALB (HTTPS, WebSockets)
                                                              │
                                              ┌───────────────┴───────────────┐
                                              ▼                               ▼
                                     ECS Fargate task (AZ a)       ECS Fargate task (AZ b)
                                              │  ╲                     ╱  │
                                              ▼   ╲___________________╱   ▼
                                    RDS PostgreSQL            ElastiCache Valkey
                                    (no public access)        (cache, rate limits, Socket.IO pub/sub)
```

### Monthly cost estimate

| Item | Size | Approx. $/month | Notes |
|---|---|---|---|
| CloudFront + S3 (web) | static files | ~$0–1 | Always-free tier: 1 TB transfer and 10M requests/month |
| Application Load Balancer | 1 ALB | ~$20 | ~$0.0225/hour plus capacity units |
| ECS Fargate (ARM/Graviton) | 2 tasks × 0.25 vCPU / 0.5 GB | ~$15 | ARM is ~20% cheaper than x86 |
| Public IPv4 addresses | 2 for ALB + 2 for tasks | ~$15 | $0.005/hour each |
| RDS PostgreSQL | db.t4g.micro, single-AZ, 20 GB gp3 | ~$18 | ~$15 instance + storage |
| ElastiCache for Valkey | cache.t4g.micro | ~$10 | |
| Route 53, ECR, CloudWatch Logs, SSM | | ~$3 | SSM Parameter Store standard tier is free |
| **Total** | | **~$80–90** | |

**Ways to pay less once it's stable:** a 1-year reserved RDS instance (about $11 instead of $15). A Compute Savings Plan for Fargate. Running extra tasks above the first one on Fargate Spot (up to ~70% off; the app tolerates a task being replaced).

**When you grow:** turn on RDS Multi-AZ (doubles the RDS line, gives automatic failover). Raise the autoscaling maximum. Add a Valkey replica.

### One-time setup

Do these in order, all in **ap-south-1** unless noted.

**0. Guard rails.** Create an **AWS Budget** with an email alert at $50 and $100 before anything else.

**1. Security groups** (in the default VPC to start):
- `bitebridge-alb`: inbound 80 and 443 from anywhere.
- `bitebridge-api`: inbound 3000 **only from `bitebridge-alb`**.
- `bitebridge-data`: inbound 5432 and 6379 **only from `bitebridge-api`**.

**2. RDS PostgreSQL:** engine 16, `db.t4g.micro`, 20 GB gp3, single-AZ, **Public access: No**, security group `bitebridge-data`. Keep automated backups for 7 days and turn on deletion protection. Note the endpoint.

**3. ElastiCache for Valkey:** node-based (not serverless), `cache.t4g.micro`, cluster mode **disabled**, 0 replicas, in-transit encryption on, security group `bitebridge-data`.

**4. Secrets** in SSM Parameter Store, as **SecureString**, under `/bitebridge/prod/`:

| Name | Value |
|---|---|
| `DATABASE_URL` | `postgres://USER:PASSWORD@<rds-endpoint>:5432/bitebridge` |
| `REDIS_URL` | `rediss://<valkey-primary-endpoint>:6379` (note `rediss` = TLS) |
| `JWT_SECRET` | 64 random characters (`openssl rand -hex 32`) |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | from the Stripe dashboard |
| `STRIPE_WEBHOOK_SECRET` | from step 11 |

**5. ECR:** create a private repository named `bitebridge-api`. Add a lifecycle rule to keep the last 20 images.

**6. IAM roles for ECS:**
- `bitebridge-ecs-execution`: managed policy `AmazonECSTaskExecutionRolePolicy`, plus `ssm:GetParameters` on `arn:aws:ssm:ap-south-1:<account>:parameter/bitebridge/prod/*` and `logs:CreateLogGroup`.
- `bitebridge-ecs-task`: no permissions yet. This is what the app itself would use for S3, SES and so on.

**7. Load balancer:**
1. Request an ACM certificate for `api.yourdomain.com`, validated by DNS.
2. Create a target group: type **IP**, port 3000, health check path `/health/ready`, deregistration delay 30s.
3. Create an internet-facing ALB in two AZs with security group `bitebridge-alb`.
4. Add a listener on 443 with the certificate that forwards to the target group, and a listener on 80 that redirects to 443.

WebSockets work on ALB without extra settings. Sticky sessions aren't needed because the web app uses the WebSocket transport only.

**8. ECS:**
1. Create a cluster named `bitebridge` (Fargate).
2. Push a first image and register the task definition by running the GitHub workflow once (step 10). Its last step will fail because the service doesn't exist yet. That's expected.
3. Create a service named `bitebridge-api`:
   - Desired tasks: 2.
   - Subnets: public subnets in two AZs, **public IP on**, security group `bitebridge-api`.
   - Load balancer: attach the target group.
   - Deployment: rolling, with the **circuit breaker and rollback** turned on.
   - Service auto scaling: target tracking on CPU at 60%, minimum 2, maximum 6.

**9. Web hosting:**
1. Create a **private** S3 bucket (for example `bitebridge-web-prod`).
2. Request an ACM certificate for `app.yourdomain.com` **in us-east-1**, because CloudFront only uses certificates from that region.
3. Create a CloudFront distribution:
   - Origin: the bucket, with **Origin Access Control**.
   - Default root object: `index.html`.
   - Custom error responses: 403 and 404 → `/index.html` with code 200. This lets React Router handle deep links.
   - Alternate domain: `app.yourdomain.com` with that certificate.
4. In Route 53, add alias records for `app.` → CloudFront and `api.` → ALB.

**10. GitHub → AWS without stored keys (OIDC):**
1. In IAM, add an identity provider: `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. Create a role `bitebridge-github-deploy`:
   - Trust policy limited to `repo:rkparupudi/bitebridge-api:*` and `repo:rkparupudi/bitebridge-web:*`.
   - Permissions: ECR push to `bitebridge-api`; `ecs:RegisterTaskDefinition`, `ecs:RunTask`, `ecs:DescribeTasks`, `ecs:DescribeServices`, `ecs:UpdateService`; `iam:PassRole` on the two ECS roles; `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on the web bucket; `cloudfront:CreateInvalidation`.
3. Set repository variables (Settings → Secrets and variables → Actions → Variables):
   - **bitebridge-api:** `AWS_DEPLOY_ROLE_ARN`, `AWS_ACCOUNT_ID`, `ECS_SUBNETS` (for example `subnet-aaa,subnet-bbb`), `ECS_SECURITY_GROUP`, `APP_URL` (`https://app.yourdomain.com`).
   - **bitebridge-web:** `AWS_DEPLOY_ROLE_ARN`, `WEB_BUCKET`, `CLOUDFRONT_DISTRIBUTION_ID`, `VITE_API_URL` (`https://api.yourdomain.com`).

**11. Stripe:**
1. In the Stripe dashboard, add a webhook endpoint `https://api.yourdomain.com/payments/webhook` with the events `payment_intent.succeeded` and `payment_intent.payment_failed`.
2. Put its signing secret in SSM as `STRIPE_WEBHOOK_SECRET`.
3. Use test-mode keys until you're ready to take real money.

**12. Alarms** (CloudWatch → email via SNS):
- ALB 5xx count.
- `UnHealthyHostCount` > 0 for 5 minutes.
- RDS CPU > 80%.
- RDS free storage < 2 GB.
- ECS running task count < 2.

### What a deploy does

Every push to `main` that passes CI runs `.github/workflows/deploy.yml`:

1. Builds an ARM image on a native ARM runner and pushes it to ECR, tagged with the commit.
2. Registers a new task definition that points at that image.
3. **Runs database migrations once**, as a one-off task (`node dist/database/migrate.js`). If they fail, the deploy stops and nothing changes.
4. Rolls the service: new tasks start and must pass `/health/ready` on the ALB before old ones drain. If the new version keeps failing, the circuit breaker rolls back.

The web workflow builds with `VITE_API_URL` and uploads to S3. Hashed assets are cached for a year; `index.html` is never cached. It then invalidates `index.html` in CloudFront.

### How the API scales

| Concern | How it's handled |
|---|---|
| More traffic | ECS adds tasks on CPU. The API is stateless (JWT auth, carts in Redis), so any task can serve any request. |
| Real-time across tasks | The Socket.IO Redis adapter relays events through Valkey pub/sub, so an update on task A reaches a phone connected to task B. |
| Rate limits across tasks | Counters live in Valkey, so the limit is per client for the whole fleet, not per task. |
| Scheduled job | The unpaid-order expiry runs on every task, but a Valkey lock means only one does the work each minute. |
| Database connections | `DB_POOL_MAX` per task × tasks must stay below RDS `max_connections` (about 80 on db.t4g.micro). At 6 tasks × 10 = 60, you're fine. Beyond that, move up an instance size or add RDS Proxy. |
| Hot reads | The restaurant list and menus are cached in Valkey and cleared on every edit. |
| Zero-downtime releases | Rolling deploys, readiness checks, a 30s drain, and graceful shutdown hooks. |
| Next steps at real scale | RDS read replica for reports, Multi-AZ, a custom VPC with private subnets, AWS WAF in front of the ALB and CloudFront, and infrastructure as code (Terraform or AWS CDK) instead of console clicks. |
