package com.arco.tv.ui

import android.content.Context
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.Toast
import androidx.activity.ComponentActivity
import com.arco.tv.R

class SettingsActivity : ComponentActivity() {

	companion object {
		const val PREFS_NAME = "arco_prefs"
		const val PREF_URL_KEY = "arco_url"
		const val DEFAULT_URL = "https://main--arco--carlossg.aem.page/"
	}

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContentView(R.layout.activity_settings)

		val radioGroup = findViewById<RadioGroup>(R.id.radio_group_urls)
		val radioDefault = findViewById<RadioButton>(R.id.radio_default)
		val radioCustom = findViewById<RadioButton>(R.id.radio_custom)
		val editUrl = findViewById<EditText>(R.id.edit_arco_url)
		val btnSave = findViewById<Button>(R.id.btn_save)
		val btnCancel = findViewById<Button>(R.id.btn_cancel)
		val btnTest = findViewById<Button>(R.id.btn_test)

		val sharedPref = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
		val currentUrl = sharedPref.getString(PREF_URL_KEY, DEFAULT_URL) ?: DEFAULT_URL

		// Set initial state based on current URL
		if (currentUrl == DEFAULT_URL) {
			radioDefault.isChecked = true
			editUrl.isEnabled = false
			editUrl.setText(DEFAULT_URL)
		} else {
			radioCustom.isChecked = true
			editUrl.isEnabled = true
			editUrl.setText(currentUrl)
		}

		// Handle radio button selection
		radioGroup.setOnCheckedChangeListener { _, checkedId ->
			when (checkedId) {
				R.id.radio_default -> {
					editUrl.setText(DEFAULT_URL)
					editUrl.isEnabled = false
				}
				R.id.radio_custom -> {
					editUrl.isEnabled = true
					editUrl.requestFocus()
				}
			}
		}

		// Save button
		btnSave.setOnClickListener {
			val newUrl = editUrl.text.toString().trim()
			if (validateUrl(newUrl)) {
				sharedPref.edit().putString(PREF_URL_KEY, newUrl).apply()
				Toast.makeText(this, getString(R.string.msg_url_saved), Toast.LENGTH_SHORT).show()
				finish()
			} else {
				Toast.makeText(this, getString(R.string.msg_invalid_url), Toast.LENGTH_LONG).show()
			}
		}

		// Cancel button
		btnCancel.setOnClickListener {
			finish()
		}

		// Test button - opens the URL in the WebView
		btnTest.setOnClickListener {
			val testUrl = editUrl.text.toString().trim()
			if (validateUrl(testUrl)) {
				Toast.makeText(this, getString(R.string.msg_testing_url), Toast.LENGTH_SHORT).show()
				// Save temporarily and go back (DiscoveryActivity will load the URL)
				sharedPref.edit().putString(PREF_URL_KEY, testUrl).apply()
				finish()
			} else {
				Toast.makeText(this, getString(R.string.msg_invalid_url), Toast.LENGTH_LONG).show()
			}
		}
	}

	private fun validateUrl(url: String): Boolean {
		if (url.isEmpty()) {
			return false
		}

		// Basic URL validation
		return url.startsWith("http://") || url.startsWith("https://")
	}
}
