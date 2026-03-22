package com.mobiledevicemcp.companion

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import org.json.JSONArray

/**
 * AccessibilityService that provides real-time UI tree data
 * to the mobile-device-mcp server via a local TCP socket.
 *
 * The service:
 * - Captures the full AccessibilityNodeInfo tree on demand
 * - Sees all windows including system dialogs and Flutter semantics
 * - Works on release builds (unlike Flutter VM Service)
 * - Starts a TCP server on 127.0.0.1:18080 for local communication
 *
 * The TCP server is only reachable via ADB port forward:
 *   adb forward tcp:18080 tcp:18080
 */
class CompanionAccessibilityService : AccessibilityService() {

    private var tcpServer: TcpServer? = null

    companion object {
        private const val TAG = "MCPCompanion"
        private const val PORT = 18080

        /** Set to true when service is running — checked by MainActivity. */
        @Volatile
        var isRunning = false
            private set
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "Accessibility service connected")
        isRunning = true

        // Start TCP server for MCP communication
        tcpServer = TcpServer(this, PORT)
        tcpServer?.start()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // We don't need to process individual events for now.
        // The MCP server polls via getTree when it needs data.
        // Future: push events to subscribed WebSocket clients.
    }

    override fun onInterrupt() {
        Log.w(TAG, "Accessibility service interrupted")
    }

    override fun onDestroy() {
        Log.i(TAG, "Accessibility service destroyed")
        isRunning = false
        tcpServer?.stop()
        tcpServer = null
        super.onDestroy()
    }

    /**
     * Capture the current UI tree from the active window.
     * Returns a JSONArray of UIElement objects matching the
     * mobile-device-mcp UIElement interface.
     *
     * Thread-safe: can be called from the TCP server thread.
     */
    fun getUITree(interactiveOnly: Boolean): JSONArray {
        val rootNode = rootInActiveWindow
        if (rootNode == null) {
            Log.d(TAG, "rootInActiveWindow is null")
            return JSONArray()
        }

        return try {
            TreeSerializer.serialize(rootNode, interactiveOnly)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to serialize tree", e)
            JSONArray()
        } finally {
            rootNode.recycle()
        }
    }
}
