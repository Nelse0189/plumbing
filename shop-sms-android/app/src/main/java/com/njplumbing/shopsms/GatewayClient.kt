package com.njplumbing.shopsms

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

data class QueuedSms(
    val id: String,
    val to: String,
    val body: String
)

class GatewayClient(private val token: String) {
    private val base = "https://us-central1-nj-plumbing.cloudfunctions.net"

    fun poll(): List<QueuedSms> {
        val encoded = URLEncoder.encode(token, "UTF-8")
        val json = request("GET", "$base/smsGatewayPoll?token=$encoded", null)
        val root = JSONObject(json)
        if (!root.optBoolean("ok", false)) {
            throw IllegalStateException(root.optString("error", "Poll failed"))
        }
        val messages: JSONArray = root.optJSONArray("messages") ?: JSONArray()
        val out = mutableListOf<QueuedSms>()
        for (i in 0 until messages.length()) {
            val item = messages.getJSONObject(i)
            val id = item.optString("id")
            val to = item.optString("to")
            val body = item.optString("message").ifBlank { item.optString("body") }
            if (id.isNotBlank() && to.isNotBlank() && body.isNotBlank()) {
                out += QueuedSms(id, to, body)
            }
        }
        return out
    }

    fun ack(id: String, status: String, error: String? = null) {
        val encoded = URLEncoder.encode(token, "UTF-8")
        val payload = JSONObject()
            .put("id", id)
            .put("status", status)
        if (!error.isNullOrBlank()) payload.put("error", error.take(300))
        request("POST", "$base/smsGatewayAck?token=$encoded", payload.toString())
    }

    fun inbound(
        from: String,
        message: String,
        providerId: String = "",
        images: List<InboundImage> = emptyList()
    ) {
        val encoded = URLEncoder.encode(token, "UTF-8")
        val payload = JSONObject()
            .put("from", from)
            .put("message", message)
        if (providerId.isNotBlank()) payload.put("providerId", providerId)
        if (images.isNotEmpty()) {
            val list = JSONArray()
            for (image in images) {
                list.put(
                    JSONObject()
                        .put("mime", image.mime)
                        .put("name", image.name)
                        .put("data", image.data)
                )
            }
            payload.put("images", list)
        }
        request("POST", "$base/smsGatewayInbound?token=$encoded", payload.toString())
    }

    private fun request(method: String, url: String, body: String?): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 30000
            connection.readTimeout = 60000
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Connection", "close")
            connection.setRequestProperty("X-Sms-Gateway-Token", token)
            if (body != null) {
                val bytes = body.toByteArray(StandardCharsets.UTF_8)
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.setRequestProperty("Content-Length", bytes.size.toString())
                connection.outputStream.use { it.write(bytes) }
            }
            val stream = if (connection.responseCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream ?: connection.inputStream
            }
            val text = BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).use { it.readText() }
            if (connection.responseCode !in 200..299) {
                val message = try {
                    JSONObject(text).optString("error").ifBlank { text }
                } catch (_: Exception) {
                    text.ifBlank { "HTTP ${connection.responseCode}" }
                }
                throw IllegalStateException(message)
            }
            return text.ifBlank { "{}" }
        } finally {
            connection.disconnect()
        }
    }
}
