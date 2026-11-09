package io.github.amossdvir1.celeste;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** Whether the app is on screen. The background service leaves notifications to the app while it is. */
    static volatile boolean visible;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CelesteNativePlugin.class);
        super.onCreate(savedInstanceState);
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
