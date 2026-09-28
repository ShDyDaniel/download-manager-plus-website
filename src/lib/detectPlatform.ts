/**
 * Which desktop build a visitor needs: 'mac' or 'win', or null when the device
 * can't run the app (phone, tablet) or the OS isn't recognised (Linux,
 * ChromeOS).
 *
 * Prefers the browser's own platform report (navigator.userAgentData, in
 * Chromium browsers — Chrome, Edge, Brave, Opera), which isn't affected by
 * user-agent quirks; falls back to the user-agent string (Safari, Firefox).
 * iPadOS Safari pretends to be a Mac, so a "Mac" with a touch screen is an iPad.
 */
export type DesktopPlatform = 'mac' | 'win'

export function isPhoneOrTablet(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  if (uaData?.mobile) return true
  const ua = navigator.userAgent
  return (
    /iPhone|iPad|iPod|Android/i.test(ua) ||
    (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1)
  )
}

export function detectPlatform(): DesktopPlatform | null {
  if (typeof navigator === 'undefined') return null
  if (isPhoneOrTablet()) return null
  const reported = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  if (reported) {
    if (/mac/i.test(reported)) return 'mac'
    if (/win/i.test(reported)) return 'win'
  }
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'win'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
  return null
}
