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
