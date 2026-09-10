package com.njplumbing.shopsms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import kotlin.concurrent.thread

class SmsInboundReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        if (Prefs.token(context).isBlank()) return
        val pending = goAsync()
        thread {
            try {
                InboxScanner.scan(context.applicationContext)
            } finally {
                pending.finish()
            }
        }
    }
}
