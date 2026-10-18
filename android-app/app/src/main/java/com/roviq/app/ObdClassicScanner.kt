package com.roviq.app

import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import java.io.IOException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Foreground read-only capture from an explicitly selected, already bonded scanner.
 * Caller must obtain BLUETOOTH_CONNECT permission and provide the device picker.
 * No arbitrary commands, clear-code operation, ECU writes, or automatic uploads.
 */
class ObdClassicScanner(context: Context) : AutoCloseable {
    data class Snapshot(val scanId: String, val observedAt: String, val dtcResponse: String,
                        val pidResponses: Map<String, String>)
    private val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
    private val worker = Executors.newSingleThreadExecutor()
    private val deadlines = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var cancellationVersion = 0
    private val spp = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private val commands = setOf("ATI", "ATE0", "ATL0", "ATH0", "ATS1", "ATSP0", "0100", "0101", "0105", "010C", "010D", "03")

    fun pairedScanners(): List<Pair<String, String>> = adapter?.bondedDevices.orEmpty()
        .filter { it.name?.startsWith("OBDLink") == true }
        .map { Pair(it.address, it.name ?: "OBDLink") }

    fun readSnapshot(address: String, result: (Result<Snapshot>) -> Unit) {
        val version = cancellationVersion
        worker.execute {
            val captured = runCatching {
                if (version != cancellationVersion) throw IOException("Scan cancelled")
                val device = adapter?.bondedDevices?.firstOrNull { it.address == address && it.name?.startsWith("OBDLink") == true }
                    ?: throw IOException("Select a paired OBDLink scanner first")
                val connection = device.createRfcommSocketToServiceRecord(spp)
                socket = connection
                try {
                    if (version != cancellationVersion) throw IOException("Scan cancelled")
                    val timeout = deadlines.schedule({ runCatching { connection.close() } }, 15, TimeUnit.SECONDS)
                    try { connection.connect() } finally { timeout.cancel(false) }
                    for (command in listOf("ATE0", "ATL0", "ATH0", "ATS1", "ATSP0")) {
                        if (!exchange(connection, command).contains("OK")) throw IOException("Scanner setup rejected: $command")
                    }
                    val observed = Instant.now().toString()
                    val responses = linkedMapOf<String, String>()
                    responses["00"] = exchange(connection, "0100")
                    // Capabilities determine which optional PIDs we request. Raw frames are
                    // retained for the strict parser; unsupported layouts stop this scan.
                    val support = responses.getValue("00").replace("SEARCHING...", "").replace(Regex("\\s|>"), "").uppercase()
                    if (!support.matches(Regex("4100[0-9A-F]{8}"))) throw IOException("Unsupported multi-ECU or capability response")
                    val bitmap = support.substring(4).toLong(16)
                    for ((pid, number) in listOf("01" to 1, "05" to 5, "0C" to 12, "0D" to 13)) {
                        if ((bitmap and (1L shl (32 - number))) != 0L) responses[pid] = exchange(connection, "01$pid")
                    }
                    Snapshot(UUID.randomUUID().toString(), observed, exchange(connection, "03"), responses)
                } finally { runCatching { connection.close() }; socket = null }
            }
            result(captured) // Caller must marshal UI updates to the main thread.
        }
    }

    private fun exchange(connection: BluetoothSocket, command: String): String {
        require(command in commands) { "Command is not read-only/approved" }
        val timeout = deadlines.schedule({ runCatching { connection.close() } }, 12, TimeUnit.SECONDS)
        try {
            connection.outputStream.write((command + "\r").toByteArray(Charsets.US_ASCII))
            connection.outputStream.flush()
            val response = StringBuilder()
            while (response.length < 16384) {
                val byte = connection.inputStream.read()
                if (byte < 0) throw IOException("Scanner disconnected")
                response.append(byte.toChar())
                if (byte == '>'.code) return response.toString()
            }
            throw IOException("Scanner response exceeded limit")
        } finally { timeout.cancel(false) }
    }

    fun cancel() {
        cancellationVersion++
        runCatching { socket?.close() }
    }

    override fun close() {
        cancel()
        worker.shutdownNow()
        deadlines.shutdownNow()
    }
}
