package com.mobiledevicemcp.companion

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Minimal setup activity for the MCP Companion.
 * Shows whether the AccessibilityService is enabled and
 * provides a button to open Accessibility Settings if needed.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var serviceStatus: TextView
    private lateinit var enableButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        serviceStatus = findViewById(R.id.serviceStatus)
        enableButton = findViewById(R.id.enableButton)

        enableButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        updateStatus()
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    private fun updateStatus() {
        val enabled = isAccessibilityServiceEnabled()

        if (enabled) {
            serviceStatus.text = "Service is ACTIVE\nListening on 127.0.0.1:18080\n\nUse 'adb forward tcp:18080 tcp:18080' to connect."
            serviceStatus.setTextColor(0xFF2E7D32.toInt()) // green
            enableButton.visibility = View.GONE
        } else {
            serviceStatus.text = "Service is NOT enabled.\nTap below to open Accessibility Settings\nand enable 'MCP Companion'."
            serviceStatus.setTextColor(0xFFC62828.toInt()) // red
            enableButton.visibility = View.VISIBLE
        }
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        // Check the static flag from the service
        if (CompanionAccessibilityService.isRunning) return true

        // Also check system settings as fallback
        val enabledServices = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false

        return enabledServices.contains(
            "${packageName}/${CompanionAccessibilityService::class.java.canonicalName}",
        )
    }
}
