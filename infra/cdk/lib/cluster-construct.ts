import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';

export interface ClusterConstructProps {
  vpc: ec2.Vpc;
  /** Absolute path to the repo root — the build context for the image assets. */
  repoRoot: string;
  /** 'arm64' (Graviton, default) or 'amd64'. Must match the build host for speed. */
  arch: 'arm64' | 'amd64';
  /** Optional explicit CORS origin for the gateway (e.g. https://<nlb-dns>). */
  appOrigin?: string;
  /** Reverse-proxy /api rate limit (req/s) and burst. */
  apiRateLimit: string;
  apiRateBurst: string;
  /** Number of gateway replicas. >1 auto-enables the WS Redis backplane. */
  gatewayReplicas: number;
  /** Number of auth replicas (stateless; balanced by the `auth` Service). */
  authReplicas: number;
  dbEndpoint: string;
  dbUsername: string;
  dbPassword: string;
  jwtSecret: string;
  auditWriterPassword: string;
  auditReaderPassword: string;
  redisEndpoint: string;
  /** Dedicated ElastiCache endpoint (host:port) for the chat message cache. */
  cacheRedisEndpoint: string;
  kafkaBootstrap: string;
}

const NS = 'concordia';

/**
 * EKS cluster + the core-subset workloads (auth, gateway, web-app, reverse-proxy).
 * Container images are built locally from the repo's existing Dockerfiles and
 * pushed to ECR automatically during `cdk deploy` (no registry pipeline). The
 * reverse-proxy is exposed via an internet-facing NLB and terminates TLS with the
 * repo's self-signed certs (mounted from a k8s Secret) — exactly as it does locally.
 */
