package io.github.amossdvir1.celeste;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Deny, pressed on a phone ability's card: the computer is told no, and nothing happens on the phone. */
public class AbilityReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String id = intent.getStringExtra("id");
        if (id == null) return;
        Cards.forget(ctx, id);
        Abilities.reply(PhoneLine.load(ctx), id, false, "The user said no on their phone.");
    }
}
