package io.github.amossdvir1.celeste;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Phone control's buttons on notifications: Allow or Deny on its cards, and Stop while it lasts. */
public class ControlReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if ("stop".equals(action)) {
            PhoneControl.end(ctx, "The user pressed Stop on the phone.");
            return;
        }
        String id = intent.getStringExtra("id");
        if (id != null) PhoneControl.answered(ctx, id, "yes".equals(action));
    }
}
