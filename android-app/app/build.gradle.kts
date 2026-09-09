plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseVersionCodeRaw = System.getenv("ROVIQ_VERSION_CODE")
val releaseVersionNameRaw = System.getenv("ROVIQ_VERSION_NAME")

fun configuredVersionCode(): Int {
    if (releaseVersionCodeRaw.isNullOrBlank()) return 1
    val value = releaseVersionCodeRaw.toIntOrNull()
        ?: throw GradleException("ROVIQ_VERSION_CODE must be an integer")
    if (value <= 0) throw GradleException("ROVIQ_VERSION_CODE must be positive")
    return value
}

fun configuredVersionName(): String = releaseVersionNameRaw?.takeIf { it.isNotBlank() } ?: "1.0.0-dev"

val appVersionCode = configuredVersionCode()
val appVersionName = configuredVersionName()

val validateReleaseVersion by tasks.registering {
    group = "verification"
    description = "Fails any release-producing task unless a valid release version is configured."
    doLast {
        val rawCode = releaseVersionCodeRaw
            ?: throw GradleException("ROVIQ_VERSION_CODE is required for release builds")
        val code = rawCode.toIntOrNull()
            ?: throw GradleException("ROVIQ_VERSION_CODE must be an integer")
        if (code <= 0) throw GradleException("ROVIQ_VERSION_CODE must be positive")
        if (releaseVersionNameRaw.isNullOrBlank()) {
            throw GradleException("ROVIQ_VERSION_NAME is required for release builds")
        }
    }
}

android {
    namespace = "com.roviq.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.roviq.app"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
    }

    val keystorePath = System.getenv("ROVIQ_ANDROID_KEYSTORE_PATH")
    val keystorePassword = System.getenv("ROVIQ_ANDROID_KEYSTORE_PASSWORD")
    val keyAlias = System.getenv("ROVIQ_ANDROID_KEY_ALIAS")
    val keyPassword = System.getenv("ROVIQ_ANDROID_KEY_PASSWORD")
    val hasReleaseSigning = listOf(keystorePath, keystorePassword, keyAlias, keyPassword).all { !it.isNullOrBlank() }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                this.keyAlias = keyAlias
                this.keyPassword = keyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

// Every Android release-producing path, including aggregate tasks such as `build`
// and `assemble`, flows through preReleaseBuild. Wiring validation here avoids
// guessing from raw command-line task names and also covers Gradle abbreviations.
tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    dependsOn(validateReleaseVersion)
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
