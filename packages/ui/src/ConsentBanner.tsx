import { useEffect, useState } from 'react'

type Consent = 'granted' | 'denied' | 'unset' | 'disabled_env'

interface TelemetryResponse {
  consent?: Consent
}

const TELEMETRY_DOCS_URL = 'https://github.com/pshenok/stackcanvas/blob/main/TELEMETRY.md'

// One-time consent surface (M1-5 / issue #9). Fetches the current consent
// state on mount and shows a dismissible banner only while it is 'unset' —
// never re-prompts once the user has decided, and never renders anything for
// 'disabled_env' (STACKCANVAS_TELEMETRY=0 / DO_NOT_TRACK=1 already settled it).
export function ConsentBanner() {
  const [consent, setConsent] = useState<Consent | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/telemetry')
      .then(res => (res.ok ? res.json() as Promise<TelemetryResponse> : null))
      .then(data => {
        if (!cancelled && data?.consent) setConsent(data.consent)
      })
      .catch(() => {
        // Telemetry can never break the product — banner just stays hidden.
      })
    return () => { cancelled = true }
  }, [])

  const decide = async (granted: boolean) => {
    try {
      const res = await fetch('/api/telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ granted }),
      })
      const data = res.ok ? await res.json() as TelemetryResponse : null
      setConsent(data?.consent ?? (granted ? 'granted' : 'denied'))
    } catch {
      // Fire-and-forget, matching TelemetryClient.emit's contract: dismiss
      // locally even if the request failed, rather than trap the user.
      setConsent(granted ? 'granted' : 'denied')
    }
  }

  if (consent !== 'unset') return null

  return (
    <div className="consent-banner" role="dialog" aria-label="Telemetry consent">
      <div className="consent-banner-head">
        <svg width="18" height="18" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.4" className="icon">
          <circle cx="8" cy="8" r="6.5" fill="none" />
          <path d="M8 7.2v4M8 4.6h.01" fill="none" strokeLinecap="round" />
        </svg>
        <p>
          Anonymous usage counters (no resource names, no infra data) help prioritize
          development — see{' '}
          <a href={TELEMETRY_DOCS_URL} target="_blank" rel="noreferrer">TELEMETRY.md</a>.
        </p>
      </div>
      <div className="consent-actions">
        <button onClick={() => void decide(true)}>Allow</button>
        <button onClick={() => void decide(false)}>No thanks</button>
      </div>
    </div>
  )
}
