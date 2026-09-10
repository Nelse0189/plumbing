package com.njplumbing.shopsms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlin.concurrent.thread

class MmsPushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Prefs.token(context).isBlank()) return
        val pending = goAsync()
        thread {
            try {
                Thread.sleep(2500)
                InboxScanner.scan(context.applicationContext)
            } finally {
                pending.finish()
            }
        }
    }
}
