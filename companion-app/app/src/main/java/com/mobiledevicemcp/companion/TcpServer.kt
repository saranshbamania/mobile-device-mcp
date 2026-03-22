package com.mobiledevicemcp.companion

import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * Lightweight TCP server that listens on localhost:18080.
 *
 * Protocol: JSON-RPC over TCP with newline delimiters.
 * Each request is a single JSON object followed by \n.
 * Each response is a single JSON object followed by \n.
 *
 * Only accepts connections from 127.0.0.1 (via ADB port forward).
 *
 * Supported methods:
 *   getTree     — returns full AccessibilityNodeInfo tree as UIElement[]
 *   getInfo     — returns version, API level, service status
 */
class TcpServer(
    private val service: CompanionAccessibilityService,
    private val port: Int = 18080,
) {
    private var serverSocket: ServerSocket? = null
    private var running = false
    private val clients = mutableListOf<ClientHandler>()

    companion object {
        private const val TAG = "MCPTcpServer"
    }

    fun start() {
        running = true
        Thread(Runnable {
            try {
                val server = ServerSocket(port, 5, InetAddress.getByName("127.0.0.1"))
                serverSocket = server
                Log.i(TAG, "Listening on 127.0.0.1:$port")

                while (running) {
                    try {
                        val client = server.accept()
                        Log.i(TAG, "Client connected")
                        val handler = ClientHandler(client)
                        synchronized(clients) { clients.add(handler) }
                        handler.start()
                    } catch (e: Exception) {
                        if (running) Log.e(TAG, "Accept failed", e)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Server failed to start", e)
            }
        }, "mcp-tcp-server").start()
    }

    fun stop() {
        running = false
        synchronized(clients) {
            clients.forEach { it.close() }
            clients.clear()
        }
        try {
            serverSocket?.close()
        } catch (_: Exception) {}
        serverSocket = null
        Log.i(TAG, "Server stopped")
    }

    private inner class ClientHandler(private val socket: Socket) {
        private var active = true

        fun start() {
            Thread(Runnable {
                try {
                    val reader = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8))
                    val writer = PrintWriter(socket.outputStream, true)

                    while (running && active && !socket.isClosed) {
                        val line = reader.readLine() ?: break
                        val response = processRequest(line)
                        writer.println(response)
                    }
                } catch (e: Exception) {
                    if (active) Log.d(TAG, "Client disconnected: ${e.message}")
                } finally {
                    close()
                    synchronized(clients) { clients.remove(this) }
                }
            }, "mcp-client-handler").start()
        }

        fun close() {
            active = false
            try {
                socket.close()
            } catch (_: Exception) {}
        }
    }

    private fun processRequest(line: String): String {
        return try {
            val request = JSONObject(line)
            val id = request.opt("id")
            val method = request.getString("method")
            val params = request.optJSONObject("params") ?: JSONObject()

            val result = when (method) {
                "getTree" -> {
                    val interactiveOnly = params.optBoolean("interactiveOnly", false)
                    val tree = service.getUITree(interactiveOnly)
                    JSONObject()
                        .put("elements", tree)
                        .put("timestamp", System.currentTimeMillis())
                        .put("count", tree.length())
                }
                "getInfo" -> {
                    JSONObject()
                        .put("version", "1.0.0")
                        .put("apiLevel", android.os.Build.VERSION.SDK_INT)
                        .put("serviceEnabled", true)
                        .put("port", port)
                }
                else -> throw IllegalArgumentException("Unknown method: $method")
            }

            JSONObject()
                .put("id", id ?: JSONObject.NULL)
                .put("result", result)
                .toString()
        } catch (e: Exception) {
            Log.e(TAG, "Request error", e)
            val error = JSONObject()
                .put("code", -1)
                .put("message", e.message ?: "Unknown error")
            JSONObject()
                .put("id", JSONObject.NULL)
                .put("error", error)
                .toString()
        }
    }
}
