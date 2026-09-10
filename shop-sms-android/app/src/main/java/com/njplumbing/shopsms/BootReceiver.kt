package com.njplumbing.shopsms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!Prefs.enabled(context) || Prefs.token(context).isBlank()) return
        val service = Intent(context, ShopSmsService::class.java)
        ContextCompat.startForegroundService(context, service)
    }
}
