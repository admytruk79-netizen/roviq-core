plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseTaskRequested = gradle.startParameter.taskNames.any { task ->
    val normalized = task.lowercase()
    normalized.contains("bundlerelease") || normalized.contains("assemblerelease") || normalized.contains("publishrelease")
}

fun validatedVersionCode(): Int {
    val raw = System.getenv("ROVIQ_VERSION_CODE")
    if (raw.isNullOrBlank()) {
        if (releaseTaskRequested) throw GradleException("ROVIQ_VERSION_CODE is required for release builds")
        return 1
    }
    val value = raw.toIntOrNull() ?: throw GradleException("ROVIQ_VERSION_CODE must be an integer")
    if (value <= 0) throw GradleException("ROVIQ_VERSION_CODE must be positive")
    return value
}

fun validatedVersionName(): String {
    val raw = System.getenv("ROVIQ_VERSION_NAME")
    if (raw.isNullOrBlank()) {
        if (releaseTaskRequested) throw GradleException("ROVIQ_VERSION_NAME is required for release builds")
        return "1.0.0-dev"
    }
    return raw
}

val appVersionCode = validatedVersionCode()
val appVersionName = validatedVersionName()

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

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