export class ClusterConstruct extends Construct {
  public readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, props: ClusterConstructProps) {
    super(scope, id);
    const { vpc, repoRoot, arch } = props;

    const isArm = arch === 'arm64';
    const platform = isArm ? ecrAssets.Platform.LINUX_ARM64 : ecrAssets.Platform.LINUX_AMD64;
    const instanceType = isArm ? 't4g.medium' : 't3.medium';
    const amiType = isArm
      ? eks.NodegroupAmiType.AL2023_ARM_64_STANDARD
      : eks.NodegroupAmiType.AL2023_X86_64_STANDARD;

    // ── EKS cluster + managed node group ─────────────────────────────────────
    this.cluster = new eks.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'concordia',
      version: eks.KubernetesVersion.V1_31,
      kubectlLayer: new KubectlV31Layer(this, 'KubectlLayer'),
      defaultCapacity: 0,
    });
    const cluster = this.cluster;

    const nodegroup = cluster.addNodegroupCapacity('Nodes', {
      instanceTypes: [new ec2.InstanceType(instanceType)],
      amiType,
      minSize: 2,
      maxSize: 4,
      desiredSize: 3, // headroom for Cassandra + chat
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // EBS CSI driver — required for persistent volumes (Cassandra). Not preinstalled
    // on EKS. The controller pods need AWS creds via IRSA: their service account
    // (kube-system/ebs-csi-controller-sa) assumes a role through the cluster OIDC
    // provider. (Relying on the node role via IMDS fails — controller pods can't
    // reach IMDS, so provisioning errors with "no EC2 IMDS role found".)
    const oidc = cluster.openIdConnectProvider;
    const ebsCsiTrust = new cdk.CfnJson(this, 'EbsCsiTrustConditions', {
      value: {
        [`${oidc.openIdConnectProviderIssuer}:sub`]: 'system:serviceaccount:kube-system:ebs-csi-controller-sa',
        [`${oidc.openIdConnectProviderIssuer}:aud`]: 'sts.amazonaws.com',
      },
    });
    const ebsCsiRole = new iam.Role(this, 'EbsCsiRole', {
      assumedBy: new iam.OpenIdConnectPrincipal(oidc, { StringEquals: ebsCsiTrust }),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEBSCSIDriverPolicy'),
      ],
    });
    const ebsCsiAddon = new eks.CfnAddon(this, 'EbsCsiAddon', {
      clusterName: cluster.clusterName,
      addonName: 'aws-ebs-csi-driver',
      serviceAccountRoleArn: ebsCsiRole.roleArn,
      resolveConflicts: 'OVERWRITE',
    });
    ebsCsiAddon.node.addDependency(nodegroup);

    // Default gp3 StorageClass for the EBS CSI driver.
    const storageClass = cluster.addManifest('Gp3StorageClass', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: {
        name: 'gp3',
        annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
      },
      provisioner: 'ebs.csi.aws.com',
      volumeBindingMode: 'WaitForFirstConsumer',
      parameters: { type: 'gp3' },
    });
    storageClass.node.addDependency(ebsCsiAddon);

    // ── Container images (built from the existing Dockerfiles) ───────────────
    // Build contexts mirror infra/docker-compose.yml exactly:
    //   gateway / auth → context = repo root, file = services/<svc>/Dockerfile
    //   web-app / reverse-proxy → context = the service directory
    const gatewayImage = new ecrAssets.DockerImageAsset(this, 'GatewayImage', {
      directory: repoRoot,
      file: 'services/gateway/Dockerfile',
      platform,
    });
    const authImage = new ecrAssets.DockerImageAsset(this, 'AuthImage', {
      directory: repoRoot,
      file: 'services/auth/Dockerfile',
      platform,
    });
    const webImage = new ecrAssets.DockerImageAsset(this, 'WebImage', {
      directory: path.join(repoRoot, 'apps/web-app'),
      file: 'Dockerfile.prod', // static export served by Nginx (no dev-mode HMR)
      platform,
    });
    const proxyImage = new ecrAssets.DockerImageAsset(this, 'ProxyImage', {
      directory: path.join(repoRoot, 'services/reverse-proxy'),
      platform,
    });
    const serversImage = new ecrAssets.DockerImageAsset(this, 'ServersImage', {
      directory: repoRoot,
      file: 'services/servers/Dockerfile',
      platform,
    });
    const presenceImage = new ecrAssets.DockerImageAsset(this, 'PresenceImage', {
      directory: path.join(repoRoot, 'services/presence'),
      platform,
    });
    const auditImage = new ecrAssets.DockerImageAsset(this, 'AuditImage', {
      directory: repoRoot,
      file: 'services/audit/Dockerfile',
      platform,
    });
    const voiceImage = new ecrAssets.DockerImageAsset(this, 'VoiceImage', {
      directory: repoRoot,
      file: 'services/voice/Dockerfile',
      platform,
    });
    const chatImage = new ecrAssets.DockerImageAsset(this, 'ChatImage', {
      directory: repoRoot,
      file: 'services/chat/Dockerfile',
      platform,
    });
    for (const img of [gatewayImage, authImage, webImage, proxyImage, serversImage, presenceImage, auditImage, voiceImage, chatImage]) {
      img.repository.grantPull(nodegroup.role);
    }

    // ── Kubernetes manifests ─────────────────────────────────────────────────
    const namespace = cluster.addManifest('Namespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: NS },
    });

    const secretRef = (key: string) => ({ secretKeyRef: { name: 'concordia-secrets', key } });

    // Literal secret values (NOT Secrets Manager dynamic references — those are
    // not resolved inside the EKS KubernetesManifest custom resource and would
    // reach the pod as the verbatim "{{resolve:...}}" string, breaking DB auth).
    const appSecret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'concordia-secrets', namespace: NS },
      type: 'Opaque',
      stringData: {
        JWT_SECRET: props.jwtSecret,
        DB_USERNAME: props.dbUsername,
        DB_PASSWORD: props.dbPassword,
        // Audit service connects to the append-only `audit` DB (same RDS instance)
        // with INSERT-only / read-only roles. sslmode=require since RDS supports TLS.
        AUDIT_DB_WRITER_URL: `postgres://audit_writer:${props.auditWriterPassword}@${props.dbEndpoint}:5432/audit?sslmode=require`,
        AUDIT_DB_READER_URL: `postgres://audit_reader:${props.auditReaderPassword}@${props.dbEndpoint}:5432/audit?sslmode=require`,
      },
    };

    // Self-signed certs reused from the repo; mounted into the reverse-proxy pod.
    const tlsSecret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'tls-certs', namespace: NS },
      type: 'Opaque',
      stringData: {
        'server.crt': fs.readFileSync(path.join(repoRoot, 'infra/certs/server.crt'), 'utf8'),
        'server.key': fs.readFileSync(path.join(repoRoot, 'infra/certs/server.key'), 'utf8'),
      },
    };

    const deployment = (
      name: string,
      image: string,
      port: number,
      env: object[],
      extra: { healthPath?: string; startupDelay?: number; volumeMounts?: object[]; volumes?: object[]; ports?: object[]; replicas?: number; resources?: object } = {},
    ) => {
      const container: Record<string, unknown> = {
        name,
        image,
        imagePullPolicy: 'Always',
        ports: extra.ports ?? [{ containerPort: port }],
        env,
      };
      if (extra.resources) container.resources = extra.resources;
      if (extra.volumeMounts) container.volumeMounts = extra.volumeMounts;
      if (extra.healthPath) {
        // Readiness gates traffic (pod removed from the Service until healthy).
        container.readinessProbe = {
          httpGet: { path: extra.healthPath, port },
          initialDelaySeconds: extra.startupDelay ?? 10,
          periodSeconds: 10,
          failureThreshold: 30,
        };
        // Liveness restarts a hung pod (fault detection + automatic recovery).
        // Conservative settings (start late, tolerate ~90s of failures) so slow
        // JVM starts aren't killed in a restart loop.
        container.livenessProbe = {
          httpGet: { path: extra.healthPath, port },
          initialDelaySeconds: (extra.startupDelay ?? 10) + 30,
          periodSeconds: 15,
          failureThreshold: 6,
        };
      }
      return {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name, namespace: NS, labels: { app: name } },
        spec: {
          replicas: extra.replicas ?? 1,
          selector: { matchLabels: { app: name } },
          template: {
            metadata: { labels: { app: name } },
            spec: {
              containers: [container],
              ...(extra.volumes ? { volumes: extra.volumes } : {}),
            },
          },
        },
      };
    };

    const service = (
      name: string,
      port: number,
      targetPort: number,
      opts: { type?: string; annotations?: object; ports?: object[] } = {},
    ) => ({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: NS, ...(opts.annotations ? { annotations: opts.annotations } : {}) },
      spec: {
        type: opts.type ?? 'ClusterIP',
        selector: { app: name },
        ports: opts.ports ?? [{ port, targetPort }],
      },
    });

    // auth (Spring Boot) — Service name `auth` matches the gateway's default AUTH_URL.
    const authDeployment = deployment('auth', authImage.imageUri, 8081, [
      { name: 'SERVER_PORT', value: '8081' },
      { name: 'SPRING_DATASOURCE_URL', value: `jdbc:postgresql://${props.dbEndpoint}:5432/auth_db` },
      { name: 'SPRING_DATASOURCE_USERNAME', valueFrom: secretRef('DB_USERNAME') },
      { name: 'SPRING_DATASOURCE_PASSWORD', valueFrom: secretRef('DB_PASSWORD') },
      { name: 'JWT_SECRET', valueFrom: secretRef('JWT_SECRET') },
      { name: 'SPRING_KAFKA_BOOTSTRAP_SERVERS', value: props.kafkaBootstrap },
    ], {
      healthPath: '/health',
      startupDelay: 60,
      replicas: props.authReplicas,
      // Reserve memory/CPU so the scheduler spreads the (3) JVM pods across nodes
      // instead of bin-packing them onto one t4g.medium and OOMing it.
      resources: { requests: { memory: '768Mi', cpu: '250m' } },
    });

    // gateway (Go)
    const gatewayEnv: object[] = [
      { name: 'GATEWAY_PORT', value: '8080' },
      { name: 'JWT_SECRET', valueFrom: secretRef('JWT_SECRET') },
      { name: 'TLS_ENABLED', value: 'false' },
      { name: 'AUTH_URL', value: 'http://auth:8081' },
      { name: 'KAFKA_BROKERS', value: props.kafkaBootstrap },
      { name: 'REDIS_ADDR', value: props.redisEndpoint },
      // >1 replica needs the Redis pub/sub backplane so WS pushes reach the pod
      // holding each socket. Auto-enabled so you can't scale out without it.
      { name: 'GATEWAY_WS_BACKPLANE', value: props.gatewayReplicas > 1 ? 'true' : 'false' },
    ];
    if (props.appOrigin) gatewayEnv.push({ name: 'ALLOWED_ORIGINS', value: props.appOrigin });
    const gatewayDeployment = deployment('gateway', gatewayImage.imageUri, 8080, gatewayEnv, {
      healthPath: '/health',
      startupDelay: 10,
      replicas: props.gatewayReplicas,
    });

    // web-app (Next.js static export served by Nginx). NEXT_PUBLIC_API_URL=/api is
    // baked at image build time, so no runtime env is needed.
    const webDeployment = deployment('web-app', webImage.imageUri, 3000, [], {
      healthPath: '/',
      startupDelay: 5,
      resources: { requests: { memory: '512Mi', cpu: '100m' } },
    });

    // kafka-topic-init Job — the MSK equivalent of compose's `kafka-init`. MSK does
    // not auto-create topics, so producers (e.g. auth's user-registered) would block
    // ~60s on metadata for a missing topic and time out. Idempotent (--if-not-exists);
    // RF=2 since MSK has 2 brokers. Runs on deploy.
    const kafkaTopics = ['user-registered', 'message-created', 'mention', 'audit.events'];
    const kafkaTopicInit = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'kafka-topic-init', namespace: NS },
      spec: {
        backoffLimit: 20,
        template: {
          spec: {
            restartPolicy: 'OnFailure',
            containers: [{
              name: 'init',
              image: 'bitnamilegacy/kafka:3.8',
              command: ['bash', '-c'],
              args: [
                kafkaTopics
                  .map((t) => `kafka-topics.sh --bootstrap-server "$KAFKA" --create --if-not-exists --topic ${t} --partitions 1 --replication-factor 2`)
                  .join(' && ') + ' && echo "topics ready"',
              ],
              env: [{ name: 'KAFKA', value: props.kafkaBootstrap }],
            }],
          },
        },
      },
    };

    // db-init Job — RDS has only auth_db; create the other databases + the
    // append-only audit schema/roles here (the cloud equivalent of compose's
    // infra/postgres/init.sql and infra/audit-db/init.sh). Idempotent; runs on deploy.
    const dbInitScript = [
      'set -e',
      "for db in servers_db audit; do",
      "  psql -tc \"SELECT 1 FROM pg_database WHERE datname='$db'\" | grep -q 1 || psql -c \"CREATE DATABASE $db\"",
      'done',
      // audit roles: create-if-missing, then (re)set password — INSERT/SELECT only.
      'psql -d audit -c "CREATE ROLE audit_writer LOGIN PASSWORD \'$AUDIT_WRITER_PASSWORD\'" || true',
      'psql -d audit -c "ALTER ROLE audit_writer LOGIN PASSWORD \'$AUDIT_WRITER_PASSWORD\'"',
      'psql -d audit -c "CREATE ROLE audit_reader LOGIN PASSWORD \'$AUDIT_READER_PASSWORD\'" || true',
      'psql -d audit -c "ALTER ROLE audit_reader LOGIN PASSWORD \'$AUDIT_READER_PASSWORD\'"',
      "psql -d audit -v ON_ERROR_STOP=1 <<'SQL'",
      'CREATE TABLE IF NOT EXISTS audit_events (',
      '  seq BIGSERIAL PRIMARY KEY,',
      '  event_id UUID NOT NULL UNIQUE,',
      '  event_type TEXT NOT NULL,',
      '  timestamp TEXT NOT NULL,',
      '  actor JSONB NOT NULL,',
      '  resource JSONB,',
      '  outcome TEXT NOT NULL,',
      '  metadata JSONB,',
      '  prev_hash TEXT,',
      '  hash TEXT NOT NULL,',
      '  received_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events (event_type);',
      "CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events ((actor->>'user_id'));",
      'CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events (timestamp);',
      'GRANT USAGE ON SCHEMA public TO audit_writer;',
      'GRANT INSERT, SELECT ON audit_events TO audit_writer;',
      'GRANT USAGE, SELECT ON SEQUENCE audit_events_seq_seq TO audit_writer;',
      'GRANT USAGE ON SCHEMA public TO audit_reader;',
      'GRANT SELECT ON audit_events TO audit_reader;',
      'SQL',
      'echo "db-init done"',
    ].join('\n');
    const dbInit = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'db-init', namespace: NS },
      spec: {
        backoffLimit: 20,
        template: {
          spec: {
            restartPolicy: 'OnFailure',
            containers: [{
              name: 'init',
              image: 'postgres:16',
              command: ['bash', '-c'],
              args: [dbInitScript],
              env: [
                { name: 'PGHOST', value: props.dbEndpoint },
                { name: 'PGPORT', value: '5432' },
                { name: 'PGUSER', value: props.dbUsername },
                { name: 'PGPASSWORD', valueFrom: secretRef('DB_PASSWORD') },
                { name: 'PGDATABASE', value: 'auth_db' },
                { name: 'PGSSLMODE', value: 'require' },
                { name: 'AUDIT_WRITER_PASSWORD', value: props.auditWriterPassword },
                { name: 'AUDIT_READER_PASSWORD', value: props.auditReaderPassword },
              ],
            }],
          },
        },
      },
    };

    // servers (Java, Spring + gRPC). REST on 8082, gRPC PermService on 50051.
    const serversDeployment = deployment('servers', serversImage.imageUri, 8082, [
      { name: 'SERVER_PORT', value: '8082' },
      { name: 'GRPC_PORT', value: '50051' },
      { name: 'SPRING_DATASOURCE_URL', value: `jdbc:postgresql://${props.dbEndpoint}:5432/servers_db` },
      { name: 'SPRING_DATASOURCE_USERNAME', valueFrom: secretRef('DB_USERNAME') },
      { name: 'SPRING_DATASOURCE_PASSWORD', valueFrom: secretRef('DB_PASSWORD') },
      { name: 'JWT_SECRET', valueFrom: secretRef('JWT_SECRET') },
      { name: 'SPRING_KAFKA_BOOTSTRAP_SERVERS', value: props.kafkaBootstrap },
    ], {
      healthPath: '/health',
      startupDelay: 60,
      ports: [{ containerPort: 8082 }, { containerPort: 50051 }],
      resources: { requests: { memory: '768Mi', cpu: '250m' } },
    });

    // presence (Go) — Redis-backed.
    const presenceDeployment = deployment('presence', presenceImage.imageUri, 8086, [
      { name: 'PRESENCE_PORT', value: '8086' },
      { name: 'REDIS_ADDR', value: props.redisEndpoint },
      { name: 'JWT_SECRET', valueFrom: secretRef('JWT_SECRET') },
    ], { healthPath: '/health', startupDelay: 10 });

    // audit (Go) — consumes audit.events from Kafka, hash-chains into the audit DB.
    const auditDeployment = deployment('audit', auditImage.imageUri, 8087, [
      { name: 'AUDIT_PORT', value: '8087' },
      { name: 'KAFKA_BROKERS', value: props.kafkaBootstrap },
      { name: 'AUDIT_TOPIC', value: 'audit.events' },
      { name: 'AUDIT_DB_WRITER_URL', valueFrom: secretRef('AUDIT_DB_WRITER_URL') },
      { name: 'AUDIT_DB_READER_URL', valueFrom: secretRef('AUDIT_DB_READER_URL') },
      { name: 'JWT_SECRET', valueFrom: secretRef('JWT_SECRET') },
    ], { healthPath: '/health', startupDelay: 20 });

    // ── Cassandra (self-hosted, persistent) — chat message store ─────────────
    const cassandraStatefulSet = {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'cassandra', namespace: NS },
      spec: {
        serviceName: 'cassandra',
        replicas: 1,
        selector: { matchLabels: { app: 'cassandra' } },
        template: {
          metadata: { labels: { app: 'cassandra' } },
          spec: {
            terminationGracePeriodSeconds: 120,
            containers: [{
              name: 'cassandra',
              image: 'cassandra:4',
              ports: [{ containerPort: 9042, name: 'cql' }],
              env: [
                { name: 'CASSANDRA_CLUSTER_NAME', value: 'concordia' },
                { name: 'MAX_HEAP_SIZE', value: '1024M' },
                { name: 'HEAP_NEWSIZE', value: '200M' },
              ],
              resources: { requests: { memory: '1Gi', cpu: '250m' } },
              readinessProbe: {
                exec: { command: ['bash', '-c', "cqlsh -e 'describe cluster'"] },
                initialDelaySeconds: 60,
                periodSeconds: 15,
                timeoutSeconds: 10,
                failureThreshold: 30,
              },
              volumeMounts: [{ name: 'data', mountPath: '/var/lib/cassandra' }],
            }],
          },
        },
        volumeClaimTemplates: [{
          metadata: { name: 'data' },
          spec: {
            accessModes: ['ReadWriteOnce'],
            storageClassName: 'gp3',
            resources: { requests: { storage: '10Gi' } },
          },
        }],
      },
    };
    const cassandraService = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'cassandra', namespace: NS },
      spec: {
        clusterIP: 'None', // headless — stable DNS for the StatefulSet pod
        selector: { app: 'cassandra' },
        ports: [{ port: 9042, targetPort: 9042 }],
      },
    };
    // Create the discord_chat keyspace once Cassandra is reachable (retries via backoffLimit).
    const cassandraInit = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'cassandra-init', namespace: NS },
      spec: {
        backoffLimit: 30,
        template: {
          spec: {
            restartPolicy: 'OnFailure',
            containers: [{
              name: 'init',
              image: 'cassandra:4',
              command: ['bash', '-c'],
              args: [
                "cqlsh cassandra -e \"CREATE KEYSPACE IF NOT EXISTS discord_chat WITH replication = {'class':'SimpleStrategy','replication_factor':1};\" && echo keyspace-ready",
              ],
            }],
          },
        },
      },
    };

    // chat (Rust/Axum) — Cassandra + Kafka + gRPC PermCheck + WS fan-out to gateway.
    // MinIO/attachments env is left at defaults (unused; the app has no attachments yet).
    const chatDeployment = deployment('chat', chatImage.imageUri, 8083, [
      { name: 'CHAT_PORT', value: '8083' },
      { name: 'CASSANDRA_HOST', value: 'cassandra' },
      { name: 'CASSANDRA_KEYSPACE', value: 'discord_chat' },
      { name: 'KAFKA_BROKERS', value: props.kafkaBootstrap },
      { name: 'SERVERS_GRPC_ADDR', value: 'http://servers:50051' },
      { name: 'SERVERS_HTTP_ADDR', value: 'http://servers:8082' },
      { name: 'PRESENCE_HTTP_ADDR', value: 'http://presence:8086' },
      { name: 'GATEWAY_INTERNAL_PUSH_URL', value: 'http://gateway:8080/internal/push' },
      { name: 'JWT_SECRET', valueFrom: secretRef('JWT_SECRET') },
      // Message-history cache (Cache-Aside, TTL) on a dedicated ElastiCache.
      { name: 'CHAT_CACHE_ENABLED', value: 'true' },
      { name: 'CHAT_CACHE_REDIS_ADDR', value: `redis://${props.cacheRedisEndpoint}` },
      { name: 'CHAT_CACHE_TTL_SECONDS', value: '5' },
    ], { healthPath: '/health', startupDelay: 20 });

    // voice (Python/FastAPI) — Redis sessions + gRPC PermCheck to servers.
    const voiceDeployment = deployment('voice', voiceImage.imageUri, 8084, [
      { name: 'VOICE_PORT', value: '8084' },
      { name: 'REDIS_ADDR', value: `redis://${props.redisEndpoint}` }, // aioredis needs the scheme
      { name: 'GRPC_ADDR', value: 'servers:50051' },
      { name: 'KAFKA_BROKERS', value: props.kafkaBootstrap },
      { name: 'JWT_SECRET', valueFrom: secretRef('JWT_SECRET') },
    ], { healthPath: '/health', startupDelay: 15 });

    // reverse-proxy (Nginx) — sole public ingress; TLS via mounted self-signed certs.
    const proxyDeployment = deployment('reverse-proxy', proxyImage.imageUri, 443, [
      { name: 'SECURITY_SECURE_CHANNEL', value: 'true' },
      { name: 'API_RATE_LIMIT', value: props.apiRateLimit },
      { name: 'API_RATE_BURST', value: props.apiRateBurst },
    ], {
      ports: [{ containerPort: 80 }, { containerPort: 443 }, { containerPort: 8088 }],
      volumeMounts: [{ name: 'certs', mountPath: '/certs', readOnly: true }],
      volumes: [{ name: 'certs', secret: { secretName: 'tls-certs' } }],
    });

    const workloads = cluster.addManifest(
      'Workloads',
      appSecret,
      tlsSecret,
      kafkaTopicInit,
      dbInit,
      cassandraStatefulSet,
      cassandraService,
      cassandraInit,
      authDeployment,
      service('auth', 8081, 8081),
      serversDeployment,
      service('servers', 8082, 8082, {
        ports: [
          { name: 'http', port: 8082, targetPort: 8082 },
          { name: 'grpc', port: 50051, targetPort: 50051 },
        ],
      }),
      presenceDeployment,
      service('presence', 8086, 8086),
      auditDeployment,
      service('audit', 8087, 8087),
      voiceDeployment,
      service('voice', 8084, 8084),
      chatDeployment,
      service('chat', 8083, 8083),
      gatewayDeployment,
      service('gateway', 8080, 8080),
      webDeployment,
      service('web-app', 3000, 3000),
      proxyDeployment,
      service('reverse-proxy', 443, 443, {
        type: 'LoadBalancer',
        annotations: {
          'service.beta.kubernetes.io/aws-load-balancer-type': 'nlb',
          'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
        },
        ports: [
          { name: 'http', port: 80, targetPort: 80 },
          { name: 'https', port: 443, targetPort: 443 },
        ],
      }),
    );
    workloads.node.addDependency(namespace);
    workloads.node.addDependency(storageClass); // gp3 SC must exist before the Cassandra PVC

    // ── Surface the public NLB DNS as a stack output ─────────────────────────
    const nlbHostname = new eks.KubernetesObjectValue(this, 'NlbHostname', {
      cluster,
      objectType: 'service',
      objectNamespace: NS,
      objectName: 'reverse-proxy',
      jsonPath: '.status.loadBalancer.ingress[0].hostname',
      timeout: cdk.Duration.minutes(10),
    });
    nlbHostname.node.addDependency(workloads);

    new cdk.CfnOutput(scope, 'AppUrl', {
      value: cdk.Fn.join('', ['https://', nlbHostname.value]),
      description: 'Public URL (self-signed cert — accept the browser warning)',
    });
    new cdk.CfnOutput(scope, 'KubeconfigCommand', {
      value: `aws eks update-kubeconfig --name ${cluster.clusterName} --region ${cdk.Stack.of(this).region}`,
      description: 'Run this to point kubectl at the cluster',
    });
  }
}
