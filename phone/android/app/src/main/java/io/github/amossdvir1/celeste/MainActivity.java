package io.github.amossdvir1.celeste;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** Whether the app is on screen. The background service leaves notifications to the app while it is. */
    static volatile boolean visible;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CelesteNativePlugin.class);
        super.onCreate(savedInstanceState);
        if (savedInstanceState == null) {
            shared(getIntent());
            asked(getIntent());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        shared(intent);
        asked(intent);
    }

    /** Opened from the notification that asks to show this screen on the computer: the app asks Android's permission now. */
    private void asked(Intent intent) {
        if (intent != null && intent.getBooleanExtra(ScreenShare.EXTRA_ASKED, false)) CelesteNativePlugin.shareAsked = true;
    }

    /** Text or a link shared to Celeste from another app: kept for the app to start a chat with. */
    private void shared(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text == null || text.toString().trim().isEmpty()) return;
        String t = text.toString().trim();
        // A shared link often comes with the page's title as the subject: both, title first.
        if (subject != null && !subject.trim().isEmpty() && !t.contains(subject.trim())) t = subject.trim() + "\n" + t;
        if (t.length() > 20_000) t = t.substring(0, 20_000);
        CelesteNativePlugin.share(t);
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onPause() {
        visible = false;
        super.onPause();
    }
}
