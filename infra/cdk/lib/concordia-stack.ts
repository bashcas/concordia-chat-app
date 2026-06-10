import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import { NetworkConstruct } from './network-construct';
import { DataConstruct } from './data-construct';
import { ClusterConstruct } from './cluster-construct';

export interface ConcordiaStackProps extends cdk.StackProps {
  /** Absolute path to the repo root (image-asset build context). */
  repoRoot: string;
  /** Node/image architecture: 'arm64' (Graviton, default) or 'amd64'. */
  arch: 'arm64' | 'amd64';
  /** Optional explicit CORS origin for the gateway. */
  appOrigin?: string;
  /** Reverse-proxy /api rate limit (req/s) and burst. */
  apiRateLimit: string;
  apiRateBurst: string;
  /** Number of gateway replicas (>1 enables the WS backplane). */
  gatewayReplicas: number;
  /** Number of auth replicas. */
  authReplicas: number;
  /** RDS master username + password (literals injected into the k8s Secret). */
  dbUsername: string;
  dbPassword: string;
  /** HS256 JWT signing key shared by gateway + auth (literal). */
  jwtSecret: string;
  /** Append-only audit DB role passwords. */
  auditWriterPassword: string;
  auditReaderPassword: string;
}

/**
 * Single stack so the whole core subset comes up with one `cdk deploy`. It is
 * composed of three layers (Network → Data → Cluster) kept as separate constructs
 * for clarity. Keeping them in one stack avoids cross-stack VPC/EKS subnet-tagging
 * pitfalls and circular references between the data and cluster layers.
 */
export class ConcordiaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConcordiaStackProps) {
    super(scope, id, props);

    const network = new NetworkConstruct(this, 'Network');

    const data = new DataConstruct(this, 'Data', {
      vpc: network.vpc,
      dbUsername: props.dbUsername,
      dbPassword: props.dbPassword,
    });

    new ClusterConstruct(this, 'Cluster', {
      vpc: network.vpc,
      repoRoot: props.repoRoot,
      arch: props.arch,
      appOrigin: props.appOrigin,
      apiRateLimit: props.apiRateLimit,
      apiRateBurst: props.apiRateBurst,
      gatewayReplicas: props.gatewayReplicas,
      authReplicas: props.authReplicas,
      dbEndpoint: data.dbEndpoint,
      dbUsername: props.dbUsername,
      dbPassword: props.dbPassword,
      jwtSecret: props.jwtSecret,
      auditWriterPassword: props.auditWriterPassword,
      auditReaderPassword: props.auditReaderPassword,
      redisEndpoint: data.redisEndpoint,
      cacheRedisEndpoint: data.cacheRedisEndpoint,
      kafkaBootstrap: data.kafkaBootstrap,
    });
  }
}
