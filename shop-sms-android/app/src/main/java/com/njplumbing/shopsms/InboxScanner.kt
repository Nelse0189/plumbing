package com.njplumbing.shopsms

import android.content.Context
import android.net.Uri
import android.provider.Telephony
import android.util.Base64
import android.util.Log

data class InboundImage(
    val mime: String,
    val name: String,
    val data: String
)

object InboxScanner {
    private const val TAG = "ShopSms"
    private const val FIRST_LOOKBACK_MS = 24L * 60 * 60 * 1000
    private const val MAX_IMAGES = 3
    private const val MAX_IMAGE_BYTES = 1_400_000
    @Volatile private var scanning = false

    fun scan(context: Context) {
        val token = Prefs.token(context)
        if (token.isBlank()) return
        synchronized(this) {
            if (scanning) return
            scanning = true
        }
        try {
            val client = GatewayClient(token)
            scanSms(context, client)
            scanMms(context, client)
        } catch (error: Exception) {
            Log.w(TAG, "Inbox scan failed", error)
            Prefs.setStatus(context, "Inbox error: ${error.message}")
        } finally {
            scanning = false
        }
    }

    private fun scanSms(context: Context, client: GatewayClient) {
        val resolver = context.contentResolver
        val lastId = Prefs.lastSmsId(context)
        val firstRun = lastId <= 0
        val cutoff = System.currentTimeMillis() - FIRST_LOOKBACK_MS
        val cursor = resolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(
                Telephony.Sms._ID,
                Telephony.Sms.ADDRESS,
                Telephony.Sms.BODY,
                Telephony.Sms.DATE
            ),
            if (firstRun) "${Telephony.Sms.DATE}>=?" else "${Telephony.Sms._ID}>?",
            arrayOf(if (firstRun) cutoff.toString() else lastId.toString()),
            "${Telephony.Sms._ID} ASC"
        ) ?: return
        var maxId = lastId
        cursor.use {
            while (it.moveToNext()) {
                val id = it.getLong(0)
                val from = it.getString(1).orEmpty()
                val body = it.getString(2).orEmpty()
                if (from.isBlank() || body.isBlank()) {
                    if (id > maxId) maxId = id
                    continue
                }
                try {
                    client.inbound(
                        from = from,
                        message = body,
                        providerId = "sms-$id"
                    )
                    if (id > maxId) maxId = id
                    Prefs.setStatus(context, "Forwarded text from $from")
                } catch (error: Exception) {
                    Log.w(TAG, "SMS forward failed $id", error)
                    Prefs.setStatus(context, "Inbox error: ${error.message}")
                    break
                }
            }
        }
        if (maxId > lastId) Prefs.setLastSmsId(context, maxId)
    }

    private fun scanMms(context: Context, client: GatewayClient) {
        val resolver = context.contentResolver
        val lastId = Prefs.lastMmsId(context)
        val firstRun = lastId <= 0
        val cutoff = System.currentTimeMillis() - FIRST_LOOKBACK_MS
        val cursor = resolver.query(
            Telephony.Mms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Mms._ID, Telephony.Mms.DATE),
            if (firstRun) "${Telephony.Mms.DATE}>=?" else "${Telephony.Mms._ID}>?",
            arrayOf(
                if (firstRun) (cutoff / 1000).toString() else lastId.toString()
            ),
            "${Telephony.Mms._ID} ASC"
        ) ?: return
        var maxId = lastId
        cursor.use {
            while (it.moveToNext()) {
                val id = it.getLong(0)
                val from = mmsFrom(context, id)
                val parts = mmsParts(context, id)
                val text = parts.first
                val images = parts.second
                if (from.isBlank() || (text.isBlank() && images.isEmpty())) {
                    if (id > maxId) maxId = id
                    continue
                }
                try {
                    client.inbound(
                        from = from,
                        message = text.ifBlank { if (images.isEmpty()) "" else "(picture)" },
                        providerId = "mms-$id",
                        images = images
                    )
                    if (id > maxId) maxId = id
                    Prefs.setStatus(
                        context,
                        if (images.isNotEmpty()) "Forwarded picture from $from" else "Forwarded MMS from $from"
                    )
                } catch (error: Exception) {
                    Log.w(TAG, "MMS forward failed $id", error)
                    Prefs.setStatus(context, "Inbox error: ${error.message}")
                    break
                }
            }
        }
        if (maxId > lastId) Prefs.setLastMmsId(context, maxId)
    }

    private fun mmsFrom(context: Context, id: Long): String {
        val uri = Uri.parse("content://mms/$id/addr")
        val cursor = context.contentResolver.query(
            uri,
            arrayOf("address", "type"),
            "type=137",
            null,
            null
        ) ?: return ""
        cursor.use {
            if (it.moveToFirst()) return it.getString(0).orEmpty()
        }
        return ""
    }

    private fun mmsParts(context: Context, id: Long): Pair<String, List<InboundImage>> {
        val uri = Uri.parse("content://mms/$id/part")
        val cursor = context.contentResolver.query(
            uri,
            arrayOf("_id", "ct", "text", "name", "cl"),
            null,
            null,
            null
        ) ?: return "" to emptyList()
        val text = StringBuilder()
        val images = mutableListOf<InboundImage>()
        cursor.use {
            while (it.moveToNext()) {
                val partId = it.getString(0) ?: continue
                val mime = it.getString(1)?.lowercase().orEmpty()
                val partText = it.getString(2)
                if (mime.startsWith("text/") && !partText.isNullOrBlank()) {
                    if (text.isNotEmpty()) text.append("\n")
                    text.append(partText.trim())
                    continue
                }
                if (!mime.startsWith("image/") || images.size >= MAX_IMAGES) continue
                val bytes = readPart(context, partId) ?: continue
                if (bytes.isEmpty() || bytes.size > MAX_IMAGE_BYTES) continue
                val label = it.getString(3).orEmpty().ifBlank { it.getString(4).orEmpty() }
                    .ifBlank { "image-${images.size + 1}" }
                images += InboundImage(
                    mime = mime,
                    name = label,
                    data = Base64.encodeToString(bytes, Base64.NO_WRAP)
                )
            }
        }
        return text.toString().trim() to images
    }

    private fun readPart(context: Context, partId: String): ByteArray? {
        val uri = Uri.parse("content://mms/part/$partId")
        return try {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (error: Exception) {
            Log.w(TAG, "Could not read MMS part $partId", error)
            null
        }
    }
}
