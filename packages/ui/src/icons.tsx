import type { JSX } from 'react'

const glyphFor = (type: string): 'network' | 'compute' | 'database' | 'storage' | 'security' | 'messaging' | 'generic' => {
  if (/vpc|subnet|route53|cloudfront|lb|apigateway|nat|gateway/.test(type)) return 'network'
  if (/db_|dynamodb|elasticache|rds/.test(type)) return 'database'
  if (/instance$|autoscaling|ecs|eks|lambda|launch/.test(type)) return 'compute'
  if (/s3|ecr|log_group|efs/.test(type)) return 'storage'
  if (/iam|security_group|kms/.test(type)) return 'security'
  if (/sqs|sns|eventbridge|kinesis/.test(type)) return 'messaging'
  return 'generic'
}

export function ResourceIcon({ type }: { type: string }) {
  const glyph = glyphFor(type)
  const paths: Record<string, JSX.Element> = {
    network: <><circle cx="8" cy="8" r="6.5" fill="none" /><path d="M1.5 8h13M8 1.5c-2.5 2-2.5 11 0 13M8 1.5c2.5 2 2.5 11 0 13" fill="none" /></>,
    compute: <><rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" /><rect x="5.5" y="5.5" width="5" height="5" /></>,
    database: <><ellipse cx="8" cy="3.5" rx="6" ry="2" fill="none" /><path d="M2 3.5v9c0 1.1 2.7 2 6 2s6-.9 6-2v-9" fill="none" /></>,
    storage: <><rect x="2" y="4" width="12" height="9" rx="1" fill="none" /><path d="M2 7.5h12" fill="none" /></>,
    security: <path d="M8 1.5l5.5 2v4c0 3.5-2.3 6-5.5 7-3.2-1-5.5-3.5-5.5-7v-4z" fill="none" />,
    messaging: <path d="M2 4l6 4.5L14 4M2.5 3.5h11a1 1 0 011 1v7a1 1 0 01-1 1h-11a1 1 0 01-1-1v-7a1 1 0 011-1z" fill="none" />,
    generic: <rect x="3" y="3" width="10" height="10" rx="2" fill="none" />,
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.4" className="icon">
      {paths[glyph]}
    </svg>
  )
}
