// Pulls the latest release metadata from the GitHub Releases API so the
// website's download buttons always point at the freshest build without
// needing a redeploy. Falls back to placeholder values if the network
// call fails — visitors still get a working "go to releases page" CTA.

export type ReleaseAsset = {
  name: string
  url: string // direct download URL
  sizeMB: number // rounded
}

export type ReleaseInfo = {
  version: string // e.g. "1.6.2"
  publishedAt: string // ISO
  htmlUrl: string // human-friendly release page on GitHub
  macArm64?: ReleaseAsset
  windows?: ReleaseAsset
}

const RELEASES_API =
  'https://api.github.com/repos/ShDyDaniel/download-manager-plus-releases/releases/latest'
const RELEASES_PAGE =
  'https://github.com/ShDyDaniel/download-manager-plus-releases/releases'

export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    const j = await res.json()
    const assets = (j.assets || []) as Array<{
      name: string
      browser_download_url: string
      size: number
    }>
    const find = (predicate: (n: string) => boolean): ReleaseAsset | undefined => {
      const a = assets.find((x) => predicate(x.name.toLowerCase()))
      if (!a) return undefined
      return {
        name: a.name,
        url: a.browser_download_url,
        sizeMB: Math.round(a.size / 1024 / 1024),
      }
    }
    return {
      version: (j.tag_name || j.name || '').replace(/^v/i, ''),
      publishedAt: j.published_at || j.created_at || '',
      htmlUrl: j.html_url || RELEASES_PAGE,
      macArm64: find((n) => n.includes('arm64') && n.endsWith('.dmg')),
      windows: find((n) => n.endsWith('.exe')),
    }
  } catch {
    return null
  }
}

export const RELEASES_PAGE_URL = RELEASES_PAGE
