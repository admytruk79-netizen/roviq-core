# ROVIQ Test Run Guide

A step-by-step script for running one complete service case on real phones against production, and for recording what breaks. It covers the current product: the Service app, the vehicle on every case, and dealership parts sharing. For a partner-facing demo narrative, see `PARTNER_DEMO_RUNBOOK.md`.

Plan for about 90 minutes: 30 minutes of setup, then about 45 minutes for one full case.

---

## Part 1 — Before test day (owner, about 30 minutes)

### 1.1 Check production is healthy

In GitHub → **Actions**, the latest `main` run of each of these should be green:

- **CI**
- **Smoke ROVIQ Production**
- **Smoke ROVIQ Production Browser**
- **Smoke Production Surfaces**

### 1.2 Check which services are connected

Run **Actions → Check ROVIQ Integrations → Run workflow** (branch `main`). It signs in as the admin already stored in GitHub and prints a yes/no table in the run summary. It never shows a key.

| Row | Needed for | If it says ❌ |
|---|---|---|
| Stripe secret key, **mode: test**, and **Stripe accepts the key ✅** | Customer card payment (step 5.8) | Skip payment; the case stops at "payment requested". Add the keys in Render → roviq-core → Environment. The webhook secret is optional for the test run: Core also confirms the payment with Stripe when the customer returns. |
| Stripe **mode: live** | — | **Stop.** Do not test payments with a live key. Swap to test keys in Render first. |
| Texts (Twilio) | Customer SMS updates | Updates still appear in the apps; no texts arrive. Add the keys in Cloudflare → Workers → roviq-core → Settings → Variables. |
| Email (Resend) | Customer email updates | Same as above, for email. |
| Push (VAPID) | Tow push alerts | Tow sees new jobs only when the queue refreshes (every 15 seconds). |

Write the results at the top of your notes sheet (see Part 4).

### 1.3 Create the test accounts

Use real inboxes you control. Gmail "plus" addresses work well, for example `you+customer@gmail.com`. Passwords need 12 or more characters. Never write passwords in this repository or in shared chats.

**Customer and staff:** run **Actions → Provision ROVIQ Production Accounts**:

- `admin_email` / `admin_password`: the existing production admin.
- `new_staff_email` / `new_staff_password`: an Ops login for the person playing Ops.
- `new_customer_email` / `new_customer_password`: the test customer.

**Service businesses:** run **Actions → Provision ROVIQ Role Portal Account** four times:

| Run | `portal_role` | `display_name` (example) | `enable_field_service` |
|---|---|---|---|
| 1 | `diagnostic` | Test Mobile Diagnostics | **true** |
| 2 | `tow` | Test Tow & Valet | false |
| 3 | `partner` | Test Dealership Service | false |
| 4 | `parts` | Test Parts Supply | false |

Afterwards, sign in once with every account to confirm the password works.

### 1.4 Prepare devices

| Person | Device | Opens |
|---|---|---|
| **Customer** | Phone | https://roviq-core-customer.pages.dev |
| **Field tech** (diagnostic + tow) | Phone with location on | https://roviq-service.pages.dev (the Service app) |
| **Shop + parts** | Laptop or tablet | https://roviq-service.pages.dev |
| **Ops** (usually you) | Laptop | https://roviq-ops.pages.dev |

- Give each role its own browser, or a private/incognito window. Two roles in the same browser profile overwrite each other's sign-in.
- Allow location on the Customer and Field-tech phones. Turn off battery saver.
- **Wake Core 5 minutes before starting.** Production runs on Render's free plan, which sleeps when idle; the first request can take about a minute and looks like a hang. Open any app and sign in once to wake it.

---

## Part 2 — The script

Everyone runs the steps in order. After each step, the person named checks the **Expect** line. If it doesn't happen, write it down (Part 4) and carry on if you can.

### Step 1 — Customer opens a case (Customer)

1. Sign in at the customer app.
2. Tap **Start service**.
3. **Which vehicle?** With no saved vehicle, enter year, make and model, plus color and license plate. VIN is optional. Set **Drive** to *All-wheel* to see the tow flatbed flag later.
4. Choose an issue, for example *Won't start*, and add a short note.
5. Tap **Capture GPS** and allow location, then choose an urgency.
6. Tap **Submit**.

**Expect:** the case page opens. It shows the vehicle with **Awaiting on-site check**, a status message, and your location on the map.

### Step 2 — Ops sends a diagnostic technician (Ops)

1. In Ops, open the new case (newest first).
2. Tap **Begin triage**, then **Request diagnosis**.
3. Choose *Test Mobile Diagnostics* and tap **Send diagnostic offer**.

**Expect:** the case moves to diagnostic pending.

### Step 3 — Technician accepts and confirms the vehicle (Field tech, Diagnostic tab)

