# Customer, Actor, Ops and Shop OS products

ROVIQ has four separately distributed apps sharing the authenticated Core API and canonical database.

| Product | Web origin | Android application ID | Purpose |
| --- | --- | --- | --- |
| ROVIQ Customer | https://roviq-core-customer.pages.dev | com.roviq.app | Vehicle owners |
| ROVIQ Actor | https://roviq-service.pages.dev | com.roviq.actor | Shops, diagnostics, towing, parts and mobility |
| ROVIQ Ops | https://roviq-ops.pages.dev | com.roviq.ops | Authorized platform administrators |
| ROVIQ Shop OS | https://roviq-shop.pages.dev | com.roviq.shop | Independent shops running their own business (Tekmetric-style shop system) |

ROVIQ Shop OS is the partner workspace built with `VITE_PRODUCT=shop` and deployed on its own origin through deploy-shop.yml. Its sign-in carries Shop OS branding and lets a new shop register (`POST /api/shops/register`) without the Actor shell. It uses the same partner role and server-side checks; a shop can still join the ROVIQ network from its Network tab. The same workspace stays embedded in Actor for network partners. Its Android flavor opens only the Shop OS origin and, like Ops, does not install the OBD bridge.

Ops is no longer a workspace packaged inside Actor. It has its own origin, browser storage, app label, Android package and launcher icon. Customer and Actor retain their existing package IDs. Actor contains five business workspaces and accepts only explicitly granted business roles; administrator login directs the user to Ops and stores no admin token. Old embedded Ops sessions are cleared. Legacy /ops/ web entry redirects to the separate Ops origin without transferring credentials.

Ops continues to require an existing admin identity. A shop/customer/provider identity cannot sign into Ops or call admin-only APIs. This separation does not create or grant administrator accounts, embed credentials, change backend authorization, or provide a new privileged API. Staff onboarding, service authorizations, credential reviews, cases and finance remain in the existing console. The user must use their existing administrator credentials; credential availability is not implied by installing the app.

Build all three products with node scripts/build-products.mjs. Ops deploys independently through deploy-ops.yml, Actor through deploy-service.yml and Customer through deploy-web.yml. Android workflows build Customer, Actor, Ops and Shop OS variants, with installable test APKs published under the test-apk prerelease. APK/AAB build success is distinct from Google Play publication or physical-device testing.

The Ops Android flavor opens only the Ops origin and uses its own private Android app storage. It does not install the OBD web bridge; diagnostics remain in Actor. Server-side role checks remain authoritative regardless of which application is installed. Test APKs use debug signing and are labelled as test builds.

Acceptance covers Actor rejecting admin sign-in, clearing retired Ops sessions, separate product outputs/manifests, all three Android flavors, Ops rejecting a business login, mobile/desktop login rendering and the multi-actor production journey using the separate Ops origin. No new real users or privileged identities are created by browser smoke checks.
