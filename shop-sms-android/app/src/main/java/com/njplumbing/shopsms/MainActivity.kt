package com.njplumbing.shopsms

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.njplumbing.shopsms.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            binding.log.text = Prefs.status(this@MainActivity)
            handler.postDelayed(this, 2000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.tokenInput.setText(Prefs.token(this))
        binding.status.text = if (Prefs.enabled(this)) {
            "Running in the background"
        } else {
            "Stopped"
        }

        binding.listenOnly.isChecked = Prefs.listenOnly(this)
        binding.listenOnly.setOnCheckedChangeListener { _, checked ->
            Prefs.setListenOnly(this, checked)
        }

        binding.saveToken.setOnClickListener {
            val token = binding.tokenInput.text?.toString()?.trim().orEmpty()
            if (!token.startsWith("sms_")) {
                Toast.makeText(this, "Paste the full sms_ token from the Phone SMS tab.", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            Prefs.setToken(this, token)
            Toast.makeText(this, "Token saved on this phone.", Toast.LENGTH_SHORT).show()
        }

        binding.startService.setOnClickListener {
            if (Prefs.token(this).isBlank()) {
                Toast.makeText(this, "Save the token first.", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            if (!hasSmsPermission()) {
                requestSmsPermission()
                return@setOnClickListener
            }
            requestNotificationPermission()
            ContextCompat.startForegroundService(this, Intent(this, ShopSmsService::class.java))
            binding.status.text = "Running in the background"
            Prefs.setStatus(
                this,
                if (Prefs.listenOnly(this)) {
                    "Started. Forwarding texts and pictures."
                } else {
                    "Started. Waiting for the office queue."
                }
            )
        }

        binding.stopService.setOnClickListener {
            stopService(Intent(this, ShopSmsService::class.java))
            Prefs.setEnabled(this, false)
            binding.status.text = "Stopped"
            Prefs.setStatus(this, "Stopped.")
        }

        binding.battery.setOnClickListener {
            val pm = getSystemService(PowerManager::class.java)
            if (pm.isIgnoringBatteryOptimizations(packageName)) {
                Toast.makeText(this, "Battery optimization is already off.", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            intent.data = Uri.parse("package:$packageName")
            startActivity(intent)
        }
    }

    override fun onResume() {
        super.onResume()
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    private fun smsPermissions(): Array<String> {
        val needed = mutableListOf(
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS
        )
        if (!Prefs.listenOnly(this)) {
            needed.add(0, Manifest.permission.SEND_SMS)
        }
        return needed.toTypedArray()
    }

    private fun hasSmsPermission(): Boolean {
        return smsPermissions().all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun requestSmsPermission() {
        val extras = arrayOf(
            Manifest.permission.RECEIVE_MMS,
            Manifest.permission.RECEIVE_WAP_PUSH
        )
        ActivityCompat.requestPermissions(
            this,
            smsPermissions() + extras,
            1001
        )
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            1002
        )
    }
}
