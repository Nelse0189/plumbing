package com.njplumbing.shopsms

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.telephony.SmsManager
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class ShopSmsService : Service() {
    private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        val notification = notification(
            if (Prefs.listenOnly(this)) {
                "Forwarding texts and pictures to the office"
            } else {
                "Waiting for queued texts from the office"
            }
        )
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        executor.scheduleWithFixedDelay({ tick() }, 2, POLL_SECONDS, TimeUnit.SECONDS)
        executor.execute { InboxScanner.scan(applicationContext) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Prefs.setEnabled(this, true)
        return START_STICKY
    }

    override fun onDestroy() {
        executor.shutdownNow()
        Prefs.setEnabled(this, false)
        super.onDestroy()
    }

    private fun tick() {
        val token = Prefs.token(this)
        if (token.isBlank()) {
            update("Save a Phone SMS token, then tap Start sending.")
            return
        }
        try {
            InboxScanner.scan(this)
            if (Prefs.listenOnly(this)) {
                update("Listening for texts and pictures. Last check ${now()}")
                return
            }
            val client = GatewayClient(token)
            val queued = client.poll()
            if (queued.isEmpty()) {
                update("Idle. Last check ${now()}")
                return
            }
            val message = queued.first()
            update("Sending to ${message.to}")
            try {
                sendSms(message.to, message.body)
                client.ack(message.id, "sent")
                update("Sent to ${message.to} at ${now()}")
            } catch (sendError: Exception) {
                try {
                    client.ack(message.id, "failed", sendError.message)
                } catch (_: Exception) {
                    // Keep the original send error for the status line.
                }
                throw sendError
            }
        } catch (error: Exception) {
            update("Error: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun sendSms(to: String, body: String) {
        val sms = if (Build.VERSION.SDK_INT >= 31) {
            getSystemService(SmsManager::class.java)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getDefault()
        }
        val parts = sms.divideMessage(body)
        if (parts.size == 1) {
            sms.sendTextMessage(to, null, body, null, null)
        } else {
            sms.sendMultipartTextMessage(to, null, parts, null, null)
        }
    }

    private fun update(text: String) {
        Prefs.setStatus(this, text)
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, notification(text))
    }

    private fun notification(text: String): Notification {
        val launch = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentIntent(launch)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build()
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW
        )
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }

    private fun now(): String {
        val time = java.text.SimpleDateFormat("h:mm:ss a", java.util.Locale.US)
        return time.format(java.util.Date())
    }

    companion object {
        const val CHANNEL_ID = "shop_sms"
        const val NOTIFICATION_ID = 42
        const val POLL_SECONDS = 8L
    }
}
