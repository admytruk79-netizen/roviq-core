plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseVersionCodeRaw = System.getenv("ROVIQ_VERSION_CODE") ?: throw GradleException("ROVIQ_VERSION_CODE is required")
val releaseVersionCode = releaseVersionCodeRaw.toIntOrNull()
    ?: throw GradleException("ROVIQ_VERSION_CODE must be an integer")
if (releaseVersionCode <= 0) throw GradleException("ROVIQ_VERSION_CODE must be positive")
val releaseVersionName = System.getenv("ROVIQ_VERSION_NAME")?.takeIf { it.isNotBlank() }
    ?: throw GradleException("ROVIQ_VERSION_NAME is required")

android {
    namespace = "com.roviq.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.roviq.app"
        minSdk = 26
        targetSdk = 35
        versionCode = releaseVersionCode
        versionName = releaseVersionName
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

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
