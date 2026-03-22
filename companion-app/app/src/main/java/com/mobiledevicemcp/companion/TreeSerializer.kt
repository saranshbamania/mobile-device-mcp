package com.mobiledevicemcp.companion

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * Serializes an AccessibilityNodeInfo tree into a JSON array of UIElement
 * objects matching the mobile-device-mcp UIElement interface.
 *
 * Walks the tree depth-first, extracting text, bounds, class name,
 * resource ID, and interaction flags from each node.
 */
object TreeSerializer {

    fun serialize(root: AccessibilityNodeInfo, interactiveOnly: Boolean): JSONArray {
        val elements = JSONArray()
        walkTree(root, elements, Counter(), interactiveOnly)
        return elements
    }

    private class Counter(var value: Int = 0)

    private fun walkTree(
        node: AccessibilityNodeInfo,
        elements: JSONArray,
        counter: Counter,
        interactiveOnly: Boolean,
    ) {
        val clickable = node.isClickable
        val focusable = node.isFocusable
        val scrollable = node.isScrollable

        // Apply interactive filter before serializing
        val include = !interactiveOnly || clickable || focusable || scrollable

        if (include) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)

            // Skip zero-area nodes
            if (bounds.width() > 0 && bounds.height() > 0) {
                val element = JSONObject().apply {
                    put("index", counter.value)
                    put("text", node.text?.toString() ?: "")
                    put("contentDescription", node.contentDescription?.toString() ?: "")
                    put("className", node.className?.toString() ?: "")
                    put("packageName", node.packageName?.toString() ?: "")
                    put("resourceId", node.viewIdResourceName ?: "")
                    put("bounds", JSONObject().apply {
                        put("left", bounds.left)
                        put("top", bounds.top)
                        put("right", bounds.right)
                        put("bottom", bounds.bottom)
                        put("centerX", bounds.centerX())
                        put("centerY", bounds.centerY())
                    })
                    put("clickable", clickable)
                    put("scrollable", scrollable)
                    put("focusable", focusable)
                    put("enabled", node.isEnabled)
                    put("selected", node.isSelected)
                    put("checked", node.isChecked)
                }
                elements.put(element)
                counter.value++
            }
        }

        // Walk children
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            try {
                walkTree(child, elements, counter, interactiveOnly)
            } finally {
                child.recycle()
            }
        }
    }
}
