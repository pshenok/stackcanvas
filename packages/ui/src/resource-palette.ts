export interface PaletteItem { type: string; label: string }
export interface ProviderPack { provider: string; label: string; items: PaletteItem[] }

// Provider packs are pure data — adding a cloud is a PR that appends a pack
// here (and, optionally, containment rules in @stackcanvas/core and icon
// patterns in icons.tsx). The canvas itself is provider-agnostic: any
// Terraform provider in the state renders without a pack; packs only curate
// the palette.
export const PROVIDER_PACKS: ProviderPack[] = [
  {
    provider: 'aws',
    label: 'AWS',
    items: [
      { type: 'aws_vpc', label: 'VPC' },
      { type: 'aws_subnet', label: 'Subnet' },
      { type: 'aws_security_group', label: 'Security group' },
      { type: 'aws_instance', label: 'EC2 instance' },
      { type: 'aws_autoscaling_group', label: 'Auto Scaling group' },
      { type: 'aws_lb', label: 'Load balancer' },
      { type: 'aws_lb_target_group', label: 'Target group' },
      { type: 'aws_ecs_cluster', label: 'ECS cluster' },
      { type: 'aws_ecs_service', label: 'ECS service' },
      { type: 'aws_eks_cluster', label: 'EKS cluster' },
      { type: 'aws_lambda_function', label: 'Lambda' },
      { type: 'aws_apigatewayv2_api', label: 'API Gateway' },
      { type: 'aws_db_instance', label: 'RDS instance' },
      { type: 'aws_dynamodb_table', label: 'DynamoDB table' },
      { type: 'aws_elasticache_cluster', label: 'ElastiCache' },
      { type: 'aws_s3_bucket', label: 'S3 bucket' },
      { type: 'aws_ecr_repository', label: 'ECR repo' },
      { type: 'aws_cloudfront_distribution', label: 'CloudFront' },
      { type: 'aws_route53_zone', label: 'Route53 zone' },
      { type: 'aws_route53_record', label: 'Route53 record' },
      { type: 'aws_sqs_queue', label: 'SQS queue' },
      { type: 'aws_sns_topic', label: 'SNS topic' },
      { type: 'aws_cloudwatch_log_group', label: 'Log group' },
      { type: 'aws_iam_role', label: 'IAM role' },
      { type: 'aws_iam_policy', label: 'IAM policy' },
    ],
  },
  {
    provider: 'google',
    label: 'GCP',
    items: [
      { type: 'google_compute_network', label: 'VPC network' },
      { type: 'google_compute_subnetwork', label: 'Subnetwork' },
      { type: 'google_compute_instance', label: 'Compute instance' },
      { type: 'google_compute_firewall', label: 'Firewall rule' },
      { type: 'google_container_cluster', label: 'GKE cluster' },
      { type: 'google_cloud_run_v2_service', label: 'Cloud Run service' },
      { type: 'google_sql_database_instance', label: 'Cloud SQL instance' },
      { type: 'google_storage_bucket', label: 'Storage bucket' },
      { type: 'google_pubsub_topic', label: 'Pub/Sub topic' },
      { type: 'google_pubsub_subscription', label: 'Pub/Sub subscription' },
      { type: 'google_cloudfunctions2_function', label: 'Cloud Function (2nd gen)' },
      { type: 'google_artifact_registry_repository', label: 'Artifact Registry repo' },
      { type: 'google_dns_managed_zone', label: 'Cloud DNS zone' },
      { type: 'google_service_account', label: 'Service account' },
      { type: 'google_project_iam_member', label: 'IAM member' },
      { type: 'google_redis_instance', label: 'Memorystore Redis' },
    ],
  },
  {
    provider: 'azurerm',
    label: 'Azure',
    items: [
      { type: 'azurerm_virtual_network', label: 'Virtual network' },
      { type: 'azurerm_subnet', label: 'Subnet' },
      { type: 'azurerm_network_security_group', label: 'Network security group' },
      { type: 'azurerm_linux_virtual_machine', label: 'Virtual machine (Linux)' },
      { type: 'azurerm_kubernetes_cluster', label: 'AKS cluster' },
      { type: 'azurerm_container_app', label: 'Container App' },
      { type: 'azurerm_mssql_server', label: 'SQL server' },
      { type: 'azurerm_mssql_database', label: 'SQL database' },
      { type: 'azurerm_postgresql_flexible_server', label: 'PostgreSQL flexible server' },
      { type: 'azurerm_storage_account', label: 'Storage account' },
      { type: 'azurerm_servicebus_namespace', label: 'Service Bus namespace' },
      { type: 'azurerm_servicebus_queue', label: 'Service Bus queue' },
      // azurerm_function_app_flex_consumption exists for the newer Flex
      // Consumption plan, but azurerm_linux_function_app is the broadly
      // compatible, long-established resource — safer as the curated default.
      { type: 'azurerm_linux_function_app', label: 'Function App (Linux)' },
      { type: 'azurerm_dns_zone', label: 'DNS zone' },
      { type: 'azurerm_key_vault', label: 'Key Vault' },
      { type: 'azurerm_redis_cache', label: 'Azure Cache for Redis' },
    ],
  },
  {
    provider: 'cloudflare',
    label: 'Cloudflare',
    items: [
      { type: 'cloudflare_zone', label: 'Zone' },
      // v5 of the provider renamed cloudflare_record -> cloudflare_dns_record;
      // this pack targets the current (v5) resource name.
      { type: 'cloudflare_dns_record', label: 'DNS record' },
      // v5 also renamed cloudflare_worker_script -> cloudflare_workers_script.
      { type: 'cloudflare_workers_script', label: 'Worker script' },
      { type: 'cloudflare_workers_kv_namespace', label: 'Workers KV namespace' },
      { type: 'cloudflare_r2_bucket', label: 'R2 bucket' },
      { type: 'cloudflare_pages_project', label: 'Pages project' },
      { type: 'cloudflare_ruleset', label: 'Ruleset' },
      // Formerly cloudflare_tunnel; current name is the zero-trust-prefixed one.
      { type: 'cloudflare_zero_trust_tunnel_cloudflared', label: 'Tunnel' },
    ],
  },
]

/** 'aws_vpc' -> 'aws', 'google_compute_instance' -> 'google', 'random_pet' -> 'random' */
export function providerOfType(type: string): string {
  const idx = type.indexOf('_')
  return idx > 0 ? type.slice(0, idx) : type
}
