package com.njplumbing.shopsms

import android.content.Context

object Prefs {
    private const val FILE = "shop_sms"
    private const val TOKEN = "token"
    private const val ENABLED = "enabled"
    private const val STATUS = "status"
    private const val LISTEN_ONLY = "listen_only"
    private const val LAST_SMS_ID = "last_sms_id"
    private const val LAST_MMS_ID = "last_mms_id"

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun token(context: Context): String = prefs(context).getString(TOKEN, "")?.trim().orEmpty()

    fun setToken(context: Context, token: String) {
        prefs(context).edit().putString(TOKEN, token.trim()).apply()
    }

    fun enabled(context: Context): Boolean = prefs(context).getBoolean(ENABLED, false)

    fun setEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(ENABLED, enabled).apply()
    }

    fun status(context: Context): String = prefs(context).getString(STATUS, "") ?: ""

    fun setStatus(context: Context, status: String) {
        prefs(context).edit().putString(STATUS, status).apply()
    }

    fun listenOnly(context: Context): Boolean = prefs(context).getBoolean(LISTEN_ONLY, false)

    fun setListenOnly(context: Context, value: Boolean) {
        prefs(context).edit().putBoolean(LISTEN_ONLY, value).apply()
    }

    fun lastSmsId(context: Context): Long = prefs(context).getLong(LAST_SMS_ID, 0L)

    fun setLastSmsId(context: Context, id: Long) {
        prefs(context).edit().putLong(LAST_SMS_ID, id).apply()
    }

    fun lastMmsId(context: Context): Long = prefs(context).getLong(LAST_MMS_ID, 0L)

    fun setLastMmsId(context: Context, id: Long) {
        prefs(context).edit().putLong(LAST_MMS_ID, id).apply()
    }
}
