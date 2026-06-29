package com.arco.tv.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import java.net.URLEncoder

import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebSettings
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.SslErrorHandler
import android.net.http.SslError

class DiscoveryActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private val TAG = "DiscoveryActivity"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                // Log errors to help diagnose web page issues
                Log.e(TAG, "WebView Error: ${error?.description} for URL: ${request?.url}")
            }

            override fun onReceivedSslError(
                view: WebView?,
                handler: SslErrorHandler?,
                error: SslError?
            ) {
                // For development/testing: Accept SSL certificates
                // WARNING: In production, you should handle this more carefully
                Log.w(TAG, "SSL Error ignored: ${error?.toString()}")
                handler?.proceed()
            }
        }
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true

        // Allow mixed content for development
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        // Set custom user agent to identify as TV
        val defaultUserAgent = settings.userAgentString
        settings.userAgentString = "$defaultUserAgent AndroidTV ArcoTV/1.0"

        // Show current base URL on startup
        val sharedPref = getSharedPreferences(SettingsActivity.PREFS_NAME, android.content.Context.MODE_PRIVATE)
        val baseUrl = sharedPref.getString(SettingsActivity.PREF_URL_KEY, SettingsActivity.DEFAULT_URL)
        Log.d(TAG, "Using base URL: $baseUrl")

        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        Log.d(TAG, "onNewIntent called with: ${intent.data}")
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent) {
        val uri = intent.data
        Log.d(TAG, "Handling intent with URI: $uri")

        // Read URL from SharedPreferences
        val sharedPref = getSharedPreferences(SettingsActivity.PREFS_NAME, android.content.Context.MODE_PRIVATE)
        val baseUrl = sharedPref.getString(SettingsActivity.PREF_URL_KEY, SettingsActivity.DEFAULT_URL)

        // Check if there's a query parameter from a deep link
        val query = uri?.getQueryParameter("q")
            ?: intent.getStringExtra("q")
            ?: intent.getStringExtra("query")

        val url = if (query != null) {
            // Voice search or deep link with query - use ?q= parameter
            Log.d(TAG, "Extracted query: $query")
            val encodedQuery = URLEncoder.encode(query, "UTF-8")

            if (baseUrl?.contains("?") == true) {
                "${baseUrl}&q=$encodedQuery&tv=1"
            } else {
                "${baseUrl}?q=$encodedQuery&tv=1"
            }
        } else {
            // Normal app launch - just load homepage with TV mode
            Log.d(TAG, "No query parameter, loading homepage")
            if (baseUrl?.contains("?") == true) {
                "${baseUrl}&tv=1"
            } else {
                "${baseUrl}?tv=1"
            }
        }

        Log.d(TAG, "Loading URL: $url")
        webView.loadUrl(url)
    }

    override fun onKeyUp(keyCode: Int, event: android.view.KeyEvent?): Boolean {
        if (keyCode == android.view.KeyEvent.KEYCODE_MENU) {
            startActivity(Intent(this, SettingsActivity::class.java))
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
