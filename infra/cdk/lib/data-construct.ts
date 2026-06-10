import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as msk from 'aws-cdk-lib/aws-msk';
import * as cr from 'aws-cdk-lib/custom-resources';

export interface DataConstructProps {
  vpc: ec2.Vpc;
  /** RDS master username + password (literal — kept in sync with the k8s Secret). */
  dbUsername: string;
  dbPassword: string;
}

/**
 * Managed data plane for the core subset: RDS Postgres (auth_db), a single-node
 * ElastiCache Redis (gateway rate-limiting), and an MSK (Kafka) cluster.
 *
 * MSK uses a PLAINTEXT in-VPC client listener (port 9092, unauthenticated) so the
 * existing Go/Spring Kafka clients work with NO code changes. Security is provided
 * by VPC isolation + security groups that only admit traffic from inside the VPC.
 * (MSK Serverless was deliberately avoided: it forces IAM/SASL auth, which would
 * require touching every service's Kafka client.)
 */
export class DataConstruct extends Construct {
  public readonly dbEndpoint: string;
  public readonly redisEndpoint: string;
  public readonly cacheRedisEndpoint: string;
  public readonly kafkaBootstrap: string;

  constructor(scope: Construct, id: string, props: DataConstructProps) {
    super(scope, id);
    const { vpc } = props;
    const fromVpc = ec2.Peer.ipv4(vpc.vpcCidrBlock);
    const privateSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });

    // ── RDS Postgres 16 (auth_db) ────────────────────────────────────────────
    // The master password is supplied explicitly (not fromGeneratedSecret) so the
    // exact same literal can be injected into the workloads' k8s Secret. Secrets
    // Manager dynamic references ({{resolve:...}}) do NOT resolve inside the EKS
    // KubernetesManifest custom resource, so they can't be used here.
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'Concordia RDS Postgres' });
    dbSg.addIngressRule(fromVpc, ec2.Port.tcp(5432), 'Postgres from within the VPC');

    const db = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      databaseName: 'auth_db',
      credentials: rds.Credentials.fromPassword(
        props.dbUsername,
        cdk.SecretValue.unsafePlainText(props.dbPassword),
      ),
      securityGroups: [dbSg],
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      multiAz: false,
      backupRetention: cdk.Duration.days(0),
      deleteAutomatedBackups: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // lab: tear down cleanly
    });
    this.dbEndpoint = db.instanceEndpoint.hostname;

    // ── ElastiCache Redis (single node, in-VPC, no auth/TLS) ─────────────────
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', { vpc, description: 'Concordia ElastiCache Redis' });
    redisSg.addIngressRule(fromVpc, ec2.Port.tcp(6379), 'Redis from within the VPC');

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnets', {
      description: 'Concordia Redis subnet group',
      subnetIds: privateSubnets.subnetIds,
    });
    const redis = new elasticache.CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      cacheNodeType: 'cache.t3.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    });
    redis.addDependency(redisSubnetGroup);
    this.redisEndpoint = `${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`;

    // Dedicated ElastiCache for the chat message-history cache — isolated from the
    // operational Redis above (sessions, rate-limit counters, WS backplane) so a
    // cache spike can't affect them. All cache keys carry a TTL, so the default
    // `volatile-lru` eviction is appropriate. Reuses the subnet group + SG.
    const cacheRedis = new elasticache.CfnCacheCluster(this, 'CacheRedis', {
      engine: 'redis',
      cacheNodeType: 'cache.t3.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    });
    cacheRedis.addDependency(redisSubnetGroup);
    this.cacheRedisEndpoint = `${cacheRedis.attrRedisEndpointAddress}:${cacheRedis.attrRedisEndpointPort}`;

    // ── MSK (Kafka), PLAINTEXT in-VPC listener ───────────────────────────────
    const kafkaSg = new ec2.SecurityGroup(this, 'KafkaSg', { vpc, description: 'Concordia MSK Kafka' });
    kafkaSg.addIngressRule(fromVpc, ec2.Port.tcp(9092), 'Kafka PLAINTEXT from within the VPC');

    const kafka = new msk.CfnCluster(this, 'Kafka', {
      clusterName: 'concordia',
      kafkaVersion: '3.6.0',
      numberOfBrokerNodes: 2, // one broker per private subnet (2 AZs)
      brokerNodeGroupInfo: {
        instanceType: 'kafka.t3.small',
        clientSubnets: privateSubnets.subnetIds,
        securityGroups: [kafkaSg.securityGroupId],
        storageInfo: { ebsStorageInfo: { volumeSize: 20 } },
      },
      clientAuthentication: { unauthenticated: { enabled: true } },
      encryptionInfo: { encryptionInTransit: { clientBroker: 'PLAINTEXT', inCluster: true } },
    });

    // MSK CfnCluster does not return the bootstrap broker string as an attribute;
    // fetch it once the cluster is ACTIVE via an SDK call.
    const brokers = new cr.AwsCustomResource(this, 'KafkaBootstrap', {
      onUpdate: {
        service: 'Kafka',
        action: 'getBootstrapBrokers',
        parameters: { ClusterArn: kafka.attrArn },
        physicalResourceId: cr.PhysicalResourceId.of(kafka.attrArn),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });
    brokers.node.addDependency(kafka);
    this.kafkaBootstrap = brokers.getResponseField('BootstrapBrokerString');

    new cdk.CfnOutput(scope, 'DbEndpoint', { value: this.dbEndpoint });
    new cdk.CfnOutput(scope, 'RedisEndpoint', { value: this.redisEndpoint });
    new cdk.CfnOutput(scope, 'KafkaBootstrap', { value: this.kafkaBootstrap });
  }
}
