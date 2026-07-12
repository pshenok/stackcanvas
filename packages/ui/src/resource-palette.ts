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
]

/** 'aws_vpc' -> 'aws', 'google_compute_instance' -> 'google', 'random_pet' -> 'random' */
export function providerOfType(type: string): string {
  const idx = type.indexOf('_')
  return idx > 0 ? type.slice(0, idx) : type
}
