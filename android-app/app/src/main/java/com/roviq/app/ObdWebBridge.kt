package com.roviq.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

/** Exact-origin, main-frame-only bridge; no bearer tokens or arbitrary commands. */
class ObdWebBridge(private val activity: Activity, private val view: WebView) : AutoCloseable {
    private val scanner = ObdClassicScanner(activity)
    private val origins = setOf("https://roviq-core-customer.pages.dev", "https://roviq-diagnostic-net.pages.dev")
    private var generation = 0
    private var busy = false
    private var installed = false
    private var confirmation: AlertDialog? = null

    fun install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(view, "ROVIQObd", origins) { _, message, origin, mainFrame, reply ->
            if (!mainFrame || origin.toString() !in origins) return@addWebMessageListener
            val raw = runCatching { message.data }.getOrNull() ?: return@addWebMessageListener
            if (raw.length > 1024) return@addWebMessageListener
            val body = runCatching { JSONObject(raw) }.getOrNull() ?: return@addWebMessageListener
            val id = body.optString("id")
            if (!id.matches(Regex("[A-Za-z0-9_-]{1,80}"))) return@addWebMessageListener
            val action = body.optString("action")
            fun send(result: JSONObject) { reply.postMessage(result.put("id", id).toString()) }
            if (action == "cancel") { navigationChanged(); send(JSONObject().put("cancelled", true)); return@addWebMessageListener }
            if (action !in setOf("list", "scan")) { send(JSONObject().put("error", "action_not_allowed")); return@addWebMessageListener }
            if (Build.VERSION.SDK_INT >= 31 && activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                activity.requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), PERMISSION_REQUEST)
                send(JSONObject().put("error", "bluetooth_permission_required")); return@addWebMessageListener
            }
            val devices = runCatching { scanner.pairedScanners() }.getOrElse {
                send(JSONObject().put("error", "bluetooth_unavailable")); return@addWebMessageListener
            }
            if (action == "list") {
                val list = JSONArray()
                devices.forEach { (address, name) -> list.put(JSONObject().put("address", address).put("name", name)) }
                send(JSONObject().put("devices", list)); return@addWebMessageListener
            }
            if (busy) { send(JSONObject().put("error", "scanner_busy")); return@addWebMessageListener }
            val device = devices.firstOrNull { it.first == body.optString("address") }
            if (device == null) { send(JSONObject().put("error", "scanner_not_paired")); return@addWebMessageListener }
            busy = true
            val epoch = generation
            confirmation = AlertDialog.Builder(activity)
                .setTitle("Read vehicle data?")
                .setMessage("Confirm this scanner is connected to the vehicle selected in ROVIQ. Read trouble codes and supported measurements from ${device.second}. No codes will be cleared.")
                .setNegativeButton("Cancel") { _, _ -> busy = false; send(JSONObject().put("error", "scan_cancelled")) }
                .setOnCancelListener { busy = false; send(JSONObject().put("error", "scan_cancelled")) }
                .setPositiveButton("Read scanner") { _, _ ->
                    scanner.readSnapshot(device.first) { result -> activity.runOnUiThread {
                        if (epoch != generation || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                        busy = false
                        val response = result.fold({ snapshot ->
                            JSONObject().put("snapshot", JSONObject().put("scanId", snapshot.scanId)
                                .put("observedAt", snapshot.observedAt).put("dtcResponse", snapshot.dtcResponse)
                                .put("pidResponses", JSONObject(snapshot.pidResponses)))
                        }, { JSONObject().put("error", "scanner_read_failed") })
                        send(response)
                    } }
                }.show()
        }
        installed = true
    }

    fun navigationChanged() {
        generation++
        busy = false
        confirmation?.dismiss()
        confirmation = null
        scanner.cancel()
    }

    override fun close() {
        navigationChanged()
        if (installed) WebViewCompat.removeWebMessageListener(view, "ROVIQObd")
        scanner.close()
    }

    companion object { const val PERMISSION_REQUEST = 1208 }
}
