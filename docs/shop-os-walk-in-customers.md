# Shop OS walk-in customers: approval, payment and books

Shop OS can now run a shop's own walk-in customers end to end, without a ROVIQ case.

**Approval link.** On a walk-in repair order whose estimate has been sent for approval, the shop
creates a customer link (Repair orders → Customer & payment). The customer opens it on any phone,
sees the shop, vehicle, concern and each line's price, and chooses Yes or Not now per line. Any
approved line approves the estimate. The link expires after 14 days; creating a new link stops the
old one. Only a SHA-256 hash of the token is stored. The page never shows costs, internal notes,
phone numbers or other customers. ROVIQ does not send the link yet: the shop copies or shares it.
Approval still requires the shop's verified repair authorization (Ops → Eligibility), like any repair
approval.

**Payment.** Once the job is completed, the link offers "Pay by card" through Stripe Checkout for
the balance (approved amount minus payments). Stripe, never the browser, confirms payment: on return
and by webhook (`metadata.roviq_shop_payment_id`). The amount must match exactly. Shops can also
record a counter payment (cash, own card terminal, other); payments can never exceed the balance.
Without a Stripe key the online option is hidden and counter payments still work.

**Books.** Completing or closing a repair order settles it immediately (revenue, parts/sublet cost,
labour cost as ledger entries on the repair order), for walk-ins as well as network jobs. Walk-in
repair orders can now track parts readiness too. The Takings tab shows jobs finished, earned, cost,
margin and money collected by method per day (shop's local time zone), walk-in customers who still
owe, and settles any finished job that missed automatic settlement.

**Shop OS layout.** The workspace is split into tabs (Today, Schedule, Repair orders, Repair floor,
Takings, ROVIQ network); the network tab shows a badge with new offers. The header shows the
business name. Repair orders show the job type, customer, vehicle, booked slot and technician by
name instead of internal IDs. Shops whose capacity comes from Shop OS bays no longer see the manual
"Declare availability" form.

Endpoints: `POST /api/shop-os/repair-orders/:id/customer-link`, `GET|POST /api/shop-os/repair-orders/:id/payments`,
`GET /api/shop-os/takings`, `POST /api/shop-os/takings/settle`, and the public
`GET /api/public/shop-estimates/:token`, `POST …/decision`, `POST …/checkout`, `POST …/confirm` (rate limited).

## Customer page (the shop's own customer portal)

Shop OS is a standalone shop system, so its customers get the shop's page, not a ROVIQ account. From
any walk-in repair order the shop creates one private link per customer (`POST
/api/shop-os/customers/:customerId/portal-link`, 90-day expiry, a new link revokes the old). The page
at `/shop/:token` carries the shop's name ("Powered by ROVIQ" only in the footer) and shows:

- each job in the shop with live progress (checked in → inspection → your approval → repair → final
  check → ready), refreshed every minute;
- updates the shop posts for the customer (`POST /api/shop-os/repair-orders/:id/customer-updates`);
- the submitted inspection report: condition (urgent / keep an eye on it / good), measurement and the
  customer note, urgent first, with customer-visible photos whose storage reference is an https URL;
- estimate approval per line and card payment once the job is done (same rules as the estimate link);
- upcoming visits, work recommended for later, service history and vehicles.

Items the customer answers "Not now" become recommended work (deferred items) with a 30-day follow-up.
Technician notes, internal notes, costs, hidden photos, phone numbers and ROVIQ network jobs are never
shown. Public endpoints: `GET /api/public/shop-portal/:token` and `POST …/jobs/:jobId/decision|checkout|confirm`.

Not yet: photo upload and storage for inspections (findings store a reference only), and sending the
link by SMS or email (needs the Twilio / Resend keys).
