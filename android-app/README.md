# ROVIQ Customer and Actor Android apps

Two product flavors share the native host code but produce separately installable apps:

- Customer: `com.roviq.app`, label ROVIQ Customer, entry https://roviq-core-customer.pages.dev. The original package ID is retained for customer upgrades.
- Actor: `com.roviq.actor`, label ROVIQ Actor, entry https://roviq-service.pages.dev. Granted roles open diagnostics, tow, shop, parts, mobility and Ops.

Build with `gradle :app:bundleCustomerRelease :app:bundleActorRelease`. Configure positive `ROVIQ_VERSION_CODE` and a `ROVIQ_VERSION_NAME` for release tasks. The CI workflow supplies an increasing run number and uploads `app-customer-release.aab` and `app-actor-release.aab` separately. Pull request bundles are unsigned validation artifacts, not Play-ready uploads.

Signed push/manual builds require ROVIQ_ANDROID_KEYSTORE_BASE64, ROVIQ_ANDROID_KEYSTORE_PASSWORD, ROVIQ_ANDROID_KEY_ALIAS and ROVIQ_ANDROID_KEY_PASSWORD repository secrets. The configured upload key may sign both distinct packages; each requires its own Play listing. Keep the upload key for future updates and use Play App Signing. Release-version validation covers both flavored and aggregate tasks.

Each flavor restricts native navigation, location and Bluetooth bridge origin to its configured HTTPS entry origin. Only main frames can invoke the read-only scanner bridge. Actor provides a link to main-frame diagnostics for scanner use and a return to Actor workspaces. Physical-device and real scanner acceptance remain required.
