package com.roviq.app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var pendingGeoOrigin: String? = null
    private var pendingGeoCallback: GeolocationPermissions.Callback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(true)
        }
        WebView.setWebContentsDebuggingEnabled(false)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                val host = uri.host.orEmpty()
                val trusted = host == "roviq-core-customer.pages.dev" || host.endsWith(".roviq.com")
                if (trusted && uri.scheme == "https") return false

                val intent = Intent(Intent.ACTION_VIEW, uri)
                return try {
                    if (intent.resolveActivity(packageManager) != null) {
                        startActivity(intent)
                    } else {
                        Toast.makeText(this@MainActivity, "No app can open this link.", Toast.LENGTH_SHORT).show()
                    }
                    true
                } catch (_: ActivityNotFoundException) {
                    Toast.makeText(this@MainActivity, "No app can open this link.", Toast.LENGTH_SHORT).show()
                    true
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                if (!isLocationOriginAllowed(origin)) {
                    callback.invoke(origin, false, false)
                    return
                }
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false)
                    return
                }
                pendingGeoCallback?.invoke(pendingGeoOrigin, false, false)
                pendingGeoOrigin = origin
                pendingGeoCallback = callback
                requestPermissions(
                    arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                    LOCATION_REQUEST
                )
            }
        }

        if (savedInstanceState == null) {
            webView.loadUrl(APP_URL)
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != LOCATION_REQUEST) return
        val allowed = grantResults.any { it == PackageManager.PERMISSION_GRANTED }
        val origin = pendingGeoOrigin
        val callback = pendingGeoCallback
        pendingGeoOrigin = null
        pendingGeoCallback = null
        if (origin != null && callback != null && isLocationOriginAllowed(origin)) {
            callback.invoke(origin, allowed, false)
        } else {
            callback?.invoke(origin, false, false)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        pendingGeoCallback?.invoke(pendingGeoOrigin, false, false)
        pendingGeoOrigin = null
        pendingGeoCallback = null
        webView.stopLoading()
        webView.webChromeClient = null
        webView.webViewClient = WebViewClient()
        webView.destroy()
        super.onDestroy()
    }

    private fun isLocationOriginAllowed(origin: String): Boolean {
        val uri = try { Uri.parse(origin) } catch (_: Exception) { return false }
        return uri.scheme == "https" && uri.host == "roviq-core-customer.pages.dev"
    }

    companion object {
        private const val APP_URL = "https://roviq-core-customer.pages.dev"
        private const val LOCATION_REQUEST = 1207
    }
}
