# ROVIQ Android release

The Android customer app uses application ID `com.roviq.app`, targets Android API 35, and opens the production ROVIQ customer experience over HTTPS.

## Google Play bundle

`.github/workflows/android-release.yml` builds `app-release.aab`. Pull requests produce an unsigned validation bundle. Pushes to `android-release-shell` and manual release runs require the repository signing secrets below and verify the signed AAB before publishing it as a workflow artifact.

Required repository secrets:

- `ROVIQ_ANDROID_KEYSTORE_BASE64`
- `ROVIQ_ANDROID_KEYSTORE_PASSWORD`
- `ROVIQ_ANDROID_KEY_ALIAS`
- `ROVIQ_ANDROID_KEY_PASSWORD`

Manual workflow runs accept `version_code` and `version_name`; Google Play version codes must increase for each upload.

The upload key must be retained for future releases. Google Play App Signing should remain enabled so the Play signing key is managed separately from the upload key.
