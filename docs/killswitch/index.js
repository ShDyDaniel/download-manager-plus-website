/**
 * Billing kill-switch — Cloud Function (Gen 2, Node 20).
 *
 * Triggered by a Cloud Billing *budget* notification on a Pub/Sub
 * topic. When the project's month-to-date cost crosses the budget
 * amount you set, this DISABLES billing on the project, which caps
 * spending: the project reverts to the free Spark limits (paid usage
 * stops). It is a last-resort circuit breaker, not an everyday throttle.
 *
 * Set the budget amount to whatever ceiling you want:
 *   - low (e.g. $3) during development → catches a runaway bug,
 *   - high (e.g. $50) in production → only fires on a true catastrophe,
 *     so normal growth (a few dollars of Firestore reads) flows through.
 *
 * CAVEATS (read these):
 *   - Budget data has a lag of a few hours — this is NOT instant.
 *   - Disabling billing stops ALL paid services on the project
 *     (Firestore beyond free tier, etc.). The app degrades / errors
 *     until you re-enable billing MANUALLY (Billing → link account).
 *   - The function's service account needs the
 *     "Billing Account Administrator" role on the BILLING ACCOUNT.
 *
 * Entry point: stopBilling
 */
const { CloudBillingClient } = require('@google-cloud/billing')

const billing = new CloudBillingClient()

// The project to protect. Set PROTECTED_PROJECT_ID as a function env
// var (recommended), e.g. "n-plus-64549". Falls back to the function's
// own project id.
const PROJECT_ID =
  process.env.PROTECTED_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT
const PROJECT_NAME = `projects/${PROJECT_ID}`

exports.stopBilling = async (cloudEvent) => {
  // Budget notifications arrive as a base64 JSON Pub/Sub message. This
  // handles both Gen-2 (data.message.data) and Gen-1 (data) shapes.
  const b64 = cloudEvent?.data?.message?.data ?? cloudEvent?.data
  if (!b64) {
    console.log('No Pub/Sub payload — ignoring.')
    return
  }

  let data
  try {
    data = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
  } catch (err) {
    console.error('Bad budget payload:', err)
    return
  }

  const cost = Number(data.costAmount || 0)
  const budget = Number(data.budgetAmount || 0)
  console.log(
    `[killswitch] project=${PROJECT_ID} cost=${cost} budget=${budget}`,
  )

  // Only act once spend has actually crossed the budget.
  if (!budget || cost <= budget) {
    console.log('[killswitch] under budget — no action.')
    return
  }

  const enabled = await isBillingEnabled(PROJECT_NAME)
  if (!enabled) {
    console.log('[killswitch] billing already disabled — nothing to do.')
    return
  }

  await disableBilling(PROJECT_NAME)
}

async function isBillingEnabled(projectName) {
  try {
    const [info] = await billing.getProjectBillingInfo({ name: projectName })
    return Boolean(info.billingEnabled)
  } catch (err) {
    console.error('[killswitch] getProjectBillingInfo failed:', err)
    // Fail safe: if we can't tell, don't try to disable (avoid loops).
    return false
  }
}

async function disableBilling(projectName) {
  // An empty billingAccountName detaches the billing account → disables
  // billing on the project.
  const [res] = await billing.updateProjectBillingInfo({
    name: projectName,
    projectBillingInfo: { billingAccountName: '' },
  })
  console.log('[killswitch] BILLING DISABLED:', JSON.stringify(res))
}
