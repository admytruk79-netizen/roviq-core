# Customer and Actor products

ROVIQ has two product entry points, sharing the Core API and database:

| Product | Web origin | Android application ID | Build output |
| --- | --- | --- | --- |
| ROVIQ Customer | https://roviq-core-customer.pages.dev | com.roviq.app | web/dist; app-customer-release.aab |
| ROVIQ Actor | https://roviq-service.pages.dev | com.roviq.actor | service/dist; app-actor-release.aab |

The existing Customer application ID is retained for upgrade continuity. Actor has a distinct ID, app label and app storage, so both can be installed together. The service directory and existing Pages project retain their internal names; the product presented to users is Actor.

Customer contains customer cases, vehicles, approvals and payment. Actor packages six role modules: diagnostic, tow, partner/shop, parts, fleet/mobility and admin/Ops. These are workspaces within Actor, not six separately distributed apps. Actor does not build or host the Customer module. Server authorization remains authoritative; hiding a workspace is not an authorization boundary.

Normal sign-in does not create test identities. Customer accepts a customer identity or switches to an explicitly granted customer role. Actor opens only its six allowed roles held by the authenticated identity. An account with both kinds of role signs in separately to each app. An admin without business grants opens Ops only. Old combined-shell session storage is cleared on upgrade.

Actor keeps the existing exact production origin. Customer and Actor therefore have separate web origins and browser storage. Previously issued combined-app checkout links are validated and redirected to the fixed Customer origin without transferring tokens. The retired /customer/ path redirects to Customer. Existing standalone role endpoints remain legacy/manual deployments, and are not deleted by this patch; automatic production deployments target Customer and Actor only. Ops is an admin workspace inside Actor.

On Android, Actor diagnostics can open at /diagnostic/ as the main frame and return to Actor workspaces. This gives the diagnostic scanner panel native access without granting subframes access to the Bluetooth bridge. Native navigation, geolocation and scanner origins are restricted to the installed product origin. Web browsers and embedded diagnostic frames have no native Bluetooth access.

Build both products with `node scripts/build-products.mjs`. The output check requires separate product titles/manifests, all six Actor modules, no Customer module in Actor and no Actor modules in Customer. CI also builds both Android flavors and uploads two separate unsigned PR AAB artifacts. Signed release runs use the existing configured upload-key secrets for each package; actual Play listings and distribution still require release setup.

Acceptance includes a customer-only account rejected from Actor, an actor-only account rejected from Customer, an identity with multiple real grants, an admin opening Ops without impersonation, cross-account server access denial, payment return to Customer, both apps installed together, and physical scanner capture in Actor. Unit/CI evidence does not substitute for the last two device checks.