1. Sign in to the Service app with the **diagnostic** account and open the **Diagnostic** tab.
2. Open the job from the queue and tap **Accept assignment**. Allow location.
3. On the **Vehicle** panel, tap **Check & confirm vehicle**. Correct anything wrong, and add the VIN and the odometer reading. Tap **Confirm vehicle**.

**Expect:**
- The panel shows **Confirmed**.
- The customer's case page shows **Confirmed by technician** after a refresh.
- The customer map shows the technician moving.

### Step 4 — Diagnosis and tow (Field tech + Ops)

1. **Field tech, Diagnostic tab:** fill in the finding. Set **Vehicle condition** to *Non-drivable* (it may read *Not drivable*) and **Recommended next step** to *Tow required*. Tap **Save finding & hand off**.
2. **Ops:** on the case, tap **Create and assign tow** (or **Assign Tow provider**) and choose *Test Tow & Valet*.
3. **Field tech:** sign out, sign in with the **tow** account, and open the **Tow** tab.
4. On the job card, check the vehicle: year, make, model, color and plate. There must be **no VIN**. With all-wheel drive set in step 1, it says **Flatbed recommended**.
5. Tap **Accept**, then **Mark en route**, **Mark arrived**, **Mark vehicle loaded** and **Mark in transit**.

**Expect:** each tap updates the job, and the customer's case page follows along.

### Step 5 — Repair, parts, approval and payment

1. **Ops:** on the case, tap **Find repair provider**, **Evaluate repair providers**, then **Select and offer repair** for *Test Dealership Service*.
2. **Field tech (Tow tab):** tap **Mark delivered**.
3. **Shop (Service app, partner account):** on the offer, tap **Accept work**. In **Repair workbench**, use **Propose repair** and **Send quote for approval**.
   - Optional: under **Request a part**, enter a simple SKU such as `TEST-BATTERY-1` and tap **Request parts**.
4. **Parts (Service app, parts account):** if a part was requested, open the order. Tap **Reserve stock**, **Mark ordered**, **Mark shipped** and **Mark delivered**. With no stock yet, first add it under **Stock on hand** → **Save inventory**.
5. **Customer:** refresh the case, review the quote and tap **Approve**.
6. **Shop:** complete the repair in the Shop OS workspace: start, quality check, complete.
7. **Ops:** tap **Request payment**, then **Create payment**.
8. **Customer:** refresh the case and tap **Pay now**. On Stripe's page, use test card **4242 4242 4242 4242**, any future expiry date, any 3-digit CVC and any ZIP code. Only do this when step 1.2 showed **mode: test**.

**Expect:** Stripe returns the customer to the case with **Payment received**. The payment shows as captured and the case completes without anyone in Ops marking it paid. (**Mark paid (outside ROVIQ)** in Ops is only for a payment taken some other way.)

---

## Part 3 — Extra checks (optional, 10 minutes each)

**Service app with all tabs (owner).** Sign in to https://roviq-service.pages.dev with the admin account. You get five tabs (Diagnostic, Tow, Shop, Parts, Mobility) marked **Test mode**. Swipe the top bar to switch tabs; each tab keeps its place.

**Parts sharing (Shop).** In the Shop tab, scroll to **Network sharing**:

1. Confirm it starts as **Private**.
2. Choose **Named partners**, tick **Show how many I have**, and save.
3. Reload and check that it stuck.
4. Set it back to Private.

**On-site repair instead of tow (Field tech).** In step 4, instead of routing to tow, choose **Assess for on-site repair**:

1. Enter a battery job at high confidence with no safety flags.
2. The customer gets an **Approve on-site repair** card; approve it.
3. The tech can then start the work and mark it fixed.

The tech cannot skip the customer's approval.

**One login, several roles:** not ready for a hands-on test yet. Giving an account a second role needs the Ops screen that is still being built.

---

## Part 4 — Recording problems

Keep one shared sheet with these columns:

| # | Step | Role / device | What you did | What you expected | What happened | Screenshot |
|---|---|---|---|---|---|---|

Also record:
- **Timing:** anything that took more than 5 seconds to respond.
- **Confusion:** any moment someone wasn't sure what to tap.

Those matter as much as errors.

## If something goes wrong

- **A screen looks stuck:** use its **Refresh** button, then reload the page. Don't create a duplicate case unless the original is unusable.
- **Everything is slow or times out at the start:** Render is waking up. Wait a minute and retry.
- **You're signed out unexpectedly:** in the Service app this happens to every tab at once when any tab's sign-in expires. Sign in again.
- **Location denied:** re-enable it in the browser's site settings and reload. The case continues without a location.
- **Tow declines by mistake:** Ops assigns the tow again; the job returns to the queue.

## After the run

- Share the notes sheet. Every problem becomes a fix, and the run repeats until it's clean.
- Test cases can stay in production. They're tagged by the test accounts that created them.
